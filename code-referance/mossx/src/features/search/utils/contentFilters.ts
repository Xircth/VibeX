import type { SearchContentFilter } from "../types";

export function toggleSearchContentFilters(
  previous: SearchContentFilter[],
  nextFilter: SearchContentFilter,
): SearchContentFilter[] {
  if (nextFilter === "all") {
    return ["all"];
  }

  const current = previous.includes("all")
    ? []
    : previous.filter((item) => item !== "all");

  if (current.includes(nextFilter)) {
    const next = current.filter((item) => item !== nextFilter);
    return next.length > 0 ? next : ["all"];
  }

  return [...current, nextFilter];
}
