import { describe, expect, it } from "vitest";
import worker from "../src/index";

const HOME_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta name="robots" content="index, follow, max-image-preview:large" />
    <meta name="description" content="homepage description" />
    <link rel="canonical" href="https://notelet.youcaidi.link/" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="短笺 Notelet" />
    <meta property="og:title" content="homepage title" />
    <meta property="og:description" content="homepage description" />
    <meta property="og:url" content="https://notelet.youcaidi.link/" />
    <meta property="og:locale" content="zh_CN" />
    <meta property="og:locale:alternate" content="en_US" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="homepage title" />
    <meta name="twitter:description" content="homepage description" />
    <title>homepage title</title>
    <script src="/app.js" type="module"></script>
  </head>
  <body><main id="app">SPA shell</main></body>
</html>`;

class MemoryKv {
  readonly values = new Map<string, string>();
  readonly deleted: string[] = [];

  async get(key: string, typeOrOptions?: string | { type?: string }): Promise<unknown> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    const type = typeof typeOrOptions === "string" ? typeOrOptions : typeOrOptions?.type;
    return type === "json" ? JSON.parse(value) as unknown : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deleted.push(key);
    this.values.delete(key);
  }

  async list({ prefix = "" }: { prefix?: string } = {}): Promise<unknown> {
    return {
      keys: [...this.values.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    };
  }

  setJson(key: string, value: unknown): void {
    this.values.set(key, JSON.stringify(value));
  }
}

function createEnvironment() {
  const kv = new MemoryKv();
  const assetRequests: string[] = [];
  const assetRequestHeaders: Headers[] = [];
  const env = {
    DOCS: kv,
    IMAGES: {
      get: async () => null,
      head: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }),
    },
    ASSETS: {
      fetch: async (request: Request) => {
        assetRequests.push(request.url);
        assetRequestHeaders.push(new Headers(request.headers));
        if (request.headers.has("If-None-Match")) {
          return new Response(null, { status: 304, headers: { ETag: '"homepage-build"' } });
        }
        if (request.headers.has("Range")) {
          return new Response(HOME_HTML.slice(0, 80), {
            status: 206,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Content-Range": `bytes 0-79/${HOME_HTML.length}`,
            },
          });
        }
        return new Response(HOME_HTML, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": String(new TextEncoder().encode(HOME_HTML).byteLength),
            "Accept-Ranges": "bytes",
            ETag: '"homepage-build"',
            "Last-Modified": "Tue, 11 Aug 2026 00:00:00 GMT",
          },
        });
      },
    },
    PUBLISH_LIMITER: { limit: async () => ({ success: true }) },
    IMAGE_LIMITER: { limit: async () => ({ success: true }) },
  };
  const fetch = (pathnameOrUrl: string, init: RequestInit = {}) => worker.fetch(
    new Request(
      pathnameOrUrl.startsWith("https://")
        ? pathnameOrUrl
        : `https://notelet.youcaidi.link${pathnameOrUrl}`,
      init,
    ),
    env as never,
  );
  return { kv, assetRequests, assetRequestHeaders, fetch };
}

function expectSharePageHeaders(response: Response): void {
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("permissions-policy")).toContain("camera=()");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
}

