import type { Plugin } from 'vite';

/**
 * `@astryxdesign/richtext@0.7.1` peers `@astryxdesign/core@0.7.1`, while the
 * rest of the app stays on 0.3.0. Rewrite only richtext's core imports to the
 * aliased 0.7.1 package.
 */
export function astryxRichtextCoreAlias(): Plugin {
  return {
    name: 'astryx-richtext-core-alias',
    enforce: 'pre',
    async resolveId(source, importer) {
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
        return this.resolve(
          source.replace('@astryxdesign/core', '@astryxdesign/core-rte'),
          importer,
          { skipSelf: true }
        );
      }
      return null;
    },
  };
}
