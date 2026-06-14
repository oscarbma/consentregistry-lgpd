// Gerador determinístico das operações sintéticas.
//
// Mistura do experimento: 50% grant / 40% verify / 10% revoke.
// Determinismo (reprodutibilidade do artigo): toda aleatoriedade vem de um DRBG
// semeado por (seed | salt) — SHA-256 em modo contador. Sem Math.random nem
// crypto.randomBytes (não semeáveis). O mesmo (seed, salt) reproduz o mesmo plano.
//
// O `salt` distingue as duas corridas (sequential/concurrent) e fumaça/real, de
// modo que os consentIds NÃO colidam na mesma cadeia persistente (um segundo
// grant do mesmo id reverteria com ConsentAlreadyExists).

import { createHash } from "crypto";
import { Operation, OpType } from "./types";

/** DRBG determinístico: bloco_i = SHA-256(key || counter_i), key = SHA-256(seed). */
export class Drbg {
  private key: Buffer;
  private counter = 0;

  constructor(seedMaterial: string) {
    this.key = createHash("sha256").update(seedMaterial).digest();
  }

  private block(): Buffer {
    const h = createHash("sha256").update(this.key);
    const c = Buffer.alloc(8);
    c.writeBigUInt64BE(BigInt(this.counter++));
    return h.update(c).digest(); // 32 bytes
  }

  /** Hash opaco de 32 bytes, 0x-prefixado. Praticamente nunca zero/colidente. */
  nextBytes32Hex(): string {
    return "0x" + this.block().toString("hex");
  }

  private nextU32(): number {
    return this.block().readUInt32BE(0);
  }

  /** Inteiro uniforme em [0, n). */
  nextInt(n: number): number {
    return Math.floor((this.nextU32() / 0x100000000) * n);
  }
}

export interface GenerateOptions {
  n: number;
  seed: string;
  salt: string;
}

/**
 * Constrói o plano de `n` operações respeitando a dependência grant→{verify,revoke}.
 *
 * A cada passo só é emitido um tipo LEGAL no estado atual:
 *   - grant: sempre legal;
 *   - verify: exige pelo menos um consentId já concedido (pode mirar um já revogado
 *             → exercita valid=false, que por decisão de projeto NÃO reverte);
 *   - revoke: exige um consentId ainda ativo (Granted), consumido ao revogar.
 * A 1ª operação é necessariamente grant (pools vazios). Como há 5x mais grants que
 * revokes, os pools nunca secam e o algoritmo nunca trava.
 */
export function generateOperations(opts: GenerateOptions): Operation[] {
  const { n, seed, salt } = opts;
  const drbg = new Drbg(`${seed}|${salt}`);

  const grantCount = Math.round(n * 0.5);
  const verifyCount = Math.round(n * 0.4);
  const revokeCount = n - grantCount - verifyCount; // garante soma exata = n
  const remaining: Record<OpType, number> = {
    grant: grantCount,
    verify: verifyCount,
    revoke: revokeCount,
  };

  // Pool para verify (qualquer id já concedido) e pool de revogáveis (ainda ativos).
  const grantedPool: { consentId: string; grantIndex: number }[] = [];
  const revocablePool: { consentId: string; grantIndex: number }[] = [];

  const ops: Operation[] = [];
  for (let i = 0; i < n; i++) {
    const legal: OpType[] = [];
    if (remaining.grant > 0) legal.push("grant");
    if (remaining.verify > 0 && grantedPool.length > 0) legal.push("verify");
    if (remaining.revoke > 0 && revocablePool.length > 0) legal.push("revoke");

    // Escolha ponderada pela quantidade restante de cada tipo → mistura espalhada.
    const weights = legal.map((t) => remaining[t]);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = drbg.nextInt(total);
    let chosen: OpType = legal[0];
    for (let k = 0; k < legal.length; k++) {
      if (r < weights[k]) {
        chosen = legal[k];
        break;
      }
      r -= weights[k];
    }

    if (chosen === "grant") {
      const consentId = drbg.nextBytes32Hex();
      const receiptHash = drbg.nextBytes32Hex(); // != 0 (contrato rejeita zero)
      const proofHash = drbg.nextBytes32Hex();
      ops.push({ index: i, type: "grant", consentId, receiptHash, proofHash, dependsOn: null });
      grantedPool.push({ consentId, grantIndex: i });
      revocablePool.push({ consentId, grantIndex: i });
      remaining.grant--;
    } else if (chosen === "verify") {
      const g = grantedPool[drbg.nextInt(grantedPool.length)];
      ops.push({ index: i, type: "verify", consentId: g.consentId, dependsOn: g.grantIndex });
      remaining.verify--;
    } else {
      const pick = drbg.nextInt(revocablePool.length);
      const g = revocablePool[pick];
      revocablePool.splice(pick, 1); // cada id revoga só uma vez
      ops.push({ index: i, type: "revoke", consentId: g.consentId, dependsOn: g.grantIndex });
      remaining.revoke--;
    }
  }

  return ops;
}

/** Contagem por tipo, para inspeção/validação rápida. */
export function summarize(ops: Operation[]): Record<OpType, number> {
  const s: Record<OpType, number> = { grant: 0, verify: 0, revoke: 0 };
  for (const op of ops) s[op.type]++;
  return s;
}

// --- CLI de inspeção (não toca a rede): tsx src/generate.ts --ops 30 --salt foo ---
if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const n = parseInt(get("--ops", "30"), 10);
  const seed = get("--seed", "encom2026");
  const salt = get("--salt", "preview");
  const ops = generateOperations({ n, seed, salt });
  const s = summarize(ops);
  console.log(`Plano: ${n} ops  (seed="${seed}" salt="${salt}")`);
  console.log(`Mistura: grant=${s.grant} verify=${s.verify} revoke=${s.revoke}`);
  console.log(`Primeira op: ${ops[0].type} (deve ser grant)`);
  console.log("\nPrimeiras 8 operações:");
  for (const op of ops.slice(0, 8)) {
    const dep = op.dependsOn === null ? "" : `  <- grant#${op.dependsOn}`;
    console.log(`  #${op.index} ${op.type.padEnd(6)} ${op.consentId.slice(0, 14)}…${dep}`);
  }
}
