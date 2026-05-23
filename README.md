# CF 临时邮箱一键部署器

将 [QLHazyCoder/cloudflare_temp_email](https://github.com/QLHazyCoder/cloudflare_temp_email) 一键部署到你自己的 Cloudflare 账户。本地启动 Web UI，填表 → 实时看日志 → 部署完成。

## 它做了什么

1. 校验你提供的 Cloudflare 凭据（Global API Key + 邮箱）
2. 检查每个域名是否已托管在 Cloudflare
3. 克隆上游仓库（首次）或拉取最新（后续）
4. 创建 D1 数据库 + 应用 `db/schema.sql`
5. 创建 KV namespace
6. 构建前端
7. 生成 `wrangler.toml` 并部署 Worker（含前端资源）
8. 部署独立 Pages 项目（前后端分离）
9. 为每个域名启用 Email Routing 并下发 MX/SPF DNS
10. 配置 Catch-all 把所有邮件路由到 Worker

完成后会显示 Worker URL、Pages URL、随机生成的管理员密码。

## 前置条件

- **Node.js ≥ 18.17**（自带 `fetch`，无需额外依赖）
- **Git** 已安装并在 PATH 中
- 域名 DNS 已托管在 Cloudflare（zone status = `active`）
- Global API Key（CF 控制台 → My Profile → API Tokens 页底部 "Global API Key"）

> Windows / macOS / Linux 均可。Wrangler 通过 `npx --yes wrangler@latest` 自动拉取，无需提前安装。

## 启动

```bash
npm install
npm start
```

浏览器自动打开 [http://localhost:5180](http://localhost:5180)（如未自动打开手动访问即可）。

## 环境变量

- `PORT`（默认 `5180`）

## 安全说明

- 所有凭据仅存在本地 Node 进程内存，不写盘、不上传。
- 工作目录 `./work/` 用于克隆仓库和生成 `wrangler.toml`，请勿提交到 git。
- 生成的管理员密码（16 位随机十六进制）只在 UI 中显示一次，请立即保存。

## 已知限制

- 只支持 Global API Key 认证（按用户要求）。如需 API Token 可在 `lib/cf-api.js` 替换请求头。
- 不处理「带 Telegram Mini App 的前端」、不部署 SMTP/IMAP 代理服务器。
- Email Routing 的 `Catch-all` 会被覆盖。如域名上已有自定义路由规则请先备份。

## 故障排查

| 现象 | 原因 |
|---|---|
| `域名 xxx 未在 Cloudflare 找到对应 zone` | 域名 DNS 未托管在 CF，或在另一个账户下 |
| `wrangler deploy 失败 (退出码 …)` | 看日志栏的 `[wrangler]` / `[deploy]` 行；常见为 `compatibility_date` 过老或 D1 ID 错位 |
| `Pages 项目已存在` | 不影响,会复用现有项目 |
| Email Routing 启用失败 | 该域名可能未通过 CF 验证(zone status ≠ active) |

## 卸载

部署到 CF 上的资源不会自动清理。如需删除：

```bash
# Worker
npx wrangler delete --name cloudflare-temp-email
# Pages
npx wrangler pages project delete cloudflare-temp-email-frontend
# D1
npx wrangler d1 delete temp-email-db
```

Email Routing 的 catch-all 规则需在 CF 控制台手动取消。
