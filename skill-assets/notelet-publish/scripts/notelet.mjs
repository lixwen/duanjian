import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";

export const DEFAULT_ORIGIN = "https://notelet.youcaidi.link";
export const DEFAULT_TTL = 7 * 24 * 60 * 60;
export const MAX_MARKDOWN_BYTES = 1_000_000;
export const MAX_CONVERSATION_BYTES = 5_000_000;
export const MAX_IMAGE_BYTES = 10_000_000;

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const IMAGE_TYPES = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"], [".avif", "image/avif"],
]);
const DATA_IMAGE_PATTERN = /^data:(image\/(?:png|jpeg|gif|webp|avif));base64,([A-Za-z0-9+/=\s]+)$/i;
const OWNED_IMAGE_PATTERN = /^\/i\/[A-Za-z0-9]{20}\.(?:png|jpg|gif|webp|avif)$/;
const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;

export function parseTtl(value) {
  if (value === null || value === "never") return null;
  if (Number.isInteger(value)) return value;
  const match = String(value).match(/^(1h|1d|7d|30d|1y)$/);
  if (!match) throw new Error("TTL must be one of: 1h, 1d, 7d, 30d, 1y, never");
  return { "1h": 3600, "1d": 86400, "7d": 604800, "30d": 2592000, "1y": 31536000 }[match[1]];
}

export function assertSlug(value) {
  if (value && !SLUG_PATTERN.test(value)) {
    throw new Error("Slug must be 3–40 lowercase letters, numbers, or hyphens");
  }
}

export function assertOrigin(value) {
  const url = new URL(value);
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new Error("Origin must use HTTPS (HTTP is allowed only for localhost)");
  }
  return url.origin;
}

export function inferTitle(markdown) {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || "Codex 分享";
}

function cleanInjectedUserContext(text) {
  return text
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>\s*/gi, "")
    .replace(/^# Files mentioned by the user:\s*[\s\S]*?^## My request:\s*/gim, "")
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>\s*/gi, "")
    .trim();
}

export function redactSecrets(value) {
  if (typeof value !== "string" || !value) return "";
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[已隐藏私钥]")
    .replace(/\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "[已隐藏密钥]")
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/g, "[已隐藏令牌]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[已隐藏访问密钥]")
    .replace(/(\bAuthorization\s*:\s*(?:Bearer|Basic)\s+)[^\s`]+/gi, "$1[已隐藏]")
    .replace(/(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)\b\s*[:=]\s*)('[^']*'|"[^"]*"|[^\s,;]+)/gi, "$1[已隐藏]");
}

function visibleText(value, { user = false } = {}) {
  const input = user ? cleanInjectedUserContext(String(value ?? "")) : String(value ?? "").trim();
  return redactSecrets(input).trim();
}

function labelFromMarkdown(markdown, fallback) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[`*_~>|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 72) || fallback;
}

function generatedImageMarkdown(item, existingText) {
  const reference = typeof item.savedPath === "string" && item.savedPath
    ? item.savedPath
    : typeof item.result === "string" && /^(?:https?:|data:image\/)/.test(item.result)
      ? item.result
      : "";
  if (!reference || existingText.includes(reference)) return "";
  return `![Codex 生成的图片](<${reference}>)`;
}

