# Architecture / 架构

## Components

- The browser application in `public/` provides the visual/source editor, reader, searchable conversation view, local share management, table of contents, image paste flow, and Chinese/English localization.
- The Worker entry point in `src/index.ts` owns routing, validation, TTL enforcement, rate limits, storage access, security headers, and scheduled image cleanup.
- `src/markdown.ts` converts Markdown into safe HTML with raw HTML disabled.
- `src/conversation.ts` validates and normalizes structured conversation payloads.
- `src/share-page.ts` derives and safely injects per-share canonical, Open Graph, and Twitter metadata into the application shell.
- Workers KV stores document and conversation records. R2 stores images privately.

## Request flow

1. The client uploads pasted images to `POST /api/images` and receives Worker-owned image URLs.
2. Publishing sends Markdown or structured turns with a requested TTL.
3. The Worker validates size, slug, TTL, and content before storing a versioned record plus a SHA-256 management-token digest in KV. The plaintext token is returned once to the publisher.
4. A read checks the record's `expiresAt` even if KV has not physically removed it yet.
5. Public HTML reads inject share-specific preview metadata without exposing editable source or management credentials.
6. Authenticated `GET`, `PATCH`, and `DELETE` requests to `/api/shares/:slug` allow the browser-local `/mine` view to retrieve source, update content or expiry, and revoke a share.
7. Images are served through `/i/:key`; per-share references prevent one share from deleting an image still used by another, and a scheduled task deletes abandoned or expired R2 objects.

## Conversation model

A conversation is not flattened into one Markdown document. Each visible user turn, assistant answer, commentary section, reasoning summary, and referenced image remains a distinct structured item. This preserves Codex-like navigation and lets every assistant answer render as independent Markdown.

The reader derives stable per-turn anchors from exported turn IDs (with a content fingerprint fallback), so search, copied links, disclosure state, and answer-only mode remain client-side concerns without changing the stored conversation model.

The export boundary intentionally excludes hidden chain-of-thought, system instructions, developer instructions, credentials, and raw tool payloads.

## 中文摘要

浏览器端负责编辑、阅读、会话搜索与轮次链接、本地分享管理、目录、图片粘贴及中英文切换；Worker 负责校验、限流、TTL、管理鉴权、动态链接预览、安全响应头和存储。KV 保存文档及结构化会话，只保存管理密钥的 SHA-256 摘要；R2 私有保存图片，并通过逐分享引用避免误删复用图片。会话不会被压成单篇 Markdown，而是保留每一轮可见消息的结构；隐藏思维链、系统指令、凭据和原始工具载荷不属于导出边界。
