import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { isReservedSlug } from "../src/index";

interface StoredPutOptions {
  expirationTtl?: number;
  metadata?: unknown;
}

class MemoryKv {
  readonly values = new Map<string, string>();
  readonly options = new Map<string, StoredPutOptions>();

  async get(key: string, typeOrOptions?: string | { type?: string }): Promise<unknown> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    const type = typeof typeOrOptions === "string" ? typeOrOptions : typeOrOptions?.type;
    return type === "json" ? JSON.parse(value) as unknown : value;
  }

  async put(key: string, value: string, options: StoredPutOptions = {}): Promise<void> {
    this.values.set(key, value);
    this.options.set(key, structuredClone(options));
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
    this.options.delete(key);
  }

  async list({ prefix = "" }: { prefix?: string } = {}): Promise<unknown> {
    return {
      keys: [...this.values.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((name) => ({ name, metadata: this.options.get(name)?.metadata })),
      list_complete: true,
      cacheStatus: null,
    };
  }

  json<T>(key: string): T | null {
    const value = this.values.get(key);
    return value === undefined ? null : JSON.parse(value) as T;
  }
}

function createEnvironment() {
  const kv = new MemoryKv();
  const deletedObjects: string[] = [];
  const imageObjects = new Map<string, Uint8Array>();
  const objectFor = (key: string, includeBody: boolean) => {
    const body = imageObjects.get(key);
    if (!body) return null;
    return {
      ...(includeBody ? { body } : {}),
      httpEtag: '"test-etag"',
      writeHttpMetadata: (headers: Headers) => headers.set("Content-Type", "image/png"),
    };
  };
  const env = {
    DOCS: kv,
    IMAGES: {
      put: async () => undefined,
      get: async (key: string) => objectFor(key, true),
      head: async (key: string) => objectFor(key, false),
      delete: async (keys: string | string[]) => {
        const removed = Array.isArray(keys) ? keys : [keys];
        deletedObjects.push(...removed);
        removed.forEach((key) => imageObjects.delete(key));
      },
      list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }),
    },
    ASSETS: { fetch: async () => new Response("asset") },
    PUBLISH_LIMITER: { limit: async () => ({ success: true }) },
    IMAGE_LIMITER: { limit: async () => ({ success: true }) },
  };
  const fetch = (pathname: string, init: RequestInit = {}) => worker.fetch(
    new Request(`https://notelet.test${pathname}`, init),
    env as never,
  );
  return { kv, deletedObjects, imageObjects, fetch };
}

function jsonRequest(method: string, body: unknown, token?: string): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

async function responseJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

interface CreateResponse {
  slug: string;
  url: string;
  expiresAt: number | null;
  manageToken: string;
  kind?: string;
}

interface StoredDocumentRecord {
  title: string;
  author: string;
  content: string;
  expiresAt: number | null;
  managementTokenHash: string;
}

