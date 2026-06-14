#!/usr/bin/env python3
"""Geração de entregáveis do artigo a partir dos CSVs crus do benchmark.

Produz, para o prefixo dado (real = sem prefixo; fumaça = "smoke_"):
  1. results/<prefix>table_results.tex  — tabela LaTeX (booktabs, \\resizebox)
     pronta para coluna dupla IEEE: linhas = modo × tipo; colunas = n, latência
     média [IC 95%], p95 [IC 95%], gás.
  2. results/<prefix>fig1_latency.{pdf,png}  — distribuição de latência por
     tipo e modo (boxplot), legível em coluna de 3.5in.
  3. results/<prefix>fig2_propagation.{pdf,png} — propagação da revogação
     (delta_ms_vs_first_node por nó).
  4. results/<prefix>captions.tex — legendas sugeridas (PT-BR) das três peças.

Reaproveita as funções de estatística de analyze.py (mesmo IC BCa, com fallback
percentil) — fonte única de verdade. matplotlib puro (sem seaborn).

Uso:
  python report.py                 # dados reais
  python report.py --prefix smoke_ # dados de fumaça
"""
from __future__ import annotations

import argparse
import os

import matplotlib

matplotlib.use("Agg")  # backend headless
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
import pandas as pd

from analyze import OP_TYPES, RESULTS_DIR, analyze_latency

MODES = ["sequential", "concurrent"]
MODE_LABEL = {"sequential": "Sequencial", "concurrent": "Concorrente"}
TYPE_LABEL = {"grant": "grant", "verify": "verify", "revoke": "revoke"}
COLORS = {"sequential": "#4C72B0", "concurrent": "#DD8452"}

# Estilo enxuto para coluna IEEE de 3.5in.
plt.rcParams.update({
    "font.size": 8,
    "axes.labelsize": 8,
    "axes.titlesize": 8,
    "xtick.labelsize": 7.5,
    "ytick.labelsize": 7.5,
    "legend.fontsize": 7,
    "figure.dpi": 300,
    "pdf.fonttype": 42,  # TrueType embarcada (compatível IEEE)
    "ps.fonttype": 42,
})
FIGSIZE = (3.5, 2.4)


def _ci(ci: list) -> str:
    lo, hi = ci
    if lo is None or hi is None:
        return "--"
    return f"[{lo:.0f},\\,{hi:.0f}]"


def build_table(df: pd.DataFrame, latency: dict, prefix: str) -> str:
    gas_med = df[df["status"] == "success"].groupby(["mode", "type"])["gas_used"].median()
    rows = []
    for mode in MODES:
        if mode not in latency:
            continue
        for i, t in enumerate(OP_TYPES):
            e = latency[mode].get(t)
            if not e:
                continue
            mode_cell = f"\\multirow{{3}}{{*}}{{{MODE_LABEL[mode]}}}" if i == 0 else ""
            gas = int(gas_med.get((mode, t), float("nan")))
            rows.append(
                f"{mode_cell} & {TYPE_LABEL[t]} & {e['n']} & "
                f"{e['mean_ms']:.0f}~{_ci(e['mean_ci95'])} & "
                f"{e['p95_ms']:.0f}~{_ci(e['p95_ci95'])} & {gas} \\\\"
            )
        rows.append("\\midrule")
    if rows and rows[-1] == "\\midrule":
        rows[-1] = "\\bottomrule"

    body = "\n".join(rows)
    tex = rf"""% Gerado por benchmark/report.py — tabela de resultados (prefixo: {prefix or 'real'})
% Requer: \usepackage{{booktabs}}, \usepackage{{multirow}}, \usepackage{{graphicx}}
\begin{{table}}[t]
  \centering
  \caption{{Latência (média e $p_{{95}}$, em ms) com intervalo de confiança de
  95\% por bootstrap BCa (10.000 reamostragens; queda para percentil quando o
  BCa degenera por empates no teto de bloco) e gás por operação. 1.000 operações
  por modo de submissão (mistura 50\% grant / 40\% verify / 10\% revoke) no
  \textsc{{ConsentRegistry}} sobre Hyperledger Besu/QBFT (N{{=}}4, blockperiod
  2\,s, gasPrice 0).}}
  \label{{tab:resultados}}
  \resizebox{{\columnwidth}}{{!}}{{%
  \begin{{tabular}}{{llrrrr}}
    \toprule
    Modo & Op. & $n$ & Latência média (ms) [IC 95\%] & $p_{{95}}$ (ms) [IC 95\%] & Gás \\
    \midrule
{body}
  \end{{tabular}}%
  }}
\end{{table}}
"""
    return tex