describe("dynamic share page routes", () => {
  it("injects escaped document discovery metadata without exposing management credentials", async () => {
    const { kv, assetRequestHeaders, fetch } = createEnvironment();
    const manageToken = "M".repeat(43);
    const managementTokenHash = "f".repeat(64);
    kv.setJson("doc:dynamic-doc", {
      version: 1,
      slug: "dynamic-doc",
      title: `Roadmap "R&D" </title><script>alert('title')</script>`,
      author: `A&B "Editor" <admin>`,
      content: `# Public summary

Safe & "quoted" text.

<script>alert("content")</script>`,
      createdAt: Date.now(),
      expiresAt: null,
      managementTokenHash,
      manageToken,
    });

    const response = await fetch("https://preview-notelet.workers.dev/dynamic-doc?utm_source=test", {
      headers: {
        "If-None-Match": '"homepage-build"',
        Range: "bytes=0-79",
      },
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expectSharePageHeaders(response);
    expect(response.headers.get("cache-control")).toContain("s-maxage=60");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("accept-ranges")).toBeNull();
    expect(response.headers.get("last-modified")).toBeNull();
    expect(assetRequestHeaders[0].get("if-none-match")).toBeNull();
    expect(assetRequestHeaders[0].get("range")).toBeNull();
    expect(html).toContain('<link rel="canonical" href="https://notelet.youcaidi.link/dynamic-doc" />');
    expect(html).toContain(
      '<meta property="og:url" content="https://notelet.youcaidi.link/dynamic-doc" />',
    );
    expect(html).not.toContain("preview-notelet.workers.dev/dynamic-doc");
    expect(html).toContain('<meta property="og:type" content="article" />');
    expect(html).toContain('data-share-page="true"');
    expect(html).toContain("— Notelet</title>");
    expect(html).not.toContain("— 短笺 Notelet</title>");
    expect(html).toContain(
      'content="Roadmap &quot;R&amp;D&quot; &lt;/title&gt;&lt;script&gt;alert(&#39;title&#39;)&lt;/script&gt;"',
    );
    expect(html).toContain(
      '<meta property="og:description" content="Public summary Safe &amp; &quot;quoted&quot; text." />',
    );
    expect(html).toContain(
      '<meta name="twitter:description" content="Public summary Safe &amp; &quot;quoted&quot; text." />',
    );
    expect(html).toContain('content="A&amp;B &quot;Editor&quot; &lt;admin&gt;"');
    expect(html).toContain('<script src="/app.js" type="module"></script>');
    expect(html).not.toContain("</title><script>alert('title')</script>");
    expect(html).not.toContain(manageToken);
    expect(html).not.toContain(managementTokenHash);
  });

  it("uses visible conversation turns for an English preview summary", async () => {
    const { kv, fetch } = createEnvironment();
    const managementTokenHash = "a".repeat(64);
    kv.setJson("conv:build-review", {
      version: 1,
      kind: "conversation",
      slug: "build-review",
      title: "Build review",
      source: "Codex",
      turns: [{
        id: "turn-1",
        label: "Review",
        user: [{ type: "text", markdown: "Can you **review** this change?" }],
        reasoningSummaries: ["A summary that should not replace the final answer."],
        commentary: ["Checking the implementation."],
        answers: ["The change is [safe](https://example.com)."],
        activities: [],
      }],
      createdAt: Date.now(),
      expiresAt: Date.now() + 300_000,
      managementTokenHash,
    });

    const response = await fetch("/build-review");
    const html = await response.text();

    expect(response.status).toBe(200);
    expectSharePageHeaders(response);
    expect(html).toContain('<meta property="og:locale" content="en_US" />');
    expect(html).toContain(
      '<meta name="description" content="Can you review this change? The change is safe." />',
    );
    expect(html).toContain(
      '<meta property="og:url" content="https://notelet.youcaidi.link/build-review" />',
    );
    expect(html).not.toContain("should not replace");
    expect(html).not.toContain(managementTokenHash);
  });

  it("serves the untouched SPA shell for an unknown share path", async () => {
    const { assetRequests, fetch } = createEnvironment();

    const response = await fetch("/unknown-share");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toBe(HOME_HTML);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(assetRequests).toHaveLength(1);
    expect(new URL(assetRequests[0]).searchParams.has("__asset_bypass")).toBe(true);
  });

  it("does not delete an expired share during the HTML request so its API can still return 410", async () => {
    const { kv, fetch } = createEnvironment();
    kv.setJson("doc:expired-doc", {
      version: 1,
      slug: "expired-doc",
      title: "Expired title",
      author: "",
      content: "Expired content",
      createdAt: Date.now() - 120_000,
      expiresAt: Date.now() - 60_000,
      managementTokenHash: "b".repeat(64),
    });

    const pageResponse = await fetch("/expired-doc");
    const pageHtml = await pageResponse.text();

    expect(pageResponse.status).toBe(200);
    expect(pageHtml).toBe(HOME_HTML);
    expect(pageHtml).not.toContain("Expired title");
    expect(kv.values.has("doc:expired-doc")).toBe(true);
    expect(kv.deleted).toEqual([]);

    const apiResponse = await fetch("/api/shares/expired-doc");
    expect(apiResponse.status).toBe(410);
    expect(await apiResponse.json()).toEqual({ error: "这个分享链接已经过期" });
    expect(kv.values.has("doc:expired-doc")).toBe(false);
    expect(kv.deleted).toEqual(["doc:expired-doc"]);
  });
});
