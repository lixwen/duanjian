import { describe, expect, it } from "vitest";
import { extractImageKeys, imageExtension } from "../src/index";

describe("image uploads", () => {
  it("accepts only safe raster image types", () => {
    expect(imageExtension("image/png")).toBe("png");
    expect(imageExtension("IMAGE/JPEG")).toBe("jpg");
    expect(imageExtension("image/webp")).toBe("webp");
    expect(imageExtension("image/svg+xml")).toBeNull();
    expect(imageExtension("text/html")).toBeNull();
  });

  it("extracts unique short-jian image keys from Markdown", () => {
    const first = "AbCdEfGhJkMnPqRsTuVw.png";
    const second = "23456789abcdefghjkmn.webp";
    const markdown = [
      `![one](https://md.youcaidi.link/i/${first})`,
      `![duplicate](/i/${first})`,
      `![two](/i/${second}?preview=1)`,
      "![external](https://example.com/image.png)",
    ].join("\n");

    expect(extractImageKeys(markdown)).toEqual([first, second]);
  });
});
