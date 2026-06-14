# Rede Besu QBFT — 3 nós validadores

Rede Hyperledger Besu permissionada usada como camada de registro para o
laboratório de **consentimento verificável** (ENCOM 2026). A blockchain guarda
apenas hashes, provas e recibos de consentimento — **nunca dados pessoais**.

## Topologia

| Nó    | Container    | IP (bridge)     | RPC HTTP no host | Papel               |
|-------|--------------|-----------------|------------------|---------------------|
| node1 | `besu-node1` | `172.16.239.11` | `8545`           | validador + bootnode|
| node2 | `besu-node2` | `172.16.239.12` | `8546`           | validador           |
| node3 | `besu-node3` | `172.16.239.13` | `8547`           | validador           |

- **Consenso:** QBFT, `blockperiodseconds = 2`.
- **chainId / network-id:** `2026`.
- **Versão do Besu:** `26.2.0` (padrão; override via `BESU_VERSION`).

> **Modelo de falhas — leia antes de citar no artigo.**
> Com **N = 3**, a regra `f = floor((N-1)/3)` dá **f = 0** falhas bizantinas
> toleradas. Ou seja, esta rede fornece **apenas crash fault tolerance**: ela
> continua produzindo blocos se um nó *cair*, mas **não** tolera um nó
> *malicioso/bizantino*. Tolerância bizantina completa (f ≥ 1) exigiria
> **N ≥ 4**. Afirme isso de forma explícita e correta.

## Pré-requisitos

- Docker + Docker Compose v2 (`docker compose ...`).
- **Não é necessário Java nem Besu instalados no host** — o genesis e as chaves
  são gerados por um container Besu efêmero.

## 1. Gerar genesis + chaves (uma vez)

```bash
cd network
./generate-network.sh
```

Isso cria (todos ignorados pelo git):

- `genesis.json` — bloco gênese QBFT com a lista de validadores em `extraData`;
- `nodes/node{1,2,3}/data/{key,key.pub}` — chaves de cada validador;
- `.env` — `BOOTNODE_ENODE` (enode do node1) consumido pelo compose.

Para fixar/trocar a versão do Besu:

```bash
BESU_VERSION=26.2.0 ./generate-network.sh
```

## 2. Subir a rede

```bash
docker compose up -d
```

Acompanhar logs (deve começar a importar blocos a cada ~2s):

```bash
docker compose logs -f node1
```

### Sanidade via RPC

Número do bloco atual (sobe a cada ~2s) e contagem de pares de cada nó:

```bash
# bloco atual no node1
curl -s -X POST localhost:8545 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

# validadores QBFT vistos pelo node1 (deve listar os 3 endereços)
curl -s -X POST localhost:8545 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"qbft_getValidatorsByBlockNumber","params":["latest"],"id":1}'

# pares conectados em cada nó (node2 -> 8546, node3 -> 8547)
curl -s -X POST localhost:8546 \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"net_peerCount","params":[],"id":1}'
```

## 3. Derrubar a rede

```bash
# para os containers, preserva os data-paths (DB) nos volumes nomeados
docker compose down

# para os containers E apaga os volumes (DB) — reinício do zero
docker compose down -v
```

> `down -v` remove apenas o estado da cadeia (volumes `node{1,2,3}-data`).
> O `genesis.json` e as chaves continuam; recrie-os com `./generate-network.sh`
> caso queira uma identidade de rede totalmente nova.

## Notas de operação em container (imagem oficial Besu)

- O `--data-path` de cada nó aponta para **`/data`** (volume montado), **nunca**
  para o data-path padrão `/opt/besu`.
- `--nat-method=DOCKER` é obrigatório em container (jamais `NONE`/`UPNP`), para
  que cada nó anuncie o IP correto aos demais.
- IPs estáticos na bridge `172.16.239.0/24` são necessários porque o enode do
  bootnode embute o IP do node1.
