import { plainTitle, renderMarkdown } from "./markdown";
import {
  extractConversationImageKeys,
  normalizeConversationTurns,
  renderConversationTurns,
  type ConversationTurn,
} from "./conversation";
import { getSystemStatus, type StatusEnv } from "./status";
import { NOTELET_SKILL_MARKDOWN } from "./notelet-skill";
import { buildSharePageHtml } from "./share-page";

interface Env extends StatusEnv {
  ASSETS: Fetcher;
  PUBLISH_LIMITER: RateLimit;
  IMAGE_LIMITER: RateLimit;
}

interface StoredDocument {
  version: 1;
  slug: string;
  title: string;
  author: string;
  content: string;
  createdAt: number;
  updatedAt?: number;
  expiresAt: number | null;
  managementTokenHash?: string;
}

interface StoredConversation {
  version: 1;
  kind: "conversation";
  slug: string;
  title: string;
  source: string;
  turns: ConversationTurn[];
  createdAt: number;
  updatedAt?: number;
  expiresAt: number | null;
  managementTokenHash?: string;
}

interface StoredImage {
  version: 1;
  key: string;
  objectKey: string;
  contentType: string;
  size: number;
  createdAt: number;
  expiresAt: number | null;
  published: boolean;
  documentSlug: string | null;
  references?: Record<string, number | null>;
}

interface ImageListMetadata {
  expiresAt: number;
  objectKey: string;
}

const MAX_MARKDOWN_BYTES = 1_000_000;
const MAX_CONVERSATION_BYTES = 5_000_000;
const MAX_IMAGE_BYTES = 10_000_000;
const MAX_TTL_SECONDS = 31_536_000;
const TEMP_IMAGE_TTL_MS = 86_400_000;
const MAX_IMAGES_PER_DOCUMENT = 100;
const MANAGEMENT_TOKEN_BYTES = 32;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const IMAGE_KEY_PATTERN = /^[A-Za-z0-9]{20}\.(?:png|jpg|gif|webp|avif)$/;
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const CANONICAL_ORIGIN = "https://notelet.youcaidi.link";
const LEGACY_HOSTNAME = "md.youcaidi.link";
const RESERVED_SLUGS = new Set([
  "agents",
  "api",
  "assets",
  "i",
  "mine",
  "skills",
  "status",
  "mermaid-renderer",
]);

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function error(message: string, status: number): Response {
  return json({ error: message }, status);
}

function secureHeaders(headers: Headers, renderer = false): Headers {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", renderer ? "SAMEORIGIN" : "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set(
    "Content-Security-Policy",
    renderer
      ? "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'"
      : "default-src 'self'; script-src 'self' 'sha256-a38CekWRaWDBUH6WUFZyJnH9/gXEj5UDX3nu0tSjcyU='; style-src 'self'; img-src 'self' https: data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  return headers;
}

function withSecurity(response: Response, renderer = false): Response {
  const secured = new Response(response.body, response);
  secureHeaders(secured.headers, renderer);
  return secured;
}

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function managementToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(MANAGEMENT_TOKEN_BYTES)));
}

async function hashManagementToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function randomSlug(length = 8): string {
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function uniqueSlug(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const slug = randomSlug();
    const [document, conversation] = await Promise.all([
      env.DOCS.get(`doc:${slug}`),
      env.DOCS.get(`conv:${slug}`),
    ]);
    if (document === null && conversation === null) return slug;
  }
  throw new Error("Could not allocate a short link");
}

async function enforceRateLimit(request: Request, limiter: RateLimit): Promise<Response | null> {
  const key = request.headers.get("CF-Connecting-IP") ?? "anonymous";
  const outcome = await limiter.limit({ key });
  if (outcome.success) return null;
  return json(
    { error: "发布得太快了，请稍后再试" },
    429,
    { "Cache-Control": "no-store", "Retry-After": "60" },
  );
}

export function imageExtension(contentType: string): string | null {
  return IMAGE_EXTENSIONS[contentType.toLowerCase()] ?? null;
}

