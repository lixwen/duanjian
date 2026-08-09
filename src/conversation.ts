import { plainTitle, renderMarkdown } from "./markdown";

export interface ConversationTextBlock {
  type: "text";
  markdown: string;
}

export interface ConversationImageBlock {
  type: "image";
  url: string;
  alt: string;
  key: string;
}

export type ConversationUserBlock = ConversationTextBlock | ConversationImageBlock;

export interface ConversationActivity {
  type: "file" | "tool" | "status";
  label: string;
  status: string;
}

export interface ConversationTurn {
  id: string;
  label: string;
  user: ConversationUserBlock[];
  reasoningSummaries: string[];
  commentary: string[];
  answers: string[];
  activities: ConversationActivity[];
}

export interface RenderedConversationTurn extends Omit<ConversationTurn, "user" | "commentary" | "answers"> {
  user: Array<ConversationImageBlock | (ConversationTextBlock & { html: string })>;
  commentary: Array<{ markdown: string; html: string }>;
  answers: Array<{ markdown: string; html: string }>;
}

const IMAGE_PATH_PATTERN = /^\/i\/([A-Za-z0-9]{20}\.(?:png|jpg|gif|webp|avif))$/;
const MARKDOWN_IMAGE_PATH_PATTERN = /(?:https:\/\/[^\s)]+)?\/i\/([A-Za-z0-9]{20}\.(?:png|jpg|gif|webp|avif))/g;
const MAX_TURNS = 500;
const MAX_BLOCKS_PER_TURN = 80;
const MAX_MARKDOWN_CHARS = 300_000;
const MAX_SUMMARY_CHARS = 8_000;

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(/\u0000/g, "").trim().slice(0, maxLength) : "";
}

function cleanId(value: unknown, fallback: string): string {
  const cleaned = cleanText(value, 80).replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-");
  return cleaned || fallback;
}

function markdownLabel(markdown: string): string {
  return plainTitle(markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[`*_~>|-]/g, " ")
    .replace(/\s+/g, " "))
    .slice(0, 72);
}

function normalizeImage(value: Record<string, unknown>, origin: string): ConversationImageBlock | null {
  const rawUrl = cleanText(value.url, 500);
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, origin);
  } catch {
    return null;
  }
  if (parsed.origin !== origin) return null;
  const match = parsed.pathname.match(IMAGE_PATH_PATTERN);
  if (!match) return null;
  return {
    type: "image",
    url: parsed.pathname,
    alt: cleanText(value.alt, 160) || "会话图片",
    key: match[1],
  };
}

function normalizeActivities(value: unknown): ConversationActivity[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_BLOCKS_PER_TURN).flatMap((activity) => {
    if (!activity || typeof activity !== "object") return [];
    const record = activity as Record<string, unknown>;
    const type = record.type === "file" || record.type === "tool" || record.type === "status"
      ? record.type
      : "status";
    const label = cleanText(record.label, 240);
    if (!label) return [];
    return [{ type, label, status: cleanText(record.status, 40) } satisfies ConversationActivity];
  });
}

export function normalizeConversationTurns(value: unknown, origin: string): ConversationTurn[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TURNS) return null;

  const turns = value.flatMap((turnValue, index) => {
    if (!turnValue || typeof turnValue !== "object") return [];
    const turn = turnValue as Record<string, unknown>;
    const user: ConversationUserBlock[] = Array.isArray(turn.user)
      ? turn.user.slice(0, MAX_BLOCKS_PER_TURN).reduce<ConversationUserBlock[]>((blocks, blockValue) => {
        if (!blockValue || typeof blockValue !== "object") return blocks;
        const block = blockValue as Record<string, unknown>;
        if (block.type === "text") {
          const markdown = cleanText(block.markdown, MAX_MARKDOWN_CHARS);
          if (markdown) blocks.push({ type: "text", markdown });
          return blocks;
        }
        if (block.type === "image") {
          const image = normalizeImage(block, origin);
          if (image) blocks.push(image);
          return blocks;
        }
        return blocks;
      }, [])
      : [];
    const reasoningSummaries = Array.isArray(turn.reasoningSummaries)
      ? turn.reasoningSummaries.map((item) => cleanText(item, MAX_SUMMARY_CHARS)).filter(Boolean).slice(0, 80)
      : [];
    const commentary = Array.isArray(turn.commentary)
      ? turn.commentary.map((item) => cleanText(item, MAX_MARKDOWN_CHARS)).filter(Boolean).slice(0, 80)
      : [];
    const answers = Array.isArray(turn.answers)
      ? turn.answers.map((item) => cleanText(item, MAX_MARKDOWN_CHARS)).filter(Boolean).slice(0, 20)
      : [];
    if (user.length === 0 && reasoningSummaries.length === 0 && commentary.length === 0 && answers.length === 0) return [];
    const firstText = user.find((block): block is ConversationTextBlock => block.type === "text")?.markdown ?? "";
    return [{
      id: cleanId(turn.id, `turn-${index + 1}`),
      label: cleanText(turn.label, 100) || markdownLabel(firstText) || `第 ${index + 1} 轮`,
      user,
      reasoningSummaries,
      commentary,
      answers,
      activities: normalizeActivities(turn.activities),
    } satisfies ConversationTurn];
  });

  return turns.length > 0 ? turns : null;
}

export function extractConversationImageKeys(turns: ConversationTurn[]): string[] {
  const keys = new Set<string>();
  for (const turn of turns) {
    for (const block of turn.user) {
      if (block.type === "image") keys.add(block.key);
      if (block.type === "text") {
        for (const match of block.markdown.matchAll(MARKDOWN_IMAGE_PATH_PATTERN)) keys.add(match[1]);
      }
    }
    for (const markdown of [...turn.commentary, ...turn.answers]) {
      for (const match of markdown.matchAll(MARKDOWN_IMAGE_PATH_PATTERN)) keys.add(match[1]);
    }
  }
  return [...keys];
}

export function renderConversationTurns(turns: ConversationTurn[]): RenderedConversationTurn[] {
  return turns.map((turn) => ({
    ...turn,
    user: turn.user.map((block) => block.type === "text"
      ? { ...block, html: renderMarkdown(block.markdown) }
      : block),
    commentary: turn.commentary.map((markdown) => ({ markdown, html: renderMarkdown(markdown) })),
    answers: turn.answers.map((markdown) => ({ markdown, html: renderMarkdown(markdown) })),
  }));
}
