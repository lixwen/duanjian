import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTranslator } from "../public/i18n.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

describe("share management UI", () => {
  it("links a local-only management page from every utility menu", () => {
    expect(html.match(/href="\/mine"/g)).toHaveLength(4);
    expect(html.match(/data-menu-label="mine"/g)).toHaveLength(3);
    expect(html).toContain('id="managedSharesView"');
    expect(html).toContain('id="managedSharesList"');
    expect(app).toContain('slug === "mine"');
  });

  it("uses bearer credentials for raw management reads, updates, and revocation", () => {
    expect(app).toContain('Authorization: `Bearer ${entry.manageToken}`');
    expect(app).toContain('?manage=1');
    expect(app).toContain('method: "PATCH"');
    expect(app).toContain('method: "DELETE"');
    expect(app).not.toContain("manageToken=");
  });

  it("supports editing existing documents and duplicating public documents without putting secrets in URLs", () => {
    expect(html).toContain('id="forkDocumentButton"');
    expect(app).toContain("sessionStorage.setItem(MANAGED_EDIT_KEY");
    expect(app).toContain("sessionStorage.setItem(FORK_DRAFT_KEY");
    expect(app).toContain('location.href = `/?editing=${encodeURIComponent(entry.slug)}`');
    expect(app).toContain('location.href = "/?fork=1"');
  });

  it("keeps management cards and dialogs usable on narrow screens", () => {
    expect(styles).toContain(".managed-shares {");
    expect(styles).toContain(".managed-share-actions { display: flex; flex-wrap: wrap;");
    expect(styles).toContain(".managed-share-action.is-quiet { width: 100%;");
    expect(styles).toContain(".manage-share-dialog");
  });

  it("ships management and fork labels in both languages", () => {
    const zh = createTranslator("zh");
    const en = createTranslator("en");
    for (const key of [
      "mine",
      "forkDocument",
      "managedSharesDescription",
      "managedEdit",
      "managedDelete",
      "managementStorageFailed",
      "confirmDeleteShare",
      "saveConfirmHelp",
    ]) {
      expect(zh(key)).not.toBe(key);
      expect(en(key)).not.toBe(key);
    }
  });
});
