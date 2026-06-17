#!/usr/bin/env python3
"""Análise estatística do benchmark do ConsentRegistry (Besu/QBFT).

Lê os CSVs crus exportados pelo runner (sem agregação) e produz:
  - Latência (latency_ms) por modo e por tipo de operação: média e p95 com
    IC 95% via BCa bootstrap (scipy.stats.bootstrap, method='BCa',
    n_resamples=10000).
  - Gás por tipo: valor único para verify/revoke; faixa + nota EIP-2028
    (variação por bytes-zero no calldata) para grant.
  - Propagação de revogação: distribuição de delta_ms_vs_first_node por nó
    (skew de observação entre os 4 nós) e delta_ms_vs_submit (inclusão).

Saída: tabela formatada para o artigo + results/<prefix>summary.json.

Uso:
  python analyze.py                 # dados reais (operations.csv, ...)
  python analyze.py --prefix smoke_ # dados de fumaça (smoke_operations.csv, ...)
"""
from __future__ import annotations

import argparse
import json
import os
import warnings
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from scipy.stats import bootstrap

RESULTS_DIR = os.path.join(os.path.dirname(__file__), "..", "results")
OP_TYPES = ["grant", "verify", "revoke"]
N_RESAMPLES = 10_000
CONF = 0.95
SEED = 12345  # CIs reprodutíveis


def _p95(x, axis):
    return np.percentile(x, 95, axis=axis)


def _bca_ci(values: np.ndarray, statistic) -> tuple[float | None, float | None, str | None]:
    """IC 95% por bootstrap. BCa é o método primário; se ele degenerar por empates
    (p.ex. p95 fixado no teto do bloco → aceleração jackknife ~0), cai para bootstrap
    percentil, sinalizando na nota. Retorna (lo, hi, nota)."""
    n = len(values)
    if n < 2:
        return None, None, "n<2"
    if np.allclose(values, values[0]):
        return float(values[0]), float(values[0]), "amostra constante"
    base_note = f"n={n} pequeno (IC frágil)" if n < 8 else None

    last: Exception | None = None
    for method in ("BCa", "percentile"):
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error")  # DegenerateDataWarning/RuntimeWarning -> erro
                res = bootstrap(
                    (values,),
                    statistic,
                    n_resamples=N_RESAMPLES,
                    method=method,
                    confidence_level=CONF,
                    vectorized=True,
                    random_state=SEED,
                )
            lo, hi = float(res.confidence_interval.low), float(res.confidence_interval.high)
            if method == "percentile":
                fb = "percentil (BCa degenerou: dados empatados)"
                return lo, hi, f"{base_note}; {fb}" if base_note else fb
            return lo, hi, base_note
        except Exception as e:  # tenta o próximo método
            last = e
    return None, None, f"bootstrap indisponível ({type(last).__name__ if last else 'desconhecido'})"


def analyze_latency(df: pd.DataFrame) -> dict:
    ok = df[df["status"] == "success"]
    out: dict = {}
    for mode in sorted(ok["mode"].unique()):
        out[mode] = {}
        for t in OP_TYPES:
            vals = ok[(ok["mode"] == mode) & (ok["type"] == t)]["latency_ms"].dropna().to_numpy(float)
            if len(vals) == 0:
                continue
            mean = float(np.mean(vals))
            p95 = float(_p95(vals, axis=0))
            m_lo, m_hi, m_note = _bca_ci(vals, np.mean)
            p_lo, p_hi, p_note = _bca_ci(vals, _p95)
            out[mode][t] = {
                "n": int(len(vals)),
                "mean_ms": mean,
                "mean_ci95": [m_lo, m_hi],
                "mean_ci_note": m_note,
                "p95_ms": p95,
                "p95_ci95": [p_lo, p_hi],
                "p95_ci_note": p_note,
            }
    return out


def analyze_gas(df: pd.DataFrame) -> dict:
    ok = df[df["status"] == "success"]
    out: dict = {}
    for t in OP_TYPES:
        vals = ok[ok["type"] == t]["gas_used"].dropna().astype("int64").to_numpy()
        if len(vals) == 0:
            continue
        distinct = sorted(set(int(v) for v in vals))
        entry = {
            "n": int(len(vals)),
            "min": int(vals.min()),
            "max": int(vals.max()),
            "distinct_count": len(distinct),
        }
        if len(distinct) == 1:
            entry["value"] = distinct[0]
            entry["note"] = "valor único"
        else:
            entry["distinct"] = distinct
            spread = int(vals.max() - vals.min())
            entry["note"] = (
                f"faixa de {spread} gas: variação EIP-2028 (bytes-zero no calldata "
                f"custam 4 vs 16); hashes aleatórios com algum 0x00 reduzem o gás"
            )
        out[t] = entry
    return out


def _dist(vals: np.ndarray) -> dict:
    return {
        "n": int(len(vals)),
        "median_ms": float(np.median(vals)),
        "mean_ms": float(np.mean(vals)),
        "p95_ms": float(_p95(vals, axis=0)),
        "max_ms": float(np.max(vals)),
    }


