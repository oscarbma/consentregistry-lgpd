// Tipos compartilhados pela camada de benchmark.
//
// INVARIANTE: nenhum dado pessoal aparece aqui. `consentId`, `receiptHash` e
// `proofHash` são âncoras opacas de 32 bytes (hashes), coerentes com a regra de
// que só hashes/provas vão on-chain. O conteúdo (recibo ISO/IEC TS 27560, VC/DID)
// é off-chain e não é tocado por este código.

export type OpType = "grant" | "verify" | "revoke";

export type Mode = "sequential" | "concurrent";

/** Uma operação sintética do plano (gerada de forma determinística). */
export interface Operation {
  index: number;
  type: OpType;
  /** Identificador opaco (32 bytes). Nunca um dado pessoal. */
  consentId: string;
  /** Apenas em grant: hash do recibo ISO/IEC TS 27560 (off-chain). */
  receiptHash?: string;
  /** Apenas em grant: hash da Verifiable Credential W3C / prova (off-chain). */
  proofHash?: string;
  /**
   * Índice da operação de grant que registrou este consentId. Para verify/revoke
   * é a dependência (happens-before) que o modo concorrente precisa respeitar:
   * só submeter o dependente após o grant referenciado estar CONFIRMADO. null em grant.
   */
  dependsOn: number | null;
}

/** Medição bruta de uma operação executada. Uma linha em operations.csv. */
export interface OpResult {
  index: number;
  mode: Mode;
  type: OpType;
  consentId: string;
  submitNode: string;
  nonce: number | null;
  txHash: string | null;
  blockNumber: number | null;
  blockTimestamp: number | null;
  submitEpochMs: number;
  confirmEpochMs: number | null;
  latencyMs: number | null;
  gasUsed: string | null;
  /** "success" | "reverted" | "error" */
  status: string;
  /** Apenas verify: valor de `valid` lido do evento ConsentVerified; null caso contrário. */
  valid: boolean | null;
  /** Janela de concorrência configurada (0 em sequencial). */
  window: number;
  dependsOn: number | null;
  error: string | null;
}

/** Primeira observação de um ConsentRevoked num nó. Linha em revocation_propagation.csv. */
export interface PropObservation {
  mode: Mode;
  consentId: string;
  node: string;
  endpoint: string;
  firstSeenEpochMs: number;
  blockNumber: number;
}
