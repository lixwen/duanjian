export function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function normalizeConversationSearch(value) {
  return String(value ?? "").trim().toLocaleLowerCase("en");
}

function cleanAnchorPart(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function turnFingerprint(turn) {
  const user = Array.isArray(turn.user)
    ? turn.user.map((block) => block.type === "image"
      ? [block.type, block.url, block.alt]
      : [block.type, block.markdown ?? block.html])
    : [];
  const markdownList = (items) => Array.isArray(items)
    ? items.map((item) => typeof item === "string" ? item : item?.markdown ?? item?.html)
    : [];
  const activities = Array.isArray(turn.activities)
    ? turn.activities.map((activity) => [activity.type, activity.label, activity.status])
    : [];

  return JSON.stringify([
    turn.label,
    user,
    turn.reasoningSummaries,
    markdownList(turn.commentary),
    markdownList(turn.answers),
    activities,
  ]);
}

export function createConversationTurnAnchors(turns) {
  const prepared = turns.map((turn) => {
    const cleanedId = cleanAnchorPart(turn.id);
    const base = cleanedId
      ? (cleanedId.startsWith("turn-") ? cleanedId : `turn-${cleanedId}`)
      : `turn-${hashText(turnFingerprint(turn))}`;
    return { base, fingerprint: hashText(turnFingerprint(turn)) };
  });
  const baseCounts = prepared.reduce((counts, item) => {
    counts.set(item.base, (counts.get(item.base) ?? 0) + 1);
    return counts;
  }, new Map());
  const claimed = new Set();

  return prepared.map(({ base, fingerprint }) => {
    const candidateBase = baseCounts.get(base) > 1 ? `${base}-${fingerprint}` : base;
    let candidate = candidateBase;
    let suffix = 2;
    while (claimed.has(candidate)) {
      candidate = `${candidateBase}-${suffix}`;
      suffix += 1;
    }
    claimed.add(candidate);
    return candidate;
  });
}
