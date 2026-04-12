import { getStore } from "@netlify/blobs";

export const STORE_NAME = "abti-analytics-v1";
export const SUMMARY_KEY = "summary/summary-v1.json";
const SUMMARY_SCHEMA_VERSION = 1;
const MAX_SUMMARY_UPDATE_RETRIES = 8;

export const PERSONA_CODES = [
  "PAPER",
  "NERD",
  "PI-er",
  "CAFE",
  "REF-s",
  "TANK",
  "SOS!",
  "HACK",
  "MONK",
  "RUSH",
  "BOSS",
  "CHILL",
  "STAR",
  "COPY",
  "IDEA",
  "SOLO",
  "TALK",
  "GRIND",
  "SLIDE",
  "REVIEW",
  "GRANT",
  "PIVOT",
  "BURN",
  "CLEAN",
  "QUIT",
  "404"
];

export function createAnalyticsStore() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

export function json(data, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), {
    ...init,
    headers
  });
}

export function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function createEmptyCounts() {
  return Object.fromEntries(PERSONA_CODES.map((code) => [code, 0]));
}

function normalizeNonNegativeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function normalizeIsoTimestamp(value) {
  if (typeof value !== "string" || !value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function createEmptySummary() {
  return {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    totalVisits: 0,
    totalResults: 0,
    lastUpdatedAt: null,
    counts: createEmptyCounts()
  };
}

export function cloneSummary(summary) {
  const normalized = normalizeSummary(summary);
  return {
    ...normalized,
    counts: { ...normalized.counts }
  };
}

export function normalizeSummary(summary) {
  const next = createEmptySummary();
  if (!summary || typeof summary !== "object") return next;

  next.totalVisits = normalizeNonNegativeInteger(summary.totalVisits);
  next.totalResults = normalizeNonNegativeInteger(summary.totalResults);
  next.lastUpdatedAt = normalizeIsoTimestamp(summary.lastUpdatedAt);

  if (summary.counts && typeof summary.counts === "object") {
    for (const code of PERSONA_CODES) {
      next.counts[code] = normalizeNonNegativeInteger(summary.counts[code]);
    }
  }

  return next;
}

function getLatestIsoTimestamp(currentIso, candidateIso) {
  const current = normalizeIsoTimestamp(currentIso);
  const candidate = normalizeIsoTimestamp(candidateIso);
  if (!current) return candidate;
  if (!candidate) return current;
  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

export function addVisitToSummary(summary, recordedAt) {
  const next = cloneSummary(summary);
  next.totalVisits += 1;
  next.lastUpdatedAt = getLatestIsoTimestamp(next.lastUpdatedAt, recordedAt);
  return next;
}

export function addResultToSummary(summary, personaCode, recordedAt) {
  if (!PERSONA_CODES.includes(personaCode)) {
    throw new Error(`Unknown personaCode: ${personaCode}`);
  }

  const next = cloneSummary(summary);
  next.totalResults += 1;
  next.counts[personaCode] += 1;
  next.lastUpdatedAt = getLatestIsoTimestamp(next.lastUpdatedAt, recordedAt);
  return next;
}

function extractTimestamp(key) {
  const match = key.match(/\/(\d{13})-/);
  return match ? Number(match[1]) : 0;
}

function extractPersonaCode(key) {
  const match = key.match(/^results\/([^/]+)\//);
  return match ? decodeURIComponent(match[1]) : null;
}

export function buildPublicSummary(summary) {
  const normalized = normalizeSummary(summary);
  const ranking = PERSONA_CODES.map((code) => {
    const count = normalized.counts[code];
    return {
      code,
      count,
      share: normalized.totalResults ? Number(((count / normalized.totalResults) * 100).toFixed(1)) : 0
    };
  }).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.code.localeCompare(b.code, "en");
  });

  return {
    totalVisits: normalized.totalVisits,
    totalResults: normalized.totalResults,
    uniquePersonasHit: ranking.filter((item) => item.count > 0).length,
    lastUpdatedAt: normalized.lastUpdatedAt,
    ranking
  };
}

export async function loadSummarySnapshot(store) {
  const entry = await store.getWithMetadata(SUMMARY_KEY, {
    type: "json",
    consistency: "strong"
  });

  if (entry === null) return null;

  return {
    summary: normalizeSummary(entry.data),
    etag: entry.etag
  };
}

async function listAllKeys(store, prefix) {
  const keys = [];
  for await (const page of store.list({ prefix, paginate: true })) {
    for (const blob of page.blobs) {
      keys.push(blob.key);
    }
  }
  return keys;
}

export async function rebuildSummaryFromEvents(store) {
  const summary = createEmptySummary();

  const visitKeys = await listAllKeys(store, "visits/");
  for (const key of visitKeys) {
    summary.totalVisits += 1;
    const timestamp = extractTimestamp(key);
    if (timestamp) {
      summary.lastUpdatedAt = getLatestIsoTimestamp(
        summary.lastUpdatedAt,
        new Date(timestamp).toISOString()
      );
    }
  }

  const resultKeys = await listAllKeys(store, "results/");
  for (const key of resultKeys) {
    summary.totalResults += 1;

    const code = extractPersonaCode(key);
    if (code && code in summary.counts) {
      summary.counts[code] += 1;
    }

    const timestamp = extractTimestamp(key);
    if (timestamp) {
      summary.lastUpdatedAt = getLatestIsoTimestamp(
        summary.lastUpdatedAt,
        new Date(timestamp).toISOString()
      );
    }
  }

  return summary;
}

export async function ensureSummarySnapshot(store) {
  const existing = await loadSummarySnapshot(store);
  if (existing) return existing;

  const rebuilt = await rebuildSummaryFromEvents(store);
  const created = await store.setJSON(SUMMARY_KEY, rebuilt, { onlyIfNew: true });
  if (created.modified) {
    return {
      summary: rebuilt,
      etag: created.etag
    };
  }

  const afterRace = await loadSummarySnapshot(store);
  if (afterRace) return afterRace;

  throw new Error("Failed to initialize analytics summary snapshot");
}

export async function updateSummarySnapshot(store, mutator) {
  let current = await ensureSummarySnapshot(store);

  for (let attempt = 0; attempt < MAX_SUMMARY_UPDATE_RETRIES; attempt += 1) {
    const next = normalizeSummary(mutator(cloneSummary(current.summary)));
    const updated = await store.setJSON(SUMMARY_KEY, next, {
      onlyIfMatch: current.etag
    });

    if (updated.modified) {
      return next;
    }

    const fresh = await loadSummarySnapshot(store);
    if (!fresh) {
      current = await ensureSummarySnapshot(store);
      continue;
    }

    current = fresh;
  }

  throw new Error("Failed to update analytics summary after concurrent retries");
}
