# 指纹上链 · Uneditable

> **按一下指纹，10 秒上链；换一份名单，下一场活动就能复用。**

Monad Blitz@广州（eventId=18）参赛项目。它不是一个投票应用，而是一套**可复用的零门槛 Web3 入口**：观众扫码、按一下指纹，10 秒内在 Monad 测试网投出一票并留下留言，不需要装钱包、不需要助记词、不需要代币、不需要自己付 gas。

---

## 一句话看懂现场演示

大屏**左栏读中心化数据库**（服务器上的 `store.json`），**右栏读 Monad 测试网合约**，同一份内容双写。把后台管理页的二维码投到屏幕上，请台下观众**亲手**改票数、删留言——左栏立刻变，右栏纹丝不动；点开右栏的交易哈希，在 MonadVision 上验证内容一个字没变。

---

## 公网 Demo

**https://uneditable.app.workbuddy.host/?sharecode=VAMHA6FEJK**

分享链接带 `sharecode` 鉴权参数，现场三张二维码与剪贴板物料都已带上它；请始终使用完整链接，裸域名会被平台拦截（403）。

- 大屏：`https://uneditable.app.workbuddy.host/screen.html?sharecode=VAMHA6FEJK`
- 手机投票：`https://uneditable.app.workbuddy.host/vote.html?sharecode=VAMHA6FEJK`
- 后台篡改：`https://uneditable.app.workbuddy.host/admin.html?sharecode=VAMHA6FEJK`

公开 GitHub 仓库：`https://github.com/thomascjf/Uneditable`

---

## 链上信息（可自行验证）

| 项 | 值 |
| --- | --- |
| 网络 | Monad Testnet |
| chainId | `10143`（`0x279f`） |
| RPC | `https://testnet-rpc.monad.xyz` |
| 区块浏览器 | `https://testnet.monadvision.com` |
| **合约 BlitzBoard** | **`0x92d7bd2fa6c169ed653a44fa94ba4b94e24f1f09`** |
| 部署交易 | `0xe09f6a109add89a4274a8dcbe29d496bbffe60ce203c7e4608b401547369ae4f` |
| 合约浏览器页 | https://testnet.monadvision.com/address/0x92d7bd2fa6c169ed653a44fa94ba4b94e24f1f09 |
| 部署交易浏览器页 | https://testnet.monadvision.com/tx/0xe09f6a109add89a4274a8dcbe29d496bbffe60ce203c7e4608b401547369ae4f |
| 转发器钱包地址（公开，只能收币） | `0xa5d28e6513766a36a3c2a00AF0966A80631Fc8E0` |
| P256 预编译 | `0x0100`（EIP-7951，Monad 官方支持「on-chain verification of WebAuthn/passkey signatures」） |
| 编译器 | solc 0.8.39（`viaIR`, optimizer 200 runs） |

---

## 两个写入口，写同一个数组

| | `vote()` | `voteByPasskey()` |
| --- | --- | --- |
| 前端开关 | 默认开启「我自己有 Monad 代币，自己付 gas」 | 关闭开关（零门槛路径） |
| 谁付 gas | 用户钱包 | 转发器代付 |
| 签名 | EIP-712 `Vote(uint16 teamId,string text,uint64 deadline)`，`ecrecover` 恢复 `author` | WebAuthn / ES256 (P-256)，由设备指纹产生 |
| 合约内验签 | `ecrecover` | **Monad `0x0100` P256 预编译**，`staticcall` 160 字节 `msgHash‖r‖s‖qx‖qy`，要求返回 1 |
| 附带校验 | 每地址限投、deadline | clientDataJSON 的 `type` / `origin` / `challenge`，authData 的 `rpIdHash` 与 UP/UV，一次性 nonce、每凭据限投、deadline |

`voteByPasskey()` 的链上校验流程：

1. `clientDataHash = sha256(clientDataJSON)`，`msgHash = sha256(authData ‖ clientDataHash)`（标准 WebAuthn 签名消息）；
2. `staticcall 0x0100` 验证 P-256 签名（**签名是用户设备产生的，不是服务器写的**）；
3. 在 `clientDataJSON` 中核对 `type=webauthn.get`、`origin=<部署域名>`、`challenge`，其中 challenge 由合约重算 `keccak256(teamId ‖ hash(text) ‖ nonce ‖ deadline ‖ chainId ‖ 合约地址 ‖ credIdHash)` 并做 base64url 编码后与 JSON 字符串比对，因此**内容与签名绑定**；
4. 核对 `authData` 前 32 字节 = `sha256(rpId)`，`flags` 的 UP(0x01) 与 UV(0x04) 位；
5. `usedChallenge[nonce]` 防重放、`usedCredential[credIdHash]` 每枚指纹限投一票。