export function convertCodexThread(thread, options = {}) {
  if (!thread || typeof thread !== "object" || !Array.isArray(thread.turns)) {
    throw new Error("Codex App Server returned an invalid thread");
  }
  const rawTurns = options.excludeLastTurn ? thread.turns.slice(0, -1) : thread.turns;
  const turns = [];

  for (const [turnIndex, rawTurn] of rawTurns.entries()) {
    const items = Array.isArray(rawTurn?.items) ? rawTurn.items : [];
    const user = [];
    const reasoningSummaries = [];
    const commentary = [];
    const answers = [];
    const generatedImages = [];
    const lastAgentIndex = items.reduce((last, item, index) => item?.type === "agentMessage" ? index : last, -1);

    for (const [itemIndex, item] of items.entries()) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "userMessage") {
        for (const block of Array.isArray(item.content) ? item.content : []) {
          if (block?.type === "text") {
            const markdown = visibleText(block.text, { user: true });
            if (markdown) user.push({ type: "text", markdown });
          } else if (block?.type === "localImage" && typeof block.path === "string") {
            user.push({ type: "localImage", path: block.path, alt: "会话图片" });
          } else if (block?.type === "image" && typeof block.url === "string") {
            user.push({ type: "image", url: block.url, alt: "会话图片" });
          }
        }
      } else if (item.type === "reasoning") {
        for (const summary of Array.isArray(item.summary) ? item.summary : []) {
          const text = visibleText(summary);
          if (text) reasoningSummaries.push(text);
        }
      } else if (item.type === "agentMessage") {
        const text = visibleText(item.text);
        if (!text) continue;
        if (item.phase === "commentary") commentary.push(text);
        else if (item.phase === "final_answer") answers.push(text);
        else if (itemIndex === lastAgentIndex) answers.push(text);
        else commentary.push(text);
      } else if (item.type === "plan") {
        const text = visibleText(item.text);
        if (text) commentary.push(`**计划**\n\n${text}`);
      } else if (item.type === "imageGeneration") {
        generatedImages.push(item);
      }
    }

    const allAgentText = [...commentary, ...answers].join("\n");
    for (const item of generatedImages) {
      const markdown = generatedImageMarkdown(item, allAgentText);
      if (markdown) answers.push(markdown);
    }
    if (user.length === 0 && reasoningSummaries.length === 0 && commentary.length === 0 && answers.length === 0) continue;
    const firstUserText = user.find((block) => block.type === "text")?.markdown || "";
    turns.push({
      id: rawTurn.id || `turn-${turnIndex + 1}`,
      label: labelFromMarkdown(firstUserText, `第 ${turnIndex + 1} 轮`),
      user,
      reasoningSummaries,
      commentary,
      answers,
      activities: [],
    });
  }

  if (turns.length === 0) throw new Error("The selected Codex task has no visible completed content");
  return {
    title: visibleText(options.title || thread.name || thread.preview || "Codex 会话", { user: true }).slice(0, 160) || "Codex 会话",
    source: "Codex",
    threadId: thread.id,
    cwd: thread.cwd,
    turns,
  };
}

class AppServerClient {
  constructor({ command = process.env.CODEX_BIN || "codex", timeoutMs = 30_000 } = {}) {
    this.child = spawn(command, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.nextId = 1;
    this.pending = new Map();
    this.timeoutMs = timeoutMs;
    this.stderr = "";
    this.closed = false;
    createInterface({ input: this.child.stdout }).on("line", (line) => this.onLine(line));
    this.child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-8_000); });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code) => {
      if (!this.closed && this.pending.size) {
        this.rejectAll(new Error(`Codex App Server exited (${code ?? "unknown"}): ${this.stderr.trim()}`));
      }
    });
  }

  onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else pending.resolve(message.result);
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Codex App Server timed out during ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async initialize() {
    await this.request("initialize", { clientInfo: { name: "notelet-share", version: "0.3.0" } });
    this.notify("initialized");
  }

  close() {
    this.closed = true;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 500);
    timer.unref();
  }
}

export async function readCodexThread(threadId, options = {}) {
  const client = new AppServerClient(options);
  try {
    await client.initialize();
    const result = await client.request("thread/read", { threadId, includeTurns: true });
    return result.thread;
  } finally {
    client.close();
  }
}

export async function findCurrentCodexThread(options = {}) {
  const client = new AppServerClient(options);
  try {
    await client.initialize();
    const result = await client.request("thread/list", {
      limit: 3,
      archived: false,
      sortKey: "recency_at",
      sortDirection: "desc",
      useStateDbOnly: true,
    });
    const threads = (Array.isArray(result.data) ? result.data : []).filter((thread) => !thread.parentThreadId);
    if (threads.length === 0) throw new Error("No current Codex task was found");
    const [current, second] = threads;
    const currentTime = current.recencyAt || current.updatedAt || 0;
    const secondTime = second?.recencyAt || second?.updatedAt || 0;
    if (second && currentTime === secondTime) {
      throw new Error("More than one recent Codex task matched; pass threadId explicitly");
    }
    if (currentTime && Date.now() / 1000 - currentTime > 15 * 60) {
      throw new Error("The most recent Codex task is older than 15 minutes; pass threadId explicitly");
    }
    return current;
  } finally {
    client.close();
  }
}

