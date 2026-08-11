import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createConversationTurnAnchors, normalizeConversationSearch } from "../public/conversation-reader.js";
import { createTranslator } from "../public/i18n.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

function turn(id, label, answer) {
  return {
    id,
    label,
    user: [{ type: "text", markdown: label }],
    reasoningSummaries: [],
    commentary: [],
    answers: [{ markdown: answer }],
    activities: [],
  };
}

describe("conversation reader", () => {
  it("builds stable unique anchors from turn IDs and content fingerprints", () => {
    const first = turn("shared", "First prompt", "First answer");
    const second = turn("shared", "Second prompt", "Second answer");
    const anchors = createConversationTurnAnchors([first, second]);
    const reordered = createConversationTurnAnchors([second, first]);

    expect(new Set(anchors).size).toBe(2);
    expect(anchors[0]).toMatch(/^turn-shared-/);
    expect(anchors[1]).toMatch(/^turn-shared-/);
    expect(reordered).toEqual([anchors[1], anchors[0]]);
    expect(createConversationTurnAnchors([turn("kept-id", "Prompt", "Answer")])).toEqual(["turn-kept-id"]);
  });

  it("normalizes case and surrounding whitespace for searches", () => {
    expect(normalizeConversationSearch("  CoDeX 会话  ")).toBe("codex 会话");
  });

  it("provides labeled native controls and a clear no-results state", () => {
    expect(html).toContain('id="conversationSearch"');
    expect(html).toContain('type="search"');
    expect(html).toContain('aria-describedby="conversationSearchStatus"');
    expect(html).toContain('id="conversationAnswerToggle" type="button" aria-pressed="false"');
    expect(html).toContain('id="conversationDisclosureToggle" type="button" aria-expanded="false"');
    expect(html).toContain('id="conversationNoResults" hidden');
  });

  it("filters and highlights visible turns while preserving hash navigation", () => {
    expect(app).toContain("highlightConversationTurn");
    expect(app).toContain("article.hidden = !visible");
    expect(app).toContain("createConversationTurnAnchors(data.turns)");
    expect(app).toContain('window.addEventListener("hashchange", navigateToConversationHash)');
    expect(app).toContain("url.hash = anchor");
  });

  it("keeps answer-only and responsive states in the stylesheet", () => {
    expect(styles).toContain(".conversation-feed.is-answer-only .conversation-user");
    expect(styles).toContain(".conversation-feed.is-answer-only .conversation-no-answer");
    expect(styles).toContain("@media (max-width: 900px)");
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  it("ships every new reader label in Chinese and English", () => {
    const zh = createTranslator("zh");
    const en = createTranslator("en");
    for (const key of [
      "conversationTools",
      "conversationSearch",
      "clearSearch",
      "answerOnly",
      "expandProgressAria",
      "collapseProgressAria",
      "conversationSearchResults",
      "conversationNoResults",
      "copyTurnLinkAria",
      "noFinalAnswer",
    ]) {
      expect(zh(key)).not.toBe(key);
      expect(en(key)).not.toBe(key);
    }
  });
});