服务端在提交交易前也会用 Web Crypto 完整验一次签名（提前拦截无效签名、避免白付 gas）；但**最终信任根是合约里的 `0x0100`**，转发器即使想改内容也做不到。

---

## 架构

```
手机浏览器(扫码) ─┐
大屏浏览器(投影) ─┼──> [ Node / Express 单端口服务 ] ──> Monad Testnet RPC
后台管理页 ───────┘      │
                         ├── /public 三页静态前端（原生 JS，无框架）
                         ├── /api/*  业务接口 + 转发器 + 中心化库
                         ├── /api/stream  SSE（左栏推本地、右栏推链上事件）
                         ├── store.json  中心化库（可被管理页任意篡改）
                         └── relayer.key 一次性测试网钱包（仅运行时）
                                │
                                └──> BlitzBoard (Monad Testnet)
```

**手机端不直连 RPC**：链上读写全部走后端代理，规避现场手机 4G 访问境外 RPC 不稳与公共 RPC 限流。后端每 1.5 秒轮询 `Voted` 事件（自带交易哈希），通过 SSE 推给大屏右栏。

---

## 换一份名单，下一场活动就能复用

这套东西的价值不在「一个投票页面」，而在**参与层基础设施**：

1. 替换 `teams.json`（`eventId` / `teams[]`，字段 `id / name / description / memberCount`）——投票选项的唯一来源，服务端启动时读入，前端通过 `/api/config` 获取；
2. 改 `config.json` 里的 `rpId` / `origin` 为新域名，服务启动时会自动调用合约 `configure()` 同步 WebAuthn 域名绑定（域名定稿后可调用 `lockConfig()` 锁定）；
3. 其余代码一行不用改：合约、passkey 注册、转发器代付、P256 验签、双栏对照全部通用。

下一场黑客松、校园选举、会议表决，都不用再教观众装钱包。

---

## 安全与凭证边界

- **转发器只负责付 gas**：它不能改票内容，内容由用户设备签名、合约独立验签；用户随时可以切回自己付 gas。
- **私钥不是钱包地址**（最容易搞错）：
  - **地址** = `0x` + 40 位十六进制（20 字节）。公开，用来收币、在浏览器查交易，**只有地址无法签名**，部署合约与代付 gas 都做不了。
  - **私钥** = `0x` + 64 位十六进制（32 字节，共 66 字符；部分钱包导出会省略 `0x`，64 位裸十六进制同样合法，代码统一补前缀）。秘密，用来签名。MetaMask 导出：账户菜单 → 账户详情 → 显示私钥 → 输入密码 → 复制。
  - **助记词** = 12 / 24 个英文单词，等于交出整个钱包，**绝不能放进文件**。
- 本项目使用**新建的一次性测试网钱包**，只放 100 MON 测试币、无任何真实资产，赛后作废。`relayer.key` 是唯一随发布目录上传的密钥；本地 `.workbuddy/deploy-key.txt`、`.mojo/agent.json` 与 SSH 私钥均不入库、不随发布上传。
- `.gitignore` 排除了 `.mojo/`、`.workbuddy/`、`.env*`、`node_modules/`、`other-docs/`；发布目录 `deploy/` 是独立整理出来的，不含方案文档与凭证残留。

---

## 本地运行

```bash
npm install
npm run compile          # solc 编译 -> artifacts/BlitzBoard.json
npm run deploy:contract  # 部署到 Monad Testnet，写回 config.json
npm run selftest         # 真实 P-256 断言打合约，验证 0x0100 / challenge / 防重放
npm run qr               # 生成 assets/qr-*.png 现场二维码
npm start                # node server/index.js，监听 $PORT / 0.0.0.0
```

环境变量：`PORT`（默认 3000）、`BASE_URL`、`RP_ID`、`ORIGIN`、`CONTRACT_ADDRESS`。

三个页面：`/screen.html`（大屏双栏）、`/vote.html`（手机扫码）、`/admin.html`（后台篡改）。

---

## 目录

```
contracts/BlitzBoard.sol     合约（当天从零编写）
scripts/  compile / deploy / selftest / qr
server/   config / chain / central / webauthn / index
public/   screen.html / vote.html / admin.html / style.css
config.json                  链与域名配置（部署后写回合约地址）
teams.json                   40 支队伍，投票选项唯一来源
artifacts/BlitzBoard.json    编译产物（含完整 ABI）
deploy/                      独立发布目录（凭证隔离）
docs/PLAN.md / DEMO_KIT.md   执行方案 / 现场物料
```

