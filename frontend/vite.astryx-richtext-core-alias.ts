import path from 'path';
import type { Plugin } from 'vite';
import { rewriteAstryxRichtextCoreSource } from './src/utils/astryxRichtextCoreAlias';

const frontendPackage = path.resolve(__dirname, 'package.json');

/**
 * `@astryxdesign/richtext@0.7.1` peers `@astryxdesign/core@0.7.1`, while the
 * rest of the app stays on 0.3.0. Rewrite only richtext's core imports to the
 * aliased 0.7.1 package, resolved from this frontend package.
 */
export function astryxRichtextCoreAlias(): Plugin {
  return {
    name: 'astryx-richtext-core-alias',
    enforce: 'pre',
    async resolveId(source, importer) {
      const rewritten = rewriteAstryxRichtextCoreSource(source, importer);
      if (!rewritten) {
        return null;
      }
      return this.resolve(rewritten, frontendPackage, { skipSelf: true });
    },
  };
}
