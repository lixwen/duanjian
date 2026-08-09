import { describe, expect, it } from "vitest";
import { plainTitle, renderMarkdown } from "../src/markdown";
import { isValidSlug } from "../src/index";

describe("Markdown renderer", () => {
  it("renders ordinary Markdown", () => {
    expect(renderMarkdown("# Hello\n\n**world**")).toContain("<strong>world</strong>");
  });

  it("escapes raw HTML", () => {
    const html = renderMarkdown('<script>alert("xss")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("blocks unsafe link protocols", () => {
    const html = renderMarkdown("[bad](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="#"');
  });

  it("marks Mermaid fences for safe client-side rendering", () => {
    const html = renderMarkdown("```mermaid\nflowchart LR\n  A --> B\n```");
    expect(html).toContain('class="language-mermaid"');
    expect(html).toContain("flowchart LR");
  });

  it("preserves common language identifiers for syntax highlighting", () => {
    const html = renderMarkdown("```typescript\nconst value: number = 1;\n```");
    expect(html).toContain('class="language-typescript"');
    expect(html).toContain("const value: number = 1;");
  });

  it("does not allow arbitrary code-fence text in class attributes", () => {
    const html = renderMarkdown("```\" onmouseover=alert(1)\nunsafe\n```");
    expect(html).not.toContain("onmouseover");
  });
});

describe("validation", () => {
  it("accepts human-readable slugs", () => {
    expect(isValidSlug("project-notes")).toBe(true);
  });

  it("rejects short, uppercase, and malformed slugs", () => {
    expect(isValidSlug("ab")).toBe(false);
    expect(isValidSlug("Project")).toBe(false);
    expect(isValidSlug("-notes-")).toBe(false);
  });

  it("strips HTML brackets from titles", () => {
    expect(plainTitle(" <b>Hello</b> ")).toBe("bHello/b");
  });
});
