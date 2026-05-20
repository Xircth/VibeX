import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');

function readFrontendFile(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8');
}

test('preview toolbar selection forwards target-mode messages into the iframe bridge', () => {
  const source = readFrontendFile('src/utils/previewBridge.ts');

  assert.match(source, /ClickToComponentToolbarBridgeReadyMessage/);
  assert.match(source, /type:\s*'toolbar-bridge-ready'/);
  assert.match(source, /type:\s*'set-targeting'/);
  assert.match(source, /setTargetingEnabled\s*\(/);
});

test('preview panel requests proxied preview urls and supports upstream inspect protocol', () => {
  const source = readFrontendFile('src/components/panels/PreviewPanel.tsx');
  const api = readFrontendFile('src/lib/api/misc.ts');

  assert.match(api, /getPreviewProxyUrl/);
  assert.match(source, /getPreviewProxyUrl/);
  assert.match(source, /createClickedElementPayload/);
  assert.match(source, /type !== 'component-detected'/);
});

test('preview panel keeps selection state aligned with actual targeting state', () => {
  const source = readFrontendFile('src/components/panels/PreviewPanel.tsx');

  assert.match(
    source,
    /const\s*\[isSelectModeEnabled,\s*setIsSelectModeEnabled\]\s*=\s*useState\(false\)/
  );
  assert.match(source, /isToolbarBridgeReady/);
  assert.match(source, /setIsSelectModeEnabled\(false\)/);
  assert.match(source, /bootstrapPreviewBridge|schedulePreviewBridgeBootstrap/);
  assert.doesNotMatch(
    source,
    /if \(previewState\.status !== 'ready' \|\| !previewState\.url \|\| !addElement\) \{\s*return;/
  );
  assert.doesNotMatch(source, /if \(!activeIframe\) \{\s*return;\s*\}/);
  assert.match(source, /requestedSelectModeRef\.current\s*=\s*nextEnabled/);
  assert.match(source, /setIsSelectModeEnabled\(nextEnabled\)/);
});

test('preview panel always clears iframe targeting during bridge bootstrap and resets', () => {
  const source = readFrontendFile('src/components/panels/PreviewPanel.tsx');

  assert.match(source, /requestedSelectModeRef\.current\s*\?\?\s*false/);
  assert.match(
    source,
    /listener\.setTargetingEnabled\(\s*iframe,\s*false,\s*bridgeTokenRef\.current\s*\?\?\s*undefined\s*\)/
  );
});

test('clicked element provider notifies after React commits new entries', () => {
  const source = readFrontendFile('src/contexts/ClickedElementsProvider.tsx');

  assert.match(source, /notifiedElementIdsRef/);
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*for \(const entry of elements\)/
  );
  assert.doesNotMatch(
    source,
    /queueMicrotask\(\(\) => \{\s*onElementAddedCallbacksRef/
  );
});

test('ready preview toolbar exposes pressed state and passes iframe load back for bridge bootstrap', () => {
  const source = readFrontendFile(
    'src/components/tasks/TaskDetails/preview/ReadyContent.tsx'
  );

  assert.match(
    source,
    /onToggleSelectMode\?:\s*\(iframe:\s*HTMLIFrameElement\s*\|\s*null\)\s*=>\s*void/
  );
  assert.match(
    source,
    /onClick=\{\(\) => onToggleSelectMode\?\.\(iframeRef\.current\)\}/
  );
  assert.match(
    source,
    /onIframeLoad\?:\s*\(iframe:\s*HTMLIFrameElement\s*\|\s*null\)\s*=>\s*void/
  );
  assert.match(
    source,
    /onLoad=\{\(\) => onIframeLoad\?\.\(iframeRef\.current\)\}/
  );
  assert.match(source, /aria-pressed=\{isSelectModeEnabled\}/);
  assert.match(source, /useEffect\(\(\) => \{/);
  assert.match(source, /setUrlInput\(displayUrl \?\? url \?\? ''\)/);
  assert.match(source, /\}, \[displayUrl, url\]\)/);
});

test('ready preview device viewports use fixed defaults and expose manual resizing', () => {
  const source = readFrontendFile(
    'src/components/tasks/TaskDetails/preview/ReadyContent.tsx'
  );

  assert.match(source, /tablet:\s*\{\s*width:\s*768,\s*height:\s*1024\s*\}/);
  assert.match(source, /mobile:\s*\{\s*width:\s*430,\s*height:\s*932\s*\}/);
  assert.match(
    source,
    /minViewportSize:\s*ViewportSize\s*=\s*\{\s*width:\s*240,\s*height:\s*320\s*\}/
  );
  assert.match(source, /handleResizePointerDown/);
  assert.match(source, /handleResizePointerMove/);
  assert.match(source, /setPointerCapture\(event\.pointerId\)/);
  assert.match(source, /releasePointerCapture\(event\.pointerId\)/);
  assert.match(source, /aria-label="Resize preview viewport"/);
  assert.match(source, /<Grip className="h-3\.5 w-3\.5" \/>/);
  assert.doesNotMatch(source, /mobile:\s*\{\s*width:\s*'375px'/);
  assert.doesNotMatch(source, /const\s+viewSizes/);
});

test('web companion installer injects the toolbar bridge for parent-triggered selection', () => {
  const source = readFrontendFile('src/utils/installWebCompanion.ts');

  assert.match(source, /toolbar-bridge-ready/);
  assert.match(source, /set-targeting/);
  assert.match(source, /button\[title="Toggle targeting mode"\]/);
  assert.match(source, /aria-pressed/);
});
