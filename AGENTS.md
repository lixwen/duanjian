# AGENTS.md

本文件适用于整个仓库。修改子目录中的代码前，先遵守这里的约定；若未来某个子目录增加更具体的 `AGENTS.md`，以离目标文件最近的说明为准。

## 项目定位

短笺（Notelet）是一个运行在 Cloudflare Workers、Workers KV 和 R2 上的双语 Markdown/Codex 会话分享服务。前端保持 Telegra.ph 风格的克制、轻量和内容优先；后端负责匿名发布、校验、TTL、限流、存储与安全响应头。

- Node.js 20+
- ESM 项目（`"type": "module"`）
- 浏览器端：原生 JavaScript、Milkdown/Crepe、Vite
- Worker 端：严格模式 TypeScript
- 测试：Vitest
- 部署：Wrangler + Cloudflare Workers Static Assets

## 目录与权威来源

- `public/index.html`：唯一主页面结构和 SEO 静态内容。
- `public/app.js`：编辑器、阅读页、会话页、目录、上传、发布和客户端路由逻辑。
- `public/styles.css`：全站视觉与响应式规则；不要在运行时写零散内联样式。
- `public/i18n.js`：所有界面文案；新增或修改文案时必须同步 `zh` 和 `en`。
- `public/mermaid-renderer.html`、`public/mermaid-renderer.js`：隔离的 Mermaid 渲染入口。
- `src/index.ts`：Worker 入口、API 路由、KV/R2、TTL、限流、CSP、重定向与定时清理。
- `src/markdown.ts`：Markdown 安全渲染；原始 HTML 在这里转义。
- `src/conversation.ts`：结构化 Codex 会话的校验、规范化和渲染边界。
- `src/status.ts`：公开状态页聚合数据及可选 Cloudflare Analytics 查询。
- `test/`：行为测试和静态回归测试；行为变化必须在这里补测试。
- `docs/ARCHITECTURE.md`、`docs/DEPLOYMENT.md`：架构与部署的详细背景。

`dist/` 是 Vite 生成物，`node_modules/` 是依赖，均不要手工编辑或提交。`.dev.vars`、`.env*`、`.wrangler/`、`.audit/` 也不得提交。

## 开发流程

首次安装或锁文件未变化时优先使用：

```bash
npm ci
cp .dev.vars.example .dev.vars
```

常用命令：

```bash
npm run dev       # 先构建，再启动本地 Wrangler Worker
npm test          # 运行全部 Vitest 测试
npm run check     # TypeScript 类型检查
npm run build     # 构建 public/ 到 dist/
npm run validate  # check + test + build
npm run deploy    # 构建并发布到 Cloudflare
```

实现改动时遵循以下顺序：

1. 先阅读目标代码和对应测试，不凭文件名猜行为。
2. 保持改动聚焦，优先复用现有函数、CSS token 和组件结构。
3. 行为变化补充或更新测试。
4. 至少运行与改动相关的测试；交付前优先运行 `npm run validate`。
5. UI 改动除自动化检查外，还要用真实浏览器验证目标视口。

不要在未得到明确授权时执行 `npm run deploy`、创建提交或推送远端。

## 客户端与视觉约定

- 保持原生浏览器模块，不引入新的前端框架或额外状态管理层。
- 保持现有纸张色、紧凑工具栏、克制阴影和内容优先的视觉语言。
- 编辑模式和预览模式共用正文排版 token；修改标题、段落、列表、代码、表格等样式时必须同时检查 `.markdown-body` 与 `.visual-editor .milkdown .ProseMirror`。
- Milkdown 会为列表、代码块、图片等增加包装 DOM。覆盖样式前先在浏览器中检查真实 DOM，不要只根据 Markdown 输出结构写选择器。
- 左侧目录展开时，正文和 `.product-info` 都必须避让目录。响应式改动至少检查 390、900、1100、1400 CSS px；不得出现横向滚动、覆盖或裁切。
- 顶部工具栏控件必须共享垂直中心线，并保留键盘焦点、ARIA、Escape 和方向键行为。
- 新增用户可见文案必须通过 `public/i18n.js`，不得只写一种语言。

## Mermaid 边界

- 主页面不得直接导入或执行 Mermaid；编辑和阅读预览统一通过同源隐藏 iframe 渲染。
- 渲染器保持 `securityLevel: "strict"`，并继续限制输入长度。
- Mermaid 返回的 SVG 必须在隔离页中规范化为合法 XML，再以图片形式交给主页面；不要在主页面使用 `innerHTML` 注入 SVG。
- `vite.config.js` 必须保留主页面与 `mermaid-renderer.html` 两个构建入口。
- `/mermaid-renderer.html` 使用独立 CSP、`SAMEORIGIN` framing 和 `no-transform` 缓存策略。不要为了消除第三方脚本告警而放宽主页面或渲染器 CSP。
- 修改该流程后，应至少验证：普通流程图、带中文和 `<br>` 的节点、带文字的分支边、错误语法，以及“仅看图形/编辑源码”切换。

## Worker 与安全不变量

以下约束不能在没有明确安全说明和测试的情况下削弱：

- Markdown 原始 HTML 必须转义；链接只允许 `http:`, `https:`, `mailto:`, `/` 和 `#`。
- 文档、会话和图片的大小上限、slug 校验、TTL 范围及匿名发布限流必须保留。
- 每次读取都检查 `expiresAt`；不能只依赖 KV 的最终过期删除。
- R2 bucket 保持私有，图片只通过 Worker 的 `/i/:key` 提供。
- 会话只导出可见消息、可见进度和可读摘要；不得保存或发布隐藏思维链、系统/开发者指令、凭据或原始工具载荷。
- 主页面 CSP 保持严格；`style-src 'unsafe-inline'` 仅限隔离 Mermaid 页面。
- `notelet.youcaidi.link` 是 canonical origin，`md.youcaidi.link` 保持永久重定向并保留路径与查询参数。
- 不得提交 `.dev.vars`、Cloudflare token、Wrangler 登录信息、真实私有文档或会话导出。

当前主要内容限制写在 `src/index.ts` 和 `src/conversation.ts`，修改限制时以代码中的常量为准，并同步错误信息、测试和文档。

## 测试与验收

- Worker/API/安全头：优先在 `test/*.test.ts` 中覆盖。
- 客户端结构、双语键、样式约束：使用现有 `test/*.test.js` 模式。
- Markdown 变化需覆盖转义、链接安全、代码语言类名和 raw HTML。
- 会话变化需覆盖结构上限、同源图片、公开导出边界和 fixture。
- 响应式布局不能只检查 CSS 字符串；关键修复要用浏览器的实际边界或截图确认。
- 构建出现 bundle size warning 时先判断是否为 Mermaid 的按需隔离 bundle；不要为消除警告把 Mermaid 合并进主包。

## 部署与上线检查

部署前运行：

```bash
npm run validate
```

部署后至少只读验证：

- `/` 返回 200，并引用本次构建的新哈希资源。
- `/mermaid-renderer.html` 返回渲染器 HTML，而不是 SPA 首页。
- 主页面与 Mermaid 页面分别带正确 CSP 和 `X-Frame-Options`。
- `/status`、中英文切换和一个临时发布流程可用。
- 涉及图片或 TTL 时，再验证上传、读取、过期响应和清理元数据。

`wrangler.jsonc` 含生产资源 ID、域名、限流和定时任务配置。除非任务明确涉及基础设施，不要顺手修改这些值。生产发布与 Git 推送是两件独立操作，完成后分别报告 Cloudflare Version ID 与 Git commit。
