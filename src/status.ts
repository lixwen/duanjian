const STATUS_CACHE_KEY = "system:status:v3";
const STATUS_CACHE_SECONDS = 300;
const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

const FREE_LIMITS = {
  workerRequests: 100_000,
  workerLogs: 200_000,
  staticAssetFiles: 20_000,
  cronTriggers: 5,
  kvReads: 100_000,
  kvWrites: 1_000,
  kvDeletes: 1_000,
  kvLists: 1_000,
  kvStorage: 1_000_000_000,
  r2Storage: 10_000_000_000,
  r2ClassA: 1_000_000,
  r2ClassB: 10_000_000,
} as const;

const R2_CLASS_A = new Set([
  "ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject",
  "CompleteMultipartUpload", "CreateMultipartUpload", "UploadPart",
  "UploadPartCopy", "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycle",
  "PutBucketNotificationConfiguration", "PutBucketLockConfiguration",
]);
const R2_CLASS_B = new Set([
  "HeadBucket", "HeadObject", "GetObject", "GetBucketEncryption", "GetBucketLocation",
  "GetBucketCors", "GetBucketLifecycle", "GetBucketNotificationConfiguration",
  "GetBucketLockConfiguration", "UsageSummary",
]);

export interface StatusEnv {
  DOCS: KVNamespace;
  IMAGES: R2Bucket;
  ASSETS?: Fetcher;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_ANALYTICS_TOKEN?: string;
  KV_NAMESPACE_ID?: string;
  R2_BUCKET_NAME?: string;
  WORKER_SCRIPT_NAME?: string;
  CRON_TRIGGER_COUNT?: string;
  RATE_LIMIT_POLICY_COUNT?: string;
  WORKERS_LOGS_ENABLED?: string;
}

export interface StatusMetric {
  id: string;
  used: number | null;
  limit: number;
  unit: "requests" | "operations" | "bytes" | "events" | "files" | "triggers";
  period: "day" | "month" | "current";
  scope: "project" | "resource";
  source: string;
  estimated?: boolean;
}

export interface StatusResource {
  id: string;
  value: number;
  source: string;
}

export interface SystemStatus {
  version: 1;
  generatedAt: number;
  cacheSeconds: number;
  analyticsConfigured: boolean;
  analyticsAvailable: boolean;
  documents: {
    markdown: number;
    conversations: number;
    total: number;
  };
  images: {
    objects: number;
    bytes: number;
  };
  metrics: StatusMetric[];
  resources: StatusResource[];
  notices: string[];
}

interface AnalyticsValues {
  workerRequests: number | null;
  kvReads: number | null;
  kvWrites: number | null;
  kvDeletes: number | null;
  kvLists: number | null;
  kvStorage: number | null;
  r2ClassA: number | null;
  r2ClassB: number | null;
}

interface GraphQlResponse {
  data?: { viewer?: { accounts?: Array<Record<string, unknown>> } };
  errors?: unknown[];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstAccount(response: GraphQlResponse): Record<string, unknown> | null {
  if (response.errors?.length) return null;
  const account = response.data?.viewer?.accounts?.[0];
  return account && typeof account === "object" ? account : null;
}

function rows(account: Record<string, unknown> | null, key: string): Array<Record<string, unknown>> {
  const value = account?.[key];
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
}

function sumField(items: Array<Record<string, unknown>>, field: string): number {
  return items.reduce((total, item) => {
    const sum = item.sum;
    if (!sum || typeof sum !== "object") return total;
    return total + (finiteNumber((sum as Record<string, unknown>)[field]) ?? 0);
  }, 0);
}

function maxField(items: Array<Record<string, unknown>>, field: string): number | null {
  const values = items.flatMap((item) => {
    const max = item.max;
    if (!max || typeof max !== "object") return [];
    const value = finiteNumber((max as Record<string, unknown>)[field]);
    return value === null ? [] : [value];
  });
  return values.length ? Math.max(...values) : null;
}

async function graphql(
  env: StatusEnv,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_ANALYTICS_TOKEN) return null;
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) return null;
  return firstAccount(await response.json() as GraphQlResponse);
}

async function workerAnalytics(env: StatusEnv, start: string, end: string): Promise<number | null> {
  if (!env.WORKER_SCRIPT_NAME) return null;
  const account = await graphql(env, `
    query WorkerUsage($accountTag: string!, $start: string!, $end: string!, $script: string!) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 10000
          filter: { datetime_geq: $start, datetime_leq: $end, scriptName: $script }
        ) { sum { requests } }
      } }
    }
  `, {
    accountTag: env.CLOUDFLARE_ACCOUNT_ID,
    start,
    end,
    script: env.WORKER_SCRIPT_NAME,
  });
  if (!account) return null;
  return sumField(rows(account, "workersInvocationsAdaptive"), "requests");
}

