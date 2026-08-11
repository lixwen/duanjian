import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const worker = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

describe("internationalized first paint", () => {
  it("uses a neutral title and translates through a lightweight module before the app", () => {
    const preflightIndex = html.indexOf("<script data-i18n-preflight>");
    const bootstrapIndex = html.indexOf('<script src="/i18n-bootstrap.js" type="module"></script>');
    const appIndex = html.indexOf('<script src="/app.js" type="module"></script>');

    expect(html).toContain('<html lang="zh-CN" data-i18n-pending>');
    expect(html).toContain("<title>Notelet</title>");
    expect(preflightIndex).toBeGreaterThan(0);
    expect(bootstrapIndex).toBeGreaterThan(preflightIndex);
    expect(appIndex).toBeGreaterThan(bootstrapIndex);
  });

  it("does not reveal static Chinese UI before translations are ready", () => {
    expect(styles).toContain("html[data-i18n-pending] body { visibility: hidden; }");
    expect(styles).toContain('html[data-i18n-pending][data-locale="en"]::before { content: "Loading…"; }');
    expect(app).toContain('document.documentElement.removeAttribute("data-i18n-pending")');
    expect(app).toContain('document.documentElement.dataset.i18nReady = "true"');
  });

  it("allows only the exact synchronous locale preflight through the main CSP", () => {
    const source = html.match(/<script data-i18n-preflight>([^<]+)<\/script>/)?.[1];
    expect(source).toBeTruthy();
    const hash = createHash("sha256").update(source).digest("base64");
    expect(worker).toContain(`'sha256-${hash}'`);
  });

  it("includes the status loading label in the shared translation pass", () => {
    expect(html).toContain('<span id="systemHealthText">正在读取…</span>');
    expect(readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8"))
      .toContain('"#systemHealthText": "statusLoading"');
  });
});
