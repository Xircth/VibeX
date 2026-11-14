import { createLogger, defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import pkg from './package.json';
import { createManualChunks } from './vite.manualChunks';
import { astryxRichtextCoreAlias } from './vite.astryx-richtext-core-alias';
import { vxSourceAnnotation } from './vite.vx-source-annotation';

const DEV_ONBOARDING_VIDEO_PREFIX = '/__dev/onboarding-videos/';
const SIBLING_SITE_VIDEO_DIR = path.resolve(
  __dirname,
  '../../vibex-site/public/videos/onboarding'
);

function devOnboardingVideos(): Plugin {
  return {
    name: 'dev-onboarding-videos',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url?.split('?')[0] ?? '';
        if (!rawUrl.startsWith(DEV_ONBOARDING_VIDEO_PREFIX)) {
          next();
          return;
        }
        const fileName = rawUrl.slice(DEV_ONBOARDING_VIDEO_PREFIX.length);
        if (!/^[a-z0-9-]+\.mp4$/.test(fileName)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const filePath = path.join(SIBLING_SITE_VIDEO_DIR, fileName);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(filePath);
        } catch {
          res.statusCode = 404;
          res.end();
          return;
        }
        const total = stat.size;
        const range = req.headers.range;
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Cache-Control', 'no-cache');
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          const start = match?.[1] ? Number.parseInt(match[1], 10) : 0;
          const end = match?.[2] ? Number.parseInt(match[2], 10) : total - 1;
          if (
            !match ||
            Number.isNaN(start) ||
            Number.isNaN(end) ||
            start > end ||
            end >= total
          ) {
            res.statusCode = 416;
            res.setHeader('Content-Range', `bytes */${total}`);
            res.end();
            return;
          }
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
          res.setHeader('Content-Length', String(end - start + 1));
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          fs.createReadStream(filePath, { start, end }).pipe(res);
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Length', String(total));
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        fs.createReadStream(filePath).pipe(res);
      });
    },
  };
}

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

export default defineConfig(({ command }) => ({
  envDir: path.resolve(__dirname, '..'),
  envPrefix: ['VITE_', 'VIBEX_'],
  customLogger: createFilteredLogger(),
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    astryxRichtextCoreAlias(),
    devOnboardingVideos(),
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
          ...(command === 'serve'
            ? [vxSourceAnnotation(path.resolve(__dirname, '..'))]
            : []),
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
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: 'shared', replacement: path.resolve(__dirname, '../shared') },
      {
        find: '@vibex/plugin-sdk',
        replacement: path.resolve(
          __dirname,
          '../packages/plugin-sdk/src/index.ts'
        ),
      },
      {
        find: /^react$/,
        replacement: path.resolve(__dirname, './node_modules/react'),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: path.resolve(
          __dirname,
          './node_modules/react/jsx-runtime.js'
        ),
      },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: path.resolve(
          __dirname,
          './node_modules/react/jsx-dev-runtime.js'
        ),
      },
      {
        find: /^react-dom$/,
        replacement: path.resolve(__dirname, './node_modules/react-dom'),
      },
      {
        find: /^react-dom\/client$/,
        replacement: path.resolve(
          __dirname,
          './node_modules/react-dom/client.js'
        ),
      },
    ],
  },
  server: {
    host: '0.0.0.0',
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
      allow: [
        path.resolve(__dirname, '.'),
        path.resolve(__dirname, '..'),
        path.resolve(__dirname, '../../..'),
      ],
    },
    open: process.env.VITE_OPEN === 'true',
    allowedHosts: [
      '.trycloudflare.com', // allow all cloudflared tunnels
    ],
  },
  optimizeDeps: {
    include: ['lucide-react'],
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
}));
