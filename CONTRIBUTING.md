# Contributing / 参与贡献

Thank you for helping improve Notelet. Bug reports, documentation fixes, translations, and focused code changes are welcome.

感谢你帮助改进短笺。欢迎提交缺陷报告、文档修正、翻译和范围明确的代码改动。

## Development workflow / 开发流程

1. Fork the repository and create a branch from `main`.
2. Install dependencies with `npm ci`.
3. Copy `.dev.vars.example` to `.dev.vars` for local-only secrets.
4. Keep changes focused and add tests for behavior changes.
5. Run `npm run validate` before opening a pull request.

1. Fork 仓库并从 `main` 创建分支。
2. 使用 `npm ci` 安装依赖。
3. 将 `.dev.vars.example` 复制为 `.dev.vars`，仅在本地保存密钥。
4. 保持改动范围清晰，行为变化需要补充测试。
5. 提交 Pull Request 前运行 `npm run validate`。

## Project conventions / 项目约定

- Use TypeScript for Worker code and plain browser modules for the client.
- Put user-facing text in `public/i18n.js`; update both `zh` and `en` entries.
- Do not weaken Markdown sanitization, TTL checks, content limits, or rate limiting without documenting the security impact.
- Never commit `.dev.vars`, Cloudflare API tokens, account credentials, or exported private conversation data.
- Preserve the compact Telegra.ph-inspired visual language and test desktop and narrow layouts.

## Pull requests

Describe the problem, the chosen solution, verification performed, and any deployment or migration impact. By contributing, you agree that your contribution is licensed under the MIT License.
