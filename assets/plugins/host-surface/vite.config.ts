import { federation } from '@module-federation/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    federation({
      name: 'host_surface',
      filename: 'remoteEntry.js',
      dts: false,
      exposes: { './view': './src/views/view.tsx' },
      shared: {
        react: { singleton: true },
        'react-dom': { singleton: true },
      },
    }),
  ],
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      input: './src/views/view.tsx',
    },
  },
  server: {
    cors: true,
  },
});
