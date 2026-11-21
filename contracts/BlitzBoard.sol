// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BlitzBoard - 指纹上链 / Uneditable
/// @notice 同一份投票与留言双写。第二条写入路径由合约自己通过 Monad 的
///         P256 预编译 (0x0100, EIP-7951) 验证 WebAuthn/passkey 签名，
///         转发器只负责付 gas，无法伪造内容。
/// @dev 当天从零编写，仅使用 Solidity 标准库写法与 Monad 官方文档中的
///      staticcall 调用形式。链上不依赖任何第三方库。
contract BlitzBoard {
    // ------------------------------------------------------------------
    // 存储
    // ------------------------------------------------------------------
    struct Entry {
        uint8 kind;        // 0 = 钱包 EIP-712 直签（自付 gas）; 1 = passkey + 转发器代付
        uint16 teamId;
        address author;
        bytes32 credHash;  // passkey 凭据哈希；钱包路径为 0
        string text;       // 留言
        uint64 timestamp;
    }

    Entry[] public entries;
    mapping(uint16 => uint256) public votes;
    mapping(bytes32 => bool) public usedCredential;   // 每枚 passkey 限投一票
    mapping(bytes32 => bool) public usedChallenge;    // 一次性 challenge，防重放
    mapping(address => bool) public hasVoted;         // 每地址限投一票（钱包路径）

    address public immutable owner;
    bytes32 public rpIdHash;        // sha256(rpId)
    bytes public originNeedle;      // "\"origin\":\"https://<rpId>\""，部署后由 owner 定稿
    bool public configLocked;

    event Voted(
        uint256 indexed id,
        uint8 kind,
        uint16 indexed teamId,
        address indexed author,
        bytes32 credHash,
        string text,
        uint64 timestamp,
        bytes32 nonce
    );
    event ConfigUpdated(bytes32 rpIdHash, bytes originNeedle);

    // EIP-712
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant VOTE_TYPEHASH =
        keccak256("Vote(uint16 teamId,string text,uint64 deadline)");

    constructor(bytes32 _rpIdHash, bytes memory _originNeedle) {
        owner = msg.sender;
        rpIdHash = _rpIdHash;
        originNeedle = _originNeedle;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    /// @notice WebAuthn 的 rpId / origin 与域名绑定，域名定稿后调用一次并锁定。
    function configure(bytes32 _rpIdHash, bytes calldata _originNeedle) external onlyOwner {
        require(!configLocked, "config locked");
        rpIdHash = _rpIdHash;
        originNeedle = _originNeedle;
        emit ConfigUpdated(_rpIdHash, _originNeedle);
    }

    function lockConfig() external onlyOwner {
        configLocked = true;
    }

    // ------------------------------------------------------------------
    // 视图
    // ------------------------------------------------------------------
    function total() external view returns (uint256) {
        return entries.length;
    }

    function getEntry(uint256 i) external view returns (Entry memory) {
        return entries[i];
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("Uneditable")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function voteDigest(uint16 teamId, string calldata text, uint64 deadline)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(VOTE_TYPEHASH, teamId, keccak256(bytes(text)), deadline));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice 服务端下发 challenge 时用完全相同的编码重算这 32 字节。
    function passkeyChallenge(
        uint16 teamId,
        string calldata text,
        bytes32 nonce,
        uint64 deadline,
        bytes32 credIdHash
    ) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                teamId,
                keccak256(bytes(text)),
                nonce,
                deadline,
                block.chainid,
                address(this),
                credIdHash
            )
        );
    }

    // ------------------------------------------------------------------
    // 路径 1：钱包 EIP-712 直签，用户自己付 gas
    // ------------------------------------------------------------------
    function vote(uint16 teamId, string calldata text, uint64 deadline, bytes calldata sig)
        external
    {
        require(block.timestamp <= deadline, "expired");
        require(!hasVoted[msg.sender], "already voted");
        require(teamId != 0, "bad team");
        require(sig.length == 65, "bad sig length");

        (bytes32 r, bytes32 s, uint8 v) = _splitSig(sig);
        address author = ecrecover(voteDigest(teamId, text, deadline), v, r, s);
        require(author != address(0) && author == msg.sender, "bad EIP-712 signature");

        hasVoted[msg.sender] = true;
        _write(0, teamId, author, bytes32(0), text, bytes32(0));
    }

    // ------------------------------------------------------------------
    // 路径 2：passkey 指纹签名 + 转发器代付 gas；合约内 P256 验签
    // ------------------------------------------------------------------
    /// @param authData        WebAuthn authenticatorData（原始字节）
    /// @param clientDataJSON  WebAuthn clientDataJSON（原始字节）
    /// @param r,s             服务端从 ASN.1 DER 签名中解出的 ECDSA (r,s)
    /// @param qx,qy           passkey 的 P-256 公钥坐标（COSE 解出）
    /// @param nonce           服务端下发的一次性 challenge nonce
    /// @param credIdHash      keccak256(credential.rawId)，每枚指纹限投一票
    function voteByPasskey(
        bytes calldata authData,
        bytes calldata clientDataJSON,
        uint256 r,
        uint256 s,
        uint256 qx,
        uint256 qy,
        uint16 teamId,
        string calldata text,
        bytes32 nonce,
        uint64 deadline,
        bytes32 credIdHash
    ) external {
        require(block.timestamp <= deadline, "expired");
        require(!usedChallenge[nonce], "challenge used");
        require(!usedCredential[credIdHash], "credential used");
        require(teamId != 0 && credIdHash != bytes32(0), "bad params");
        require(authData.length >= 37, "short authData");

        // (1) rpIdHash 绑定域名 + UP/UV 用户在场与已验证标志
        bytes32 gotRpIdHash;
        assembly {
            gotRpIdHash := calldataload(authData.offset)
        }
        require(gotRpIdHash == rpIdHash, "bad rpIdHash");
        uint8 flags = uint8(authData[32]);
        require(flags & 0x05 == 0x05, "UP/UV required");

        // (2) clientDataJSON 的 type / origin / challenge
        bytes memory cdj = clientDataJSON;
        require(_contains(cdj, bytes("\"type\":\"webauthn.get\"")), "bad type");
        require(_contains(cdj, originNeedle), "bad origin");
        bytes32 ch = keccak256(
            abi.encodePacked(
                teamId,
                keccak256(bytes(text)),
                nonce,
                deadline,
                block.chainid,
                address(this),
                credIdHash
            )
        );
        require(
            _contains(cdj, bytes(string.concat("\"challenge\":\"", _b64url32(ch), "\""))),
            "bad challenge"
        );

        // (3) WebAuthn 签名消息 = authData || sha256(clientDataJSON)，再取 sha256
        //     交给 Monad 的 P256 预编译 0x0100 验证。
        bytes32 clientHash = _sha256(clientDataJSON);
        bytes32 msgHash = _sha256(abi.encodePacked(authData, clientHash));
        require(_p256(msgHash, r, s, qx, qy), "bad P256 signature");

        usedChallenge[nonce] = true;
        usedCredential[credIdHash] = true;
        _write(1, teamId, msg.sender, credIdHash, text, nonce);
    }

    // ------------------------------------------------------------------
    // 内部
    // ------------------------------------------------------------------
    function _write(
        uint8 kind,
        uint16 teamId,
        address author,
        bytes32 credHash,
        string memory text,
        bytes32 nonce
    ) internal {
        entries.push(
            Entry({
                kind: kind,
                teamId: teamId,
                author: author,
                credHash: credHash,
                text: text,
                timestamp: uint64(block.timestamp)
            })
        );
        votes[teamId] += 1;
        emit Voted(
            entries.length - 1,
            kind,
            teamId,
            author,
            credHash,
            text,
            uint64(block.timestamp),
            nonce
        );
    }

    function _splitSig(bytes calldata sig)
        internal
        pure
        returns (bytes32 r, bytes32 s, uint8 v)
    {
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
    }

    /// @notice EIP-7951：输入 160 字节 hash||r||s||qx||qy，有效返回 32 字节 1。
    function _p256(bytes32 h, uint256 r, uint256 s, uint256 qx, uint256 qy)
        internal
        view
        returns (bool)
    {
        bytes memory input = abi.encodePacked(h, r, s, qx, qy);
        (bool ok, bytes memory ret) = address(uint160(0x0100)).staticcall(input);
        if (!ok || ret.length != 32) return false;
        return abi.decode(ret, (uint256)) == 1;
    }

    function _sha256(bytes memory data) internal view returns (bytes32) {
        (bool ok, bytes memory ret) = address(uint160(0x02)).staticcall(data);
        require(ok && ret.length == 32, "sha256 precompile failed");
        return abi.decode(ret, (bytes32));
    }

    /// @notice 32 字节摘要的 base64url（无 padding，43 字符），与浏览器
    ///         clientDataJSON.challenge 的编码完全一致。
    function _b64url32(bytes32 data) internal pure returns (string memory) {
        bytes memory alpha =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        bytes memory out = new bytes(43);
        uint256 o = 0;
        uint256 i;
        for (i = 0; i < 30; i += 3) {
            uint24 v = (uint24(uint8(data[i])) << 16)
                | (uint24(uint8(data[i + 1])) << 8)
                | uint24(uint8(data[i + 2]));
            out[o++] = alpha[(v >> 18) & 63];
            out[o++] = alpha[(v >> 12) & 63];
            out[o++] = alpha[(v >> 6) & 63];
            out[o++] = alpha[v & 63];
        }
        uint24 v = (uint24(uint8(data[30])) << 16) | (uint24(uint8(data[31])) << 8);
        out[o++] = alpha[(v >> 18) & 63];
        out[o++] = alpha[(v >> 12) & 63];
        out[o++] = alpha[(v >> 6) & 63];
        return string(out);
    }

    function _contains(bytes memory hay, bytes memory needle)
        internal
        pure
        returns (bool)
    {
        uint256 n = needle.length;
        uint256 h = hay.length;
        if (n == 0 || n > h) return false;
        for (uint256 i = 0; i <= h - n; i++) {
            bool hit = true;
            for (uint256 j = 0; j < n; j++) {
                if (hay[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return true;
        }
        return false;
    }
}
