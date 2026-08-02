import path from 'node:path';
import { mergeConfig } from 'vite';

import baseConfig from './vite.config';

export default mergeConfig(baseConfig, {
  build: {
    rollupOptions: {
      input: {
        app: path.resolve(import.meta.dirname, 'index.html'),
        agentE: path.resolve(import.meta.dirname, 'e2e/agent-e/index.html'),
        agentG: path.resolve(import.meta.dirname, 'e2e/agent-g/index.html'),
        agentJ: path.resolve(import.meta.dirname, 'e2e/agent-j/index.html'),
      },
    },
  },
});
