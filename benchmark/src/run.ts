// Runner do benchmark: submissão das ops, medição de latência/gás por operação e
// medição da propagação de revogação entre os 3 nós. Exporta CSV cru em results/.
//
// Decisões (aprovadas):
//   - Duas corridas rotuladas por `mode`: sequential (base limpa) e concurrent
//     (janela W=20, fila de nonce manual). Cada modo usa salt próprio → consentIds
//     distintos, sem colisão na cadeia persistente.
//   - Conta ÚNICA (node1) submetendo via RPC do node1 (8545).
//   - Propagação por polling HTTP apertado (~35 ms) de eth_getLogs nos 3 nós
//     (não há WebSocket exposto na rede).
//   - Fumaça: --smoke (= --ops 30 --prefix smoke_) valida o pipeline antes da
//     corrida real, sem misturar arquivos (prefixo smoke_).
//
// Não toca em docker nem no estado da rede além de enviar transações válidas.

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { generateOperations, summarize } from "./generate";
import { writeOperationsCsv, writePropagationCsv } from "./csv";
import { Mode, Operation, OpResult, PropObservation } from "./types";

// ---------------------------------------------------------------------------
// Caminhos e constantes
// ---------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, "..", "..");
const DEPLOYMENT = path.join(ROOT, "contracts", "deployments", "besu.json");
const NODE1_KEY = path.join(ROOT, "network", "nodes", "node1", "data", "key");
const RESULTS_DIR = path.join(ROOT, "results");
const DATA_DIR = path.join(__dirname, "..", "data");

const ENDPOINTS = [
  { name: "node1", endpoint: "http://localhost:8545" },
  { name: "node2", endpoint: "http://localhost:8546" },
  { name: "node3", endpoint: "http://localhost:8547" },
];
const SUBMIT_NODE = ENDPOINTS[0]; // conta única submete sempre pelo node1

const BLOCK_PERIOD_S = 2; // QBFT blockperiod (network/genesis.json)
const GAS_LIMIT = 500_000n; // teto generoso (grant cabe folgado); evita estimateGas por tx
const RECEIPT_POLL_MS = 50; // resolução do tx.wait() (provider do submissor)
const PROP_DRAIN_MS = 15_000; // janela extra para captar stragglers após a última op

// ---------------------------------------------------------------------------
// Utilitários de concorrência
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function createSemaphore(max: number) {
  let avail = max;
  const queue: Array<() => void> = [];
  return {
    async acquire(): Promise<void> {
      if (avail > 0) {
        avail--;
        return;
      }
      await new Promise<void>((r) => queue.push(r));
    },
    release(): void {
      const next = queue.shift();
      if (next) next();
      else avail++;
    },
  };
}

async function sendWithRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(150);
    }
  }
  throw last;
}

// ---------------------------------------------------------------------------
// Watcher de propagação: poll de eth_getLogs(ConsentRevoked) nos 3 nós
// ---------------------------------------------------------------------------
class RevocationWatcher {
  private stopped = false;
  private loops: Promise<void>[] = [];
  // consentId -> node -> {ms, block}
  readonly seen = new Map<string, Map<string, { ms: number; block: number }>>();

  constructor(
    private mode: Mode,
    private nodes: { name: string; endpoint: string; provider: ethers.JsonRpcProvider }[],
    private address: string,
    private topic: string,
    private pending: Set<string>,
    private pollMs: number,
    private startBlock: number,
  ) {}

  start(): void {
    this.stopped = false;
    this.loops = this.nodes.map((n) => this.loop(n));
  }

  private async loop(n: { name: string; provider: ethers.JsonRpcProvider }): Promise<void> {
    let cursor = this.startBlock;
    while (!this.stopped) {
      try {
        const latest = await n.provider.getBlockNumber();
        if (latest >= cursor) {
          const logs = await n.provider.getLogs({
            address: this.address,
            topics: [this.topic],
            fromBlock: cursor,
            toBlock: latest,
          });
          const now = Date.now();
          for (const log of logs) {
            const cid = log.topics[1]; // consentId indexado (bytes32)
            if (!this.pending.has(cid)) continue;
            let m = this.seen.get(cid);
            if (!m) {
              m = new Map();
              this.seen.set(cid, m);
            }
            if (!m.has(n.name)) m.set(n.name, { ms: now, block: log.blockNumber });
          }
          cursor = latest + 1;
        }
      } catch {
        // RPC transiente: ignora e segue no próximo poll.
      }
      await sleep(this.pollMs);
    }
  }

