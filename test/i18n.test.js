import { describe, expect, it } from "vitest";
import { applyStaticTranslations, createTranslator, detectLocale, translateServerError } from "../public/i18n.js";
import { bootstrapI18n } from "../public/i18n-bootstrap.js";

function fakeDocument({ sharePage = false } = {}) {
  const metadata = new Map();
  const documentElement = {
    dataset: {},
    lang: "zh-CN",
    removeAttribute(name) {
      if (name === "data-i18n-pending") delete this.dataset.i18nPending;
    },
  };
  documentElement.dataset.i18nPending = "";
  if (sharePage) documentElement.dataset.sharePage = "true";
  return {
    documentElement,
    metadata,
    title: "Original title",
    querySelector(selector) {
      if (!selector.startsWith("meta[")) return null;
      return {
        setAttribute(name, value) {
          metadata.set(`${selector}:${name}`, value);
        },
      };
    },
    querySelectorAll() {
      return [];
    },
  };
}

describe("internationalization", () => {
  it("detects Chinese and English locales", () => {
    expect(detectLocale(null, "zh-CN")).toBe("zh");
    expect(detectLocale(null, "en-US")).toBe("en");
    expect(detectLocale("zh", "en-US")).toBe("zh");
  });

  it("renders variables in both languages", () => {
    expect(createTranslator("zh")("brandName")).toBe("短笺");
    expect(createTranslator("en")("brandName")).toBe("Notelet");
    expect(createTranslator("zh")("expiresHours", { count: 2 })).toBe("约 2 小时后过期");
    expect(createTranslator("en")("expiresHours", { count: 2 })).toBe("Expires in about 2 hours");
  });

  it("translates known API errors for English readers", () => {
    expect(translateServerError("文档不存在", "en")).toBe("Document not found.");
    expect(translateServerError("custom", "en")).toBe("custom");
  });

  it("translates the shell before revealing an English page", () => {
    const root = fakeDocument();
    const locale = bootstrapI18n({
      root,
      storage: { getItem: () => "en" },
      browserLanguage: "zh-CN",
    });

    expect(locale).toBe("en");
    expect(root.documentElement.lang).toBe("en");
    expect(root.documentElement.dataset.locale).toBe("en");
    expect(root.documentElement.dataset.i18nReady).toBe("true");
    expect(root.documentElement.dataset).not.toHaveProperty("i18nPending");
    expect(root.title).toBe("Notelet — Share Markdown and Codex conversations");
  });

  it("keeps server-rendered share metadata intact during UI translation", () => {
    const root = fakeDocument({ sharePage: true });
    root.title = "Shared document — Notelet";

    applyStaticTranslations("en", root);

    expect(root.documentElement.lang).toBe("en");
    expect(root.title).toBe("Shared document — Notelet");
    expect(root.metadata.size).toBe(0);
  });
});
