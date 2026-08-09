# Deployment / 部署

## Cloudflare resources

Notelet expects these bindings in `wrangler.jsonc`:

- `DOCS`: Workers KV namespace for documents and conversations
- `IMAGES`: private R2 bucket for images
- `PUBLISH_LIMITER`: publish rate-limit binding
- `IMAGE_LIMITER`: image-upload rate-limit binding

The scheduled trigger runs daily to remove expired or abandoned images.

## Deploy a fork

1. Create a KV namespace and R2 bucket with Wrangler.
2. Replace the existing resource identifiers, bucket name, and custom-domain route in `wrangler.jsonc`.
3. Review rate limits and compatibility date for your account.
4. Run `npm run validate`.
5. Run `npm run deploy`.
6. Verify `/`, a temporary document, an image upload, expiration behavior, and both interface languages.

## Optional status analytics

`/status` works without an API token and directly counts documents and R2 objects. Full operation usage requires:

- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID
- `CLOUDFLARE_ANALYTICS_TOKEN`: a token with read-only Account Analytics permission

Keep the account ID in Worker variables and set the token with `npx wrangler secret put CLOUDFLARE_ANALYTICS_TOKEN`. The public endpoint never returns either value. Usage snapshots are cached for five minutes.

`wrangler.jsonc` contains deployable resource identifiers and a public hostname, not account credentials. Authentication remains in Wrangler's user configuration and must never be committed.

## 部署自己的实例

创建 KV 和 R2 后，将 `wrangler.jsonc` 中已有的资源 ID、bucket 名称和域名 route 替换为自己的配置。部署前运行 `npm run validate`，部署后验证首页、`/status`、临时文档、图片上传、过期行为和中英文切换。状态页无需 token 也能统计文档和 R2；完整操作用量需设置 Account Analytics 只读 token。Wrangler 登录凭据不得提交到仓库。
