import { runStdioPluginWorker } from '@dimoai/plugin-sdk/stdio';
import definition from './worker.mjs';

await runStdioPluginWorker(definition);
