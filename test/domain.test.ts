import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("canonical domain", () => {
  it("permanently redirects the legacy host while preserving path and query", async () => {
    const response = await worker.fetch(
      new Request("https://md.youcaidi.link/example?from=legacy"),
      {} as never,
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "https://notelet.youcaidi.link/example?from=legacy",
    );
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});
