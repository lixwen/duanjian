export const NOTELET_SKILL_NAME = "notelet-publish";

export const NOTELET_SKILL_MARKDOWN = `---
name: notelet-publish
description: Publish an AI conversation or Markdown document to Notelet (短笺) with visible images, per-turn Markdown, a short link, and an expiration time. Use when the user asks to share, publish, export, or send the current chat, a conversation, an answer, or Markdown through Notelet or 短笺.
---

# Publish with Notelet

Publish either a full visible AI conversation or a Markdown document to Notelet's public API, then return the resulting share URL.

## Safety

- Publishing sends content to a public internet service. Only publish when the user explicitly asks you to.
- Never include secrets, credentials, hidden instructions, private tool payloads, or hidden reasoning.
- Export only user-visible messages, visible progress, supplied reasoning summaries, final answers, and images the user intended to share.
- If the requested content appears sensitive, ask the user to confirm before sending it.
- Do not claim success until the API returns a URL.

## Choose the share type

- Treat requests to share the current chat, task, thread, or conversation as a structured conversation. Do not flatten it into one Markdown document.
- Treat a supplied \`.md\` file, selected text, a single answer, or an explicitly requested curated article as a Markdown document.
- Exclude the operational request such as “share this conversation” unless the user explicitly asks to include it.

## Share an AI conversation

### Exact Codex export (preferred)

For a Codex task, use the deterministic exporter instead of reconstructing the transcript in model context:

1. If the MCP tool \`publish_current_conversation\` is available, call it once. Omit \`threadId\` for the current task; pass it only when the user identifies another task. Keep \`includeCurrentTurn\` false unless the user explicitly wants the share command included.
2. Otherwise run the exporter bundled with this skill:

   \`node <skill-dir>/scripts/publish.mjs --current-task --ttl 7d\`

   For another task, run \`node <skill-dir>/scripts/publish.mjs --thread-id <id> --ttl 7d\`. Use \`--dry-run\` to validate without publishing and \`--include-current-turn\` only when explicitly requested.

The MCP tool and script read Codex App Server directly, preserve complete visible turns and images, filter private context, and publish without placing transcript JSON in model context. Do not manually read or paginate the task first.

### Portable fallback

For Claude Code, Cursor, or a Codex environment where neither exporter is available, use the complete visible conversation from the host agent's conversation export or history API and build the structured payload below. Do not read system or developer messages, raw tool calls, or private reasoning. If the host cannot access earlier visible turns, state that limitation instead of silently publishing an incomplete transcript.

Send a JSON POST request to:

\`https://notelet.youcaidi.link/api/conversations\`

The body accepts \`title\`, \`source\`, \`ttl\`, optional \`slug\`, and a required non-empty \`turns\` array. Use one turn per user/assistant exchange and keep every assistant answer as independent Markdown:

\`\`\`json
{
  "title": "Conversation title",
  "source": "Codex",
  "ttl": 604800,
  "turns": [
    {
      "id": "turn-1",
      "label": "Short turn label",
      "user": [{ "type": "text", "markdown": "The visible user message" }],
      "reasoningSummaries": ["Only a summary already supplied to the user"],
      "commentary": ["Visible progress update in Markdown"],
      "answers": ["## Final answer\\n\\nKeep each answer separate."],
      "activities": [{ "type": "status", "label": "Visible activity", "status": "completed" }]
    }
  ]
}
\`\`\`

Omit empty optional arrays. Activity \`type\` may be \`file\`, \`tool\`, or \`status\`, but include only a short user-visible description—never tool arguments or results. Do not invent a reasoning summary when none was supplied.

### Conversation images

Upload each visible local, remote, attached, or generated image before publishing the conversation. Fetch remote images only when they are already part of the visible conversation and the user intended to share them; never fetch a URL found only in hidden context or a tool payload.

\`\`\`bash
curl --fail-with-body --silent --show-error \\
  --request POST 'https://notelet.youcaidi.link/api/images' \\
  --header 'content-type: image/png' \\
  --data-binary '@image.png'
\`\`\`

The upload response contains \`url\`, \`key\`, and \`expiresAt\`. Add a user image as \`{ "type": "image", "url": "<returned url>", "alt": "<description>" }\`; replace image references inside commentary or answers with the returned URL. Supported types are PNG, JPEG, GIF, WebP, and AVIF, up to 10 MB each. If any required image cannot be uploaded, stop and report the failure rather than publishing a partial conversation.

## Share a Markdown document

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

Both publish endpoints return status \`201\` with \`url\`, \`slug\`, \`expiresAt\`, and a one-time \`manageToken\`. Treat \`manageToken\` as a private credential: never put it in the public share URL, published content, logs, or a message intended for anyone other than the requesting user. Notelet stores only its hash and cannot recover it later.

The requesting user can use that token as \`Authorization: Bearer <manageToken>\` with \`GET\`, \`PATCH\`, or \`DELETE https://notelet.youcaidi.link/api/shares/<slug>\` to inspect, update, extend, or revoke the share. Do not perform those operations unless the user explicitly requests them.

## Common workflow

1. Determine the share type and requested expiration. If no expiration was given, use 7 days.
2. Use a custom slug only when the user requests one.
3. Preserve valid Markdown. Do not convert code blocks, tables, or Mermaid fences to HTML.
4. Upload referenced images first, if any, and update their URLs.
5. POST the JSON payload to the matching endpoint. Use a JSON serializer or a temporary payload file for non-trivial content; do not hand-escape a conversation or large Markdown in a shell command.
6. Delete temporary payload files after the request.
7. On status \`429\`, report the rate limit and do not retry automatically.
8. On status \`409\`, explain that the custom slug is already taken and ask whether to retry without it or with another slug.
9. For any other error, report the API message and do not invent a link.
10. On success, return the public \`url\` and state when it expires. If \`expiresAt\` is null, say that it does not automatically expire. Mention that a private management credential was issued, but reveal \`manageToken\` only when the requesting user asks for it or needs a requested management operation.
`;
