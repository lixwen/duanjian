import { applyStaticTranslations, detectLocale } from "./i18n.js";

export function bootstrapI18n({
  root = document,
  storage,
  browserLanguage = navigator.language,
} = {}) {
  let storedLocale = null;
  try {
    storedLocale = storage?.getItem("duanjian-locale-v1") ?? null;
  } catch {
    // Language detection can fall back to the browser when storage is blocked.
  }

  const locale = detectLocale(storedLocale, browserLanguage);
  root.documentElement.dataset.locale = locale;
  applyStaticTranslations(locale, root);
  root.documentElement.dataset.i18nReady = "true";
  root.documentElement.removeAttribute("data-i18n-pending");
  return locale;
}

if (typeof document !== "undefined") {
  let storage;
  try {
    storage = globalThis.localStorage;
  } catch {
    storage = undefined;
  }
  bootstrapI18n({ root: document, storage, browserLanguage: navigator.language });
}
