import { runStdioPluginWorker } from '@vibex/plugin-sdk/stdio';
import definition from './worker.mjs';

await runStdioPluginWorker(definition);
