import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

describe("publish confirmation flow", () => {
  it("keeps a single publish entry in the editor toolbar", () => {
    expect(html.match(/id="publishButton"/g)).toHaveLength(1);
    expect(html).not.toContain('id="settingsButton"');
  });

  it("places expiration, slug, and final publishing inside one dialog", () => {
    const dialog = html.match(/<dialog class="publish-dialog"[\s\S]*?<\/dialog>/)?.[0] ?? "";
    expect(dialog).toContain('id="ttlSelect"');
    expect(dialog).toContain('id="slugInput"');
    expect(dialog).toContain('id="confirmPublishButton"');
  });

  it("opens the confirmation before calling the publish request", () => {
    expect(app).toContain('elements.publishButton.addEventListener("click", openPublishDialog)');
    expect(app).toContain('$("#publishForm").addEventListener("submit"');
  });
});