export function extractImageKeys(content: string): string[] {
  const matches = content.matchAll(/\/i\/([A-Za-z0-9]{20}\.(?:png|jpg|gif|webp|avif))(?:[?#][^\s)]*)?/g);
  return [...new Set(Array.from(matches, (match) => match[1]))].slice(0, MAX_IMAGES_PER_DOCUMENT);
}

function imageRecordKey(key: string): string {
  return `image:${key}`;
}

async function putImageRecord(env: Env, image: StoredImage): Promise<void> {
  await env.DOCS.put(imageRecordKey(image.key), JSON.stringify(image), {
    metadata: {
      expiresAt: image.expiresAt ?? 0,
      objectKey: image.objectKey,
    } satisfies ImageListMetadata,
  });
}

async function uploadImage(request: Request, env: Env): Promise<Response> {
  const limited = await enforceRateLimit(request, env.IMAGE_LIMITER);
  if (limited) return limited;

  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  const extension = imageExtension(contentType);
  if (!extension) return error("仅支持 PNG、JPEG、GIF、WebP 和 AVIF 图片", 415);

  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (declaredLength > MAX_IMAGE_BYTES) return error("图片不能超过 10 MB", 413);

  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return error("图片内容为空", 400);
  if (body.byteLength > MAX_IMAGE_BYTES) return error("图片不能超过 10 MB", 413);

  const key = `${randomSlug(20)}.${extension}`;
  const objectKey = `images/${key}`;
  const now = Date.now();
  const image: StoredImage = {
    version: 1,
    key,
    objectKey,
    contentType,
    size: body.byteLength,
    createdAt: now,
    expiresAt: now + TEMP_IMAGE_TTL_MS,
    published: false,
    documentSlug: null,
  };

  await env.IMAGES.put(objectKey, body, {
    httpMetadata: {
      contentType,
      contentDisposition: "inline",
    },
    customMetadata: { source: "clipboard" },
  });

  try {
    await putImageRecord(env, image);
  } catch (caught) {
    await env.IMAGES.delete(objectKey);
    throw caught;
  }

  const url = new URL(request.url);
  return json(
    {
      key,
      url: `${url.origin}/i/${key}`,
      expiresAt: image.expiresAt,
    },
    201,
    { "Cache-Control": "no-store" },
  );
}

async function getImage(env: Env, key: string, headOnly = false): Promise<Response> {
  if (!IMAGE_KEY_PATTERN.test(key)) return error("图片不存在", 404);
  const record = await env.DOCS.get<StoredImage>(imageRecordKey(key), "json");
  if (!record) return error("图片不存在", 404);

  if (record.expiresAt !== null && Date.now() >= record.expiresAt) {
    await Promise.all([env.IMAGES.delete(record.objectKey), env.DOCS.delete(imageRecordKey(key))]);
    return error("图片已经过期", 410);
  }

  const object = headOnly
    ? await env.IMAGES.head(record.objectKey)
    : await env.IMAGES.get(record.objectKey);
  if (!object) {
    await env.DOCS.delete(imageRecordKey(key));
    return error("图片不存在", 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", record.contentType);
  headers.set("Content-Disposition", "inline");
  headers.set("ETag", object.httpEtag);
  const remainingSeconds = record.expiresAt === null
    ? 31_536_000
    : Math.max(0, Math.floor((record.expiresAt - Date.now()) / 1000));
  // A published image can later be revoked or receive a shorter lifetime via
  // the management API. Keep a small shared-cache window, but require browsers
  // to revalidate instead of treating the URL as immutable for up to a day.
  const sharedMaxAge = Math.min(60, remainingSeconds);
  headers.set("Cache-Control", `public, max-age=0, s-maxage=${sharedMaxAge}, must-revalidate`);
  headers.set("X-Robots-Tag", "noindex, nofollow");
  const responseBody = headOnly ? null : (object as R2ObjectBody).body;
  return new Response(responseBody, { headers });
}

async function finalizeReferencedImages(
  env: Env,
  content: string,
  documentSlug: string,
  documentExpiresAt: number | null,
): Promise<void> {
  await finalizeImageKeys(env, extractImageKeys(content), documentSlug, documentExpiresAt);
}

function imageReferences(record: StoredImage): Record<string, number | null> {
  const references = { ...(record.references ?? {}) };
  if (record.published && record.documentSlug && !(record.documentSlug in references)) {
    references[record.documentSlug] = record.expiresAt;
  }
  return references;
}

function imageExpiration(references: Record<string, number | null>): number | null {
  const expirations = Object.values(references);
  if (expirations.some((expiresAt) => expiresAt === null)) return null;
  return expirations.length > 0 ? Math.max(...expirations as number[]) : Date.now() + TEMP_IMAGE_TTL_MS;
}

async function updateImageReference(
  env: Env,
  key: string,
  documentSlug: string,
  documentExpiresAt: number | null,
): Promise<void> {
  const record = await env.DOCS.get<StoredImage>(imageRecordKey(key), "json");
  if (!record) return;
  const references = imageReferences(record);
  references[documentSlug] = documentExpiresAt;
  const slugs = Object.keys(references);
  await putImageRecord(env, {
    ...record,
    expiresAt: imageExpiration(references),
    published: true,
    documentSlug: slugs.length === 1 ? slugs[0] : null,
    references,
  });
}

async function releaseImageReference(env: Env, key: string, documentSlug: string): Promise<void> {
  const record = await env.DOCS.get<StoredImage>(imageRecordKey(key), "json");
  if (!record) return;
  const references = imageReferences(record);
  delete references[documentSlug];
  const slugs = Object.keys(references);
  await putImageRecord(env, {
    ...record,
    expiresAt: imageExpiration(references),
    published: slugs.length > 0,
    documentSlug: slugs.length === 1 ? slugs[0] : null,
    references,
  });
}

async function syncImageReferences(
  env: Env,
  previousKeys: string[],
  nextKeys: string[],
  documentSlug: string,
  documentExpiresAt: number | null,
): Promise<void> {
  const previous = new Set(previousKeys);
  const next = new Set(nextKeys);
  await Promise.all([
    ...[...next].map((key) => updateImageReference(env, key, documentSlug, documentExpiresAt)),
    ...[...previous]
      .filter((key) => !next.has(key))
      .map((key) => releaseImageReference(env, key, documentSlug)),
  ]);
}

async function finalizeImageKeys(
  env: Env,
  keys: string[],
  documentSlug: string,
  documentExpiresAt: number | null,
): Promise<void> {
  await Promise.all(keys.map((key) => updateImageReference(env, key, documentSlug, documentExpiresAt)));
}

async function cleanupExpiredImages(env: Env): Promise<void> {
  let cursor: string | undefined;
  const now = Date.now();

  do {
    const listing = await env.DOCS.list<ImageListMetadata>({
      prefix: "image:",
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    const expired = listing.keys.filter((key) => {
      const expiresAt = key.metadata?.expiresAt ?? 0;
      return expiresAt > 0 && expiresAt <= now && Boolean(key.metadata?.objectKey);
    });

    if (expired.length > 0) {
      await env.IMAGES.delete(expired.map((key) => key.metadata!.objectKey));
      await Promise.all(expired.map((key) => env.DOCS.delete(key.name)));
    }

    cursor = listing.list_complete ? undefined : listing.cursor;
  } while (cursor);
}

async function readDocument(env: Env, slug: string): Promise<StoredDocument | null> {
  const doc = await env.DOCS.get<StoredDocument>(`doc:${slug}`, "json");
  if (!doc) return null;
  return doc;
}

async function readConversation(env: Env, slug: string): Promise<StoredConversation | null> {
  const conversation = await env.DOCS.get<StoredConversation>(`conv:${slug}`, "json");
  return conversation ?? null;
}

type LoadedShare =
  | { kind: "document"; key: string; record: StoredDocument }
  | { kind: "conversation"; key: string; record: StoredConversation };

async function readShare(env: Env, slug: string): Promise<LoadedShare | null> {
  const [document, conversation] = await Promise.all([
    readDocument(env, slug),
    readConversation(env, slug),
  ]);
  if (conversation) return { kind: "conversation", key: `conv:${slug}`, record: conversation };
  if (document) return { kind: "document", key: `doc:${slug}`, record: document };
  return null;
}

function shareImageKeys(share: LoadedShare): string[] {
  return share.kind === "document"
    ? extractImageKeys(share.record.content)
    : extractConversationImageKeys(share.record.turns);
}

async function deleteStoredShare(env: Env, share: LoadedShare): Promise<void> {
  await env.DOCS.delete(share.key);
  await Promise.all(shareImageKeys(share).map((key) => releaseImageReference(env, key, share.record.slug)));
}

async function readActiveShare(env: Env, slug: string): Promise<LoadedShare | Response> {
  if (!slug || slug.length > 64) return error("分享不存在", 404);
  const share = await readShare(env, slug);
  if (!share) return error("分享不存在", 404);
  if (share.record.expiresAt !== null && Date.now() >= share.record.expiresAt) {
    await deleteStoredShare(env, share);
    return error("这个分享链接已经过期", 410);
  }
  return share;
}

function managementUnauthorized(): Response {
  return json({ error: "管理凭据无效" }, 401, {
    "Cache-Control": "no-store",
    "WWW-Authenticate": 'Bearer realm="notelet-share"',
  });
}

function bearerManagementToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+([A-Za-z0-9_-]{43})$/i);
  return match?.[1] ?? null;
}

async function hasManagementAccess(request: Request, share: LoadedShare): Promise<boolean> {
  const token = bearerManagementToken(request);
  const expected = share.record.managementTokenHash;
  if (!token || !expected) return false;
  return constantTimeEqual(await hashManagementToken(token), expected);
}

function managementPayload(share: LoadedShare, origin: string): Record<string, unknown> {
  if (share.kind === "document") {
    const document = share.record;
    return {
      kind: "document",
      version: document.version,
      slug: document.slug,
      url: `${origin}/${document.slug}`,
      title: document.title,
      author: document.author,
      content: document.content,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      expiresAt: document.expiresAt,
    };
  }
  const conversation = share.record;
  return {
    kind: conversation.kind,
    version: conversation.version,
    slug: conversation.slug,
    url: `${origin}/${conversation.slug}`,
    title: conversation.title,
    source: conversation.source,
    turns: conversation.turns,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    expiresAt: conversation.expiresAt,
  };
}

function kvExpirationTtl(expiresAt: number): number {
  return Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000));
}

async function putStoredDocument(env: Env, document: StoredDocument): Promise<void> {
  await env.DOCS.put(`doc:${document.slug}`, JSON.stringify(document), {
    ...(document.expiresAt === null ? {} : { expirationTtl: kvExpirationTtl(document.expiresAt) }),
    metadata: { expiresAt: document.expiresAt },
  });
}

async function putStoredConversation(env: Env, conversation: StoredConversation): Promise<void> {
  await env.DOCS.put(`conv:${conversation.slug}`, JSON.stringify(conversation), {
    ...(conversation.expiresAt === null ? {} : { expirationTtl: kvExpirationTtl(conversation.expiresAt) }),
    metadata: { expiresAt: conversation.expiresAt, kind: conversation.kind },
  });
}

function parseTtl(value: unknown): number | null | undefined {
  const ttl = value === null || value === 0 ? null : Number(value);
  if (ttl === null) return null;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > MAX_TTL_SECONDS) return undefined;
  return ttl;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function updatedExpiration(
  body: Record<string, unknown>,
  current: number | null,
  now: number,
): { expiresAt: number | null } | { error: Response } {
  const hasTtl = hasOwn(body, "ttl");
  const hasExpiresAt = hasOwn(body, "expiresAt");
  if (hasTtl && hasExpiresAt) {
    return { error: error("不能同时设置 TTL 和 expiresAt", 400) };
  }
  if (hasTtl) {
    const ttl = parseTtl(body.ttl);
    if (ttl === undefined) return { error: error("TTL 必须在 60 秒到 365 天之间", 400) };
    return { expiresAt: ttl === null ? null : now + ttl * 1000 };
  }
  if (hasExpiresAt) {
    if (body.expiresAt === null || body.expiresAt === 0) return { expiresAt: null };
    const expiresAt = Number(body.expiresAt);
    if (
      !Number.isInteger(expiresAt)
      || expiresAt < now + 60_000
      || expiresAt > now + MAX_TTL_SECONDS * 1000
    ) {
      return { error: error("expiresAt 必须在当前时间 60 秒到 365 天之间", 400) };
    }
    return { expiresAt };
  }
  return { expiresAt: current };
}

async function slugIsTaken(env: Env, slug: string): Promise<boolean> {
  const [document, conversation] = await Promise.all([
    env.DOCS.get(`doc:${slug}`),
    env.DOCS.get(`conv:${slug}`),
  ]);
  return document !== null || conversation !== null;
}

async function createDocument(request: Request, env: Env): Promise<Response> {
  const limited = await enforceRateLimit(request, env.PUBLISH_LIMITER);
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return error("请求格式无效", 400);
  }

  const content = typeof body.content === "string" ? body.content : "";
  const title = plainTitle(typeof body.title === "string" ? body.title : "");
  const author = plainTitle(typeof body.author === "string" ? body.author : "").slice(0, 80);
  const customSlug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  const ttl = parseTtl(body.ttl);

  if (!content.trim()) return error("Markdown 内容不能为空", 400);
  if (new TextEncoder().encode(content).byteLength > MAX_MARKDOWN_BYTES) {
    return error("Markdown 文件不能超过 1 MB", 413);
  }
  if (customSlug && !isValidSlug(customSlug)) {
    return error("短链只能包含 3–40 位小写字母、数字和连字符", 400);
  }
  if (customSlug && isReservedSlug(customSlug)) {
    return error("这个短链已经被使用", 409);
  }
  if (ttl === undefined) {
    return error("TTL 必须在 60 秒到 365 天之间", 400);
  }

  const slug = customSlug || (await uniqueSlug(env));
  if (customSlug && await slugIsTaken(env, slug)) {
    return error("这个短链已经被使用", 409);
  }

  const now = Date.now();
  const manageToken = managementToken();
  const doc: StoredDocument = {
    version: 1,
    slug,
    title: title || "无标题",
    author,
    content,
    createdAt: now,
    expiresAt: ttl === null ? null : now + ttl * 1000,
    managementTokenHash: await hashManagementToken(manageToken),
  };

  await finalizeReferencedImages(env, content, slug, doc.expiresAt);

  await env.DOCS.put(`doc:${slug}`, JSON.stringify(doc), {
    ...(ttl === null ? {} : { expirationTtl: ttl }),
    metadata: { expiresAt: doc.expiresAt },
  });

  const url = new URL(request.url);
  return json(
    {
      slug,
      url: `${url.origin}/${slug}`,
      expiresAt: doc.expiresAt,
      manageToken,
    },
    201,
    { "Cache-Control": "no-store" },
  );
}

async function createConversation(request: Request, env: Env): Promise<Response> {
  const limited = await enforceRateLimit(request, env.PUBLISH_LIMITER);
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_CONVERSATION_BYTES) {
      return error("会话内容不能超过 5 MB", 413);
    }
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return error("请求格式无效", 400);
  }

  const title = plainTitle(typeof body.title === "string" ? body.title : "");
  const source = plainTitle(typeof body.source === "string" ? body.source : "Codex").slice(0, 80) || "Codex";
  const customSlug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  const ttl = parseTtl(body.ttl);
  const origin = new URL(request.url).origin;
  const turns = normalizeConversationTurns(body.turns, origin);

  if (!turns) return error("会话至少需要一轮有效内容", 400);
  if (customSlug && !isValidSlug(customSlug)) {
    return error("短链只能包含 3–40 位小写字母、数字和连字符", 400);
  }
  if (customSlug && isReservedSlug(customSlug)) return error("这个短链已经被使用", 409);
  if (ttl === undefined) return error("TTL 必须在 60 秒到 365 天之间", 400);

  const slug = customSlug || await uniqueSlug(env);
  if (customSlug && await slugIsTaken(env, slug)) return error("这个短链已经被使用", 409);

  const now = Date.now();
  const manageToken = managementToken();
  const conversation: StoredConversation = {
    version: 1,
    kind: "conversation",
    slug,
    title: title || turns[0].label || "Codex 会话",
    source,
    turns,
    createdAt: now,
    expiresAt: ttl === null ? null : now + ttl * 1000,
    managementTokenHash: await hashManagementToken(manageToken),
  };

  await finalizeImageKeys(
    env,
    extractConversationImageKeys(turns),
    slug,
    conversation.expiresAt,
  );
  await env.DOCS.put(`conv:${slug}`, JSON.stringify(conversation), {
    ...(ttl === null ? {} : { expirationTtl: ttl }),
    metadata: { expiresAt: conversation.expiresAt, kind: conversation.kind },
  });

  return json({
    slug,
    url: `${origin}/${slug}`,
    expiresAt: conversation.expiresAt,
    kind: conversation.kind,
    manageToken,
  }, 201, { "Cache-Control": "no-store" });
}

