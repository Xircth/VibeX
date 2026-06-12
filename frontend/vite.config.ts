// vite.config.ts
import { createLogger, defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import pkg from './package.json';

function createFilteredLogger() {
  const logger = createLogger();
  const originalError = logger.error.bind(logger);

  let lastRestartLog = 0;
  const DEBOUNCE_MS = 2000;

  logger.error = (msg, options) => {
    const isProxyError =
      msg.includes('ws proxy socket error') ||
      msg.includes('ws proxy error:') ||
      msg.includes('http proxy error:');

    if (isProxyError) {
      const now = Date.now();
      if (now - lastRestartLog > DEBOUNCE_MS) {
        logger.warn('Proxy connection closed, auto-reconnecting...');
        lastRestartLog = now;
      }
      return;
    }
    originalError(msg, options);
  };

  return logger;
}

function executorSchemasPlugin(): Plugin {
  const VIRTUAL_ID = 'virtual:executor-schemas';
  const RESOLVED_VIRTUAL_ID = '\0' + VIRTUAL_ID;
  const schemasDir = path.resolve(__dirname, '../shared/schemas');

  return {
    name: 'executor-schemas-plugin',
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID; // keep it virtual
      return null;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return null;

      const files = fs.existsSync(schemasDir)
        ? fs.readdirSync(schemasDir).filter((f) => f.endsWith('.json'))
        : [];

      const imports: string[] = [];
      const entries: string[] = [];

      files.forEach((file, i) => {
        const varName = `__schema_${i}`;
        const importPath = `shared/schemas/${file}`; // uses your alias
        const key = file.replace(/\.json$/, '').toUpperCase(); // claude_code -> CLAUDE_CODE
        imports.push(`import ${varName} from "${importPath}";`);
        entries.push(`  "${key}": ${varName}`);
      });

      // IMPORTANT: pure JS (no TS types), and quote keys.
      const code = `
${imports.join('\n')}

export const schemas = {
${entries.join(',\n')}
};

export default schemas;
`;
      return code;
    },
    configureServer(server) {
      // Watch the schemas directory so new/changed schema files
      // invalidate the virtual module without a dev-server restart.
      server.watcher.add(schemasDir);
      server.watcher.on('all', (event, filePath) => {
        if (
          filePath.startsWith(schemasDir) &&
          filePath.endsWith('.json') &&
          ['add', 'change', 'unlink'].includes(event)
        ) {
          const mod = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_ID);
          if (mod) {
            server.moduleGraph.invalidateModule(mod);
            server.ws.send({ type: 'full-reload' });
          }
        }
      });
    },
  };
}