interface StoredImageRecord {
  key: string;
  objectKey: string;
  expiresAt: number | null;
  published: boolean;
  documentSlug: string | null;
  references?: Record<string, number | null>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-11T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("share management credentials", () => {
  it("returns a one-time high-entropy token and stores only its hash", async () => {
    const { kv, fetch } = createEnvironment();
    const createdResponse = await fetch("/api/docs", jsonRequest("POST", {
      slug: "managed-doc",
      title: "Managed",
      author: "Author",
      content: "# Private draft",
      ttl: 3600,
    }));
    expect(createdResponse.status).toBe(201);
    expect(createdResponse.headers.get("Cache-Control")).toBe("no-store");
    const created = await responseJson<CreateResponse>(createdResponse);
    expect(created.manageToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const rawStored = kv.values.get("doc:managed-doc") ?? "";
    const stored = JSON.parse(rawStored) as StoredDocumentRecord;
    expect(rawStored).not.toContain(created.manageToken);
    expect(stored.managementTokenHash).toMatch(/^[a-f0-9]{64}$/);

    const publicResponse = await fetch("/api/shares/managed-doc");
    const publicShare = await responseJson<Record<string, unknown>>(publicResponse);
    expect(publicResponse.headers.get("Vary")).toContain("Authorization");
    expect(publicShare.managementTokenHash).toBeUndefined();
    expect(publicShare.manageToken).toBeUndefined();

    const managedResponse = await fetch("/api/shares/managed-doc", {
      headers: { Authorization: `Bearer ${created.manageToken}` },
    });
    const managed = await responseJson<Record<string, unknown>>(managedResponse);
    expect(managedResponse.status).toBe(200);
    expect(managedResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(managedResponse.headers.get("Vary")).toContain("Authorization");
    expect(managed.content).toBe("# Private draft");
    expect(managed.managementTokenHash).toBeUndefined();
    expect(managed.manageToken).toBeUndefined();
  });

  it("rejects missing, malformed, and incorrect management credentials", async () => {
    const { fetch } = createEnvironment();
    const created = await responseJson<CreateResponse>(await fetch("/api/docs", jsonRequest("POST", {
      slug: "auth-check",
      content: "hello",
      ttl: null,
    })));

    const missingGet = await fetch("/api/shares/auth-check?manage=1");
    expect(missingGet.status).toBe(401);
    expect(missingGet.headers.get("Cache-Control")).toBe("no-store");
    expect(missingGet.headers.get("WWW-Authenticate")).toContain("Bearer");

    const malformed = await fetch("/api/shares/auth-check", {
      headers: { Authorization: "Bearer short" },
    });
    expect(malformed.status).toBe(401);

    const wrong = await fetch("/api/shares/auth-check", {
      headers: { Authorization: `Bearer ${"a".repeat(43)}` },
    });
    expect(wrong.status).toBe(401);

    const missingPatch = await fetch("/api/shares/auth-check", jsonRequest("PATCH", { title: "No" }));
    expect(missingPatch.status).toBe(401);

    const invalidPatch = await fetch("/api/shares/auth-check", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${created.manageToken}`,
        "Content-Type": "application/json",
      },
      body: "{",
    });
    expect(invalidPatch.status).toBe(400);
    expect(invalidPatch.headers.get("Cache-Control")).toBe("no-store");

    const correct = await fetch("/api/shares/auth-check", {
      headers: { Authorization: `Bearer ${created.manageToken}` },
    });
    expect(correct.status).toBe(200);
  });
});

describe("managed document lifecycle", () => {
  it("updates content and metadata, extends from now, and can become permanent", async () => {
    const { kv, fetch } = createEnvironment();
    const created = await responseJson<CreateResponse>(await fetch("/api/docs", jsonRequest("POST", {
      slug: "edit-document",
      title: "Old",
      author: "Before",
      content: "old",
      ttl: 60,
    })));

    vi.advanceTimersByTime(10_000);
    const patchedResponse = await fetch("/api/shares/edit-document", jsonRequest("PATCH", {
      title: "<New>",
      author: "After",
      content: "# updated",
      ttl: 120,
    }, created.manageToken));
    expect(patchedResponse.status).toBe(200);
    const patched = await responseJson<Record<string, unknown>>(patchedResponse);
    expect(patched).toMatchObject({
      kind: "document",
      title: "New",
      author: "After",
      content: "# updated",
      expiresAt: Date.now() + 120_000,
    });
    expect(kv.options.get("doc:edit-document")?.expirationTtl).toBe(120);
    expect(kv.json<StoredDocumentRecord>("doc:edit-document")).toMatchObject({
      title: "New",
      author: "After",
      content: "# updated",
    });

    const permanentResponse = await fetch("/api/shares/edit-document", jsonRequest("PATCH", {
      ttl: null,
    }, created.manageToken));
    expect(permanentResponse.status).toBe(200);
    expect((await responseJson<Record<string, unknown>>(permanentResponse)).expiresAt).toBeNull();
    expect(kv.options.get("doc:edit-document")?.expirationTtl).toBeUndefined();
    expect(kv.json<StoredDocumentRecord>("doc:edit-document")?.expiresAt).toBeNull();
  });

  it("supports a bounded absolute expiresAt and rejects invalid expiration updates", async () => {
    const { fetch } = createEnvironment();
    const created = await responseJson<CreateResponse>(await fetch("/api/docs", jsonRequest("POST", {
      slug: "absolute-expiry",
      content: "body",
      ttl: null,
    })));
    const absolute = Date.now() + 300_000;
    const valid = await fetch("/api/shares/absolute-expiry", jsonRequest("PATCH", {
      expiresAt: absolute,
    }, created.manageToken));
    expect(valid.status).toBe(200);
    expect((await responseJson<Record<string, unknown>>(valid)).expiresAt).toBe(absolute);

    const tooSoon = await fetch("/api/shares/absolute-expiry", jsonRequest("PATCH", {
      expiresAt: Date.now() + 59_999,
    }, created.manageToken));
    expect(tooSoon.status).toBe(400);

    const ambiguous = await fetch("/api/shares/absolute-expiry", jsonRequest("PATCH", {
      ttl: 300,
      expiresAt: absolute,
    }, created.manageToken));
    expect(ambiguous.status).toBe(400);
  });

  it("deletes a share only with the correct token", async () => {
    const { kv, fetch } = createEnvironment();
    const created = await responseJson<CreateResponse>(await fetch("/api/docs", jsonRequest("POST", {
      slug: "delete-me",
      content: "body",
      ttl: null,
    })));
    const denied = await fetch("/api/shares/delete-me", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${"b".repeat(43)}` },
    });
    expect(denied.status).toBe(401);
    expect(kv.values.has("doc:delete-me")).toBe(true);

    const deleted = await fetch("/api/shares/delete-me", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${created.manageToken}` },
    });
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get("Cache-Control")).toBe("no-store");
    expect(kv.values.has("doc:delete-me")).toBe(false);
    expect((await fetch("/api/shares/delete-me")).status).toBe(404);
  });

  it("treats the exact expiresAt boundary as expired and removes the record", async () => {
    const { kv, fetch } = createEnvironment();
    const created = await responseJson<CreateResponse>(await fetch("/api/docs", jsonRequest("POST", {
      slug: "boundary-doc",
      content: "body",
      ttl: 60,
    })));
    vi.setSystemTime(created.expiresAt as number);

    const expired = await fetch("/api/shares/boundary-doc", {
      headers: { Authorization: `Bearer ${created.manageToken}` },
    });
    expect(expired.status).toBe(410);
    expect(expired.headers.get("Cache-Control")).toBe("no-store");
    expect(kv.values.has("doc:boundary-doc")).toBe(false);
  });
});

describe("managed conversation lifecycle", () => {
  it("returns raw editable turns and validates normalized turn updates", async () => {
    const { kv, fetch } = createEnvironment();
    const created = await responseJson<CreateResponse>(await fetch("/api/conversations", jsonRequest("POST", {
      slug: "edit-conversation",
      title: "Old chat",
      source: "Codex",
      ttl: 3600,
      turns: [{
        id: "first",
        label: "First",
        user: [{ type: "text", markdown: "Question" }],
        answers: ["Answer"],
      }],
    })));
    expect(created.kind).toBe("conversation");

    const managed = await responseJson<Record<string, unknown>>(await fetch("/api/shares/edit-conversation", {
      headers: { Authorization: `Bearer ${created.manageToken}` },
    }));
    expect(Array.isArray(managed.turns)).toBe(true);

    const patchedResponse = await fetch("/api/shares/edit-conversation", jsonRequest("PATCH", {
      title: "New chat",
      source: "Agent",
      turns: [{
        id: "second id",
        user: [{ type: "text", markdown: "Updated question" }],
        commentary: ["Progress"],
        answers: ["Updated answer"],
      }],
      ttl: null,
    }, created.manageToken));
    expect(patchedResponse.status).toBe(200);
    const patched = await responseJson<Record<string, unknown>>(patchedResponse);
    expect(patched).toMatchObject({ title: "New chat", source: "Agent", expiresAt: null });
    expect(JSON.stringify(patched.turns)).toContain("second-id");

    const stored = kv.values.get("conv:edit-conversation") ?? "";
    expect(stored).not.toContain(created.manageToken);
    expect(kv.options.get("conv:edit-conversation")?.expirationTtl).toBeUndefined();

    const invalid = await fetch("/api/shares/edit-conversation", jsonRequest("PATCH", {
      turns: [],
    }, created.manageToken));
    expect(invalid.status).toBe(400);
  });
});

describe("managed image references and route reservations", () => {
  it("keeps shared images alive and gives unreferenced images a cleanup grace period", async () => {
    const { kv, deletedObjects, imageObjects, fetch } = createEnvironment();
    const imageKey = "AbCdEfGhJkMnPqRsTuVw.png";
    imageObjects.set(`images/${imageKey}`, new Uint8Array([1, 2, 3]));
    await kv.put(`image:${imageKey}`, JSON.stringify({
      version: 1,
      key: imageKey,
      objectKey: `images/${imageKey}`,
      contentType: "image/png",
      size: 100,
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
      published: false,
      documentSlug: null,
    }));
    const content = `![shared](/i/${imageKey})`;
    const first = await responseJson<CreateResponse>(await fetch("/api/docs", jsonRequest("POST", {
      slug: "image-first",
      content,
      ttl: 300,
    })));
    const second = await responseJson<CreateResponse>(await fetch("/api/docs", jsonRequest("POST", {
      slug: "image-second",
      content,
      ttl: null,
    })));
    let image = kv.json<StoredImageRecord>(`image:${imageKey}`)!;
    expect(image.expiresAt).toBeNull();
    expect(Object.keys(image.references ?? {}).sort()).toEqual(["image-first", "image-second"]);
    const imageResponse = await fetch(`/i/${imageKey}`);
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get("Cache-Control")).toBe(
      "public, max-age=0, s-maxage=60, must-revalidate",
    );
    expect(imageResponse.headers.get("Cache-Control")).not.toContain("immutable");

    const deleted = await fetch("/api/shares/image-first", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${first.manageToken}` },
    });
    expect(deleted.status).toBe(204);
    image = kv.json<StoredImageRecord>(`image:${imageKey}`)!;
    expect(image.published).toBe(true);
    expect(image.references).toEqual({ "image-second": null });

    const removed = await fetch("/api/shares/image-second", jsonRequest("PATCH", {
      content: "image removed",
    }, second.manageToken));
    expect(removed.status).toBe(200);
    image = kv.json<StoredImageRecord>(`image:${imageKey}`)!;
    expect(image.published).toBe(false);
    expect(image.references).toEqual({});
    expect(image.expiresAt).toBe(Date.now() + 86_400_000);

    vi.advanceTimersByTime(86_400_000);
    const expiredImage = await fetch(`/i/${imageKey}`);
    expect(expiredImage.status).toBe(410);
    expect(kv.values.has(`image:${imageKey}`)).toBe(false);
    expect(deletedObjects).toContain(`images/${imageKey}`);
  });

  it("rejects custom slugs reserved for product and infrastructure routes", async () => {
    const { fetch } = createEnvironment();
    for (const slug of ["mine", "status", "agents", "api", "assets", "skills", "mermaid-renderer"]) {
      expect(isReservedSlug(slug)).toBe(true);
      const response = await fetch("/api/docs", jsonRequest("POST", { slug, content: "body", ttl: null }));
      expect(response.status).toBe(409);
    }
  });
});
