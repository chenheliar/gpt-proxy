# Personal Gateway Pages Template

一个部署在 **Cloudflare Pages** 上的个人自用中转网关模板，内置：

- 基于路径前缀的 HTTP 网关转发
- D1 持久化路由管理
- `/admin` 可视化管理后台
- 管理员账号 / 会话登录
- OpenAI、Gemini、npm、Docker 等常见上游的适配逻辑

这个项目的设计目标很明确：**尽量只改请求入口地址，不改原始请求本身。**

例如把：

```text
https://generativelanguage.googleapis.com/v1beta/models/...
```

改为：

```text
https://your-domain.example/gemini/v1beta/models/...
```

除地址前缀变化外，请求方法、请求头、请求体、流式响应都尽量保持原样透传。

---

## 适用场景

适合这类个人部署需求：

- 统一收口多个上游服务到同一个自有域名
- 在部分网络环境下，为官方 API / Registry 提供稳定入口
- 通过后台维护路由，而不是每次都改代码
- 希望在手机上也能完成日常管理

不适合：

- TCP / UDP 四层转发
- 非 HTTP 协议的通用代理
- 面向公众开放的多租户网关平台

它本质上是一个运行在 **Cloudflare Pages Functions** 上的 HTTP 网关，而不是通用网络代理。

---

## 当前能力

### 网关能力

- 路径前缀路由转发
- 请求头注入 / 删除
- 是否去除挂载前缀
- 路由启用 / 停用
- 流式响应透传（适配 OpenAI / Gemini 一类 streaming 请求）

### 协议适配

- **OpenAI / Gemini：** 支持流式透传，不要求把 API Key 写在路由里
- **npm Registry：** 自动重写元数据中的 tarball 下载地址，避免后续请求绕过网关
- **Docker Registry V2：** 自动重写 `WWW-Authenticate` 里的 `realm`，并通过网关继续完成认证流程

### 后台能力

- `/admin` 管理后台
- 首次初始化管理员账户
- 账号密码登录
- 路由列表管理
- 弹窗式新增 / 编辑路由
- 移动端响应式管理界面

---

## 路由模型

后台中的每条路由主要包含以下字段：

- `name`：路由名称
- `mount_path`：挂载路径，例如 `/gemini`
- `target_base`：目标上游地址，例如 `https://generativelanguage.googleapis.com`
- `strip_prefix`：转发时是否去掉前缀
- `inject_headers`：额外注入的请求头
- `remove_headers`：需要移除的请求头
- `enabled`：是否启用

以 Gemini 为例：

- 挂载路径：`/gemini`
- 目标地址：`https://generativelanguage.googleapis.com`
- 开启去前缀：`true`

则：

```text
https://your-domain.example/gemini/v1beta/models/gemini-flash-latest:generateContent
```

会被转发到：

```text
https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent
```

请求头中的 `X-goog-api-key` 会继续按原样传递，不需要额外写入路由配置。

---

## 内置预设

管理后台内可直接创建以下常见预设：

- OpenAI → `https://api.openai.com`
- Gemini → `https://generativelanguage.googleapis.com`
- npm → `https://registry.npmjs.org`
- Docker → `https://registry-1.docker.io`

这些预设只是便捷填充，后续仍可按需修改。

---

## 数据存储

项目使用 **Cloudflare D1** 持久化以下数据：

- `admins`：管理员账户
- `sessions`：登录会话
- `routes`：路由配置

当前初始化迁移文件：

- `migrations/0001_init.sql`

密码不会明文存储；会话也不会直接保存原始 token。

---

## 项目结构

```text
public/                     静态资源输出目录
public/admin/               管理后台页面与前端脚本
public/_headers             Cloudflare 静态响应头配置
functions/                  Pages Functions 入口
functions/_lib/             认证、数据库、代理、工具函数
migrations/                 D1 迁移文件
scripts/setup-template.mjs  一键初始化脚本
wrangler.toml               Wrangler / Pages 配置
package.json                项目脚本
```

关键文件：

- `functions/[[path]].js`：Functions 主入口、API 路由与静态访问保护
- `functions/_lib/proxy.js`：代理逻辑、Streaming、npm / Docker 适配
- `functions/_lib/auth.js`：管理员认证与会话逻辑
- `functions/_lib/db.js`：D1 数据访问
- `functions/_lib/utils.js`：校验、哈希、CORS、安全工具
- `public/admin/index.html`：后台页面
- `public/admin/app.js`：后台交互逻辑

---

## 本地开发

安装依赖：

```bash
npm install
```

本地启动：

```bash
npm run dev
```

语法检查：

```bash
npm run check
```

手动部署：

```bash
npm run deploy -- --project-name my-gateway
```

当前 `wrangler.toml` 已使用：

```toml
pages_build_output_dir = "public"
```

也就是说，Pages 的静态输出目录就是 `public/`。

---

## 不使用命令行的部署方式

如果你希望完全通过 Cloudflare 控制台部署，可以按下面做。

### 1. 导入仓库

1. 把仓库推到 GitHub
2. 打开 Cloudflare Dashboard
3. 进入 **Workers & Pages** → **Create application** → **Pages**
4. 选择 **Connect to Git**
5. 选中这个仓库

