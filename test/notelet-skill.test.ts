import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { NOTELET_SKILL_MARKDOWN } from "../src/notelet-skill";

describe("Notelet Agent Skill", () => {
  it("contains portable frontmatter and safe publishing instructions", () => {
    expect(NOTELET_SKILL_MARKDOWN).toMatch(/^---\nname: notelet-publish\n/);
    expect(NOTELET_SKILL_MARKDOWN).toContain("https://notelet.youcaidi.link/api/docs");
    expect(NOTELET_SKILL_MARKDOWN).toContain("https://notelet.youcaidi.link/api/conversations");
    expect(NOTELET_SKILL_MARKDOWN).toContain("https://notelet.youcaidi.link/api/images");
    expect(NOTELET_SKILL_MARKDOWN).toContain("Only publish when the user explicitly asks");
    expect(NOTELET_SKILL_MARKDOWN).toContain("Do not claim success until the API returns a URL");
  });

  it("documents full visible conversation sharing without leaking private context", () => {
    expect(NOTELET_SKILL_MARKDOWN).toContain("current chat, task, thread, or conversation");
    expect(NOTELET_SKILL_MARKDOWN).toContain('"reasoningSummaries"');
    expect(NOTELET_SKILL_MARKDOWN).toContain('"commentary"');
    expect(NOTELET_SKILL_MARKDOWN).toContain('"answers"');
    expect(NOTELET_SKILL_MARKDOWN).toContain("Do not invent a reasoning summary");
    expect(NOTELET_SKILL_MARKDOWN).toContain("Exclude the operational request");
    expect(NOTELET_SKILL_MARKDOWN).toContain("never tool arguments or results");
  });

  it("prefers exact Codex App Server export with MCP and script fallbacks", () => {
    expect(NOTELET_SKILL_MARKDOWN).toContain("Exact Codex export (preferred)");
    expect(NOTELET_SKILL_MARKDOWN).toContain("`publish_current_conversation`");
    expect(NOTELET_SKILL_MARKDOWN).toContain("scripts/publish.mjs --current-task");
    expect(NOTELET_SKILL_MARKDOWN).toContain("scripts/publish.mjs --thread-id <id>");
    expect(NOTELET_SKILL_MARKDOWN).toContain("without placing transcript JSON in model context");
    expect(NOTELET_SKILL_MARKDOWN).toContain("Portable fallback");
  });

  it("documents lossless image and failure handling", () => {
    expect(NOTELET_SKILL_MARKDOWN).toContain("Upload each visible local, remote, attached, or generated image");
    expect(NOTELET_SKILL_MARKDOWN).toContain("rather than publishing a partial conversation");
    expect(NOTELET_SKILL_MARKDOWN).toContain("Use a custom slug only when the user requests one");
    expect(NOTELET_SKILL_MARKDOWN).toContain("On status `429`");
    expect(NOTELET_SKILL_MARKDOWN).toContain("do not retry automatically");
  });

  it("treats the one-time management token as a private credential", () => {
    expect(NOTELET_SKILL_MARKDOWN).toContain("one-time `manageToken`");
    expect(NOTELET_SKILL_MARKDOWN).toContain("Authorization: Bearer <manageToken>");
    expect(NOTELET_SKILL_MARKDOWN).toContain("never put it in the public share URL");
    expect(NOTELET_SKILL_MARKDOWN).toContain("cannot recover it later");
  });

  it("serves SKILL.md as a same-origin, non-indexed download", async () => {
    const response = await worker.fetch(
      new Request("https://notelet.youcaidi.link/skills/notelet-publish/SKILL.md"),
      {} as never,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain("SKILL.md");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await response.text()).toBe(NOTELET_SKILL_MARKDOWN);
  });
});
