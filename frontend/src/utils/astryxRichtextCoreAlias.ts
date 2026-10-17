/**
 * `@astryxdesign/richtext@0.7.1` imports `@astryxdesign/core`, which pnpm
 * satisfies with the app's 0.3.0 copy. Rewrite those imports to the aliased
 * 0.7.1 package. Resolve the rewrite from the frontend package, not from
 * inside richtext — richtext cannot see `@astryxdesign/core-rte`.
 */
export function rewriteAstryxRichtextCoreSource(
  source: string,
  importer: string | undefined
): string | null {
  if (!importer) {
    return null;
  }
  const from = importer.replace(/\\/g, '/');
  const fromRichtext =
    from.includes('/@astryxdesign/richtext/') ||
    from.includes('/@astryxdesign+richtext@');
  if (!fromRichtext) {
    return null;
  }
  if (
    source === '@astryxdesign/core' ||
    source.startsWith('@astryxdesign/core/')
  ) {
    return source.replace('@astryxdesign/core', '@astryxdesign/core-rte');
  }
  return null;
}