function isBlockedRemoteHostname(hostname) {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}

async function uploadBytes(bytes, mime, origin) {
  if (!mime.startsWith("image/") || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("Image must be a supported file smaller than 10 MB");
  }
  const response = await fetch(`${origin}/api/images`, {
    method: "POST",
    headers: { "content-type": mime },
    body: bytes,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${result.error ?? "Image upload failed"}`);
  return result;
}

async function uploadLocalImage(path, origin) {
  const mime = IMAGE_TYPES.get(extname(path).toLowerCase());
  if (!mime) throw new Error(`Unsupported local image: ${path}`);
  return uploadBytes(await readFile(path), mime, origin);
}

async function importImageReference(reference, origin, baseDir) {
  const dataMatch = reference.match(DATA_IMAGE_PATTERN);
  if (dataMatch) return uploadBytes(Buffer.from(dataMatch[2], "base64"), dataMatch[1].toLowerCase(), origin);
  let url;
  try { url = new URL(reference); } catch { url = null; }
  if (!url || url.protocol === "file:") {
    const rawPath = url?.protocol === "file:" ? decodeURIComponent(url.pathname) : reference;
    const path = isAbsolute(rawPath) ? rawPath : resolve(baseDir || process.cwd(), rawPath);
    return uploadLocalImage(path, origin);
  }
  if (url.origin === origin && OWNED_IMAGE_PATTERN.test(url.pathname)) {
    return { url: url.pathname, key: url.pathname.slice(3) };
  }
  if (url.protocol !== "https:" || isBlockedRemoteHostname(url.hostname)) {
    throw new Error(`Unsafe image URL: ${reference}`);
  }
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`Unable to fetch image (${response.status}): ${reference}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_IMAGE_BYTES) throw new Error(`Remote image exceeds 10 MB: ${reference}`);
  const mime = (response.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
  return uploadBytes(new Uint8Array(await response.arrayBuffer()), mime, origin);
}

async function rewriteMarkdownImages(markdown, context) {
  const fencedRanges = [];
  let offset = 0;
  let openFence = null;
  for (const line of markdown.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) || []) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker && !openFence) {
      openFence = { start: offset, character: marker[1][0], length: marker[1].length };
    } else if (marker && openFence && marker[1][0] === openFence.character && marker[1].length >= openFence.length) {
      fencedRanges.push([openFence.start, offset + line.length]);
      openFence = null;
    }
    offset += line.length;
  }
  if (openFence) fencedRanges.push([openFence.start, markdown.length]);
  const matches = [...markdown.matchAll(MARKDOWN_IMAGE_PATTERN)]
    .filter((match) => !fencedRanges.some(([start, end]) => match.index >= start && match.index < end));
  if (matches.length === 0) return markdown;
  let output = "";
  let cursor = 0;
  for (const match of matches) {
    const reference = match[2] || match[3];
    context.imageReferences.add(reference);
    output += markdown.slice(cursor, match.index);
    if (context.dryRun) output += match[0];
    else {
      let uploaded = context.uploadCache.get(reference);
      if (!uploaded) {
        uploaded = await importImageReference(reference, context.origin, context.baseDir);
        context.uploadCache.set(reference, uploaded);
      }
      output += `![${match[1]}](${uploaded.url})`;
    }
    cursor = match.index + match[0].length;
  }
  return output + markdown.slice(cursor);
}