  allSeen(): boolean {
    for (const cid of this.pending) {
      const m = this.seen.get(cid);
      if (!m) return false;
      for (const n of this.nodes) if (!m.has(n.name)) return false;
    }
    return true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.loops);
  }

  observations(): PropObservation[] {
    const out: PropObservation[] = [];
    for (const [cid, m] of this.seen) {
      for (const n of this.nodes) {
        const o = m.get(n.name);
        if (o) {
          out.push({
            mode: this.mode,
            consentId: cid,
            node: n.name,
            endpoint: n.endpoint,
            firstSeenEpochMs: o.ms,
            blockNumber: o.block,
          });
        }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Envio de uma operação
// ---------------------------------------------------------------------------
function sendOp(
  contract: ethers.Contract,
  op: Operation,
  nonce: number | undefined,
): Promise<ethers.ContractTransactionResponse> {
  const overrides: ethers.Overrides = { gasPrice: 0, gasLimit: GAS_LIMIT };
  if (nonce !== undefined) overrides.nonce = nonce;
  if (op.type === "grant") {
    return contract.grantConsent(op.consentId, op.receiptHash, op.proofHash, overrides);
  }
  if (op.type === "verify") {
    return contract.verifyConsent(op.consentId, overrides);
  }
  return contract.revokeConsent(op.consentId, overrides);
}

function decodeValid(contract: ethers.Contract, receipt: ethers.ContractTransactionReceipt): boolean | null {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === "ConsentVerified") return Boolean(parsed.args.valid);
    } catch {
      // log de outro contrato/evento — ignora
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Coleta de uma medição a partir de tx + receipt
// ---------------------------------------------------------------------------
async function measure(
  op: Operation,
  mode: Mode,
  window: number,
  submitEpochMs: number,
  tx: ethers.ContractTransactionResponse,
  contract: ethers.Contract,
  blockTsCache: Map<number, number>,
  provider: ethers.JsonRpcProvider,
): Promise<OpResult> {
  const receipt = await tx.wait(1);
  const confirmEpochMs = Date.now();
  if (!receipt) throw new Error("receipt nulo");

  let blockTimestamp = blockTsCache.get(receipt.blockNumber) ?? null;
  if (blockTimestamp === null) {
    const block = await provider.getBlock(receipt.blockNumber);
    if (block) {
      blockTimestamp = Number(block.timestamp);
      blockTsCache.set(receipt.blockNumber, blockTimestamp);
    }
  }

  return {
    index: op.index,
    mode,
    type: op.type,
    consentId: op.consentId,
    submitNode: SUBMIT_NODE.name,
    nonce: tx.nonce,
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    blockTimestamp,
    submitEpochMs,
    confirmEpochMs,
    latencyMs: confirmEpochMs - submitEpochMs,
    gasUsed: receipt.gasUsed.toString(),
    status: receipt.status === 1 ? "success" : "reverted",
    valid: op.type === "verify" ? decodeValid(contract, receipt) : null,
    window,
    dependsOn: op.dependsOn,
    error: null,
  };
}

function errorResult(op: Operation, mode: Mode, window: number, submitEpochMs: number, e: unknown): OpResult {
  return {
    index: op.index, mode, type: op.type, consentId: op.consentId, submitNode: SUBMIT_NODE.name,
    nonce: null, txHash: null, blockNumber: null, blockTimestamp: null, submitEpochMs,
    confirmEpochMs: null, latencyMs: null, gasUsed: null, status: "error", valid: null,
    window, dependsOn: op.dependsOn, error: e instanceof Error ? e.message : String(e),
  };
}

// ---------------------------------------------------------------------------
// Modo sequencial: await do receipt antes da próxima op (nonce automático)
// ---------------------------------------------------------------------------
async function runSequential(
  ops: Operation[],
  contract: ethers.Contract,
  provider: ethers.JsonRpcProvider,
  blockTsCache: Map<number, number>,
): Promise<OpResult[]> {
  const results: OpResult[] = [];
  for (const op of ops) {
    const submitEpochMs = Date.now();
    try {
      const tx = await sendWithRetry(() => sendOp(contract, op, undefined));
      results.push(await measure(op, "sequential", 0, submitEpochMs, tx, contract, blockTsCache, provider));
    } catch (e) {
      results.push(errorResult(op, "sequential", 0, submitEpochMs, e));
    }
    if (results.length % 100 === 0) console.log(`    [sequential] ${results.length}/${ops.length}`);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Modo concorrente: janela W em voo, nonce manual, barreira de dependência
// ---------------------------------------------------------------------------
async function runConcurrent(
  ops: Operation[],
  contract: ethers.Contract,
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider,
  blockTsCache: Map<number, number>,
  window: number,
): Promise<OpResult[]> {
  const results: OpResult[] = new Array(ops.length);
  const sem = createSemaphore(window);

  // Fila de nonce manual: contador síncrono → sem lacunas, monotônico na ordem de envio.
  let nextNonce = await wallet.getNonce("pending");

  // Barreira grant→dependente: um verify/revoke só envia depois do grant confirmado.
  const confirmResolvers = new Map<number, () => void>();
  const confirmPromises = new Map<number, Promise<void>>();
  for (const op of ops) {
    if (op.type === "grant") {
      let resolve!: () => void;
      confirmPromises.set(op.index, new Promise<void>((r) => (resolve = r)));
      confirmResolvers.set(op.index, resolve);
    }
  }

  let done = 0;
  const tasks = ops.map((op) => (async () => {
    // 1) Espera a dependência confirmar — SEM ocupar slot da janela.
    if (op.dependsOn !== null) {
      const dep = confirmPromises.get(op.dependsOn);
      if (dep) await dep;
    }
    // 2) Ocupa um slot da janela de concorrência (W em voo).
    await sem.acquire();
    const submitEpochMs = Date.now();
    try {
      const nonce = nextNonce++; // atribuição síncrona: sem corrida, sem lacuna
      const tx = await sendWithRetry(() => sendOp(contract, op, nonce));
      results[op.index] = await measure(op, "concurrent", window, submitEpochMs, tx, contract, blockTsCache, provider);
    } catch (e) {
      results[op.index] = errorResult(op, "concurrent", window, submitEpochMs, e);
    } finally {
      // Libera dependentes mesmo em erro (evita deadlock da barreira).
      if (op.type === "grant") confirmResolvers.get(op.index)?.();
      sem.release();
      if (++done % 100 === 0) console.log(`    [concurrent] ${done}/${ops.length}`);
    }
  })());

  await Promise.all(tasks);
  return results;
}

// ---------------------------------------------------------------------------
// Execução de um modo (gera plano + watcher + submissão + observações)
// ---------------------------------------------------------------------------
interface ModeOutput {
  results: OpResult[];
  observations: PropObservation[];
  revokeConsentIds: string[];
  salt: string;
  mix: Record<string, number>;
}

async function runMode(
  mode: Mode,
  cfg: Config,
  address: string,
  abi: unknown[],
  wallet: ethers.Wallet,
  submitProvider: ethers.JsonRpcProvider,
  watchProviders: { name: string; endpoint: string; provider: ethers.JsonRpcProvider }[],
): Promise<ModeOutput> {
  const salt = `${cfg.prefix}${mode}`;
  const ops = generateOperations({ n: cfg.ops, seed: cfg.seed, salt });
  const mix = summarize(ops);
  console.log(`\n=== Modo ${mode} === ops=${cfg.ops} (grant=${mix.grant} verify=${mix.verify} revoke=${mix.revoke}) salt="${salt}"`);

  // Persiste o plano gerado (reprodutibilidade).
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(DATA_DIR, `${cfg.prefix}operations_${mode}.json`),
    JSON.stringify({ seed: cfg.seed, salt, ops }, null, 2),
  );

  const contract = new ethers.Contract(address, abi as ethers.InterfaceAbi, wallet);
  const revokedTopic = ethers.id("ConsentRevoked(bytes32,address,uint64)");
  const revokeConsentIds = ops.filter((o) => o.type === "revoke").map((o) => o.consentId);

  // Watcher começa ANTES da submissão, ancorado no bloco atual.
  const startBlock = await submitProvider.getBlockNumber();
  const watcher = new RevocationWatcher(
    mode, watchProviders, address, revokedTopic, new Set(revokeConsentIds), cfg.pollMs, startBlock,
  );
  watcher.start();

  const blockTsCache = new Map<number, number>();
  const results =
    mode === "sequential"
      ? await runSequential(ops, contract, submitProvider, blockTsCache)
      : await runConcurrent(ops, contract, wallet, submitProvider, blockTsCache, cfg.window);

  // Drena: aguarda até todos os revokes serem vistos nos 3 nós, ou timeout.
  const deadline = Date.now() + PROP_DRAIN_MS;
  while (!watcher.allSeen() && Date.now() < deadline) await sleep(cfg.pollMs);
  await watcher.stop();

  const observations = watcher.observations();
  const seenCount = new Set(observations.map((o) => o.consentId)).size;
  console.log(`    propagação: ${seenCount}/${revokeConsentIds.length} revokes observados em ≥1 nó`);

  return { results, observations, revokeConsentIds, salt, mix };
}

// ---------------------------------------------------------------------------
// Configuração / CLI
// ---------------------------------------------------------------------------
interface Config {
  ops: number;
  modes: Mode[];
  window: number;
  pollMs: number;
  prefix: string;
  seed: string;
  smoke: boolean;
}

function parseArgs(argv: string[]): Config {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const smoke = argv.includes("--smoke");
  const modeArg = (get("--mode") ?? "both") as "sequential" | "concurrent" | "both";
  const modes: Mode[] = modeArg === "both" ? ["sequential", "concurrent"] : [modeArg];
  return {
    ops: parseInt(get("--ops") ?? (smoke ? "30" : "1000"), 10),
    modes,
    window: parseInt(get("--window") ?? "20", 10),
    pollMs: parseInt(get("--poll-ms") ?? "35", 10),
    prefix: get("--prefix") ?? (smoke ? "smoke_" : ""),
    seed: get("--seed") ?? "encom2026",
    smoke,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const cfg = parseArgs(process.argv.slice(2));

  const dep = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
  const address: string = dep.address;
  const abi: unknown[] = dep.abi;
  const key = fs.readFileSync(NODE1_KEY, "utf8").trim();

  const submitProvider = new ethers.JsonRpcProvider(SUBMIT_NODE.endpoint, undefined, {
    staticNetwork: true,
  });
  submitProvider.pollingInterval = RECEIPT_POLL_MS; // tx.wait() resolve rápido
  const wallet = new ethers.Wallet(key, submitProvider);

  const watchProviders = ENDPOINTS.map((n) => ({
    ...n,
    provider: new ethers.JsonRpcProvider(n.endpoint, undefined, { staticNetwork: true }),
  }));

  console.log("================ benchmark ConsentRegistry ================");
  console.log(`Contrato:  ${address}`);
  console.log(`Conta:     ${wallet.address} (node1, conta única)`);
  console.log(`Config:    ops=${cfg.ops}/modo  modos=[${cfg.modes.join(", ")}]  W=${cfg.window}  poll=${cfg.pollMs}ms  prefixo="${cfg.prefix}"  seed="${cfg.seed}"`);
  console.log(cfg.smoke ? ">>> CORRIDA DE FUMAÇA (smoke_) <<<" : ">>> CORRIDA REAL <<<");

  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const startedAt = new Date().toISOString();
  const allResults: OpResult[] = [];
  const perModeProp: ModeOutput[] = [];

  for (const mode of cfg.modes) {
    const out = await runMode(mode, cfg, address, abi, wallet, submitProvider, watchProviders);
    allResults.push(...out.results);
    perModeProp.push(out);
  }
  const finishedAt = new Date().toISOString();

  // --- Exporta CSVs (com prefixo) ---
  const opsCsv = path.join(RESULTS_DIR, `${cfg.prefix}operations.csv`);
  writeOperationsCsv(opsCsv, allResults);

  const propCsv = path.join(RESULTS_DIR, `${cfg.prefix}revocation_propagation.csv`);
  const allObs = perModeProp.flatMap((p) => p.observations);
  const allRevokeIds = perModeProp.flatMap((p) => p.revokeConsentIds);
  const submitMs = new Map<string, number>();
  for (const r of allResults) {
    if (r.type === "revoke") submitMs.set(r.consentId, r.submitEpochMs);
  }
  writePropagationCsv(propCsv, allObs, allRevokeIds, ENDPOINTS, submitMs);

  // --- run_meta.json (reprodutibilidade) ---
  const meta = {
    startedAt, finishedAt,
    smoke: cfg.smoke,
    prefix: cfg.prefix,
    contract: address,
    chainId: dep.chainId,
    account: wallet.address,
    submitNode: SUBMIT_NODE,
    nodes: ENDPOINTS,
    blockPeriodSeconds: BLOCK_PERIOD_S,
    mix: { grant: 0.5, verify: 0.4, revoke: 0.1 },
    opsPerMode: cfg.ops,
    modes: cfg.modes,
    window: cfg.window,
    pollMs: cfg.pollMs,
    seed: cfg.seed,
    salts: Object.fromEntries(perModeProp.map((p, i) => [cfg.modes[i], p.salt])),
    gasLimit: GAS_LIMIT.toString(),
    receiptPollMs: RECEIPT_POLL_MS,
    propDrainMs: PROP_DRAIN_MS,
    errors: allResults.filter((r) => r.status === "error").length,
    outputs: {
      operations: path.basename(opsCsv),
      propagation: path.basename(propCsv),
    },
  };
  fs.writeFileSync(path.join(RESULTS_DIR, `${cfg.prefix}run_meta.json`), JSON.stringify(meta, null, 2));

  console.log("\n================ concluído ================");
  console.log(`  ${opsCsv}  (${allResults.length} linhas)`);
  console.log(`  ${propCsv}  (${allObs.length} observações)`);
  console.log(`  ${path.join(RESULTS_DIR, `${cfg.prefix}run_meta.json`)}`);
  if (meta.errors > 0) console.log(`  ⚠ ${meta.errors} operações com erro (ver coluna 'error')`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
