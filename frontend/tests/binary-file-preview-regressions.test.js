import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(frontendRoot, '..');

function readFrontendFile(relativePath) {
  return fs.readFileSync(path.join(frontendRoot, relativePath), 'utf8');
}

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('preview panel keeps Office rendering behind plugin file openers', () => {
  const source = readFrontendFile(
    'src/components/panels/DockviewPreviewPanel.tsx'
  );
  const hookSource = readFrontendFile('src/hooks/useFileContent.ts');
  const apiSource = readFrontendFile('src/lib/api/misc.ts');
  const zoomableImageSource = readFrontendFile(
    'src/components/previews/ZoomableImagePreview.tsx'
  );
  const popoverSource = readFrontendFile(
    'src/components/file-tree/FilePreviewPopover.tsx'
  );
  const backendSource = readRepoFile('src-tauri/src/commands/file_tree.rs');

  assert.match(source, /getFilePreviewKind/);
  assert.match(source, /previewKind === 'text'/);
  assert.match(source, /useBinaryAssetPreview/);
  assert.match(source, /ZoomableImagePreview/);
  assert.match(source, /shouldFetchBinaryAsset/);
  assert.match(source, /Loading image preview/);
  assert.match(source, /Loading PDF preview/);
  assert.match(source, /effectivePreviewKind === 'pdf'/);
  assert.doesNotMatch(source, /effectivePreviewKind === 'document'/);
  assert.doesNotMatch(source, /useDocumentPreview/);
  assert.match(source, /PDF preview is unavailable/);
  assert.match(source, /Binary file preview is not supported/);
  assert.match(source, /Image preview is unavailable/);
  assert.match(hookSource, /export function useBinaryAssetPreview/);
  assert.match(hookSource, /URL\.createObjectURL\(blob\)/);
  assert.match(hookSource, /URL\.revokeObjectURL\(nextObjectUrl\)/);
  assert.match(apiSource, /readBinaryAsset: async \(path: string\)/);
  assert.match(apiSource, /'read_binary_asset'/);
  assert.doesNotMatch(apiSource, /read_document_preview/);
  assert.match(backendSource, /pub async fn read_binary_asset/);
  assert.match(backendSource, /data_base64/);
  assert.match(backendSource, /mime_type/);
  assert.doesNotMatch(backendSource, /read_document_preview/);
  assert.match(zoomableImageSource, /Wheel to zoom/);
  assert.match(zoomableImageSource, /Drag to pan/);
  assert.match(zoomableImageSource, /View image at actual size/);
  assert.match(zoomableImageSource, /Fit to viewport/);
  assert.match(zoomableImageSource, /onDoubleClick/);
  assert.match(popoverSource, /ZoomableImagePreview/);
});

test('diff panel and diff cards no longer force-load readonly assets as UTF-8 text', () => {
  const diffPanelSource = readFrontendFile(
    'src/components/panels/DockviewDiffPanel.tsx'
  );
  const diffCardSource = readFrontendFile('src/components/DiffCard.tsx');

  assert.match(diffPanelSource, /shouldFetchTextDiff = previewKind === 'text'/);
  assert.match(diffPanelSource, /Binary diff is not supported/);
  assert.match(diffPanelSource, /PDF diff is not supported here/);
  assert.match(diffPanelSource, /Word document diff is not supported here/);
  assert.match(
    diffCardSource,
    /canForceLoadTextContent = previewKind === 'text'/
  );
  assert.match(
    diffCardSource,
    /Binary diff content is not rendered in this card/
  );
  assert.match(
    diffCardSource,
    /Image diff content is not rendered in this card/
  );
  assert.match(diffCardSource, /PDF diff content is not rendered in this card/);
  assert.match(
    diffCardSource,
    /Word document diff content is not rendered in this card/
  );
});

test('binary read failures are downgraded from noisy global console errors', () => {
  const fileChangeSource = readFrontendFile(
    'src/components/NormalizedConversation/FileChangeRenderer.tsx'
  );
  const processChangeSource = readFrontendFile(
    'src/components/NormalizedConversation/ProcessChangeFileRenderer.tsx'
  );
  const hookSource = readFrontendFile('src/hooks/useFileContent.ts');
  const mainSource = readFrontendFile('src/main.tsx');
  const tauriApiSource = readFrontendFile('src/lib/tauriApi.ts');

  assert.match(
    fileChangeSource,
    /shouldRenderInlineTextDiff =\s*isWrite\(change\) && effectiveExpanded && previewKind === 'text'/
  );
  assert.match(
    processChangeSource,
    /shouldRenderInlineTextDiff =\s*isWrite\(change\) && effectiveExpanded && previewKind === 'text'/
  );
  assert.match(fileChangeSource, /previewKind !== 'text'/);
  assert.match(processChangeSource, /previewKind !== 'text'/);
  assert.match(hookSource, /suppressGlobalError: true/);
  assert.match(mainSource, /suppressGlobalError/);
  assert.match(mainSource, /isFileContentQuery/);
  assert.match(mainSource, /isCanceledError\(error\)/);
  assert.match(mainSource, /isBinaryContentError\(error\)/);
  assert.match(tauriApiSource, /isCanceledError/);
  assert.match(tauriApiSource, /isExpectedBinaryTextReadError/);
  assert.match(tauriApiSource, /!isCanceledError\(error\)/);
  assert.match(tauriApiSource, /!isExpectedBinaryTextReadError\(cmd, error\)/);
  assert.match(
    tauriApiSource,
    /!isExpectedAttachTerminalNotFoundError\(cmd, error\)/
  );
  assert.match(
    tauriApiSource,
    /!isExpectedRepoRemoteConfigError\(cmd, error\)/
  );
});

test('backend rejects binary blobs and has no Office-specific preview extraction', () => {
  const source = readRepoFile('src-tauri/src/commands/file_tree.rs');

  assert.match(source, /fn read_utf8_text_file/);
  assert.match(source, /Binary file cannot be opened as text/);
  assert.match(source, /blob\.is_binary\(\)/);
  assert.doesNotMatch(source, /pub async fn read_document_preview/);
  assert.doesNotMatch(source, /extract_docx_text_from_xml/);
  assert.doesNotMatch(source, /extract_word_text_with_powershell/);
});
