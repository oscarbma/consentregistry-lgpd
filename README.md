# ConsentRegistry — Mapeamento de Primitivas do Hyperledger Besu sob a LGPD

Artefato de reproducao do artigo **"Criptografia Aplicada ao Registro de Consentimento sob a LGPD: Mapeamento de Primitivas do Hyperledger Besu"**, submetido ao **ENCOM 2026**.

**Autores:** Oscar Bruno Maciel de Abreu, Joao Crisostomo Weyl Albuquerque Costa, Rosinei de Sousa Oliveira
Programa de Pos-Graduacao em Engenharia Eletrica (PPGEE) — Universidade Federal do Para (UFPA)

## Visao geral

Contrato inteligente `ConsentRegistry`, infraestrutura de rede e scripts de benchmark que materializam o mapeamento entre primitivas criptograficas do Hyperledger Besu e requisitos selecionados da LGPD descrito no artigo.

A rede experimental e uma blockchain permissionada **Hyperledger Besu 26.2.0** com **4 nos validadores** sob consenso **QBFT** (N >= 3f + 1 para f = 1, isto e, tolerancia a uma falha bizantina), emulada em conteineres Docker, com intervalo de bloco de 2 s e preco de gas nulo.

**Restricao de projeto:** nenhum dado pessoal e registrado em cadeia. O contrato armazena apenas identificadores opacos, *commitments* (Keccak-256) e recibos de consentimento; os dados pessoais permanecem sob custodia do controlador, fora da cadeia.

## Estrutura

    contracts/   Contrato Solidity + projeto Hardhat (ConsentRegistry.sol, deploy.ts, deployments/)
    network/     Rede Besu QBFT (docker-compose.yml, genesis.json, generate-network.sh)
    benchmark/   Cliente de carga (src/run.ts) e analise (analyze.py, report.py)
    results/     CSVs, JSONs e figuras dos experimentos

As chaves privadas dos validadores **nao** sao versionadas (ver `.gitignore`); sao geradas localmente por `generate-network.sh`.

## Requisitos

Docker e Docker Compose; Node.js LTS (recomenda-se `nvm`); Python 3 com `venv`.

## Reproducao

**1. Gerar a rede (chaves + genese):**

    cd network && ./generate-network.sh

**2. Subir os 4 validadores:**

    docker compose up -d
    curl -s -X POST --data '{"jsonrpc":"2.0","method":"qbft_getValidatorsByBlockNumber","params":["latest"],"id":1}' -H "Content-Type: application/json" http://localhost:8545

Use `docker compose down` **sem** a flag `-v`. A flag `-v` apaga os volumes (estado da cadeia e do contrato).

**3. Implantar o contrato:**

    cd ../contracts && npm install && npm run deploy:besu

**4. Executar o benchmark:**

    cd ../benchmark && npm install
    npm run smoke
    npm run bench

**5. Analise estatistica e figuras:**

    python3 -m venv .venv && source .venv/bin/activate
    pip install pandas numpy scipy matplotlib
    python3 analyze.py
    python3 report.py

Resultados (CSVs, tabelas LaTeX, figuras) sao escritos em `results/`.

## Parametros do experimento

| Parametro | Valor |
|---|---|
| Substrato | Hyperledger Besu 26.2.0 |
| Consenso | QBFT (N = 4, f = 1) |
| chainId | 2026 |
| Intervalo de bloco | 2 s |
| Preco de gas | 0 |
| EVM | Berlin |
| Contrato | ConsentRegistry (Solidity 0.8.24) |
| Carga | 2.000 tx (50% grant / 40% verify / 10% revoke) |
| Bootstrap | BCa, 10.000 reamostragens, semente 12345 |

Endereco implantado na execucao de referencia: ver `contracts/deployments/besu.json`.

## Como citar

> O. B. M. de Abreu, J. C. W. A. Costa e R. de S. Oliveira, "Criptografia Aplicada a Gestao de Consentimento sob a LGPD: Mapeamento de Primitivas do Hyperledger Besu," in *Anais do XVI ENCOM*, Joao Pessoa, PB, Brasil, 2026.

## Licenca

MIT — ver `LICENSE`.