代码当天从零编写；`viem` / `express` / `solc` / `qrcode` / `@simplewebauthn/server` 属于允许的标准库，P256 `staticcall` 片段来自 Monad 官方文档；`teams.json` 是活动公开数据。

---

## 完整 ABI

见下方 JSON（同一份文件也在 `artifacts/BlitzBoard.json`）。

<!-- ABI_START -->
```json
[
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "_rpIdHash",
        "type": "bytes32"
      },
      {
        "internalType": "bytes",
        "name": "_originNeedle",
        "type": "bytes"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "rpIdHash",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "bytes",
        "name": "originNeedle",
        "type": "bytes"
      }
    ],
    "name": "ConfigUpdated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "id",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "kind",
        "type": "uint8"
      },
      {
        "indexed": true,
        "internalType": "uint16",
        "name": "teamId",
        "type": "uint16"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "author",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "credHash",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "string",
        "name": "text",
        "type": "string"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "timestamp",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "nonce",
        "type": "bytes32"
      }
    ],
    "name": "Voted",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "configLocked",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "_rpIdHash",
        "type": "bytes32"
      },
      {
        "internalType": "bytes",
        "name": "_originNeedle",
        "type": "bytes"
      }
    ],
    "name": "configure",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "domainSeparator",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "name": "entries",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "kind",
        "type": "uint8"
      },
      {
        "internalType": "uint16",
        "name": "teamId",
        "type": "uint16"
      },
      {
        "internalType": "address",
        "name": "author",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "credHash",
        "type": "bytes32"
      },
      {
        "internalType": "string",
        "name": "text",
        "type": "string"
      },
      {
        "internalType": "uint64",
        "name": "timestamp",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "i",
        "type": "uint256"
      }
    ],
    "name": "getEntry",
    "outputs": [
      {
        "components": [
          {
            "internalType": "uint8",
            "name": "kind",
            "type": "uint8"
          },
          {
            "internalType": "uint16",
            "name": "teamId",
            "type": "uint16"
          },
          {
            "internalType": "address",
            "name": "author",
            "type": "address"
          },
          {
            "internalType": "bytes32",
            "name": "credHash",
            "type": "bytes32"
          },
          {
            "internalType": "string",
            "name": "text",
            "type": "string"
          },
          {
            "internalType": "uint64",
            "name": "timestamp",
            "type": "uint64"
          }
        ],
        "internalType": "struct BlitzBoard.Entry",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "hasVoted",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "lockConfig",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "originNeedle",
    "outputs": [
      {
        "internalType": "bytes",
        "name": "",
        "type": "bytes"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "owner",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint16",
        "name": "teamId",
        "type": "uint16"
      },
      {
        "internalType": "string",
        "name": "text",
        "type": "string"
      },
      {
        "internalType": "bytes32",
        "name": "nonce",
        "type": "bytes32"
      },
      {
        "internalType": "uint64",
        "name": "deadline",
        "type": "uint64"
      },
      {
        "internalType": "bytes32",
        "name": "credIdHash",
        "type": "bytes32"
      }
    ],
    "name": "passkeyChallenge",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "rpIdHash",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "total",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "name": "usedChallenge",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "name": "usedCredential",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint16",
        "name": "teamId",
        "type": "uint16"
      },
      {
        "internalType": "string",
        "name": "text",
        "type": "string"
      },
      {
        "internalType": "uint64",
        "name": "deadline",
        "type": "uint64"
      },
      {
        "internalType": "bytes",
        "name": "sig",
        "type": "bytes"
      }
    ],
    "name": "vote",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes",
        "name": "authData",
        "type": "bytes"
      },
      {
        "internalType": "bytes",
        "name": "clientDataJSON",
        "type": "bytes"
      },
      {
        "internalType": "uint256",
        "name": "r",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "s",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "qx",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "qy",
        "type": "uint256"
      },
      {
        "internalType": "uint16",
        "name": "teamId",
        "type": "uint16"
      },
      {
        "internalType": "string",
        "name": "text",
        "type": "string"
      },
      {
        "internalType": "bytes32",
        "name": "nonce",
        "type": "bytes32"
      },
      {
        "internalType": "uint64",
        "name": "deadline",
        "type": "uint64"
      },
      {
        "internalType": "bytes32",
        "name": "credIdHash",
        "type": "bytes32"
      }
    ],
    "name": "voteByPasskey",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint16",
        "name": "teamId",
        "type": "uint16"
      },
      {
        "internalType": "string",
        "name": "text",
        "type": "string"
      },
      {
        "internalType": "uint64",
        "name": "deadline",
        "type": "uint64"
      }
    ],
    "name": "voteDigest",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint16",
        "name": "",
        "type": "uint16"
      }
    ],
    "name": "votes",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
]
```
<!-- ABI_END -->
