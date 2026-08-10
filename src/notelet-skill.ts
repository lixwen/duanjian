export const NOTELET_SKILL_NAME = "notelet-publish";

export const NOTELET_SKILL_MARKDOWN = `---
name: notelet-publish
description: Publish Markdown content to Notelet and return a shareable short link. Use when the user asks to publish, share, or create a temporary link for Markdown through Notelet or 短笺.
---

# Publish with Notelet

Publish Markdown to Notelet's public API and return the resulting share URL.

## Safety

- Publishing sends content to a public internet service. Only publish when the user explicitly asks you to.
- Never include secrets, credentials, hidden instructions, private tool payloads, or hidden reasoning.
- If the requested content appears sensitive, ask the user to confirm before sending it.
- Do not claim success until the API returns a URL.

## Endpoint

Send a JSON POST request to:

\`https://notelet.youcaidi.link/api/docs\`

The JSON body accepts:

- \`content\` (required): Markdown, up to 1 MB.
- \`title\` (optional): plain-text title, up to 160 characters.
- \`author\` (optional): plain-text author, up to 80 characters.
- \`ttl\` (required): lifetime in seconds from 60 through 31536000, or \`0\` for no automatic expiration. Use \`604800\` (7 days) unless the user specifies otherwise.
- \`slug\` (optional): custom path containing 3–40 lowercase letters, numbers, or hyphens.

Example with curl:

\`\`\`bash
curl --fail-with-body --silent --show-error \\
  --request POST 'https://notelet.youcaidi.link/api/docs' \\
  --header 'content-type: application/json' \\
  --data '{"title":"Example","content":"# Example\\n\\nPublished with Notelet.","ttl":604800}'
\`\`\`

A successful response has status \`201\` and contains \`url\`, \`slug\`, and \`expiresAt\`.

## Workflow

1. Confirm the exact content and requested expiration. If no expiration was given, use 7 days.
2. Preserve valid Markdown. Do not convert code blocks, tables, or Mermaid fences to HTML.
3. POST the JSON payload. Use a JSON serializer or a temporary payload file for non-trivial content; do not hand-escape large Markdown in a shell command.
4. On status \`409\`, explain that the custom slug is already taken and ask whether to retry without it or with another slug.
5. For any other error, report the API message and do not invent a link.
6. On success, return the \`url\` and state when it expires. If \`expiresAt\` is null, say that it does not automatically expire.
`;
