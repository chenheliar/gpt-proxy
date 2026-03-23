# Personal Gateway Pages Template

这是我写给自己用的一套 **Cloudflare Pages + Pages Functions + D1** 中转网关模板。

它的目标很直接：

- 用一个自己的域名统一承接常见 HTTP 请求
- 在 `/admin` 提供一个可视化后台来维护路由
- 尽量不改动原始请求，只在网关层做必要的地址改写
- 让这套东西可以作为 **Pages 项目模板** 反复复用

这不是一个面向公开 SaaS 的网关产品，而是一套偏个人维护、偏自用的部署模板。

## 适合什么场景

我写这个项目，主要是为了解决这类问题：

- 某些上游服务在部分网络环境下访问不稳定
- 我希望把多个上游服务统一收口到同一个域名下
- 我不想每次改配置都去改代码或改反向代理文件
- 我希望在手机上也能直接管理路由

如果你的需求和上面差不多，这个项目就是为这件事做的。

## 当前能力

项目已经内置下面这些能力：

- 路径前缀式代理转发
- `/admin` 可视化管理后台
- 管理员账户初始化、登录、退出
- 路由的新增、编辑、删除、启用、停用
- 路由配置持久化到 D1
- 请求头注入 / 移除
- 是否去掉挂载前缀
- 流式透传，适配 OpenAI / Gemini 这类 streaming 请求
- npm 元数据中的下载链接自动重写
- Docker Registry V2 认证 `WWW-Authenticate` realm 自动改写

内置预设目前包括：

- OpenAI
- Gemini
- npm Registry
- Docker Hub Registry

## 这套网关的设计原则

这个项目有一个很重要的原则：

**尽量只改“请求地址”，不动原始请求本身。**

这也是我后面把 OpenAI / Gemini 预设调整成“仅改 base URL”的原因。  
例如：

```text
https://generativelanguage.googleapis.com/v1beta/models/...
↓
https://your-domain.example/gemini/v1beta/models/...
```

除了域名和挂载前缀发生变化，其他内容尽量保持不变：

- 原始请求方法不变
- 原始请求头尽量保留
- 原始请求体不变
- 流式响应直接透传

如果你确实需要额外处理请求头，也可以在后台里单独配置。

## 一些已经补过的协议细节

除了普通 HTTP 代理之外，项目里还补了几处更偏“可用性”的逻辑：

### 1. Streaming 透传

对 OpenAI / Gemini 这类返回流式数据的接口，网关不会先把响应读完再回给客户端，而是直接透传上游响应流。

### 2. npm 链接自动修复

npm registry 返回的元数据里通常会带上包 tarball 的完整下载地址。  
如果这些地址仍然指向官方域名，客户端后续下载就会绕开网关。

这里已经做了自动重写：当上游是 `registry.npmjs.org` 时，元数据里的相关 URL 会改回你自己的网关域名。

### 3. Docker V2 认证重定向修复

Docker Registry V2 的认证流程里，服务端会通过 `WWW-Authenticate` 返回一个 `realm`。  
如果不处理，Docker 客户端会直接跳回官方认证域名。

这里已经做了两层处理：

- 把返回头里的 `realm` 改写成网关内部地址
- 由网关再去请求真实认证地址

这样 Docker 客户端看到的认证入口仍然是你的域名。

## 后台里一条路由的含义

后台维护的每条路由，本质上对应下面几个字段：

- `name`：路由名称
- `mount_path`：挂载路径，例如 `/openai`
- `target_base`：目标上游地址，例如 `https://api.openai.com`
- `strip_prefix`：转发时是否去掉挂载前缀
- `inject_headers`：额外注入的请求头
- `remove_headers`：需要移除的请求头
- `enabled`：是否启用

一个最简单的例子：

- 挂载路径：`/gemini`
- 目标地址：`https://generativelanguage.googleapis.com`
- 去前缀：开启

那么：

```text
https://your-domain.example/gemini/v1beta/models
```

会被转发到：

```text
https://generativelanguage.googleapis.com/v1beta/models
```

## 管理后台

后台路径固定是：

```text
/admin
```

