export function reportSearchMetrics(payload: {
  query: string;
  elapsedMs: number;
  resultCount: number;
}): void {
  if (!import.meta.env.DEV) {
    return;
  }
  if (typeof console === "undefined") {
    return;
  }
  if (payload.query.trim().length === 0) {
    return;
  }
  console.debug("[search]", {
    q: payload.query,
    ms: payload.elapsedMs,
    count: payload.resultCount,
  });
}
