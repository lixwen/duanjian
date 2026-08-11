const SITE_NAME = "短笺 Notelet";
const MAX_TITLE_LENGTH = 160;
const MAX_SUMMARY_SOURCE_LENGTH = 50_000;

export const MAX_SHARE_DESCRIPTION_LENGTH = 180;

export type SharePageLocale = "zh-CN" | "en";

export interface ShareConversationUserBlock {
  type: string;
  markdown?: string;
  alt?: string;
}

export interface ShareConversationTurn {
  label?: string;
  user?: readonly ShareConversationUserBlock[];
  reasoningSummaries?: readonly string[];
  commentary?: readonly string[];
  answers?: readonly string[];
}

interface SharePageInputBase {
  title: string;
  url: string | URL;
  locale?: string;
}

export interface DocumentSharePageInput extends SharePageInputBase {
  kind: "document";
  author?: string;
  content: string;
}

export interface ConversationSharePageInput extends SharePageInputBase {
  kind: "conversation";
  source?: string;
  turns: readonly ShareConversationTurn[];
}

export type SharePageInput = DocumentSharePageInput | ConversationSharePageInput;

export interface SharePageMetadata {
  kind: SharePageInput["kind"];
  title: string;
  pageTitle: string;
  description: string;
  canonicalUrl: string;
  locale: SharePageLocale;
  ogLocale: "zh_CN" | "en_US";
  ogLocaleAlternate: "en_US" | "zh_CN";
  ogType: "article";
  siteName: typeof SITE_NAME;
  twitterCard: "summary";
  author?: string;
}

