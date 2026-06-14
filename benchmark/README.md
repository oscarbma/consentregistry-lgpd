# benchmark/ — medição do ConsentRegistry na rede Besu/QBFT

Gera operações sintéticas, submete-as ao `ConsentRegistry` deployado, mede
latência e gás por operação e o tempo de propagação de revogação entre os 4 nós.
Exporta **CSV cru** para `../results/` (a análise estatística — média e p95 com
IC BCa bootstrap, 10.000 reamostragens, scipy — é feita depois, em Python).

## Pré-requisitos

- Rede Besu no ar (4 nós: `8545`/`8546`/`8547`/`8548`) e contrato vivo em
  `../contracts/deployments/besu.json` (validar com `check.ts`).
- `npm install` neste diretório.

## Uso

```bash
# Corrida de FUMAÇA (valida o pipeline completo em ~1 min, escreve smoke_*):
npm run smoke                 # = --ops 30 --prefix smoke_ , modos sequential+concurrent

# Corrida REAL (1.000 ops por modo; a sequencial leva ~33+ min):
npm run bench                 # = --ops 1000 , modos sequential+concurrent

# Inspeção offline do plano gerado (não toca a rede):
npm run generate -- --ops 30 --salt preview
```

### Flags (`src/run.ts`)

| Flag | Padrão | Descrição |
|------|--------|-----------|
| `--ops N` | 1000 (30 em `--smoke`) | operações por modo (= por dataset) |
| `--mode` | `both` | `sequential` \| `concurrent` \| `both` |
| `--window N` | 20 | janela de txs em voo (modo concorrente) |
| `--poll-ms N` | 35 | intervalo do polling de propagação |
| `--prefix s` | `""` (`smoke_` em `--smoke`) | prefixo dos arquivos em `results/` |
| `--seed s` | `encom2026` | semente do gerador determinístico |
| `--smoke` | — | atalho: `--ops 30 --prefix smoke_` |

## Saídas (em `../results/`)

- `<prefix>operations.csv` — uma linha por operação: tipo, nonce, bloco,
  timestamps de submissão/confirmação, `latency_ms`, `gas_used`, `valid` (verify),
  `mode`, `window`. **Sem agregação.**
- `<prefix>revocation_propagation.csv` — formato longo, uma linha por
  (revoke × nó): `first_seen_epoch_ms`, `block_number`, deltas vs submissão e vs
  primeiro nó.
- `<prefix>run_meta.json` — endereço, chainId, mistura, sementes/salts por modo,
  janela, intervalo de poll, contagem de erros — reprodutibilidade.

## Notas de medição

- **Conta única** (node1): a fila de nonce é um contador monotônico sem lacunas.
- **Duas corridas** (sequential/concurrent) usam **salts distintos** → consentIds
  diferentes, sem colisão na cadeia persistente.
- Com `blockperiod=2s` e `gasPrice=0`, a latência é dominada pela geometria do
  bloco; o **gás** é o sinal determinístico por tipo de operação.
- Sem WebSocket exposto, a propagação é medida por **polling HTTP** (~35 ms):
  resolução de ±~`poll-ms`.
