import { createLogger, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import pkg from './package.json';
import { createManualChunks } from './vite.manualChunks';
import { astryxRichtextCoreAlias } from './vite.astryx-richtext-core-alias';

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

export default defineConfig({
  customLogger: createFilteredLogger(),
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    astryxRichtextCoreAlias(),
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
    include: ['lucide-react', '@module-federation/runtime'],
    exclude: ['@astryxdesign/richtext'],
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