def analyze_propagation(prop: pd.DataFrame) -> dict:
    out: dict = {"vs_first_node": {}, "vs_submit": {}, "coverage": {}}
    for mode in sorted(prop["mode"].unique()):
        sub = prop[prop["mode"] == mode]
        # Skew de observação entre nós (delta vs primeiro nó a enxergar o evento).
        out["vs_first_node"][mode] = {}
        for node in sorted(sub["node"].unique()):
            vals = sub[sub["node"] == node]["delta_ms_vs_first_node"].dropna().to_numpy(float)
            if len(vals):
                out["vs_first_node"][mode][node] = _dist(vals)
        # Inclusão: tempo da submissão do revoke até ser observado (qualquer nó).
        vs = sub["delta_ms_vs_submit"].dropna().to_numpy(float)
        if len(vs):
            out["vs_submit"][mode] = _dist(vs)
        # Cobertura: quantos (revoke×nó) foram efetivamente observados.
        total = len(sub)
        seen = int(sub["first_seen_epoch_ms"].notna().sum())
        out["coverage"][mode] = {"observed": seen, "expected": total}
    return out


def _fmt_ci(ci: list, note: str | None) -> str:
    lo, hi = ci
    if lo is None or hi is None:
        return f"[—]{' '+note if note else ''}"
    base = f"[{lo:.1f}, {hi:.1f}]"
    return base + (f" ⚠{note}" if note else "")


def print_tables(latency: dict, gas: dict, prop: dict, prefix: str) -> None:
    tag = prefix if prefix else "(dados reais)"
    print(f"\n{'='*78}\n  RESULTADOS DO BENCHMARK — {tag}\n{'='*78}")

    print("\n● Latência (ms) por modo e tipo — IC 95% BCa, 10.000 reamostragens\n")
    hdr = f"  {'modo':<11} {'tipo':<7} {'n':>4}  {'média':>8}  {'IC95 média':<22}  {'p95':>8}  {'IC95 p95':<22}"
    print(hdr)
    print("  " + "-" * (len(hdr) - 2))
    for mode in latency:
        for t in OP_TYPES:
            e = latency[mode].get(t)
            if not e:
                continue
            print(
                f"  {mode:<11} {t:<7} {e['n']:>4}  {e['mean_ms']:>8.1f}  "
                f"{_fmt_ci(e['mean_ci95'], e['mean_ci_note']):<22}  {e['p95_ms']:>8.1f}  "
                f"{_fmt_ci(e['p95_ci95'], e['p95_ci_note']):<22}"
            )

    print("\n● Gás por tipo de operação\n")
    print(f"  {'tipo':<7} {'n':>4}  {'gás':<14}  nota")
    print("  " + "-" * 70)
    for t in OP_TYPES:
        e = gas.get(t)
        if not e:
            continue
        val = str(e["value"]) if "value" in e else f"{e['min']}–{e['max']}"
        print(f"  {t:<7} {e['n']:>4}  {val:<14}  {e['note']}")

    print("\n● Propagação de revogação entre os 4 nós\n")
    print("  Skew vs. primeiro nó a observar (delta_ms_vs_first_node):")
    print(f"  {'modo':<11} {'nó':<7} {'n':>4}  {'mediana':>8}  {'média':>8}  {'p95':>8}  {'máx':>8}")
    print("  " + "-" * 60)
    for mode in prop["vs_first_node"]:
        for node, d in prop["vs_first_node"][mode].items():
            print(f"  {mode:<11} {node:<7} {d['n']:>4}  {d['median_ms']:>8.1f}  {d['mean_ms']:>8.1f}  {d['p95_ms']:>8.1f}  {d['max_ms']:>8.1f}")
    print("\n  Inclusão vs. submissão do revoke (delta_ms_vs_submit):")
    print(f"  {'modo':<11} {'n':>4}  {'mediana':>8}  {'média':>8}  {'p95':>8}  {'máx':>8}")
    print("  " + "-" * 55)
    for mode, d in prop["vs_submit"].items():
        print(f"  {mode:<11} {d['n']:>4}  {d['median_ms']:>8.1f}  {d['mean_ms']:>8.1f}  {d['p95_ms']:>8.1f}  {d['max_ms']:>8.1f}")
    print("\n  Cobertura (revoke×nó observados):")
    for mode, c in prop["coverage"].items():
        print(f"    {mode:<11} {c['observed']}/{c['expected']}")
    print()


def main() -> None:
    ap = argparse.ArgumentParser(description="Análise BCa do benchmark ConsentRegistry")
    ap.add_argument("--prefix", default="", help='Prefixo dos arquivos (ex.: "smoke_")')
    args = ap.parse_args()
    prefix = args.prefix

    ops_path = os.path.join(RESULTS_DIR, f"{prefix}operations.csv")
    prop_path = os.path.join(RESULTS_DIR, f"{prefix}revocation_propagation.csv")
    for p in (ops_path, prop_path):
        if not os.path.exists(p):
            raise SystemExit(f"arquivo não encontrado: {p}")

    df = pd.read_csv(ops_path)
    prop = pd.read_csv(prop_path)

    latency = analyze_latency(df)
    gas = analyze_gas(df)
    propagation = analyze_propagation(prop)

    print_tables(latency, gas, propagation, prefix)

    summary = {
        "prefix": prefix or None,
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "bootstrap": {"method": "BCa", "n_resamples": N_RESAMPLES, "confidence_level": CONF, "seed": SEED},
        "n_operations": int(len(df)),
        "n_errors": int((df["status"] == "error").sum()),
        "latency": latency,
        "gas": gas,
        "propagation": propagation,
    }
    out_path = os.path.join(RESULTS_DIR, f"{prefix}summary.json")
    with open(out_path, "w") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    print(f"→ {out_path}")


if __name__ == "__main__":
    main()
