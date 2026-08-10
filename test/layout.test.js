import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

describe("expanded table of contents layout", () => {
  it("keeps the product information clear of the desktop table of contents", () => {
    expect(styles).toContain("body.has-expanded-toc .product-info");
    expect(styles).toContain("margin-left: calc(50% - 388px)");
  });

  it("reflows product cards when the medium-width table of contents is expanded", () => {
    expect(styles).toContain("width: min(920px, calc(100% - 300px))");
    expect(styles).toContain(".product-info .feature-grid { grid-template-columns: repeat(2, 1fr); }");
    expect(styles).toContain(".product-info .feature-grid { grid-template-columns: 1fr; }");
  });
});
