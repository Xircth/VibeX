// vite.config.ts
import { createLogger, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
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

function createManualChunks(id: string): string | undefined {
  const normalizedId = id.replace(/\\/g, '/');

  if (!normalizedId.includes('/node_modules/')) {
    return undefined;
  }

  if (
    normalizedId.includes('/node_modules/mermaid/') ||
    normalizedId.includes('/node_modules/@mermaid-js/')
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

  if (normalizedId.includes('/node_modules/@git-diff-view/')) {
    return 'vendor-diff';
  }

  if (
    normalizedId.includes('/node_modules/dockview') ||
    normalizedId.includes('/node_modules/dockview-core/') ||
    normalizedId.includes('/node_modules/dockview-react/')
  ) {
    return 'vendor-dockview';
  }

  if (normalizedId.includes('/node_modules/@tauri-apps/')) {
    return 'vendor-tauri';
  }

  // React UI libraries stay here with React. A separate icons/radix chunk
  // boots before React.forwardRef exists and leaves the Host Web UI blank.
  return 'vendor';
}

export default defineConfig({
  customLogger: createFilteredLogger(),
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    {
      name: 'react-refresh-preamble',
      apply: 'serve',
      transformIndexHtml() {
        return [
          {
            tag: 'script',
            attrs: { type: 'module' },
            injectTo: 'head-prepend',
            children: `import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;`,
          },
        ];
      },
    },
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
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      shared: path.resolve(__dirname, '../shared'),
    },
  },
  server: {
    port: parseInt(process.env.FRONTEND_PORT || '3000', 10),
    proxy: (() => {
      const frontendPort = parseInt(process.env.FRONTEND_PORT || '3000', 10);
      const backendPort = process.env.BACKEND_PORT
        ? parseInt(process.env.BACKEND_PORT, 10)
        : undefined;
      if (!backendPort || backendPort === frontendPort) {
        return undefined;
      }
      return {
        '/api': {
          target: `http://127.0.0.1:${backendPort}`,
          changeOrigin: true,
          ws: true,
        },
      };
    })(),
    fs: {
      allow: [path.resolve(__dirname, '.'), path.resolve(__dirname, '..')],
    },
    open: process.env.VITE_OPEN === 'true',
    allowedHosts: [
      '.trycloudflare.com', // allow all cloudflared tunnels
    ],
  },
  optimizeDeps: {
    exclude: ['wa-sqlite'],
    include: ['lucide-react'],
  },
  build: {
    sourcemap: process.env.VITE_SOURCEMAP === 'true',
    rollupOptions: {
      output: {
        manualChunks: createManualChunks,
      },
    },
  },
});