async function kvAnalytics(env: StatusEnv, start: string, end: string): Promise<Pick<AnalyticsValues, "kvReads" | "kvWrites" | "kvDeletes" | "kvLists" | "kvStorage">> {
  const empty = { kvReads: null, kvWrites: null, kvDeletes: null, kvLists: null, kvStorage: null };
  if (!env.KV_NAMESPACE_ID) return empty;
  const account = await graphql(env, `
    query KvUsage($accountTag: string!, $namespaceId: string!, $start: Date!, $end: Date!) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        kvOperationsAdaptiveGroups(
          limit: 10000
          filter: { date_geq: $start, date_leq: $end, namespaceId: $namespaceId }
        ) { dimensions { actionType } sum { requests } }
        kvStorageAdaptiveGroups(
          limit: 10000
          filter: { date_geq: $start, date_leq: $end, namespaceId: $namespaceId }
        ) { max { byteCount } }
      } }
    }
  `, { accountTag: env.CLOUDFLARE_ACCOUNT_ID, namespaceId: env.KV_NAMESPACE_ID, start, end });
  if (!account) return empty;
  const operations = rows(account, "kvOperationsAdaptiveGroups");
  const counts = { read: 0, write: 0, delete: 0, list: 0 };
  for (const item of operations) {
    const dimensions = item.dimensions;
    const action = dimensions && typeof dimensions === "object"
      ? String((dimensions as Record<string, unknown>).actionType ?? "").toLowerCase()
      : "";
    const count = sumField([item], "requests");
    if (action.includes("read")) counts.read += count;
    else if (action.includes("write")) counts.write += count;
    else if (action.includes("delete")) counts.delete += count;
    else if (action.includes("list")) counts.list += count;
  }
  return {
    kvReads: counts.read,
    kvWrites: counts.write,
    kvDeletes: counts.delete,
    kvLists: counts.list,
    kvStorage: maxField(rows(account, "kvStorageAdaptiveGroups"), "byteCount"),
  };
}

export function classifyR2Operation(action: string): "classA" | "classB" | "free" | "unknown" {
  const normalized = action.toLowerCase();
  if ([...R2_CLASS_A].some((item) => item.toLowerCase() === normalized)) return "classA";
  if ([...R2_CLASS_B].some((item) => item.toLowerCase() === normalized)) return "classB";
  if (normalized.startsWith("delete") || normalized === "abortmultipartupload") return "free";
  return "unknown";
}

async function r2Analytics(env: StatusEnv, start: string, end: string): Promise<Pick<AnalyticsValues, "r2ClassA" | "r2ClassB">> {
  const empty = { r2ClassA: null, r2ClassB: null };
  if (!env.R2_BUCKET_NAME) return empty;
  const account = await graphql(env, `
    query R2Usage($accountTag: string!, $bucket: string!, $start: Time!, $end: Time!) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        r2OperationsAdaptiveGroups(
          limit: 10000
          filter: { datetime_geq: $start, datetime_leq: $end, bucketName: $bucket }
        ) { dimensions { actionType } sum { requests } }
      } }
    }
  `, { accountTag: env.CLOUDFLARE_ACCOUNT_ID, bucket: env.R2_BUCKET_NAME, start, end });
  if (!account) return empty;
  let classA = 0;
  let classB = 0;
  for (const item of rows(account, "r2OperationsAdaptiveGroups")) {
    const dimensions = item.dimensions;
    const action = dimensions && typeof dimensions === "object"
      ? String((dimensions as Record<string, unknown>).actionType ?? "")
      : "";
    const count = sumField([item], "requests");
    const classification = classifyR2Operation(action);
    if (classification === "classA") classA += count;
    if (classification === "classB") classB += count;
  }
  return { r2ClassA: classA, r2ClassB: classB };
}

async function analytics(env: StatusEnv, now: Date): Promise<AnalyticsValues> {
  const day = now.toISOString().slice(0, 10);
  const dayStart = `${day}T00:00:00.000Z`;
  const end = now.toISOString();
  const monthStart = `${day.slice(0, 8)}01T00:00:00.000Z`;
  const [worker, kv, r2] = await Promise.allSettled([
    workerAnalytics(env, dayStart, end),
    kvAnalytics(env, day, day),
    r2Analytics(env, monthStart, end),
  ]);
  const kvValue = kv.status === "fulfilled" ? kv.value : { kvReads: null, kvWrites: null, kvDeletes: null, kvLists: null, kvStorage: null };
  const r2Value = r2.status === "fulfilled" ? r2.value : { r2ClassA: null, r2ClassB: null };
  return {
    workerRequests: worker.status === "fulfilled" ? worker.value : null,
    ...kvValue,
    ...r2Value,
  };
}

async function countKvPrefix(kv: KVNamespace, prefix: string): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, limit: 1_000, cursor });
    total += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return total;
}