function sliceCodePoints(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  let codePoints = 0;
  let end = 0;
  for (const character of value) {
    if (codePoints >= maximum) break;
    end += character.length;
    codePoints += 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function cleanInlineText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value: string, maximum: number): string {
  const cleaned = cleanInlineText(value);
  const characters = Array.from(cleaned);
  if (characters.length <= maximum) return cleaned;
  return `${characters.slice(0, maximum - 1).join("").trimEnd()}…`;
}

/**
 * Produces a short, plain-text excerpt without parsing Markdown as HTML. The
 * input is bounded before applying the regular expressions so this remains
 * cheap enough to run while a Worker is serving the HTML shell.
 */
export function markdownExcerpt(markdown: string): string {
  let text = sliceCodePoints(markdown, MAX_SUMMARY_SOURCE_LENGTH)
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\2[^\n]*(?=\n|$)/g, "$1 ")
    .replace(/(^|\n)[ \t]{0,3}(?:`{3,}|~{3,})[^\n]*(?:\n[\s\S]*)?$/g, "$1 ")
    .replace(/^[ \t]{0,3}\[[^\]]+\]:[ \t]+\S+.*$/gm, " ")
    .replace(/!\[([^\]]*)\]\((?:\\.|[^)])*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:\\.|[^)])*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<(https?:\/\/[^>]+|mailto:[^>]+)>/gi, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, " ")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
    .replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    .replace(/^[ \t]*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*$/gm, " ")
    .replace(/`{1,3}([^`\n]+)`{1,3}/g, "$1")
    .replace(/[\*_~]{1,3}/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/(?:&#0*39;|&apos;)/gi, "'");

  text = cleanInlineText(text);
  return truncateText(text, MAX_SHARE_DESCRIPTION_LENGTH);
}

function conversationMarkdown(turns: readonly ShareConversationTurn[]): string {
  const excerpts: string[] = [];
  let collectedLength = 0;

  const append = (value: unknown): void => {
    if (typeof value !== "string" || collectedLength >= MAX_SUMMARY_SOURCE_LENGTH) return;
    const remaining = MAX_SUMMARY_SOURCE_LENGTH - collectedLength;
    const bounded = sliceCodePoints(value, remaining);
    if (!bounded.trim()) return;
    excerpts.push(bounded);
    collectedLength += Array.from(bounded).length;
  };

  for (let turnIndex = 0; turnIndex < turns.length && collectedLength < MAX_SUMMARY_SOURCE_LENGTH; turnIndex += 1) {
    const turn = turns[turnIndex];
    for (const block of turn.user ?? []) {
      if (block.type === "text") append(block.markdown);
      else if (block.type === "image") append(block.alt);
    }

    const answers = turn.answers ?? [];
    for (const answer of answers) append(answer);
    if (answers.length === 0) {
      for (const commentary of turn.commentary ?? []) append(commentary);
      for (const summary of turn.reasoningSummaries ?? []) append(summary);
    }
  }

  return excerpts.join("\n\n");
}

function resolveLocale(requestedLocale: string | undefined, sample: string): SharePageLocale {
  const requested = requestedLocale?.trim().replace("_", "-").toLowerCase();
  if (requested?.startsWith("zh")) return "zh-CN";
  if (requested?.startsWith("en")) return "en";

  return /\p{Script=Han}/u.test(sample) ? "zh-CN" : "en";
}

function canonicalShareUrl(value: string | URL): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new TypeError("Share page URL must be an absolute HTTP or HTTPS URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("Share page URL must use HTTP or HTTPS");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

export function deriveSharePageMetadata(input: SharePageInput): SharePageMetadata {
  const summaryMarkdown = input.kind === "document"
    ? input.content
    : conversationMarkdown(input.turns);
  const locale = resolveLocale(
    input.locale,
    `${input.title}\n${sliceCodePoints(summaryMarkdown, MAX_SUMMARY_SOURCE_LENGTH)}`,
  );
  const title = truncateText(input.title, MAX_TITLE_LENGTH)
    || (input.kind === "conversation"
      ? (locale === "zh-CN" ? "Codex 会话" : "Codex conversation")
      : (locale === "zh-CN" ? "无标题" : "Untitled"));
  const source = input.kind === "conversation"
    ? truncateText(input.source ?? "Codex", 80) || "Codex"
    : "";
  const excerpt = markdownExcerpt(summaryMarkdown);
  const description = excerpt || (input.kind === "conversation"
    ? (locale === "zh-CN"
      ? `通过短笺分享的 ${source} 会话。`
      : `A ${source} conversation shared with Notelet.`)
    : (locale === "zh-CN"
      ? "通过短笺分享的 Markdown 文档。"
      : "A Markdown document shared with Notelet."));
  const author = input.kind === "document"
    ? truncateText(input.author ?? "", 80) || undefined
    : undefined;

  return {
    kind: input.kind,
    title,
    pageTitle: `${title} — Notelet`,
    description: truncateText(description, MAX_SHARE_DESCRIPTION_LENGTH),
    canonicalUrl: canonicalShareUrl(input.url),
    locale,
    ogLocale: locale === "zh-CN" ? "zh_CN" : "en_US",
    ogLocaleAlternate: locale === "zh-CN" ? "en_US" : "zh_CN",
    ogType: "article",
    siteName: SITE_NAME,
    twitterCard: "summary",
    ...(author ? { author } : {}),
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function headElementPattern(tag: string, attribute: string, value: string): RegExp {
  const escapedTag = escapeRegExp(tag);
  const escapedAttribute = escapeRegExp(attribute);
  const escapedValue = escapeRegExp(value);
  return new RegExp(
    `<${escapedTag}\\b(?=[^>]*\\b${escapedAttribute}\\s*=\\s*(?:"${escapedValue}"|'${escapedValue}'))[^>]*>`,
    "i",
  );
}

function insertBeforeHeadEnd(html: string, element: string): string {
  const closingHead = html.search(/<\/head\s*>/i);
  if (closingHead < 0) throw new TypeError("Share page template must contain a closing head element");
  return `${html.slice(0, closingHead)}    ${element}\n${html.slice(closingHead)}`;
}

function replaceOrInsertHeadElement(html: string, pattern: RegExp, element: string): string {
  return pattern.test(html) ? html.replace(pattern, element) : insertBeforeHeadEnd(html, element);
}

function removeHeadElement(html: string, pattern: RegExp): string {
  return html.replace(pattern, "");
}

function metaByName(name: string, content: string): string {
  return `<meta name="${name}" content="${escapeHtml(content)}" />`;
}

function metaByProperty(property: string, content: string): string {
  return `<meta property="${property}" content="${escapeHtml(content)}" />`;
}

function setHtmlLanguage(html: string, locale: SharePageLocale): string {
  return html.replace(/<html\b[^>]*>/i, (htmlTag) => {
    if (/\blang\s*=\s*(?:"[^"]*"|'[^']*')/i.test(htmlTag)) {
      return htmlTag.replace(/\blang\s*=\s*(?:"[^"]*"|'[^']*')/i, `lang="${locale}"`);
    }
    return htmlTag.replace(/>$/, ` lang="${locale}">`);
  });
}

function markSharePage(html: string): string {
  return html.replace(/<html\b[^>]*>/i, (htmlTag) => {
    if (/\bdata-share-page\s*=/i.test(htmlTag)) {
      return htmlTag.replace(
        /\bdata-share-page\s*=\s*(?:"[^"]*"|'[^']*')/i,
        'data-share-page="true"',
      );
    }
    return htmlTag.replace(/>$/, ' data-share-page="true">');
  });
}

/**
 * Rewrites only discoverability metadata in the homepage HTML shell. Scripts,
 * styles, and body markup are otherwise left byte-for-byte intact. Indexing is
 * intentionally controlled by the Worker's X-Robots-Tag response header.
 */
export function renderSharePageHtml(homeHtml: string, metadata: SharePageMetadata): string {
  const locale: SharePageLocale = metadata.locale === "zh-CN" ? "zh-CN" : "en";
  let html = markSharePage(setHtmlLanguage(homeHtml, locale));
  const escapedPageTitle = escapeHtml(metadata.pageTitle);
  const titlePattern = /<title\b[^>]*>[\s\S]*?<\/title\s*>/i;
  html = titlePattern.test(html)
    ? html.replace(titlePattern, `<title>${escapedPageTitle}</title>`)
    : insertBeforeHeadEnd(html, `<title>${escapedPageTitle}</title>`);

  const fields: ReadonlyArray<readonly [RegExp, string]> = [
    [headElementPattern("meta", "name", "description"), metaByName("description", metadata.description)],
    [headElementPattern("meta", "property", "og:type"), metaByProperty("og:type", metadata.ogType)],
    [headElementPattern("meta", "property", "og:site_name"), metaByProperty("og:site_name", metadata.siteName)],
    [headElementPattern("meta", "property", "og:title"), metaByProperty("og:title", metadata.title)],
    [headElementPattern("meta", "property", "og:description"), metaByProperty("og:description", metadata.description)],
    [headElementPattern("meta", "property", "og:url"), metaByProperty("og:url", metadata.canonicalUrl)],
    [headElementPattern("meta", "property", "og:locale"), metaByProperty("og:locale", metadata.ogLocale)],
    [headElementPattern("meta", "property", "og:locale:alternate"), metaByProperty("og:locale:alternate", metadata.ogLocaleAlternate)],
    [headElementPattern("meta", "name", "twitter:card"), metaByName("twitter:card", metadata.twitterCard)],
    [headElementPattern("meta", "name", "twitter:title"), metaByName("twitter:title", metadata.title)],
    [headElementPattern("meta", "name", "twitter:description"), metaByName("twitter:description", metadata.description)],
    [headElementPattern("meta", "name", "twitter:url"), metaByName("twitter:url", metadata.canonicalUrl)],
  ];
  for (const [pattern, element] of fields) {
    html = replaceOrInsertHeadElement(html, pattern, element);
  }

  html = replaceOrInsertHeadElement(
    html,
    headElementPattern("link", "rel", "canonical"),
    `<link rel="canonical" href="${escapeHtml(metadata.canonicalUrl)}" />`,
  );

  const authorNamePattern = headElementPattern("meta", "name", "author");
  const articleAuthorPattern = headElementPattern("meta", "property", "article:author");
  if (metadata.author) {
    html = replaceOrInsertHeadElement(html, authorNamePattern, metaByName("author", metadata.author));
    html = replaceOrInsertHeadElement(html, articleAuthorPattern, metaByProperty("article:author", metadata.author));
  } else {
    html = removeHeadElement(html, authorNamePattern);
    html = removeHeadElement(html, articleAuthorPattern);
  }

  return html;
}

export function buildSharePageHtml(homeHtml: string, input: SharePageInput): string {
  return renderSharePageHtml(homeHtml, deriveSharePageMetadata(input));
}
