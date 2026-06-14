import { artifacts, ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Faz o deploy do ConsentRegistry na rede Besu local e grava um artefato de
 * deployment (endereço + ABI + metadados da tx) em deployments/<rede>.json,
 * para o benchmark consumir depois.
 */
async function main() {
  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    throw new Error(
      "Nenhuma conta carregada. Verifique as chaves dos validadores em " +
        "network/nodes/node{1,2,3}/data/key ou a variável BESU_PRIVATE_KEYS."
    );
  }
  const deployer = signers[0];

  console.log(`Rede:      ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Deployer:  ${deployer.address}`);

  const factory = await ethers.getContractFactory("ConsentRegistry", deployer);
  const contract = await factory.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const deployTx = contract.deploymentTransaction();
  const receipt = deployTx ? await deployTx.wait() : null;

  console.log(`ConsentRegistry: ${address}`);
  console.log(`tx:              ${deployTx?.hash}`);
  console.log(`bloco:           ${receipt?.blockNumber}`);

  const artifact = await artifacts.readArtifact("ConsentRegistry");
  const out = {
    network: network.name,
    chainId: Number(network.config.chainId),
    address,
    deployer: deployer.address,
    txHash: deployTx?.hash ?? null,
    blockNumber: receipt?.blockNumber ?? null,
    abi: artifact.abi,
  };

  const dir = path.resolve(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Deployment salvo em deployments/${network.name}.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
