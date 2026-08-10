import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

describe("topbar utility menus", () => {
  it("keeps language and status out of the primary editor controls", () => {
    const editorActions = html.match(/<div class="topbar-actions editor-only">([\s\S]*?)<\/div>\s*<\/div>/)?.[1] ?? "";
    expect(editorActions).toContain('class="mode-switch"');
    expect(editorActions).toContain('id="publishButton"');
    expect(editorActions).toContain("data-utility-menu");
    expect(editorActions).not.toContain("language-button");
    expect(editorActions).not.toContain("status-link");
  });

  it("provides labeled, keyboard-aware menus across all topbar states", () => {
    expect(html.match(/data-utility-trigger/g)).toHaveLength(3);
    expect(html.match(/role="menu"/g)).toHaveLength(3);
    expect(html.match(/data-language-toggle/g)).toHaveLength(3);
    expect(app).toContain('event.key !== "Escape"');
    expect(app).toContain('event.key === "ArrowDown"');
  });

  it("keeps the mobile utility trigger aligned with the other primary controls", () => {
    expect(styles).toContain(".utility-menu-trigger { width: 36px; height: 36px; }");
    expect(styles).toContain("line-height: 0;");
  });
});
