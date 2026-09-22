import { runStdioPluginWorker } from '@vibex/plugin-sdk';
import worker from './worker.mjs';

await runStdioPluginWorker(worker);