function createManualChunks(id: string): string | undefined {
  const normalizedId = id.replace(/\\/g, '/');

  if (!normalizedId.includes('/node_modules/')) {
    return undefined;
  }

  if (
    normalizedId.includes('/node_modules/mermaid/') ||
    normalizedId.includes('/node_modules/@mermaid-js/') ||
    normalizedId.includes('/node_modules/@braintree/sanitize-url/') ||
    normalizedId.includes('/node_modules/@iconify/') ||
    normalizedId.includes('/node_modules/@upsetjs/venn.js/') ||
    normalizedId.includes('/node_modules/cytoscape') ||
    normalizedId.includes('/node_modules/cose-base/') ||
    normalizedId.includes('/node_modules/d3') ||
    normalizedId.includes('/node_modules/dagre-d3-es/') ||
    normalizedId.includes('/node_modules/dayjs/') ||
    normalizedId.includes('/node_modules/delaunator/') ||
    normalizedId.includes('/node_modules/es-toolkit/') ||
    normalizedId.includes('/node_modules/internmap/') ||
    normalizedId.includes('/node_modules/khroma/') ||
    normalizedId.includes('/node_modules/layout-base/') ||
    normalizedId.includes('/node_modules/marked/') ||
    normalizedId.includes('/node_modules/robust-predicates/') ||
    normalizedId.includes('/node_modules/roughjs/') ||
    normalizedId.includes('/node_modules/stylis/') ||
    normalizedId.includes('/node_modules/ts-dedent/') ||
    normalizedId.includes('/node_modules/uuid/')
  ) {
    return 'vendor-mermaid';
  }

  if (
    normalizedId.includes('/node_modules/shiki/') ||
    normalizedId.includes('/node_modules/@shikijs/') ||
    normalizedId.includes('/node_modules/vscode-oniguruma/') ||
    normalizedId.includes('/node_modules/vscode-textmate/')
  ) {
    return 'vendor-shiki';
  }

  if (
    normalizedId.includes('/node_modules/monaco-editor/') ||
    normalizedId.includes('/node_modules/@monaco-editor/')
  ) {
    return 'vendor-monaco';
  }

  if (normalizedId.includes('/node_modules/@xterm/')) {
    return 'vendor-terminal';
  }

  if (
    normalizedId.includes('/node_modules/@codemirror/') ||
    normalizedId.includes('/node_modules/@uiw/react-codemirror/')
  ) {
    return 'vendor-codemirror';
  }

  if (
    normalizedId.includes('/node_modules/lexical/') ||
    normalizedId.includes('/node_modules/@lexical/')
  ) {
    return 'vendor-lexical';
  }

  if (normalizedId.includes('/node_modules/highlight.js/es/languages/')) {
    const language = path.basename(normalizedId, '.js');
    if (
      ['mathematica', 'isbl', 'gml', 'sqf', '1c', 'maxima', 'pgsql'].includes(
        language
      )
    ) {
      return 'vendor-highlight-special';
    }

    if (/^[a-f]/.test(language)) {
      return 'vendor-highlight-a-f';
    }

    if (/^[g-m]/.test(language)) {
      return 'vendor-highlight-g-m';
    }

    return 'vendor-highlight-n-z';
  }

  if (normalizedId.includes('/node_modules/highlight.js/')) {
    return 'vendor-highlight';
  }

  if (normalizedId.includes('/node_modules/prismjs/')) {
    return 'vendor-prism';
  }

  if (
    normalizedId.includes('/node_modules/react-markdown/') ||
    normalizedId.includes('/node_modules/remark-') ||
    normalizedId.includes('/node_modules/rehype-') ||
    normalizedId.includes('/node_modules/micromark') ||
    normalizedId.includes('/node_modules/mdast-') ||
    normalizedId.includes('/node_modules/hast-') ||
    normalizedId.includes('/node_modules/unified/') ||
    normalizedId.includes('/node_modules/unist-') ||
    normalizedId.includes('/node_modules/vfile')
  ) {
    return 'vendor-markdown';
  }

  if (
    normalizedId.includes('/node_modules/@git-diff-view/') ||
    normalizedId.includes('/node_modules/@pierre/diffs/')
  ) {
    return 'vendor-diff';
  }

  if (
    normalizedId.includes('/node_modules/dockview') ||
    normalizedId.includes('/node_modules/dockview-core/') ||
    normalizedId.includes('/node_modules/dockview-react/')
  ) {
    return 'vendor-dockview';
  }

  if (normalizedId.includes('/node_modules/@radix-ui/')) {
    return 'vendor-radix';
  }

  if (normalizedId.includes('/node_modules/@dnd-kit/')) {
    return 'vendor-dnd';
  }

  if (normalizedId.includes('/node_modules/lucide-react/')) {
    return 'vendor-icons';
  }

  if (normalizedId.includes('/node_modules/@tauri-apps/')) {
    return 'vendor-tauri';
  }

  return 'vendor';
}

export default defineConfig({
  customLogger: createFilteredLogger(),
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react({
      babel: {
        compact: false,
        plugins: [
          [
            'babel-plugin-react-compiler',
            {
              target: '18',
              sources: [path.resolve(__dirname, 'src')],
              environment: {
                enableResetCacheOnSourceFileChanges: true,
              },
            },
          ],
        ],
      },
    }),
    executorSchemasPlugin(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      shared: path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    port: parseInt(process.env.FRONTEND_PORT || '3000'),
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.BACKEND_PORT || '3001'}`,
        changeOrigin: true,
        ws: true,
      },
    },
    fs: {
      allow: [path.resolve(__dirname, '.'), path.resolve(__dirname, '..')],
    },
    open: process.env.VITE_OPEN === 'true',
    allowedHosts: [
      '.trycloudflare.com', // allow all cloudflared tunnels
    ],
  },
  optimizeDeps: {
    exclude: ['wa-sqlite', '@lexical/code'],
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: createManualChunks,
      },
    },
  },
});
