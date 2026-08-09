# Deployment / 部署

## Cloudflare resources

Duanjian expects these bindings in `wrangler.jsonc`:

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

`wrangler.jsonc` contains deployable resource identifiers and a public hostname, not account credentials. Authentication remains in Wrangler's user configuration and must never be committed.

## 部署自己的实例

创建 KV 和 R2 后，将 `wrangler.jsonc` 中已有的资源 ID、bucket 名称和域名 route 替换为自己的配置。部署前运行 `npm run validate`，部署后验证首页、临时文档、图片上传、过期行为和中英文切换。Wrangler 登录凭据不得提交到仓库。
