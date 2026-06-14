import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Normaliza uma chave privada para o formato 0x-prefixado esperado pelo Hardhat.
 */
function normalizeKey(raw: string): string {
  const k = raw.trim();
  return k.startsWith("0x") ? k : `0x${k}`;
}

/**
 * Carrega as chaves privadas dos validadores em runtime.
 *
 * Ordem de precedência:
 *   1. BESU_PRIVATE_KEYS (lista separada por vírgula) — sobrescrita explícita.
 *   2. Arquivos de chave dos nós em ../network/nodes/node{1,2,3}/data/key.
 *
 * As chaves NUNCA são embutidas no código-fonte. São chaves de teste da rede
 * permissionada local; ainda assim são lidas do disco a cada execução.
 */
function loadValidatorKeys(): string[] {
  const fromEnv = process.env.BESU_PRIVATE_KEYS;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0)
      .map(normalizeKey);
  }

  const nodesDir = path.resolve(__dirname, "..", "network", "nodes");
  const keys: string[] = [];
  for (const node of ["node1", "node2", "node3"]) {
    const keyPath = path.join(nodesDir, node, "data", "key");
    if (fs.existsSync(keyPath)) {
      keys.push(normalizeKey(fs.readFileSync(keyPath, "utf8")));
    }
  }
  return keys;
}

const accounts = loadValidatorKeys();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      // Travado em "berlin": o genesis da rede declara apenas berlinBlock=0.
      // O default do compilador (shanghai) emitiria PUSH0, opcode que o EVM
      // em berlin não executa — o que invalidaria o bytecode no Besu.
      evmVersion: "berlin",
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    besu: {
      url: process.env.BESU_RPC_URL || "http://localhost:8545",
      chainId: 2026,
      gasPrice: 0, // nós sobem com --min-gas-price=0
      accounts,
    },
  },
};

export default config;
