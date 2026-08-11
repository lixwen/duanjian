import { describe, expect, it } from "vitest";
import {
  MANAGED_SHARES_KEY,
  MAX_MANAGED_SHARES,
  managedShareFromPublish,
  normalizeManagedShares,
  readManagedShares,
  removeManagedShare,
  upsertManagedShare,
} from "../public/share-management.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    value: (key) => values.get(key),
  };
}

function entry(slug, updatedAt = Date.now()) {
  return {
    slug,
    manageToken: "a".repeat(43),
    kind: "document",
    title: slug,
    author: "",
    createdAt: updatedAt,
    updatedAt,
    expiresAt: null,
  };
}

describe("managed shares client storage", () => {
  it("keeps only valid, unique, recent private management records", () => {
    const values = [entry("same-share", 1), entry("same-share", 2), { ...entry("bad-token"), manageToken: "short" }];
    for (let index = 0; index < MAX_MANAGED_SHARES + 8; index += 1) values.push(entry(`share-${index}`, 100 + index));

    const normalized = normalizeManagedShares(values);
    expect(normalized).toHaveLength(MAX_MANAGED_SHARES);
    expect(normalized[0].slug).toBe(`share-${MAX_MANAGED_SHARES + 7}`);
    expect(normalized.some((item) => item.slug === "bad-token")).toBe(false);
  });

  it("upserts and removes entries without exposing a second storage format", () => {
    const storage = memoryStorage();
    expect(upsertManagedShare(entry("first-share", 1), storage)).toBe(true);
    expect(upsertManagedShare({ ...entry("first-share", 2), title: "Updated" }, storage)).toBe(true);
    expect(readManagedShares(storage)).toMatchObject([{ slug: "first-share", title: "Updated" }]);
    expect(removeManagedShare("first-share", storage)).toBe(true);
    expect(JSON.parse(storage.value(MANAGED_SHARES_KEY))).toEqual([]);
  });

  it("creates a record only when the publish response contains a valid one-time token", () => {
    const valid = managedShareFromPublish({
      slug: "published-doc",
      manageToken: "Z".repeat(43),
      expiresAt: 1_800_000_000_000,
    }, { kind: "document", title: "Published", author: "Me", createdAt: 1_700_000_000_000 });
    expect(valid).toMatchObject({ slug: "published-doc", title: "Published", author: "Me" });
    expect(managedShareFromPublish({ slug: "published-doc" }, {})).toBeNull();
  });

  it("fails closed when storage is corrupt or unavailable", () => {
    const corrupt = memoryStorage({ [MANAGED_SHARES_KEY]: "{" });
    expect(readManagedShares(corrupt)).toEqual([]);
    const unavailable = { getItem: () => "[]", setItem: () => { throw new Error("denied"); } };
    expect(upsertManagedShare(entry("private-share"), unavailable)).toBe(false);
  });
});
