import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const distDir = resolve(__dirname, '../dist');
const assetsDir = join(distDir, 'assets');
const indexHtmlPath = join(distDir, 'index.html');

const MAX_STARTUP_BYTES = 1_600_000;
const MAX_VENDOR_REACT_BYTES = 600_000;
const MAX_CHUNK_BYTES = 1_500_000;
const MAX_SHIKI_CORE_CHUNK_BYTES = 300_000;
const FORBIDDEN_STARTUP_PRELOAD_PREFIXES = [
  'vendor-monaco-',
  'vendor-mermaid-',
  'vendor-shiki-',
  'vendor-terminal-',
  'vendor-dockview-',
  'vendor-diff-',
  'vendor-katex-',
  'vendor-gsap-',
  'vendor-xyflow-',
  'vendor-markdown-',
  'vendor-codemirror-',
];

const files = readdirSync(assetsDir);
const indexHtml = readFileSync(indexHtmlPath, 'utf8');
const preloaded = new Set(
  [...indexHtml.matchAll(/assets\/([^"']+\.js)/g)].map((match) => match[1])
);

let failed = false;

function fail(message) {
  console.error(`[bundle-budget] ${message}`);
  failed = true;
}

let startupBytes = 0;
let vendorReactBytes = 0;
let sawVendorReact = false;

for (const file of files) {
  const fullPath = join(assetsDir, file);
  const size = statSync(fullPath).size;

  if (file.endsWith('.woff2') && /noto-sans-sc/i.test(file)) {
    fail(`Noto Sans SC slice is still emitted: ${file}`);
  }

  if (!file.endsWith('.js')) continue;

  if (preloaded.has(file)) {
    startupBytes += size;
  }

  if (file.startsWith('vendor-shiki-') && !file.startsWith('vendor-shiki-core-')) {
    fail(`Forbidden monolithic Shiki chunk: ${file} (${size} bytes)`);
  }

  if (file.startsWith('vendor-shiki-core-') && size > MAX_SHIKI_CORE_CHUNK_BYTES) {
    fail(`${file} (${size} bytes) exceeds shiki core limit ${MAX_SHIKI_CORE_CHUNK_BYTES}`);
  }

  if (file.startsWith('vendor-react-')) {
    sawVendorReact = true;
    vendorReactBytes += size;
    if (size > MAX_VENDOR_REACT_BYTES) {
      fail(`${file} (${size} bytes) exceeds vendor-react limit ${MAX_VENDOR_REACT_BYTES}`);
    }
  }

  const monacoWorker = /(?:^|\/)(?:ts|css|html|json|editor)\.worker/i.test(file);
  const monacoChunk = file.startsWith('vendor-monaco-') || monacoWorker;
  if (size <= MAX_CHUNK_BYTES || monacoChunk) continue;
  const grammar =
    !preloaded.has(file) &&
    !file.startsWith('vendor-') &&
    !file.startsWith('index-') &&
    readFileSync(fullPath).subarray(0, 8000).toString('utf8').includes('scopeName');
  if (!grammar) {
    fail(`${file} (${size} bytes) exceeds per-chunk limit ${MAX_CHUNK_BYTES}`);
  }
}

if (!sawVendorReact) {
  fail('dist is missing vendor-react-*.js');
}

const startupReactBytes = [...preloaded]
  .filter((file) => file.startsWith('index-') || file.startsWith('vendor-react-'))
  .reduce((sum, file) => sum + statSync(join(assetsDir, file)).size, 0);

if (startupReactBytes > MAX_STARTUP_BYTES) {
  fail(
    `index + vendor-react preload is ${startupReactBytes} bytes, limit ${MAX_STARTUP_BYTES}`
  );
}

if (startupBytes > MAX_STARTUP_BYTES) {
  fail(
    `modulepreload JS total is ${startupBytes} bytes, limit ${MAX_STARTUP_BYTES}`
  );
}

for (const prefix of FORBIDDEN_STARTUP_PRELOAD_PREFIXES) {
  if (indexHtml.includes(prefix)) {
    fail(`dist/index.html must not modulepreload "${prefix}"`);
  }
}

if (failed) {
  process.exit(1);
}

console.log(
  `[bundle-budget] Passed. startup=${startupBytes} index+vendor-react=${startupReactBytes} vendor-react=${vendorReactBytes}`
);
