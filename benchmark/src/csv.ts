// Escrita de CSV cru — SEM agregação. Média/p95 com IC BCa bootstrap (scipy)
// ficam para a análise em Python, sobre estes mesmos arquivos.

import * as fs from "fs";
import { OpResult, PropObservation } from "./types";

function esc(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeRows(filePath: string, header: string[], rows: unknown[][]): void {
  const lines = [header.join(",")];
  for (const row of rows) lines.push(row.map(esc).join(","));
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
}

/** operations.csv — uma linha por operação executada. */
export function writeOperationsCsv(filePath: string, results: OpResult[]): void {
  const header = [
    "op_index", "mode", "type", "consent_id", "submit_node", "nonce", "tx_hash",
    "block_number", "block_timestamp", "submit_epoch_ms", "confirm_epoch_ms",
    "latency_ms", "gas_used", "status", "valid", "window", "depends_on", "error",
  ];
  const rows = results.map((r) => [
    r.index, r.mode, r.type, r.consentId, r.submitNode, r.nonce, r.txHash,
    r.blockNumber, r.blockTimestamp, r.submitEpochMs, r.confirmEpochMs,
    r.latencyMs, r.gasUsed, r.status, r.valid, r.window, r.dependsOn, r.error,
  ]);
  writeRows(filePath, header, rows);
}

/**
 * revocation_propagation.csv — formato longo, uma linha por (revoke × nó observador).
 *
 * `submitMs` mapeia consentId -> instante de submissão do revoke (para delta vs submit).
 * Nós sem observação saem com first_seen vazio (gap explícito p/ a análise, sem inventar dado).
 * delta_ms_* são transformações por linha (não agregação) incluídas por conveniência.
 */
export function writePropagationCsv(
  filePath: string,
  observations: PropObservation[],
  revokeConsentIds: string[],
  nodes: { name: string; endpoint: string }[],
  submitMs: Map<string, number>,
): void {
  const header = [
    "mode", "consent_id", "node", "endpoint", "revoke_submit_epoch_ms",
    "first_seen_epoch_ms", "block_number", "delta_ms_vs_submit", "delta_ms_vs_first_node",
  ];

  // Index: (consentId, node) -> observação.
  const byKey = new Map<string, PropObservation>();
  const mode = observations[0]?.mode ?? "";
  for (const o of observations) byKey.set(`${o.consentId}|${o.node}`, o);

  const rows: unknown[][] = [];
  for (const cid of revokeConsentIds) {
    // Menor first_seen entre os nós para este revoke (instante de "primeira chegada").
    let firstNodeMs: number | null = null;
    for (const n of nodes) {
      const o = byKey.get(`${cid}|${n.name}`);
      if (o && (firstNodeMs === null || o.firstSeenEpochMs < firstNodeMs)) firstNodeMs = o.firstSeenEpochMs;
    }
    const sub = submitMs.get(cid) ?? null;
    for (const n of nodes) {
      const o = byKey.get(`${cid}|${n.name}`);
      const seen = o ? o.firstSeenEpochMs : null;
      rows.push([
        o?.mode ?? mode, cid, n.name, n.endpoint, sub,
        seen, o?.blockNumber ?? null,
        seen !== null && sub !== null ? seen - sub : null,
        seen !== null && firstNodeMs !== null ? seen - firstNodeMs : null,
      ]);
    }
  }
  writeRows(filePath, header, rows);
}
