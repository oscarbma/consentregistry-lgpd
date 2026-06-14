import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Verificação de liveness: lê o endereço de deployments/<rede>.json e chama
 * getConsent (view) com um consentId arbitrário. Um contrato vivo retorna
 * campos zerados / status None para um id nunca registrado.
 *
 * consentId opcional via argumento: hardhat run scripts/check.ts --network besu <id>
 */
async function main() {
  const file = path.resolve(__dirname, "..", "deployments", `${network.name}.json`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));

  const code = await ethers.provider.getCode(dep.address);
  console.log(`Rede:     ${network.name} (chainId ${network.config.chainId})`);
  console.log(`Endereço: ${dep.address}`);
  console.log(`Bytecode on-chain: ${code === "0x" ? "VAZIO (sem contrato!)" : `${(code.length - 2) / 2} bytes`}`);

  const arg = process.argv[process.argv.length - 1];
  const consentId = arg && arg.startsWith("0x") && arg.length === 66 ? arg : ethers.id("liveness-probe");

  const registry = await ethers.getContractAt(dep.abi, dep.address);
  const c = await registry.getConsent(consentId);

  const statusName = ["None", "Granted", "Revoked"][Number(c.status)] ?? String(c.status);
  console.log(`\ngetConsent(${consentId}):`);
  console.log(`  receiptHash: ${c.receiptHash}`);
  console.log(`  proofHash:   ${c.proofHash}`);
  console.log(`  registrar:   ${c.registrar}`);
  console.log(`  status:      ${c.status} (${statusName})`);
  console.log(`  grantedAt:   ${c.grantedAt}`);
  console.log(`  revokedAt:   ${c.revokedAt}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
