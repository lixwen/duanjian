import { describe, expect, it } from "vitest";
import { classifyR2Operation, getSystemStatus, type StatusEnv } from "../src/status";

describe("R2 quota classification", () => {
  it("classifies billable and free operations", () => {
    expect(classifyR2Operation("PutObject")).toBe("classA");
    expect(classifyR2Operation("GetObject")).toBe("classB");
    expect(classifyR2Operation("DeleteObject")).toBe("free");
    expect(classifyR2Operation("FutureOperation")).toBe("unknown");
  });
});

describe("public status snapshot", () => {
  it("counts only documents, conversations, and R2 objects", async () => {
    const writes: Array<[string, string]> = [];
    const env = {
      DOCS: {
        get: async () => null,
        list: async ({ prefix }: { prefix?: string }) => ({
          keys: prefix === "doc:"
            ? [{ name: "doc:a" }, { name: "doc:b" }]
            : prefix === "conv:" ? [{ name: "conv:c" }] : [],
          list_complete: true,
          cacheStatus: null,
        }),
        put: async (key: string, value: string) => { writes.push([key, value]); },
      },
      IMAGES: {
        list: async () => ({
          objects: [{ key: "images/a.png", size: 1_200 }, { key: "images/b.png", size: 800 }],
          truncated: false,
          delimitedPrefixes: [],
        }),
      },
      WORKER_SCRIPT_NAME: "duanjian",
      KV_NAMESPACE_ID: "namespace",
      R2_BUCKET_NAME: "bucket",
    } as unknown as StatusEnv;

    const status = await getSystemStatus(env);
    expect(status.documents).toEqual({ markdown: 2, conversations: 1, total: 3 });
    expect(status.images).toEqual({ objects: 2, bytes: 2_000 });
    expect(status.analyticsConfigured).toBe(false);
    expect(status.analyticsAvailable).toBe(false);
    expect(status.metrics.find((item) => item.id === "r2Storage")?.used).toBe(2_000);
    expect(writes[0]?.[0]).toBe("system:status:v1");
  });
});
