import { describe, expect, it } from "vitest";
import { createTranslator, detectLocale, translateServerError } from "../public/i18n.js";

describe("internationalization", () => {
  it("detects Chinese and English locales", () => {
    expect(detectLocale(null, "zh-CN")).toBe("zh");
    expect(detectLocale(null, "en-US")).toBe("en");
    expect(detectLocale("zh", "en-US")).toBe("zh");
  });

  it("renders variables in both languages", () => {
    expect(createTranslator("zh")("expiresHours", { count: 2 })).toBe("约 2 小时后过期");
    expect(createTranslator("en")("expiresHours", { count: 2 })).toBe("Expires in about 2 hours");
  });

  it("translates known API errors for English readers", () => {
    expect(translateServerError("文档不存在", "en")).toBe("Document not found.");
    expect(translateServerError("custom", "en")).toBe("custom");
  });
});
