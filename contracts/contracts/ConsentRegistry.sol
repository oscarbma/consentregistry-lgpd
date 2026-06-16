pragma solidity 0.8.24;

contract ConsentRegistry {
        enum Status {
        None, // nunca registrado
        Granted, // consentimento ativo
        Revoked // consentimento revogado
    }

   struct Consent {
        bytes32 receiptHash; // hash do recibo ISO/IEC TS 27560:2023 (off-chain)
        bytes32 proofHash; // hash da Verifiable Credential W3C (VC/DID) / prova
        address registrar; // instituição registrante (controlador), não dado pessoal
        Status status;
        uint64 grantedAt; // block.timestamp do grant
        uint64 revokedAt; // block.timestamp do revoke (0 enquanto ativo)
    }

    mapping(bytes32 => Consent) private _consents;

    /// Emitido ao registrar um consentimento.
    event ConsentGranted(
        bytes32 indexed consentId,
        bytes32 indexed receiptHash,
        bytes32 proofHash,
        address indexed registrar,
        uint64 timestamp
    );

    /// Emitido a cada verificação. `valid` reflete se o consentimento estava ativo (Granted) no momento da verificação.
    event ConsentVerified(
        bytes32 indexed consentId,
        address indexed verifier,
        bool valid,
        uint64 timestamp
    );

    /// Emitido ao revogar um consentimento.
    event ConsentRevoked(
        bytes32 indexed consentId,
        address indexed registrar,
        uint64 timestamp
    );

    error InvalidConsentId();
    error InvalidReceiptHash();
    error ConsentAlreadyExists(bytes32 consentId);
    error ConsentNotFound(bytes32 consentId);
    error ConsentNotActive(bytes32 consentId);

    function grantConsent(
        bytes32 consentId,
        bytes32 receiptHash,
        bytes32 proofHash
    ) external {
        if (consentId == bytes32(0)) revert InvalidConsentId();
        if (receiptHash == bytes32(0)) revert InvalidReceiptHash();

        Consent storage c = _consents[consentId];
        if (c.status != Status.None) revert ConsentAlreadyExists(consentId);

        uint64 ts = uint64(block.timestamp);
        c.receiptHash = receiptHash;
        c.proofHash = proofHash;
        c.registrar = msg.sender;
        c.status = Status.Granted;
        c.grantedAt = ts;

        emit ConsentGranted(consentId, receiptHash, proofHash, msg.sender, ts);
    }

    
    function verifyConsent(bytes32 consentId) external returns (bool valid) {
        valid = _consents[consentId].status == Status.Granted;
        emit ConsentVerified(consentId, msg.sender, valid, uint64(block.timestamp));
    }

    function revokeConsent(bytes32 consentId) external {
        Consent storage c = _consents[consentId];
        if (c.status == Status.None) revert ConsentNotFound(consentId);
        if (c.status != Status.Granted) revert ConsentNotActive(consentId);

        uint64 ts = uint64(block.timestamp);
        c.status = Status.Revoked;
        c.revokedAt = ts;

        emit ConsentRevoked(consentId, msg.sender, ts);
    }

    /// Leitura off-chain sem custo (view, não emite evento).
    function getConsent(bytes32 consentId)
        external
        view
        returns (
            bytes32 receiptHash,
            bytes32 proofHash,
            address registrar,
            Status status,
            uint64 grantedAt,
            uint64 revokedAt
        )
    {
        Consent storage c = _consents[consentId];
        return (
            c.receiptHash,
            c.proofHash,
            c.registrar,
            c.status,
            c.grantedAt,
            c.revokedAt
        );
    }
}
