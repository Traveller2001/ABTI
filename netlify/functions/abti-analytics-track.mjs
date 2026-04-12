import { randomUUID } from "node:crypto";
import {
  PERSONA_CODES,
  addResultToSummary,
  addVisitToSummary,
  createAnalyticsStore,
  getErrorMessage,
  json,
  updateSummarySnapshot
} from "./_abti-analytics.mjs";

const ALLOWED_RESULT_CODES = new Set(PERSONA_CODES);

export default async (request) => {
  if (request.method !== "POST") {
    return json(
      { error: "Method Not Allowed" },
      { status: 405, headers: { Allow: "POST" } }
    );
  }

  const store = createAnalyticsStore();
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const now = Date.now();
  const id = randomUUID();
  const recordedAt = new Date(now).toISOString();

  try {
    if (payload?.kind === "visit") {
      await updateSummarySnapshot(store, (summary) => addVisitToSummary(summary, recordedAt));
      await store.setJSON(`visits/${now}-${id}.json`, {
        kind: "visit",
        path: typeof payload.path === "string" ? payload.path : "/",
        recordedAt
      });

      return json({ ok: true });
    }

    if (payload?.kind === "result") {
      const personaCode = typeof payload.personaCode === "string" ? payload.personaCode : "";
      if (!ALLOWED_RESULT_CODES.has(personaCode)) {
        return json({ error: "Unknown personaCode" }, { status: 400 });
      }

      await updateSummarySnapshot(store, (summary) =>
        addResultToSummary(summary, personaCode, recordedAt)
      );
      await store.setJSON(`results/${encodeURIComponent(personaCode)}/${now}-${id}.json`, {
        kind: "result",
        personaCode,
        personaName: typeof payload.personaName === "string" ? payload.personaName : "",
        special: Boolean(payload.special),
        similarity: Number.isFinite(payload.similarity) ? payload.similarity : null,
        recordedAt
      });

      return json({ ok: true });
    }
  } catch (error) {
    return json(
      {
        error: "Analytics write failed",
        detail: getErrorMessage(error)
      },
      { status: 503 }
    );
  }

  return json({ error: "Unknown analytics kind" }, { status: 400 });
};
