# OutcomeX

OutcomeX 是一个面向 AI Agent 的可验证链上数据按次付费网络。v0.1 先验证一个最小闭环：服务目录 → 报价 → 模拟支付 → 可复核结果 → 收据；真实 USDC 验证与链上结算仍是下一阶段。

## 当前状态

- `frontend/`：产品首页、服务目录和请求演示面板。
- `backend/`：订单和服务 API（由后端实现提供）。
- `contracts/`：结算合约（由合约实现提供）。
- `backend/providers/evm.js`：可选的只读 EVM RPC Provider。
- `outputs/outcomex-product-spec-v0.1.md`：完整产品规格。

## 本地开发目标

默认后端监听 `http://localhost:8787`。直接打开 `frontend/index.html` 也可以查看产品界面；后端未启动时，页面会使用本地演示数据。

启动方式以 `backend/README.md` 和 `contracts/README.md` 为准。

没有配置 RPC 时，三种服务都使用确定性 Mock；配置 `OUTCOMEX_RPC_URL` 后只有 `wallet_snapshot` 使用真实 EVM 读取，结果中的 RPC 依据仍不是独立密码学证明。付款默认是模拟模式，不会转账。

## 快速启动

在一个终端启动 API：

```powershell
cd backend
npm start
```

在另一个终端提供前端静态文件：

```powershell
python -m http.server 4173 --directory frontend
```

然后打开 `http://localhost:4173`。

## 设计原则

第一版只支持确定性、可重放的链上数据服务；不托管私钥、不发行代币、不承诺收益。协议分账只在模拟收据中计算，未发生资金转移；真实收费必须等付款验证器和结算合约接入后再启用。