async function loadManagedShare(request: Request, env: Env, slug: string): Promise<LoadedShare | Response> {
  const loaded = await readActiveShare(env, slug);
  if (loaded instanceof Response) return loaded;
  if (!await hasManagementAccess(request, loaded)) return managementUnauthorized();
  return loaded;
}

async function getManagedShare(request: Request, env: Env, slug: string): Promise<Response> {
  const loaded = await loadManagedShare(request, env, slug);
  if (loaded instanceof Response) return loaded;
  return json(managementPayload(loaded, new URL(request.url).origin), 200, {
    "Cache-Control": "no-store",
  });
}

async function readManagementPatch(request: Request): Promise<Record<string, unknown> | Response> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_CONVERSATION_BYTES) {
    return error("更新内容不能超过 5 MB", 413);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return error("请求格式无效", 400);
    }
    return parsed as Record<string, unknown>;
  } catch {
    return error("请求格式无效", 400);
  }
}

async function patchManagedShare(request: Request, env: Env, slug: string): Promise<Response> {
  const loaded = await loadManagedShare(request, env, slug);
  if (loaded instanceof Response) return loaded;
  const body = await readManagementPatch(request);
  if (body instanceof Response) return body;

  const now = Date.now();
  const expiration = updatedExpiration(body, loaded.record.expiresAt, now);
  if ("error" in expiration) return expiration.error;
  const expirationChanged = expiration.expiresAt !== loaded.record.expiresAt;

  if (loaded.kind === "document") {
    const supported = ["title", "author", "content", "ttl", "expiresAt"].some((key) => hasOwn(body, key));
    if (!supported) return error("没有可更新的字段", 400);
    if (hasOwn(body, "title") && typeof body.title !== "string") return error("标题格式无效", 400);
    if (hasOwn(body, "author") && typeof body.author !== "string") return error("作者格式无效", 400);
    if (hasOwn(body, "content") && typeof body.content !== "string") return error("Markdown 内容格式无效", 400);

    const content = hasOwn(body, "content") ? body.content as string : loaded.record.content;
    if (!content.trim()) return error("Markdown 内容不能为空", 400);
    if (new TextEncoder().encode(content).byteLength > MAX_MARKDOWN_BYTES) {
      return error("Markdown 文件不能超过 1 MB", 413);
    }
    const document: StoredDocument = {
      ...loaded.record,
      title: hasOwn(body, "title") ? plainTitle(body.title as string) || "无标题" : loaded.record.title,
      author: hasOwn(body, "author")
        ? plainTitle(body.author as string).slice(0, 80)
        : loaded.record.author,
      content,
      updatedAt: now,
      expiresAt: expiration.expiresAt,
    };

    if (hasOwn(body, "content") || expirationChanged) {
      await syncImageReferences(
        env,
        extractImageKeys(loaded.record.content),
        extractImageKeys(document.content),
        document.slug,
        document.expiresAt,
      );
    }
    await putStoredDocument(env, document);
    return json(managementPayload({ kind: "document", key: loaded.key, record: document }, new URL(request.url).origin), 200, {
      "Cache-Control": "no-store",
    });
  }

  const supported = ["title", "source", "turns", "ttl", "expiresAt"].some((key) => hasOwn(body, key));
  if (!supported) return error("没有可更新的字段", 400);
  if (hasOwn(body, "title") && typeof body.title !== "string") return error("标题格式无效", 400);
  if (hasOwn(body, "source") && typeof body.source !== "string") return error("来源格式无效", 400);
  const turns = hasOwn(body, "turns")
    ? normalizeConversationTurns(body.turns, new URL(request.url).origin)
    : loaded.record.turns;
  if (!turns) return error("会话至少需要一轮有效内容", 400);

  const conversation: StoredConversation = {
    ...loaded.record,
    title: hasOwn(body, "title")
      ? plainTitle(body.title as string) || turns[0].label || "Codex 会话"
      : loaded.record.title,
    source: hasOwn(body, "source")
      ? plainTitle(body.source as string).slice(0, 80) || "Codex"
      : loaded.record.source,
    turns,
    updatedAt: now,
    expiresAt: expiration.expiresAt,
  };
  if (hasOwn(body, "turns") || expirationChanged) {
    await syncImageReferences(
      env,
      extractConversationImageKeys(loaded.record.turns),
      extractConversationImageKeys(conversation.turns),
      conversation.slug,
      conversation.expiresAt,
    );
  }
  await putStoredConversation(env, conversation);
  return json(managementPayload({ kind: "conversation", key: loaded.key, record: conversation }, new URL(request.url).origin), 200, {
    "Cache-Control": "no-store",
  });
}

