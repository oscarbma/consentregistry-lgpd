# Rede Besu QBFT — 4 nós validadores

Rede Hyperledger Besu permissionada usada como camada de registro para o laboratório de **consentimento verificável** (ENCOM 2026). A blockchain guarda apenas hashes, provas e recibos de consentimento — **nunca dados pessoais**.

## Topologia

| Nó | Container | IP (bridge) | RPC HTTP no host | Papel |
|---|---|---|---|---|
| node1 | `besu-node1` | 172.16.239.11 | 8545 | validador + bootnode |
| node2 | `besu-node2` | 172.16.239.12 | 8546 | validador |
| node3 | `besu-node3` | 172.16.239.13 | 8547 | validador |
| node4 | `besu-node4` | 172.16.239.14 | 8548 | validador |

- **Consenso:** QBFT, `blockperiodseconds = 2`.
- **chainId / network-id:** `2026`.
- **Versão do Besu:** `26.2.0` (padrão; override via `BESU_VERSION`).

> **Modelo de falhas.** Com N = 4, a regra `f = floor((N-1)/3)` dá **f = 1**: a rede satisfaz `N >= 3f + 1` e, portanto, tolera **uma falha bizantina** (um nó malicioso) mantendo a finalidade determinística do QBFT, sem bifurcação do estado. A tolerância é estabelecida pela topologia e pela garantia do protocolo QBFT; a injeção ativa de falha adversária não é exercitada neste artefato (ver Seção VI do artigo).

## Pré-requisitos

- Docker + Docker Compose v2 (`docker compose ...`).
- **Não é necessário Java nem Besu instalados no host** — o genesis e as chaves são gerados por um container Besu efêmero.

## 1. Gerar genesis + chaves (uma vez)

    cd network
    ./generate-network.sh

Isso cria (todos ignorados pelo git):
- `genesis.json` — bloco de gênese com os 4 validadores QBFT;
- `nodes/node{1..4}/data/key` — as chaves privadas de cada validador;
- `networkFiles/` — material auxiliar da geração.

> As chaves **não** são versionadas. Cada clone gera as suas próprias.

## 2. Subir os 4 validadores

    docker compose up -d

Verificar que os 4 validadores estão ativos:

    curl -s -X POST --data '{"jsonrpc":"2.0","method":"qbft_getValidatorsByBlockNumber","params":["latest"],"id":1}' -H "Content-Type: application/json" http://localhost:8545

A resposta deve listar **4 endereços** de validador.

> **Atenção:** use `docker compose down` **sem** a flag `-v`. A flag `-v` apaga os volumes e, com eles, o estado da cadeia e do contrato implantado.

## 3. Parar a rede

    docker compose down

Os volumes (estado da cadeia) são preservados; um novo `up -d` retoma de onde parou.
