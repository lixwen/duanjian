export const MANAGED_SHARES_KEY = "notelet-managed-shares-v1";
export const MAX_MANAGED_SHARES = 50;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SLUG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{1,62}[A-Za-z0-9])?$/;

function finiteTimestamp(value, fallback = Date.now()) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

export function normalizeManagedShare(value) {
  if (!value || typeof value !== "object") return null;
  const slug = typeof value.slug === "string" ? value.slug.trim() : "";
  const manageToken = typeof value.manageToken === "string" ? value.manageToken.trim() : "";
  if (!SLUG_PATTERN.test(slug) || !TOKEN_PATTERN.test(manageToken)) return null;
  const expiresAt = value.expiresAt === null
    ? null
    : Number.isFinite(Number(value.expiresAt)) ? Math.trunc(Number(value.expiresAt)) : null;
  return {
    version: 1,
    slug,
    manageToken,
    kind: value.kind === "conversation" ? "conversation" : "document",
    title: typeof value.title === "string" ? value.title.trim().slice(0, 160) : "",
    author: typeof value.author === "string" ? value.author.trim().slice(0, 80) : "",
    createdAt: finiteTimestamp(value.createdAt),
    updatedAt: finiteTimestamp(value.updatedAt),
    expiresAt,
  };
}

export function normalizeManagedShares(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Map();
  value.forEach((candidate) => {
    const entry = normalizeManagedShare(candidate);
    if (!entry) return;
    const existing = unique.get(entry.slug);
    if (!existing || entry.updatedAt >= existing.updatedAt) unique.set(entry.slug, entry);
  });
  return [...unique.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_MANAGED_SHARES);
}

export function readManagedShares(storage = localStorage) {
  try {
    return normalizeManagedShares(JSON.parse(storage.getItem(MANAGED_SHARES_KEY) || "[]"));
  } catch {
    return [];
  }
}

export function writeManagedShares(entries, storage = localStorage) {
  try {
    storage.setItem(MANAGED_SHARES_KEY, JSON.stringify(normalizeManagedShares(entries)));
    return true;
  } catch {
    return false;
  }
}

export function upsertManagedShare(value, storage = localStorage) {
  const entry = normalizeManagedShare(value);
  if (!entry) return false;
  return writeManagedShares([entry, ...readManagedShares(storage).filter((item) => item.slug !== entry.slug)], storage);
}

export function removeManagedShare(slug, storage = localStorage) {
  return writeManagedShares(readManagedShares(storage).filter((entry) => entry.slug !== slug), storage);
}

export function managedShareFromPublish(data, metadata = {}) {
  return normalizeManagedShare({
    version: 1,
    slug: data?.slug,
    manageToken: data?.manageToken,
    kind: data?.kind ?? metadata.kind,
    title: metadata.title,
    author: metadata.author,
    createdAt: metadata.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    expiresAt: data?.expiresAt ?? null,
  });
}
