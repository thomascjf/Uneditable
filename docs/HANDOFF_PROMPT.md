# 另起任务的交接 Prompt（整块复制下面代码块即可）

以下代码块内容自包含，新任务无需读取本对话历史。

```
你是本次黑客松的工程实现负责人。请独立完成代码落地、公网部署与 GitHub 归档，不要等待当前对话的进一步输入。

【工作目录】
D:\work\WorkBuddy\web3-monad-guangzhou-261121
先读 docs/PLAN.md（完整执行方案）、teams.json（40 支队伍，投票选项唯一来源）、AGENTS.md（MOJO 提醒块，禁止修改）、.gitignore。

【背景】
活动「Monad Blitz@广州」（eventId=18），一日线下黑客松，提交截止 2026-11-21 18:30（UTC+8），19:00 三分钟 Demo，名次由现场观众投票决定。官方硬规则：代码当天从零编写（标准库可用）、必须有公网可访问的 Demo 链接（本地跑不计入评选）、公开 GitHub 仓库、3 分钟演示。评审偏好新颖机制与探索 Monad 极限，不看重 UI 和功能清单。

【要做的产品】
「现场留言 + 实时投票」双栏对照应用。大屏左栏读中心化数据库、右栏读 Monad 测试网合约，同一份内容双写。观众扫码进手机页，从写死的 40 支队伍里选队投票并留言；页面有「我自己有 Monad 代币，自己付 gas」开关，默认开启（连钱包直签），取消则由 passkey 指纹签名 + 转发器代付 gas。演示时把后台管理二维码投屏，请台下观众亲手改票数、删留言，左栏立刻变、右栏纹丝不动，再点开交易哈希在浏览器验证。

【只放大两个亮点】
1. 零门槛上链入口：passkey + 转发器代付 gas + 合约内用 Monad P256 预编译 0x0100 直接验签。收尾讲成「换一份 teams.json，下一场活动就能直接复用的基础设施」，而不是「一个投票应用」。
2. 让观众亲手篡改（现场钩子，用来换票）。
明确不讲：600ms 出块、低手续费、「流式执行事件让大屏不用索引器」。同场队伍 id=640「GENESIS GARAGE」也在做「无钱包 + 扫码 + 大屏 + Monad」，禁止用「扫码上链」当主叙事，差异化压在「可复用基础设施」和「亲手篡改对照」上。

【已实测结论，别重复摸索】
- Testnet RPC https://testnet-rpc.monad.xyz 可用，chainId 10143（0x279f）；区块浏览器 https://testnet.monadvision.com/（testnet.monadexplorer.com 会 308 跳过去）
- P256 预编译 0x0100 确认可用：160 字节输入 hash||r||s||qx||qy，有效签名 eth_call 返回 32 字节 1、无效返回空、gas 6900；官方文档 docs.monad.xyz/developer-essentials/precompiles 给出 Solidity staticcall 示例并明确「enabling on-chain verification of WebAuthn/passkey signatures」
- webauthn-sol 在 npm 不可得，链上 WebAuthn 验证需自写；@simplewebauthn/server 14.1.0 可用于服务端辅助与自测
- 依赖可装：viem 2.58.4 / solc 0.8.39 / express 5.3.0；本机 Node v22.22.2
- eth_sendRawTransactionSync 实测 503（screening unavailable），只作可选优化不作核心链路；faucet.monad.xyz 返回 429
- 队伍已写死，不拉 teamup 接口（该页仅参赛者登录可见，无公开接口）

【技术架构】
单端口 Node/Express 服务：静态托管大屏 / 手机页 / 管理页 + /api + SSE + 转发器 + 中心化 store.json。手机端不直连 RPC，所有链上读写走后端代理（现场手机网络不稳、公共 RPC 有 20rps 限流）。合约 BlitzBoard.sol 两个写入口写同一数组：vote() 用钱包 EIP-712 直签；voteByPasskey() 由转发器提交，合约校验 clientDataJSON 的 type / origin / challenge、authData 的 rpIdHash 与 UP/UV 标志，再 staticcall 0x0100 验签。必须做死防重放、一次性 challenge、每凭据与每地址限投一票。前端原生 JS 不上框架，合约用 solc 直接编译，不引 Hardhat/Foundry。

【分级交付，按时间砍】
L0 必达：钱包直签路径 + 双栏大屏 + 中心化库 + 管理页篡改 + 扫码投票 + 公网可访问。仅这一层就能完整演示。
L1 核心：passkey + 转发器代付 + 合约内 P256 验签 + 防重放限投。
L1' 降级：链上 WebAuthn JSON 解析卡住时，验签移到服务端、合约只存 credHash 与签名摘要作可查存证，界面与「0 门槛」体验不变；讲解时如实说明，不冒充链上验签。
L2 加分：确认耗时显示、5 位没碰过钱包的同学实测数据、录屏兜底。
16:30（剩 2 小时）前 L1 未跑通真机就切 L1'，不再死磕。

【凭证与安全】
- 检查 .workbuddy/deploy-key.txt：需要一个专用一次性测试网钱包私钥（部署合约 + 转发器代付）。若不存在，请用户写入该文件，不要让用户贴在聊天里，绝不入库、绝不打印。这是硬阻塞，优先解决。
- .mojo/agent.json 是 Mojo Agent 凭证，同样绝不入库、绝不打印。
- 发布工具会压缩上传整个目录但只排除 node_modules/.git/build：必须另建独立 deploy/ 目录只放运行必需文件，隔离 .mojo/、.workbuddy/、other-docs/、docs/。
- WebAuthn 需 HTTPS 且 rpId 绑定域名：域名先定，部署成功后才开始 passkey 自测，之后不再改域名。

【公网部署】
主方案用 WorkBuddy 应用发布（备选 Railway / Render / Vercel）。服务必须监听 $PORT 环境变量并绑定 0.0.0.0，用 npm start 起 Express。发布属于写线上链接的操作，需用户明确说「发布 / 上线」才执行。部署后按顺序验收 7 项：线上 eth_chainId 通 → 合约地址在浏览器可查且 ABI 已同步 → 三个页面在手机 4G（非同一 WiFi）下 HTTPS 可开 → 真机 passkey 投票成功 → 左栏篡改右栏不变且右栏 2 秒内刷新 → 转发器余额够 → 三个二维码（投票/管理/水龙头）指向线上而非 localhost。

【GitHub 与提交边界】
本地已有 main 分支与 4 次提交（最新 304533f 是方案文档），可继续正常提交，但不要改写或 amend 已有提交、不要 force push、不要动 AGENTS.md 的 MOJO 提醒块。由你负责创建公开 GitHub 仓库、推送归档并给出仓库地址。Mojo 提交用 mojo-submit skill（凭证 .mojo/agent.json），需准备：项目名、简介、Demo 链接、GitHub 地址、至少一张自己上传的截图（建议大屏双栏 + 篡改前后各一张）；提交后进 pending 等人工审核。

【交付物】
合约地址与 ABI（写进 README）、公网 Demo 链接、公开 GitHub 地址、三张二维码物料、2 页极简 PPT（P1 一句话钩子、P2 架构图只高亮 P256 预编译）、三分钟逐句讲稿、剪贴板预置项、截图、录屏兜底。逐句脚本、Q&A 三问与现场检查清单见 docs/PLAN.md 第 8 节。

【时间纪律】
每次开始工作先用系统时间算距 18:30 的剩余时长并告诉用户。剩 ≤2 小时停止开新功能、专注可运行可演示；剩 ≤30 分钟先查 Mojo 是否已提交，未提交立即提交现有成果。不要再把创意发给创意导师（方案已定，今日额度剩 19/20 无需使用）。

最后请汇报：实际跑通到哪一级、线上 Demo 链接、GitHub 地址、合约地址、未完成项与剩余风险。
```
