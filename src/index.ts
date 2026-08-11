import { plainTitle, renderMarkdown } from "./markdown";
import {
  extractConversationImageKeys,
  normalizeConversationTurns,
  renderConversationTurns,
  type ConversationTurn,
} from "./conversation";
import { getSystemStatus, type StatusEnv } from "./status";
import { NOTELET_SKILL_MARKDOWN } from "./notelet-skill";

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
  expiresAt: number | null;
}

interface StoredConversation {
  version: 1;
  kind: "conversation";
  slug: string;
  title: string;
  source: string;
  turns: ConversationTurn[];
  createdAt: number;
  expiresAt: number | null;
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
  const maxAge = record.published ? Math.min(86_400, remainingSeconds) : Math.min(60, remainingSeconds);
  headers.set("Cache-Control", `public, max-age=${maxAge}, immutable`);
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

async function finalizeImageKeys(
  env: Env,
  keys: string[],
  documentSlug: string,
  documentExpiresAt: number | null,
): Promise<void> {
  await Promise.all(keys.map(async (key) => {
    const record = await env.DOCS.get<StoredImage>(imageRecordKey(key), "json");
    if (!record) return;

    let expiresAt = documentExpiresAt;
    if (record.published) {
      expiresAt = record.expiresAt === null || documentExpiresAt === null
        ? null
        : Math.max(record.expiresAt, documentExpiresAt);
    }

    await putImageRecord(env, {
      ...record,
      expiresAt,
      published: true,
      documentSlug,
    });
  }));
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

function parseTtl(value: unknown): number | null | undefined {
  const ttl = value === null || value === 0 ? null : Number(value);
  if (ttl === null) return null;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > MAX_TTL_SECONDS) return undefined;
  return ttl;
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
  if (ttl === undefined) {
    return error("TTL 必须在 60 秒到 365 天之间", 400);
  }

  const slug = customSlug || (await uniqueSlug(env));
  if (customSlug && await slugIsTaken(env, slug)) {
    return error("这个短链已经被使用", 409);
  }

  const now = Date.now();
  const doc: StoredDocument = {
    version: 1,
    slug,
    title: title || "无标题",
    author,
    content,
    createdAt: now,
    expiresAt: ttl === null ? null : now + ttl * 1000,
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
  if (ttl === undefined) return error("TTL 必须在 60 秒到 365 天之间", 400);

  const slug = customSlug || await uniqueSlug(env);
  if (customSlug && await slugIsTaken(env, slug)) return error("这个短链已经被使用", 409);

  const now = Date.now();
  const conversation: StoredConversation = {
    version: 1,
    kind: "conversation",
    slug,
    title: title || turns[0].label || "Codex 会话",
    source,
    turns,
    createdAt: now,
    expiresAt: ttl === null ? null : now + ttl * 1000,
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
  }, 201, { "Cache-Control": "no-store" });
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
    await env.DOCS.delete(`conv:${slug}`);
    return error("这个分享链接已经过期", 410);
  }
  const cacheControl = shareCacheControl(conversation.expiresAt);
  if (raw) {
    return new Response(JSON.stringify(conversation, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `inline; filename="${conversation.slug}.json"`,
        "Cache-Control": cacheControl,
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  }
  return json({
    ...conversation,
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
    await env.DOCS.delete(`doc:${slug}`);
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
      ...doc,
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
  if (request.method === "GET" && shareMatch) {
    const slug = decodeURIComponent(shareMatch[1]);
    const conversation = await readConversation(env, slug);
    if (conversation) return getConversation(env, slug, false);
    return getDocument(request, env, slug, false);
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
      const assetRequest = url.pathname.startsWith("/assets/")
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
      const asset = withSecurity(await env.ASSETS.fetch(assetRequest), isMermaidRenderer);
      if (!url.pathname.startsWith("/assets/")) {
        asset.headers.set(
          "Cache-Control",
          isMermaidRenderer
            ? "public, max-age=0, must-revalidate, no-transform"
            : "no-store, max-age=0",
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