async function countR2(bucket: R2Bucket): Promise<{ objects: number; bytes: number }> {
  let objects = 0;
  let bytes = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ limit: 1_000, cursor });
    objects += page.objects.length;
    bytes += page.objects.reduce((total, object) => total + object.size, 0);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { objects, bytes };
}

async function countStaticAssets(assets?: Fetcher): Promise<number | null> {
  if (!assets) return null;
  try {
    const response = await assets.fetch("https://assets.internal/resource-manifest.json");
    if (!response.ok) return null;
    const manifest = await response.json() as { staticAssetFiles?: unknown };
    return finiteNumber(manifest.staticAssetFiles);
  } catch {
    return null;
  }
}

function configuredCount(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function metric(id: string, used: number | null, limit: number, unit: StatusMetric["unit"], period: StatusMetric["period"], scope: StatusMetric["scope"], source: string, estimated = false): StatusMetric {
  return { id, used, limit, unit, period, scope, source, ...(estimated ? { estimated } : {}) };
}

export async function getSystemStatus(env: StatusEnv): Promise<SystemStatus> {
  const cached = await env.DOCS.get<SystemStatus>(STATUS_CACHE_KEY, "json");
  if (cached && Date.now() - cached.generatedAt < STATUS_CACHE_SECONDS * 1_000) return cached;

  const now = new Date();
  const analyticsConfigured = Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ANALYTICS_TOKEN);
  const [markdown, conversations, images, usage, staticAssetFiles] = await Promise.all([
    countKvPrefix(env.DOCS, "doc:"),
    countKvPrefix(env.DOCS, "conv:"),
    countR2(env.IMAGES),
    analytics(env, now),
    countStaticAssets(env.ASSETS),
  ]);
  const analyticsAvailable = Object.values(usage).every((value) => value !== null);
  const notices = !analyticsConfigured
    ? ["analytics_not_configured"]
    : analyticsAvailable ? [] : ["analytics_partial"];
  const snapshot: SystemStatus = {
    version: 1,
    generatedAt: now.getTime(),
    cacheSeconds: STATUS_CACHE_SECONDS,
    analyticsConfigured,
    analyticsAvailable,
    documents: { markdown, conversations, total: markdown + conversations },
    images,
    metrics: [
      metric("workerRequests", usage.workerRequests, FREE_LIMITS.workerRequests, "requests", "day", "project", "https://developers.cloudflare.com/workers/platform/pricing/"),
      ...(env.WORKERS_LOGS_ENABLED === "false" ? [] : [
        metric("workerLogs", usage.workerRequests, FREE_LIMITS.workerLogs, "events", "day", "project", "https://developers.cloudflare.com/workers/observability/logs/workers-logs/", true),
      ]),
      metric("kvReads", usage.kvReads, FREE_LIMITS.kvReads, "operations", "day", "resource", "https://developers.cloudflare.com/kv/platform/pricing/"),
      metric("kvWrites", usage.kvWrites, FREE_LIMITS.kvWrites, "operations", "day", "resource", "https://developers.cloudflare.com/kv/platform/pricing/"),
      metric("kvDeletes", usage.kvDeletes, FREE_LIMITS.kvDeletes, "operations", "day", "resource", "https://developers.cloudflare.com/kv/platform/pricing/"),
      metric("kvLists", usage.kvLists, FREE_LIMITS.kvLists, "operations", "day", "resource", "https://developers.cloudflare.com/kv/platform/pricing/"),
      metric("kvStorage", usage.kvStorage, FREE_LIMITS.kvStorage, "bytes", "current", "resource", "https://developers.cloudflare.com/kv/platform/pricing/"),
      metric("r2Storage", images.bytes, FREE_LIMITS.r2Storage, "bytes", "current", "resource", "https://developers.cloudflare.com/r2/pricing/"),
      metric("r2ClassA", usage.r2ClassA, FREE_LIMITS.r2ClassA, "operations", "month", "resource", "https://developers.cloudflare.com/r2/pricing/"),
      metric("r2ClassB", usage.r2ClassB, FREE_LIMITS.r2ClassB, "operations", "month", "resource", "https://developers.cloudflare.com/r2/pricing/"),
      metric("staticAssetFiles", staticAssetFiles, FREE_LIMITS.staticAssetFiles, "files", "current", "project", "https://developers.cloudflare.com/workers/static-assets/platform/limits/"),
      metric("cronTriggers", configuredCount(env.CRON_TRIGGER_COUNT, 1), FREE_LIMITS.cronTriggers, "triggers", "current", "resource", "https://developers.cloudflare.com/workers/platform/limits/"),
    ],
    resources: [{
      id: "rateLimitPolicies",
      value: configuredCount(env.RATE_LIMIT_POLICY_COUNT, 2),
      source: "https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/",
    }],
    notices,
  };
  await env.DOCS.put(STATUS_CACHE_KEY, JSON.stringify(snapshot), { expirationTtl: STATUS_CACHE_SECONDS * 2 });
  return snapshot;
}
