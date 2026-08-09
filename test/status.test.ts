import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyR2Operation, getSystemStatus, type StatusEnv } from "../src/status";

afterEach(() => vi.unstubAllGlobals());

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
      ASSETS: {
        fetch: async () => new Response(JSON.stringify({ staticAssetFiles: 102 })),
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
    expect(status.metrics.find((item) => item.id === "staticAssetFiles")?.used).toBe(102);
    expect(status.metrics.find((item) => item.id === "workerLogs")?.estimated).toBe(true);
    expect(status.resources).toEqual([expect.objectContaining({ id: "rateLimitPolicies", value: 2 })]);
    expect(writes[0]?.[0]).toBe("system:status:v3");
  });

  it("queries and combines Workers, KV, and R2 analytics", async () => {
    const queries: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      queries.push(request.query);
      const account = request.query.includes("workersInvocationsAdaptive")
        ? { workersInvocationsAdaptive: [{ sum: { requests: 42 } }] }
        : request.query.includes("kvOperationsAdaptiveGroups")
          ? {
              kvOperationsAdaptiveGroups: [
                { dimensions: { actionType: "read" }, sum: { requests: 10 } },
                { dimensions: { actionType: "write" }, sum: { requests: 3 } },
                { dimensions: { actionType: "delete" }, sum: { requests: 2 } },
                { dimensions: { actionType: "list" }, sum: { requests: 1 } },
              ],
              kvStorageAdaptiveGroups: [{ max: { byteCount: 4_000 } }],
            }
          : {
              r2OperationsAdaptiveGroups: [
                { dimensions: { actionType: "PutObject" }, sum: { requests: 5 } },
                { dimensions: { actionType: "GetObject" }, sum: { requests: 9 } },
                { dimensions: { actionType: "DeleteObject" }, sum: { requests: 4 } },
              ],
            };
      return new Response(JSON.stringify({ data: { viewer: { accounts: [account] } } }));
    }));

    const env = {
      DOCS: {
        get: async () => null,
        list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
        put: async () => undefined,
      },
      IMAGES: {
        list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }),
      },
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_ANALYTICS_TOKEN: "token",
      WORKER_SCRIPT_NAME: "duanjian",
      KV_NAMESPACE_ID: "namespace",
      R2_BUCKET_NAME: "bucket",
    } as unknown as StatusEnv;

    const status = await getSystemStatus(env);
    const used = Object.fromEntries(status.metrics.map((item) => [item.id, item.used]));
    expect(status.analyticsAvailable).toBe(true);
    expect(used).toMatchObject({
      workerRequests: 42,
      kvReads: 10,
      kvWrites: 3,
      kvDeletes: 2,
      kvLists: 1,
      kvStorage: 4_000,
      r2ClassA: 5,
      r2ClassB: 9,
    });
    expect(queries.join("\n")).toContain("$start: string!");
    expect(queries.join("\n")).toContain("date_geq: $start");
  });
});
