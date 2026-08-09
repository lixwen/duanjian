import { Marked, Renderer } from "marked";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeHref(href: string): string {
  const trimmed = href.trim();
  if (/^(https?:|mailto:|\/|#)/i.test(trimmed)) return trimmed;
  return "#";
}

const renderer = new Renderer();

renderer.html = ({ text }) => escapeHtml(text);
renderer.link = ({ href, title, tokens }) => {
  const body = markedInstance.parser(tokens);
  const safe = escapeHtml(safeHref(href));
  const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${safe}"${titleAttribute} rel="noopener noreferrer">${body}</a>`;
};

const markedInstance = new Marked({
  async: false,
  breaks: false,
  gfm: true,
  renderer,
});

export function renderMarkdown(markdown: string): string {
  return markedInstance.parse(markdown) as string;
}

export function plainTitle(title: string): string {
  return title.replace(/[<>]/g, "").trim().slice(0, 160);
}