export async function prepareConversation(input, { origin, dryRun = false } = {}) {
  if (!input || typeof input !== "object" || !Array.isArray(input.turns) || input.turns.length === 0) {
    throw new Error("Conversation JSON must contain a non-empty turns array");
  }
  const context = {
    origin,
    dryRun,
    baseDir: input.cwd || process.cwd(),
    uploadCache: new Map(),
    imageReferences: new Set(),
  };
  const turns = [];
  for (const [index, rawTurn] of input.turns.entries()) {
    if (!rawTurn || typeof rawTurn !== "object") continue;
    const user = [];
    for (const block of Array.isArray(rawTurn.user) ? rawTurn.user : []) {
      if (block?.type === "text" && typeof block.markdown === "string") {
        user.push({ type: "text", markdown: await rewriteMarkdownImages(block.markdown, context) });
      } else if (block?.type === "localImage" && typeof block.path === "string") {
        context.imageReferences.add(block.path);
        if (!dryRun) {
          let uploaded = context.uploadCache.get(block.path);
          if (!uploaded) {
            uploaded = await uploadLocalImage(block.path, origin);
            context.uploadCache.set(block.path, uploaded);
          }
          user.push({ type: "image", url: uploaded.url, key: uploaded.key, alt: block.alt || "会话图片" });
        }
      } else if (block?.type === "image" && typeof block.url === "string") {
        context.imageReferences.add(block.url);
        if (!dryRun) {
          let uploaded = context.uploadCache.get(block.url);
          if (!uploaded) {
            uploaded = await importImageReference(block.url, origin, context.baseDir);
            context.uploadCache.set(block.url, uploaded);
          }
          user.push({ type: "image", url: uploaded.url, key: uploaded.key, alt: block.alt || "会话图片" });
        }
      }
    }
    const rewriteList = async (value) => {
      const output = [];
      for (const item of Array.isArray(value) ? value : []) {
        if (typeof item === "string" && item.trim()) output.push(await rewriteMarkdownImages(item, context));
      }
      return output;
    };
    turns.push({
      id: rawTurn.id || `turn-${index + 1}`,
      label: rawTurn.label || "",
      user,
      reasoningSummaries: Array.isArray(rawTurn.reasoningSummaries) ? rawTurn.reasoningSummaries : [],
      commentary: await rewriteList(rawTurn.commentary),
      answers: await rewriteList(rawTurn.answers),
      activities: [],
    });
  }
  return { turns, imageCount: context.imageReferences.size };
}

async function requestJson(endpoint, payload) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${result.error ?? "Publishing failed"}`);
  return result;
}

export async function publishMarkdownFile(options) {
  const origin = assertOrigin(options.origin || DEFAULT_ORIGIN);
  const ttl = parseTtl(options.ttl ?? DEFAULT_TTL);
  assertSlug(options.slug);
  const content = await readFile(options.file, "utf8");
  if (!content.trim()) throw new Error("Markdown content is empty");
  const bytes = new TextEncoder().encode(content).byteLength;
  if (bytes > MAX_MARKDOWN_BYTES) throw new Error("Markdown exceeds 1 MB");
  const payload = {
    content,
    title: options.title ?? inferTitle(content),
    author: options.author ?? "",
    ttl,
    ...(options.slug ? { slug: options.slug } : {}),
  };
  if (options.dryRun) return { dryRun: true, kind: "document", title: payload.title, bytes, ttl };
  const endpoint = options.endpoint || `${origin}/api/docs`;
  return requestJson(endpoint, payload);
}

export async function publishConversation(input, options = {}) {
  const origin = assertOrigin(options.origin || DEFAULT_ORIGIN);
  const ttl = parseTtl(options.ttl ?? DEFAULT_TTL);
  assertSlug(options.slug);
  const prepared = await prepareConversation(input, { origin, dryRun: options.dryRun });
  const payload = {
    title: options.title ?? input.title ?? "Codex 会话",
    source: input.source ?? "Codex",
    turns: prepared.turns,
    ttl,
    ...(options.slug ? { slug: options.slug } : {}),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  if (bytes > MAX_CONVERSATION_BYTES) throw new Error("Conversation exceeds 5 MB after filtering");
  if (options.dryRun) {
    return { dryRun: true, kind: "conversation", title: payload.title, turns: prepared.turns.length, images: prepared.imageCount, bytes, ttl, threadId: input.threadId };
  }
  return requestJson(`${origin}/api/conversations`, payload);
}

export async function publishCodexThread(options = {}) {
  const threadMeta = options.threadId
    ? { id: options.threadId }
    : await findCurrentCodexThread(options.appServer);
  const thread = await readCodexThread(threadMeta.id, options.appServer);
  const conversation = convertCodexThread(thread, {
    excludeLastTurn: options.excludeLastTurn ?? true,
    title: options.title,
  });
  const result = await publishConversation(conversation, options);
  return { ...result, threadId: thread.id, exportedTurns: conversation.turns.length };
}
