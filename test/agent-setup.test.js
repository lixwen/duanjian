import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

describe("agent skill setup page", () => {
  it("links the setup page from every utility menu", () => {
    expect(html.match(/href="\/agents"/g)).toHaveLength(3);
    expect(html).toContain('id="agentSetupView"');
  });

  it("offers Codex, Claude Code, and Cursor with user and project scopes", () => {
    for (const agent of ["codex", "claude", "cursor"]) {
      expect(html).toContain(`data-agent="${agent}"`);
    }
    expect(html).toContain('data-scope="user"');
    expect(html).toContain('data-scope="project"');
    expect(app).toContain('codex: { user: "~/.agents/skills", project: ".agents/skills" }');
    expect(app).toContain('claude: { user: "~/.claude/skills", project: ".claude/skills" }');
    expect(app).toContain('cursor: { user: "~/.cursor/skills", project: ".cursor/skills" }');
  });

  it("advertises both AI conversation and Markdown sharing", () => {
    expect(html).toContain("把当前 AI 对话或 Markdown 发布为短链接");
    expect(html).toContain("分享 AI 对话或 Markdown，并返回短链");
  });

  it("writes through an explicit directory picker and keeps manual fallbacks", () => {
    expect(app).toContain('"showDirectoryPicker" in window');
    expect(app).toContain('path: "scripts/notelet.mjs"');
    expect(app).toContain('path: "scripts/publish.mjs"');
    expect(app).toContain("getDirectoryHandle(AGENT_SKILL_NAME, { create: true })");
    expect(app).toContain("writeAgentSkillFile(directory, file.path, file.content)");
    expect(app).toContain("createWritable()");
    expect(app).toContain('mkdir -p "${target}/scripts"');
    expect(html).toContain('id="agentCopyCommand"');
    expect(html).toContain('id="agentDownloadSkill"');
    expect(html).toContain('id="agentFileCount">3 个文件');
  });

  it("keeps the installer responsive without horizontal command overflow", () => {
    expect(styles).toContain(".agent-setup-grid { display: grid;");
    expect(styles).toContain(".command-box code { display: block; min-width: 0;");
    expect(styles).toContain(".agent-setup-grid { grid-template-columns: 1fr;");
  });
});
