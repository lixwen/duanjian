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

  it("scopes inline styles and framing to the isolated Mermaid renderer", async () => {
    const env = {
      ASSETS: { fetch: async () => new Response("<!doctype html>") },
    } as never;
    const page = await worker.fetch(new Request("https://notelet.youcaidi.link/"), env);
    const renderer = await worker.fetch(
      new Request("https://notelet.youcaidi.link/mermaid-renderer.html"),
      env,
    );

    expect(page.headers.get("content-security-policy")).toContain("style-src 'self'");
    expect(page.headers.get("content-security-policy")).not.toContain("style-src 'unsafe-inline'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(renderer.headers.get("content-security-policy")).toContain("style-src 'unsafe-inline'");
    expect(renderer.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(renderer.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(renderer.headers.get("cache-control")).toContain("no-transform");
  });
});