def _grouped_boxplot(ax, data_by_group, group_labels, ylabel):
    """data_by_group: dict[mode] -> list (um array por grupo no eixo x)."""
    n_groups = len(group_labels)
    width = 0.36
    offsets = {"sequential": -width / 2 - 0.02, "concurrent": width / 2 + 0.02}
    for mode in MODES:
        if mode not in data_by_group:
            continue
        positions = [g + offsets[mode] for g in range(n_groups)]
        bp = ax.boxplot(
            data_by_group[mode],
            positions=positions,
            widths=width,
            patch_artist=True,
            showfliers=True,
            flierprops=dict(marker=".", markersize=2, alpha=0.3,
                            markerfacecolor=COLORS[mode], markeredgecolor="none"),
            medianprops=dict(color="black", linewidth=1.0),
            whiskerprops=dict(linewidth=0.7),
            capprops=dict(linewidth=0.7),
            boxprops=dict(linewidth=0.7),
        )
        for box in bp["boxes"]:
            box.set_facecolor(COLORS[mode])
            box.set_alpha(0.75)
    ax.set_xticks(range(n_groups))
    ax.set_xticklabels(group_labels)
    ax.set_ylabel(ylabel)
    ax.grid(axis="y", linestyle=":", linewidth=0.5, alpha=0.6)
    # Legenda acima dos eixos: nunca sobrepõe as caixas/outliers.
    ax.legend(handles=[Patch(facecolor=COLORS[m], alpha=0.75, label=MODE_LABEL[m]) for m in MODES],
              loc="lower center", bbox_to_anchor=(0.5, 1.0), ncol=2, frameon=False,
              handlelength=1.2, borderaxespad=0.2, columnspacing=1.5)


def fig_latency(df: pd.DataFrame, prefix: str) -> None:
    ok = df[df["status"] == "success"]
    data = {m: [ok[(ok["mode"] == m) & (ok["type"] == t)]["latency_ms"].to_numpy(float)
                for t in OP_TYPES] for m in MODES if m in ok["mode"].unique()}
    fig, ax = plt.subplots(figsize=FIGSIZE)
    _grouped_boxplot(ax, data, [TYPE_LABEL[t] for t in OP_TYPES], "Latência de confirmação (ms)")
    ax.set_xlabel("Tipo de operação")
    fig.tight_layout(pad=0.4)
    for ext in ("pdf", "png"):
        fig.savefig(os.path.join(RESULTS_DIR, f"{prefix}fig1_latency.{ext}"), bbox_inches="tight")
    plt.close(fig)


def fig_propagation(prop: pd.DataFrame, prefix: str) -> None:
    nodes = sorted(prop["node"].unique())
    data = {m: [prop[(prop["mode"] == m) & (prop["node"] == n)]["delta_ms_vs_first_node"].dropna().to_numpy(float)
                for n in nodes] for m in MODES if m in prop["mode"].unique()}
    fig, ax = plt.subplots(figsize=FIGSIZE)
    _grouped_boxplot(ax, data, nodes, "Atraso vs. 1º nó (ms)")
    ax.set_xlabel("Nó validador")
    fig.tight_layout(pad=0.4)
    for ext in ("pdf", "png"):
        fig.savefig(os.path.join(RESULTS_DIR, f"{prefix}fig2_propagation.{ext}"), bbox_inches="tight")
    plt.close(fig)


CAPTIONS = r"""% Legendas sugeridas (PT-BR) — geradas por benchmark/report.py

% --- Tabela ---
% Ver \caption em table_results.tex (Tabela~\ref{tab:resultados}).

% --- Figura 1 (fig1_latency) ---
\caption{Distribuição da latência de confirmação (intervalo submissão$\rightarrow$recibo)
por tipo de operação e modo de submissão, em 1.000 operações por modo. A latência
concentra-se próxima ao teto do período de bloco (2\,s), refletindo a geometria de
inclusão do consenso QBFT e não o custo de execução; o gás (Tabela~\ref{tab:resultados}),
e não a latência, é o sinal determinístico por operação.}
\label{fig:latencia}

% --- Figura 2 (fig2_propagation) ---
\caption{Propagação da revogação entre os quatro nós validadores: atraso de observação
de cada nó em relação ao primeiro a expor o evento \texttt{ConsentRevoked}
($\Delta$ vs.\ 1º nó), medido por \emph{polling} HTTP ($\sim$35\,ms). Em QBFT os quatro
nós confirmam o mesmo bloco; o atraso medido é de importação/observação via RPC --- não
de propagação do dado, pois apenas a prova (hash) trafega, nunca o dado pessoal.}
\label{fig:propagacao}
"""


def main() -> None:
    ap = argparse.ArgumentParser(description="Gera tabela LaTeX e figuras do benchmark")
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

    latency = analyze_latency(df)  # mesmo BCa (+ fallback) de analyze.py

    tex = build_table(df, latency, prefix)
    table_path = os.path.join(RESULTS_DIR, f"{prefix}table_results.tex")
    with open(table_path, "w") as f:
        f.write(tex)

    fig_latency(df, prefix)
    fig_propagation(prop, prefix)

    cap_path = os.path.join(RESULTS_DIR, f"{prefix}captions.tex")
    with open(cap_path, "w") as f:
        f.write(CAPTIONS)

    print(f"Entregáveis gerados (prefixo: {prefix or 'real'}):")
    print(f"  → {table_path}")
    print(f"  → {os.path.join(RESULTS_DIR, f'{prefix}fig1_latency.pdf')}  (+ .png)")
    print(f"  → {os.path.join(RESULTS_DIR, f'{prefix}fig2_propagation.pdf')}  (+ .png)")
    print(f"  → {cap_path}")
    print("\n--- prévia da tabela ---\n")
    print(tex)


if __name__ == "__main__":
    main()