async function deleteManagedShare(request: Request, env: Env, slug: string): Promise<Response> {
  const loaded = await loadManagedShare(request, env, slug);
  if (loaded instanceof Response) return loaded;
  await deleteStoredShare(env, loaded);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

function shareCacheControl(expiresAt: number | null): string {
  return expiresAt
    ? `public, max-age=0, s-maxage=${Math.max(0, Math.min(60, Math.floor((expiresAt - Date.now()) / 1000)))}`
    : "public, max-age=0, s-maxage=60";
}

async function getConversation(env: Env, slug: string, raw: boolean): Promise<Response> {
  if (!slug || slug.length > 64) return error("会话不存在", 404);
  const conversation = await readConversation(env, slug);
  if (!conversation) return error("会话不存在", 404);
  if (conversation.expiresAt !== null && Date.now() >= conversation.expiresAt) {
    await deleteStoredShare(env, { kind: "conversation", key: `conv:${slug}`, record: conversation });
    return error("这个分享链接已经过期", 410);
  }
  const cacheControl = shareCacheControl(conversation.expiresAt);
  const publicConversation = {
    version: conversation.version,
    kind: conversation.kind,
    slug: conversation.slug,
    title: conversation.title,
    source: conversation.source,
    turns: conversation.turns,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    expiresAt: conversation.expiresAt,
  };
  if (raw) {
    return new Response(JSON.stringify(publicConversation, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `inline; filename="${conversation.slug}.json"`,
        "Cache-Control": cacheControl,
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  }
  return json({
    ...publicConversation,
    turns: renderConversationTurns(conversation.turns),
  }, 200, {
    "Cache-Control": cacheControl,
    "X-Robots-Tag": "noindex, nofollow",
  });
}

async function getDocument(request: Request, env: Env, slug: string, raw: boolean): Promise<Response> {
  if (!slug || slug.length > 64) return error("文档不存在", 404);
  const doc = await readDocument(env, slug);
  if (!doc) return error("文档不存在", 404);

  if (doc.expiresAt !== null && Date.now() >= doc.expiresAt) {
    await deleteStoredShare(env, { kind: "document", key: `doc:${slug}`, record: doc });
    return error("这个分享链接已经过期", 410);
  }

  const cacheControl = shareCacheControl(doc.expiresAt);

  if (raw) {
    const filename = `${doc.slug}.md`;
    return new Response(doc.content, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": cacheControl,
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  }

  return json(
    {
      kind: "document",
      version: doc.version,
      slug: doc.slug,
      title: doc.title,
      author: doc.author,
      content: doc.content,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      expiresAt: doc.expiresAt,
      html: renderMarkdown(doc.content),
    },
    200,
    {
      "Cache-Control": cacheControl,
      "X-Robots-Tag": "noindex, nofollow",
    },
  );
}

async function preview(request: Request): Promise<Response> {
  let body: { content?: unknown };
  try {
    body = (await request.json()) as { content?: unknown };
  } catch {
    return error("请求格式无效", 400);
  }
  const content = typeof body.content === "string" ? body.content : "";
  if (new TextEncoder().encode(content).byteLength > MAX_MARKDOWN_BYTES) {
    return error("Markdown 文件不能超过 1 MB", 413);
  }
  return json({ html: renderMarkdown(content) }, 200, { "Cache-Control": "no-store" });
}

function appendVary(headers: Headers, field: string): void {
  const values = (headers.get("Vary") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.some((value) => value.toLowerCase() === field.toLowerCase())) values.push(field);
  headers.set("Vary", values.join(", "));
}

function managementCachePolicy(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  appendVary(response.headers, "Authorization");
  return response;
}

function publicShareCachePolicy(response: Response): Response {
  appendVary(response.headers, "Authorization");
  return response;
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/status") {
    return json(await getSystemStatus(env), 200, {
      "Cache-Control": "public, max-age=60, stale-while-revalidate=240",
      "X-Robots-Tag": "noindex, nofollow",
    });
  }
  if (request.method === "POST" && url.pathname === "/api/docs") {
    return createDocument(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/preview") {
    return preview(request);
  }
  if (request.method === "POST" && url.pathname === "/api/images") {
    return uploadImage(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/conversations") {
    return createConversation(request, env);
  }

  const shareMatch = url.pathname.match(/^\/api\/shares\/([^/]+)$/);
  if (shareMatch && request.method === "PATCH") {
    return managementCachePolicy(await patchManagedShare(request, env, decodeURIComponent(shareMatch[1])));
  }
  if (shareMatch && request.method === "DELETE") {
    return managementCachePolicy(await deleteManagedShare(request, env, decodeURIComponent(shareMatch[1])));
  }
  if (request.method === "GET" && shareMatch) {
    const slug = decodeURIComponent(shareMatch[1]);
    if (request.headers.has("Authorization") || url.searchParams.has("manage")) {
      return managementCachePolicy(await getManagedShare(request, env, slug));
    }
    const conversation = await readConversation(env, slug);
    if (conversation) return publicShareCachePolicy(await getConversation(env, slug, false));
    return publicShareCachePolicy(await getDocument(request, env, slug, false));
  }

  const conversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)(\/raw)?$/);
  if (request.method === "GET" && conversationMatch) {
    return getConversation(env, decodeURIComponent(conversationMatch[1]), Boolean(conversationMatch[2]));
  }

  const match = url.pathname.match(/^\/api\/docs\/([^/]+)(\/raw)?$/);
  if (request.method === "GET" && match) {
    return getDocument(request, env, decodeURIComponent(match[1]), Boolean(match[2]));
  }
  return error("接口不存在", 404);
}

function publicText(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": `${contentType}; charset=utf-8`,
      "Cache-Control": "public, max-age=3600",
    },
  });
}

