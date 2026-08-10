import { describe, expect, it } from "vitest";
import {
  convertCodexThread,
  parseTtl,
  redactSecrets,
} from "../skill-assets/notelet-publish/scripts/duanjian.mjs";

describe("bundled Codex conversation exporter", () => {
  it("keeps visible content and excludes the operational share turn", () => {
    const result = convertCodexThread({
      id: "thread-1",
      name: "完整会话",
      cwd: "/tmp/example",
      turns: [
        {
          id: "turn-1",
          items: [
            {
              type: "userMessage",
              content: [{
                type: "text",
                text: "<in-app-browser-context>hidden URL</in-app-browser-context>\n请分析截图",
              }],
            },
            { type: "reasoning", summary: ["先检查图片。"], content: ["private chain of thought"] },
            { type: "commandExecution", command: "print-secret", aggregatedOutput: "SECRET" },
            { type: "agentMessage", phase: "commentary", text: "正在检查。" },
            { type: "agentMessage", phase: "final_answer", text: "# 结论\n\n图片正常。" },
          ],
        },
        {
          id: "turn-2",
          items: [
            { type: "userMessage", content: [{ type: "text", text: "请分享当前会话" }] },
          ],
        },
      ],
    }, { excludeLastTurn: true });

    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].user[0].markdown).toBe("请分析截图");
    expect(result.turns[0].reasoningSummaries).toEqual(["先检查图片。"]);
    expect(result.turns[0].commentary).toEqual(["正在检查。"]);
    expect(result.turns[0].answers).toEqual(["# 结论\n\n图片正常。"]);
    expect(JSON.stringify(result)).not.toContain("private chain of thought");
    expect(JSON.stringify(result)).not.toContain("print-secret");
  });

  it("redacts credentials and accepts the documented TTL aliases", () => {
    expect(redactSecrets("Authorization: Bearer abc123")).toBe("Authorization: Bearer [已隐藏]");
    expect(parseTtl("1h")).toBe(3600);
    expect(parseTtl("never")).toBeNull();
    expect(() => parseTtl("2h")).toThrow();
  });
});
