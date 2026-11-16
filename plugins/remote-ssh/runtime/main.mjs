import { runStdioPluginWorker } from '@dimoai/plugin-sdk';
import worker from './worker.mjs';

await runStdioPluginWorker(worker);