function robotsText(origin: string): string {
  return `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /i/\nDisallow: /status\n\nSitemap: ${origin}/sitemap.xml\n`;
}

function sitemapXml(origin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${origin}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>\n`;
}

function llmsText(origin: string): string {
  return `# 短笺 (Notelet)\n\n> 一个开源、极简的 Markdown 文档与 Codex 会话分享工具。\n\n短笺可将 Markdown 文档或结构化 Codex 会话发布为短链接，支持链接有效期、粘贴图片、代码语法高亮、Mermaid 图表与对话式浏览。服务运行在 Cloudflare Workers、KV 和 R2 上。\n\n## Links\n\n- Product: ${origin}/\n- Service status: ${origin}/status\n- Source code: https://github.com/lixwen/notelet\n\n## Privacy and indexing\n\n公开首页可被搜索引擎索引；随机分享链接和 API 响应通过 X-Robots-Tag 禁止索引。请勿使用短笺发布敏感信息。\n`;
}

function potentialShareSlug(pathname: string): string | null {
  const match = pathname.match(/^\/([A-Za-z0-9](?:[A-Za-z0-9-]{1,62}[A-Za-z0-9])?)\/?$/);
  if (!match) return null;
  const slug = decodeURIComponent(match[1]);
  return isReservedSlug(slug) ? null : slug;
}