后台目前支持：

- 首次初始化管理员
- 登录 / 退出
- 查看路由统计
- 表格式管理路由
- 弹窗创建 / 编辑路由
- 移动端响应式管理

账户、会话、路由数据都存放在 D1 里。

## 数据库结构

当前迁移文件是：

- `migrations/0001_init.sql`

里面会创建三张表：

- `admins`
- `sessions`
- `routes`

其中：

- 管理员密码使用哈希 + salt 存储
- 会话只保存 token 的哈希，不保存明文 token

## 部署方式

这个仓库现在已经被整理成一套 **可复用的 Pages 项目模板**。  
你可以用两种方式部署。

### 方案 A：Cloudflare 控制台部署（不使用命令行）

如果你不想碰命令行，可以直接走控制台：

1. 把仓库推到 GitHub
2. 在 Cloudflare Pages 里选择 **连接 Git 仓库**
3. 选择这个仓库
4. 构建配置里保持：
   - 构建命令：留空
   - 输出目录：`.`
5. 创建一个 D1 数据库
6. 在 Pages 项目设置里添加 D1 绑定：
   - Binding name：`DB`
7. 打开 `migrations/0001_init.sql`
8. 把 SQL 内容复制到 Cloudflare D1 控制台执行一次
9. 在 Pages 环境变量中添加 `ADMIN_SETUP_TOKEN`
10. 重新部署 Pages

完成后，访问 `/admin` 初始化第一个管理员账户即可。

### 方案 B：命令行一键初始化

如果你使用 Wrangler，可以直接运行：

```bash
npm install
npm run setup -- --project my-gateway
```

可选参数：

```bash
npm run setup -- --project my-gateway --database my-gateway-db
```

如果你只想创建 D1 并写回配置，先不部署：

```bash
npm run setup -- --project my-gateway --skip-deploy
```

这个脚本会做下面这些事：

1. 检查 Wrangler 登录状态
2. 创建 D1 数据库
3. 回填 `wrangler.toml`
4. 执行本地迁移
5. 执行远端迁移
6. 首次部署到 Cloudflare Pages
7. 后续通过 `ADMIN_SETUP_TOKEN` 完成首次管理员初始化

脚本文件在：

- `scripts/setup-template.mjs`

## 本地开发

安装依赖：

```bash
npm install
```

本地运行：

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

## 项目结构

```text
public/                   静态资源输出目录
public/admin/             后台页面与前端脚本
functions/                Pages Functions 入口
functions/_lib/           代理、鉴权、D1、工具函数
migrations/               D1 迁移文件
scripts/setup-template.mjs
wrangler.toml
package.json
```

几个关键文件：

- `functions/[[path]].js`：Pages Functions 主入口
- `functions/_lib/proxy.js`：代理逻辑与协议补丁
- `functions/_lib/auth.js`：管理员认证与会话
- `public/admin/index.html`：后台页面
- `public/admin/app.js`：后台交互逻辑
- `migrations/0001_init.sql`：数据库初始化

## 安全边界与限制

这个项目适合做：

- 常见 REST 接口中转
- SSE / 流式响应透传
- 包管理 / 镜像类 HTTP 请求中转
- 个人域名统一入口

这个项目不适合做：

- 原始 TCP 转发
- UDP 转发
- WebSocket 以外的非 HTTP 协议直通
- 多租户公网网关服务

也就是说，它本质上还是一个 **基于 Cloudflare Pages Functions 的 HTTP 网关**，不是通用四层代理。

## 我对这份模板的建议用法

如果你准备长期维护它，我建议这样用：

1. 把这个仓库作为模板仓库保留
2. 每个新网关都从模板复制一份
3. 每个实例使用独立的 Pages 项目和独立的 D1
4. 管理后台只给自己用，不要做成公开注册系统

这样最省心，也最符合它本来的定位。

## 最后

这份仓库不是为了“做一个看起来很全的代理平台”，而是为了把一件事情做顺手：

**把常见上游服务统一收口，并且让后续维护尽量简单。**

如果你正需要的也是这个目标，那这套模板应该刚好合适。
