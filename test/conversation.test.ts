import { describe, expect, it } from "vitest";
import {
  extractConversationImageKeys,
  normalizeConversationTurns,
  renderConversationTurns,
} from "../src/conversation";

const origin = "https://md.youcaidi.link";

describe("structured conversations", () => {
  it("keeps messages separate and accepts only owned R2 images", () => {
    const turns = normalizeConversationTurns([{
      id: "turn 1",
      user: [
        { type: "text", markdown: "请分析这个截图" },
        { type: "image", url: "/i/AbCdEf0123456789WXYZ.png", alt: "界面" },
        { type: "image", url: "https://evil.example/image.png", alt: "外部图片" },
      ],
      reasoningSummaries: ["先确认页面结构，再检查目录生成逻辑。"],
      commentary: ["正在检查 **目录**。"],
      answers: ["# 结论\n\n目录应该按轮次生成。\n\n![结果](/i/ZyXwVu9876543210AbCd.webp)"],
    }], origin);

    expect(turns).not.toBeNull();
    expect(turns?.[0].id).toBe("turn-1");
    expect(turns?.[0].user).toHaveLength(2);
    expect(extractConversationImageKeys(turns!)).toEqual([
      "AbCdEf0123456789WXYZ.png",
      "ZyXwVu9876543210AbCd.webp",
    ]);
  });

  it("renders each Markdown message independently and sanitizes HTML", () => {
    const turns = normalizeConversationTurns([{
      user: [{ type: "text", markdown: "用户 <script>alert(1)</script>" }],
      answers: ["# 第一条", "# 第二条\n\n<img src=x onerror=alert(1)>"],
    }], origin)!;
    const rendered = renderConversationTurns(turns);

    expect(rendered[0].answers).toHaveLength(2);
    expect(rendered[0].answers[0].html).toContain("第一条");
    expect(rendered[0].answers[1].html).not.toContain("<img");
    expect(rendered[0].answers[1].html).toContain("&lt;img");
    expect(rendered[0].user[0]).toMatchObject({ type: "text" });
  });

  it("rejects empty conversations", () => {
    expect(normalizeConversationTurns([], origin)).toBeNull();
    expect(normalizeConversationTurns([{ user: [] }], origin)).toBeNull();
  });
});