### 2. 配置构建

保持最简配置即可：

- Build command：留空
- Build output directory：`public`

### 3. 创建并绑定 D1

1. 在 Cloudflare 控制台创建一个 D1 数据库
2. 打开 Pages 项目设置
3. 在 **Bindings** 中添加 D1
4. Binding 名称填写：`DB`

### 4. 执行数据库初始化

1. 打开 `migrations/0001_init.sql`
2. 将 SQL 内容复制到 Cloudflare D1 控制台执行一次

### 5. 配置环境变量

至少添加：

- `ADMIN_SETUP_TOKEN`：首次初始化管理员账户时必须提供的令牌

### 6. 重新部署

保存配置并重新部署后，访问：

```text
/admin
```

即可进入后台初始化流程。

---

## 命令行一键初始化

如果你使用 Wrangler，也可以直接用脚本完成初始化：

```bash
npm install
npm run setup -- --project my-gateway
```

可选参数：

```bash
npm run setup -- --project my-gateway --database my-gateway-db
```

只创建数据库并写回配置，暂不部署：

```bash
npm run setup -- --project my-gateway --skip-deploy
```

脚本文件：

- `scripts/setup-template.mjs`

这个脚本会协助完成：

1. 创建 D1 数据库
2. 回填 `wrangler.toml`
3. 执行本地与远程迁移
4. 首次部署 Pages 项目

管理员账户本身仍然需要在 `/admin` 中通过 `ADMIN_SETUP_TOKEN` 完成初始化。

---

## 安全说明

这个项目已经做了几层默认加固，但它依然是一个**自用网关模板**，上线前建议你继续按自己的环境补充策略。

### 已内置的安全措施

- **首次初始化保护**
  - `/api/auth/setup` 不再是裸开放接口
  - 必须先在 Pages 环境变量中配置 `ADMIN_SETUP_TOKEN`
  - 首次创建管理员时必须提供这个 token

- **敏感文件不公开**
  - Pages 静态目录已收敛到 `public/`
  - 根目录中的 `wrangler.toml`、`package.json`、`migrations/`、`scripts/`、`functions/` 等不会作为静态资源直接暴露
  - `functions/[[path]].js` 也额外拦截了常见敏感路径访问

- **D1 绑定检查**
  - 如果 Pages 项目未正确绑定 `DB`，接口会返回明确错误，而不是直接崩溃

- **同源约束**
  - 登录、登出、初始化、路由写操作都要求同源请求
  - 后台接口的 CORS 不再无条件开放 `*`

- **上游地址限制**
  - 路由配置只允许 `http` / `https`
  - 拒绝本地、内网、私有地址与保留后缀，避免把网关配置成内部网络跳板

- **Docker 认证重写校验**
  - Docker V2 的 `realm` 在重写时会校验协议和预期认证主机
  - 避免利用伪造 `realm` 做 SSRF 跳转

- **响应头加固**
  - `public/_headers` 已配置基础安全头：
    - `Content-Security-Policy`
    - `X-Frame-Options`
    - `X-Content-Type-Options`
    - `Referrer-Policy`
    - `Permissions-Policy`

- **未知路径不再回首页**
  - 未匹配到静态资源或代理路由时，返回真实 `404`

### 仍建议在 Cloudflare 侧补充的措施

- 为 `/admin*` 加一层 **Cloudflare Access**
- 对以下路径配置 **Rate Limiting**
  - `/api/auth/setup`
  - `/api/auth/login`
  - 公开代理入口，如 `/openai/*`、`/gemini/*`、`/npm/*`、`/docker/*`
- 打开 **Always Use HTTPS**
- 为域名启用 **HSTS**
- 如果只给自己使用，尽量不要把后台入口公开传播

---

## 常见问题

### 1. 进入后台提示 `Cannot read properties of undefined (reading 'prepare')`

说明当前 Pages 项目没有正确绑定 D1，或者绑定名称不是 `DB`。

检查项：

- Pages 项目是否已绑定 D1
- Binding 名称是否为 `DB`
- 是否已经重新部署

### 2. 初始化管理员时报 400

优先检查：

- 是否已经配置 `ADMIN_SETUP_TOKEN`
- 提交时填写的 setup token 是否与环境变量一致
- 用户名是否满足 `3-32` 位规则
- 密码是否至少 `10` 位

### 3. npm 安装仍然走官方域名

确认你的 npm 路由目标地址是否为：

```text
https://registry.npmjs.org
```

只有在匹配 npm Registry 场景时，系统才会自动重写元数据中的 tarball 下载地址。

### 4. Docker 登录时跳回官方认证地址

确认你的 Docker 路由目标地址是否为：

```text
https://registry-1.docker.io
```

系统只对 Docker Registry V2 场景执行 `WWW-Authenticate` 的 `realm` 改写。

---

## 使用建议

我对这套模板的推荐使用方式是：

1. 把它作为个人模板仓库保留
2. 每个独立实例使用自己的 Pages 项目和 D1 数据库
3. 只在后台维护自用路由，不做公开注册系统
4. 把它当成“稳定入口层”，而不是复杂业务平台

如果你的目标是：

**把常见上游统一收口，并把维护成本压低到足够简单。**

那么这套模板就是为这件事写的。

