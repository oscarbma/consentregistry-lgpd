// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @title ConsentRegistry
/// @notice Âncora on-chain de consentimentos verificáveis para compartilhamento
///         de dados pessoais entre entidades do setor público brasileiro (LGPD).
/// @dev    INVARIANTE FUNDAMENTAL: nenhum dado pessoal é gravado on-chain. O
///         contrato armazena EXCLUSIVAMENTE hashes, provas criptográficas e
///         ponteiros para recibos. O conteúdo (recibo ISO/IEC TS 27560:2023,
///         Verifiable Credential W3C, dados do titular) permanece off-chain.
///         Esta separação resolve a tensão entre a imutabilidade da blockchain
///         e os direitos da LGPD (apagamento, retificação): o que é imutável
///         on-chain é apenas a prova, nunca o dado.
contract ConsentRegistry {
    /// @notice Ciclo de vida de um consentimento.
    enum Status {
        None, // nunca registrado
        Granted, // consentimento ativo
        Revoked // consentimento revogado
    }

    /// @dev Registro de consentimento. Somente âncoras criptográficas.
    struct Consent {
        bytes32 receiptHash; // hash do recibo ISO/IEC TS 27560:2023 (off-chain)
        bytes32 proofHash; // hash da Verifiable Credential W3C (VC/DID) / prova
        address registrar; // instituição registrante (controlador), não dado pessoal
        Status status;
        uint64 grantedAt; // block.timestamp do grant
        uint64 revokedAt; // block.timestamp do revoke (0 enquanto ativo)
    }

    /// @dev consentId (gerado off-chain, opaco on-chain) => registro.
    mapping(bytes32 => Consent) private _consents;

    // ----------------------------------------------------------------------
    // Eventos de medição
    //
    // Carregam block.timestamp para o benchmark cruzar com o relógio de
    // submissão (latência) e, no caso de revogação, medir o tempo de
    // propagação do evento entre os 3 nós validadores (assinando o mesmo
    // ConsentRevoked, indexado por consentId, em cada nó).
    // ----------------------------------------------------------------------

    /// @notice Emitido ao registrar um consentimento.
    event ConsentGranted(
        bytes32 indexed consentId,
        bytes32 indexed receiptHash,
        bytes32 proofHash,
        address indexed registrar,
        uint64 timestamp
    );

    /// @notice Emitido a cada verificação. `valid` reflete se o consentimento
    ///         estava ativo (Granted) no momento da verificação.
    event ConsentVerified(
        bytes32 indexed consentId,
        address indexed verifier,
        bool valid,
        uint64 timestamp
    );

    /// @notice Emitido ao revogar um consentimento.
    event ConsentRevoked(
        bytes32 indexed consentId,
        address indexed registrar,
        uint64 timestamp
    );

    // ----------------------------------------------------------------------
    // Erros
    // ----------------------------------------------------------------------

    error InvalidConsentId();
    error InvalidReceiptHash();
    error ConsentAlreadyExists(bytes32 consentId);
    error ConsentNotFound(bytes32 consentId);
    error ConsentNotActive(bytes32 consentId);

    // ----------------------------------------------------------------------
    // Operações (mistura do experimento: 50% grant / 40% verify / 10% revoke)
    // ----------------------------------------------------------------------

    /// @notice Registra um novo consentimento ancorando suas provas on-chain.
    /// @param consentId   Identificador opaco gerado off-chain (não dado pessoal).
    /// @param receiptHash Hash do recibo de consentimento ISO/IEC TS 27560:2023.
    /// @param proofHash   Hash da Verifiable Credential W3C / prova associada.
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

    /// @notice Verifica um consentimento. É uma transação (emite evento) por
    ///         decisão de projeto: o experimento mede gás e latência de verify
    ///         (40% das operações) e o evento ConsentVerified é essencial para
    ///         a medição. Para leitura off-chain sem custo, use getConsent.
    /// @return valid Verdadeiro se o consentimento está ativo (Granted).
    function verifyConsent(bytes32 consentId) external returns (bool valid) {
        valid = _consents[consentId].status == Status.Granted;
        emit ConsentVerified(consentId, msg.sender, valid, uint64(block.timestamp));
    }

    /// @notice Revoga um consentimento ativo. O ConsentRevoked resultante é a
    ///         base para medir o tempo de propagação da revogação entre os nós.
    function revokeConsent(bytes32 consentId) external {
        Consent storage c = _consents[consentId];
        if (c.status == Status.None) revert ConsentNotFound(consentId);
        if (c.status != Status.Granted) revert ConsentNotActive(consentId);

        uint64 ts = uint64(block.timestamp);
        c.status = Status.Revoked;
        c.revokedAt = ts;

        emit ConsentRevoked(consentId, msg.sender, ts);
    }

    // ----------------------------------------------------------------------
    // Leitura
    // ----------------------------------------------------------------------

    /// @notice Leitura off-chain sem custo (view, não emite evento).
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
