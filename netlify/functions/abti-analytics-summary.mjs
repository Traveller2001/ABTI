import {
  buildPublicSummary,
  createAnalyticsStore,
  ensureSummarySnapshot,
  getErrorMessage,
  json
} from "./_abti-analytics.mjs";

export default async (request) => {
  if (request.method !== "GET") {
    return json(
      { error: "Method Not Allowed" },
      { status: 405, headers: { Allow: "GET" } }
    );
  }

  try {
    const store = createAnalyticsStore();
    const snapshot = await ensureSummarySnapshot(store);
    return json(buildPublicSummary(snapshot.summary));
  } catch (error) {
    return json(
      {
        error: "Analytics summary unavailable",
        detail: getErrorMessage(error)
      },
      { status: 503 }
    );
  }
};