async function activeShareForPage(env: Env, pathname: string): Promise<LoadedShare | null> {
  const slug = potentialShareSlug(pathname);
  if (!slug) return null;
  const share = await readShare(env, slug);
  if (!share) return null;
  if (share.record.expiresAt !== null && Date.now() >= share.record.expiresAt) return null;
  return share;
}

async function injectSharePageMetadata(
  response: Response,
  share: LoadedShare,
): Promise<Response> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!response.ok || !contentType.toLowerCase().includes("text/html")) return response;

  const homeHtml = await response.text();
  const shareUrl = new URL(`/${encodeURIComponent(share.record.slug)}`, CANONICAL_ORIGIN);
  const html = share.kind === "document"
    ? buildSharePageHtml(homeHtml, {
      kind: "document",
      title: share.record.title,
      author: share.record.author,
      content: share.record.content,
      url: shareUrl,
    })
    : buildSharePageHtml(homeHtml, {
      kind: "conversation",
      title: share.record.title,
      source: share.record.source,
      turns: share.record.turns,
      url: shareUrl,
    });
  const headers = new Headers(response.headers);
  for (const header of [
    "Accept-Ranges",
    "Age",
    "Content-Encoding",
    "Content-Length",
    "Content-Range",
    "ETag",
    "Expires",
    "Last-Modified",
  ]) {
    headers.delete(header);
  }
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function fullSharePageAssetRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const header of [
    "If-Match",
    "If-Modified-Since",
    "If-None-Match",
    "If-Range",
    "If-Unmodified-Since",
    "Range",
  ]) {
    headers.delete(header);
  }
  return new Request(request, { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.hostname === LEGACY_HOSTNAME) {
        const canonical = new URL(`${url.pathname}${url.search}`, CANONICAL_ORIGIN);
        return withSecurity(Response.redirect(canonical, 308));
      }
      if (request.method === "GET" && url.pathname === "/robots.txt") {
        return withSecurity(publicText(robotsText(url.origin), "text/plain"));
      }
      if (request.method === "GET" && url.pathname === "/sitemap.xml") {
        return withSecurity(publicText(sitemapXml(url.origin), "application/xml"));
      }
      if (request.method === "GET" && url.pathname === "/llms.txt") {
        return withSecurity(publicText(llmsText(url.origin), "text/plain"));
      }
      if (request.method === "GET" && url.pathname === "/skills/notelet-publish/SKILL.md") {
        const response = publicText(NOTELET_SKILL_MARKDOWN, "text/markdown");
        response.headers.set("Content-Disposition", 'inline; filename="SKILL.md"');
        response.headers.set("X-Robots-Tag", "noindex, nofollow");
        return withSecurity(response);
      }
      if (url.pathname.startsWith("/api/")) {
        const response = withSecurity(await handleApi(request, env, url));
        response.headers.set("X-Robots-Tag", "noindex, nofollow");
        return response;
      }
      const imageMatch = url.pathname.match(/^\/i\/([^/]+)$/);
      if ((request.method === "GET" || request.method === "HEAD") && imageMatch) {
        return withSecurity(await getImage(env, decodeURIComponent(imageMatch[1]), request.method === "HEAD"));
      }
      // Cloudflare's asset binding may retain an older HTML entry at the same
      // path across deployments. The JavaScript and CSS files are content-
      // hashed, so bypass that binding cache only for HTML/app routes; static
      // assets can keep their long-lived cache behaviour.
      const initialAssetRequest = url.pathname.startsWith("/assets/")
        ? request
        : new Request(
          (() => {
            const assetUrl = new URL(request.url);
            assetUrl.searchParams.set("__asset_bypass", crypto.randomUUID());
            return assetUrl;
          })(),
          request,
        );
      const isMermaidRenderer = url.pathname === "/mermaid-renderer"
        || url.pathname === "/mermaid-renderer.html";
      const activeShare = request.method === "GET"
        ? await activeShareForPage(env, url.pathname)
        : null;
      const assetRequest = activeShare
        ? fullSharePageAssetRequest(initialAssetRequest)
        : initialAssetRequest;
      const rawAsset = await env.ASSETS.fetch(assetRequest);
      const pageAsset = activeShare
        ? await injectSharePageMetadata(rawAsset, activeShare)
        : rawAsset;
      const asset = withSecurity(pageAsset, isMermaidRenderer);
      if (!url.pathname.startsWith("/assets/")) {
        asset.headers.set(
          "Cache-Control",
          isMermaidRenderer
            ? "public, max-age=0, must-revalidate, no-transform"
            : activeShare ? shareCacheControl(activeShare.record.expiresAt) : "no-store, max-age=0",
        );
        asset.headers.set("X-Robots-Tag", url.pathname === "/" ? "index, follow" : "noindex, nofollow");
      }
      return asset;
    } catch (caught) {
      console.error(caught);
      return withSecurity(error("服务器暂时无法处理请求", 500));
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(cleanupExpiredImages(env));
  },
} satisfies ExportedHandler<Env>;
