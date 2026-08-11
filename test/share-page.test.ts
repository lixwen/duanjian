import { describe, expect, it } from "vitest";
import {
  buildSharePageHtml,
  deriveSharePageMetadata,
  markdownExcerpt,
  MAX_SHARE_DESCRIPTION_LENGTH,
} from "../src/share-page";

const homepage = `<!doctype html>
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
    <script type="application/ld+json">{"name":"短笺"}</script>
    <script src="/app.js" type="module"></script>
  </head>
  <body><main id="app">preserved page</main></body>
</html>`;

describe("share page metadata", () => {
  it("cleans Markdown into a bounded plain-text document excerpt", () => {
    const excerpt = markdownExcerpt(`# **Release** notes

![Preview](https://example.com/image.png)

Read [the docs](https://example.com) and use \`npm run build\`.

<script>alert("hidden")</script>

\`\`\`js
alert("also hidden")
\`\`\``);

    expect(excerpt).toBe("Release notes Preview Read the docs and use npm run build.");
    expect(excerpt).not.toContain("script");
    expect(excerpt).not.toContain("https://");
  });

  it("limits long excerpts by Unicode code point without splitting emoji", () => {
    const description = markdownExcerpt("🙂".repeat(MAX_SHARE_DESCRIPTION_LENGTH + 50));

    expect(Array.from(description)).toHaveLength(MAX_SHARE_DESCRIPTION_LENGTH);
    expect(description.endsWith("…")).toBe(true);
    expect(description).not.toContain("�");
  });

  it("builds an English conversation summary from visible user and answer Markdown", () => {
    const metadata = deriveSharePageMetadata({
      kind: "conversation",
      title: "Build review",
      source: "Codex",
      url: "https://notelet.youcaidi.link/review?tracking=yes#turn-1",
      turns: [{
        user: [{ type: "text", markdown: "Can you **review** this change?" }],
        reasoningSummaries: ["Internal-looking summary should follow the answer."],
        commentary: ["Checking files."],
        answers: ["The change is [safe](https://example.com)."],
      }],
    });

    expect(metadata.locale).toBe("en");
    expect(metadata.ogLocale).toBe("en_US");
    expect(metadata.description).toBe("Can you review this change? The change is safe.");
    expect(metadata.description).not.toContain("Internal-looking");
    expect(metadata.canonicalUrl).toBe("https://notelet.youcaidi.link/review");
  });

  it("provides localized fallbacks for content without a usable excerpt", () => {
    const zh = deriveSharePageMetadata({
      kind: "conversation",
      title: "会话记录",
      source: "Codex & Friends",
      url: "https://notelet.youcaidi.link/empty",
      turns: [],
    });
    const en = deriveSharePageMetadata({
      kind: "document",
      title: "",
      locale: "en-US",
      content: "<!-- only a comment -->",
      url: "https://notelet.youcaidi.link/untitled",
    });

    expect(zh.description).toBe("通过短笺分享的 Codex & Friends 会话。");
    expect(en.title).toBe("Untitled");
    expect(en.description).toBe("A Markdown document shared with Notelet.");
  });

  it("rejects non-web canonical URLs", () => {
    expect(() => deriveSharePageMetadata({
      kind: "document",
      title: "Unsafe URL",
      content: "text",
      url: "javascript:alert(1)",
    })).toThrow("HTTP or HTTPS");
  });
});

describe("share page HTML shell", () => {
  it("sets document, Open Graph, Twitter, locale, canonical, and author metadata", () => {
    const html = buildSharePageHtml(homepage, {
      kind: "document",
      title: `研究 "R&D" <script>alert('title')</script> & 结论`,
      author: `A&B "Editor" <admin>`,
      content: "# 第一章\n\n这是 **摘要** & 后续内容。",
      url: "https://notelet.youcaidi.link/safe-share",
    });

    expect(html).toContain('<html lang="zh-CN" data-share-page="true">');
    expect(html).toContain('<meta name="description" content="第一章 这是 摘要 &amp; 后续内容。" />');
    expect(html).toContain('<link rel="canonical" href="https://notelet.youcaidi.link/safe-share" />');
    expect(html).toContain('<meta property="og:type" content="article" />');
    expect(html).toContain('<meta property="og:site_name" content="短笺 Notelet" />');
    expect(html).toContain('<meta property="og:locale" content="zh_CN" />');
    expect(html).toContain('<meta property="og:locale:alternate" content="en_US" />');
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    expect(html).toContain('<meta name="twitter:url" content="https://notelet.youcaidi.link/safe-share" />');
    expect(html).toContain("— Notelet</title>");
    expect(html).not.toContain("— 短笺 Notelet</title>");
    expect(html).toContain('content="A&amp;B &quot;Editor&quot; &lt;admin&gt;"');
    expect(html).toContain("研究 &quot;R&amp;D&quot; &lt;script&gt;alert(&#39;title&#39;)&lt;/script&gt; &amp; 结论");
    expect(html).not.toContain("<script>alert('title')</script>");
  });

  it("preserves scripts and body structure and leaves noindex to the Worker header", () => {
    const html = buildSharePageHtml(homepage, {
      kind: "document",
      title: "A shared page",
      content: "Plain content",
      url: "https://notelet.youcaidi.link/page",
    });

    expect(html).toContain('<script type="application/ld+json">{"name":"短笺"}</script>');
    expect(html).toContain('<script src="/app.js" type="module"></script>');
    expect(html).toContain('data-share-page="true"');
    expect(html).toContain('<body><main id="app">preserved page</main></body>');
    expect(html).toContain('<meta name="robots" content="index, follow, max-image-preview:large" />');
    expect(html).not.toContain('content="noindex');
  });
});
