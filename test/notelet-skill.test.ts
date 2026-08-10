import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { NOTELET_SKILL_MARKDOWN } from "../src/notelet-skill";

describe("Notelet Agent Skill", () => {
  it("contains portable frontmatter and safe publishing instructions", () => {
    expect(NOTELET_SKILL_MARKDOWN).toMatch(/^---\nname: notelet-publish\n/);
    expect(NOTELET_SKILL_MARKDOWN).toContain("https://notelet.youcaidi.link/api/docs");
    expect(NOTELET_SKILL_MARKDOWN).toContain("Only publish when the user explicitly asks");
    expect(NOTELET_SKILL_MARKDOWN).toContain("Do not claim success until the API returns a URL");
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
