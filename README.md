# BSC v4 Liquidity Guard

一个使用 WSS 新区块通知和多 HTTP RPC `latest` 状态共识的 Uniswap v4 BSC 流动性监控器：同时监控多个目标 `nftId`，任意目标流动性减少时自动撤出自己的 `nftId`，并使用 OKX DEX Aggregator 将取回的非稳定币换成配置的稳定币。

## 使用

```bash
npm install
cp .env.example .env
npm start
```

访问 http://127.0.0.1:3000。对方 NFT ID 输入框支持使用逗号、空格或换行填写多个 ID，再填写我的 NFT ID 和卖出滑点并保存。默认滑点为 `1%`（`100 BPS`）；需要真实执行时，把 `.env` 中 `AUTO_EXECUTE` 改为 `true`，并配置专用小额钱包私钥及 OKX DEX API 凭证。启动时会先由多个 RPC 逐个验证所有目标 NFT 与我的 NFT 使用同一风险代币、每个目标流动性非零、钱包确实持有自己的 NFT，然后才进入布防；稳定币一侧允许在 `stablecoins` 白名单内不同，各仓位也可以位于不同费率、tickSpacing 或 hooks 的池子。布防后由 WSS 新区块通知立即唤醒检查，并要求多个 HTTP RPC 对所有目标的最新流动性形成同一份共识，WSS 断开时继续使用 HTTP 轮询。撤出后会根据我的仓位池子的 token，在 `config.json` 的 `stablecoins` 白名单中识别 USDT、USD1、USDC、U 等目标稳定币，并将另一个资产兑换成我的池子原本的稳定币；如果池子没有匹配到白名单币种，则兑换成 `stablecoin` 中配置的默认 USDT。

配置 `ADMIN_PASSWORD` 后，管理页面和全部业务 API 都要求登录。登录会话使用 HttpOnly、SameSite=Strict Cookie，写操作还需要 CSRF 令牌；同一来源 15 分钟内连续失败 5 次会暂时限制登录。`ADMIN_PASSWORD` 至少 12 个字符，`AUTH_SESSION_HOURS` 默认 12 小时。只有在 HTTPS 反向代理已经生效后才可设置 `AUTH_COOKIE_SECURE=true`。登录保护不能替代 HTTPS：如果通过公网访问，仍必须使用 TLS，不能直接开放明文 HTTP 端口。

输入 NFT ID 后，页面会逐个显示所有目标仓位和我的仓位。每张仓位卡保留稳定币和代币的预计本金数量，并使用该仓位池子的当前价格把代币侧折算成对应稳定币，额外显示“仓位估值”；多个目标仓位会按稳定币币种分别汇总估值。估值不包含尚未结算的手续费，也没有扣除真实卖出时的价格冲击、滑点和 Gas，因此不等于最终可兑换到账金额。点击“验证并布防”后，按钮会切换为“已布防”；所有手动操作和后台阶段变化都会显示顶部通知。执行结果会标明触发撤退的目标 NFT、流动性下降前后数值、撤退状态、关键耗时、兑换方向、实际稳定币到账和交易链接；交易入块后的确认及到账核验时间单独标记为“不重要”，不计入撤退、兑换和关键总耗时。

## 重要限制

- WSS 新区块通知会立即唤醒仓位和交易回执检查，HTTP 轮询每 `450ms` 监控仓位并以 `receiptPollIntervalMs` 兜底查询回执；所有目标仓位默认在同一区块读取 BSC `latest` 状态，并要求至少 2 个独立 HTTP RPC 对整组流动性返回一致结果。RPC 按历史延迟、失败次数、正在处理的请求和冷却状态排序，连续失败节点会暂时移出热路径。
- WSS Provider 在服务进程内跨执行轮次复用；每轮完成或手动停止后只进入空闲，不调用 ethers 的订阅取消和 `destroy()`，避免 `eth_unsubscribe` 清理竞争导致 Node 进程退出。
- 布防期间以独立的 `myPositionCheckIntervalMs` 周期检查我的 NFT，不阻塞对方仓位的快速监控。若检测到我的流动性已在外部撤空、NFT 已转移或池子与布防基线不一致，会立即解除布防并通知；不会把钱包原有余额或外部撤仓到账误当成本轮资产进行兑换。
- 链上交易在本地离线签名后并行广播到多个 RPC，同一原始交易的哈希和 nonce 不变，不会因为多节点广播而生成多笔交易。
- 布防时会取得非稳定币对应的 OKX spender；如果尚未无限授权，会先发送 `MaxUint256` 授权并等待首次入块，授权成功后才进入监控。撤仓使用 `withdrawConfirmations=1`，首次入块后立即读取准确到账数量并进入兑换准备；兑换使用独立的 `swapConfirmations=2`，首次入块后的额外确认等待不计入关键耗时。预准备失败、spender 变化或报价过期时才退回串行安全路径。
- 所有交易采用 RPC 建议值、OKX fast 建议值与 `minGasPriceGwei` 三者中的最高值，并继续受 `maxGasPriceGwei` 上限保护；默认最低 `0.1 Gwei`。
- “只读检查”不会执行撤仓；只有成功“验证并布防”后，任意目标 NFT 的流动性低于它上一次获得多节点共识的数值才会触发。增加流动性不会触发，但会成为下一次比较的新参考值；落后于已处理区块的 RPC 结果不会触发。
- 布防前会使用官方 `web3.okx.com` 接口验证 OKX 凭证和 BSC 兑换服务可达。预检失败时拒绝布防，避免先撤仓后才发现兑换接口无法连接。OKX GET 请求会有限重试，并在日志中记录具体端点和 DNS、连接超时或主机不可达原因。
- 撤出和每笔兑换状态会写入本地 `.guard-action.json`。兑换失败后不会再次撤仓；停止监控并点击“重试兑换”时，会先检查已有交易哈希和资产余额，状态不明确时拒绝重复发送。
- 撤退及兑换全部完成后会自动停止监控、解除布防并清空本轮触发基线，但保留执行摘要；输入新的 NFT ID 后可以开始下一轮。
- 兑换通过 OKX `/api/v6/dex/aggregator/approve-transaction` 获取授权 spender，授权 calldata 在本地严格编码；再通过 `/api/v6/dex/aggregator/swap` 获取聚合交易 calldata。OKX API 的滑点由 `maxSlippageBps` 转为百分比传入。
- OKX API 密钥只放在服务端 `.env`，不要放到前端或提交到 Git。服务默认仅监听 `127.0.0.1`。
