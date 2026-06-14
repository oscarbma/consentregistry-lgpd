import { expect } from "chai";
import { ethers } from "hardhat";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { ConsentRegistry } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Status enum do contrato: None=0, Granted=1, Revoked=2
const Status = { None: 0n, Granted: 1n, Revoked: 2n } as const;

// Âncoras de teste — hashes opacos, NUNCA dados pessoais.
const consentId = ethers.id("consent-0001");
const receiptHash = ethers.id("recibo-iso-27560-0001");
const proofHash = ethers.id("vc-w3c-0001");
const missingId = ethers.id("inexistente-9999");

describe("ConsentRegistry", () => {
  let registry: ConsentRegistry;
  let registrar: HardhatEthersSigner;
  let other: HardhatEthersSigner;

  beforeEach(async () => {
    [registrar, other] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("ConsentRegistry");
    registry = await factory.deploy();
    await registry.waitForDeployment();
  });

  describe("grantConsent", () => {
    it("registra e emite ConsentGranted; status vira Granted", async () => {
      await expect(registry.grantConsent(consentId, receiptHash, proofHash))
        .to.emit(registry, "ConsentGranted")
        .withArgs(consentId, receiptHash, proofHash, registrar.address, anyValue);

      const c = await registry.getConsent(consentId);
      expect(c.status).to.equal(Status.Granted);
    });

    it("reverte ConsentAlreadyExists em grant duplicado", async () => {
      await registry.grantConsent(consentId, receiptHash, proofHash);
      await expect(
        registry.grantConsent(consentId, receiptHash, proofHash)
      )
        .to.be.revertedWithCustomError(registry, "ConsentAlreadyExists")
        .withArgs(consentId);
    });
  });

  describe("verifyConsent", () => {
    it("de um Granted retorna valid=true e emite ConsentVerified", async () => {
      await registry.grantConsent(consentId, receiptHash, proofHash);

      // valor de retorno (sem alterar estado)
      expect(await registry.verifyConsent.staticCall(consentId)).to.equal(true);

      await expect(registry.connect(other).verifyConsent(consentId))
        .to.emit(registry, "ConsentVerified")
        .withArgs(consentId, other.address, true, anyValue);
    });

    it("de um inexistente retorna valid=false e emite (não reverte)", async () => {
      expect(await registry.verifyConsent.staticCall(missingId)).to.equal(false);

      await expect(registry.verifyConsent(missingId))
        .to.emit(registry, "ConsentVerified")
        .withArgs(missingId, registrar.address, false, anyValue);
    });

    it("de um revogado retorna valid=false", async () => {
      await registry.grantConsent(consentId, receiptHash, proofHash);
      await registry.revokeConsent(consentId);
      expect(await registry.verifyConsent.staticCall(consentId)).to.equal(false);
    });
  });

  describe("revokeConsent", () => {
    it("de um Granted vira Revoked, grava revokedAt e emite ConsentRevoked", async () => {
      await registry.grantConsent(consentId, receiptHash, proofHash);

      await expect(registry.revokeConsent(consentId))
        .to.emit(registry, "ConsentRevoked")
        .withArgs(consentId, registrar.address, anyValue);

      const c = await registry.getConsent(consentId);
      expect(c.status).to.equal(Status.Revoked);
      expect(c.revokedAt).to.be.gt(0n);
    });

    it("reverte ConsentNotFound se inexistente", async () => {
      await expect(registry.revokeConsent(missingId))
        .to.be.revertedWithCustomError(registry, "ConsentNotFound")
        .withArgs(missingId);
    });

    it("reverte ConsentNotActive se já revogado", async () => {
      await registry.grantConsent(consentId, receiptHash, proofHash);
      await registry.revokeConsent(consentId);
      await expect(registry.revokeConsent(consentId))
        .to.be.revertedWithCustomError(registry, "ConsentNotActive")
        .withArgs(consentId);
    });
  });

  describe("getConsent (view)", () => {
    it("retorna os campos corretos de um consentimento ativo", async () => {
      await registry.grantConsent(consentId, receiptHash, proofHash);

      const c = await registry.getConsent(consentId);
      expect(c.receiptHash).to.equal(receiptHash);
      expect(c.proofHash).to.equal(proofHash);
      expect(c.registrar).to.equal(registrar.address);
      expect(c.status).to.equal(Status.Granted);
      expect(c.grantedAt).to.be.gt(0n);
      expect(c.revokedAt).to.equal(0n);
    });

    it("após revogar, grava revokedAt e mantém os demais campos", async () => {
      await registry.grantConsent(consentId, receiptHash, proofHash);
      await registry.revokeConsent(consentId);

      const c = await registry.getConsent(consentId);
      expect(c.status).to.equal(Status.Revoked);
      expect(c.receiptHash).to.equal(receiptHash);
      expect(c.proofHash).to.equal(proofHash);
      expect(c.grantedAt).to.be.gt(0n);
      expect(c.revokedAt).to.be.gte(c.grantedAt);
    });

    it("retorna campos zerados para consentId inexistente", async () => {
      const c = await registry.getConsent(missingId);
      expect(c.status).to.equal(Status.None);
      expect(c.receiptHash).to.equal(ethers.ZeroHash);
      expect(c.registrar).to.equal(ethers.ZeroAddress);
      expect(c.grantedAt).to.equal(0n);
      expect(c.revokedAt).to.equal(0n);
    });
  });
});
