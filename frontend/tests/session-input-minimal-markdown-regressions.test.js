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

test('session execution input uses the lightweight composer instead of WYSIWYG markdown', () => {
  const source = readFrontendFile(
    'src/components/tasks/TaskFollowUpSection.tsx'
  );

  assert.match(source, /<SessionComposerInput/);
  assert.doesNotMatch(source, /<WYSIWYGEditor/);
  assert.doesNotMatch(
    source,
    /markdownPreset=\{SESSION_INPUT_MARKDOWN_PRESET\}/
  );
  assert.match(
    source,
    /sendShortcut=\{config\?\.send_message_shortcut \?\? 'Enter'\}/
  );
});

test('session execution input caps editor height at two and a half default rows', () => {
  const source = readFrontendFile(
    'src/components/tasks/follow-up/SessionComposerInput.tsx'
  );

  assert.match(source, /max-h-\[100px\]/);
  assert.match(source, /Math\.min\(textarea\.scrollHeight, 100\)/);
});

test('context compaction does not switch the session input into read-only markdown mode', () => {
  const source = readFrontendFile(
    'src/components/tasks/TaskFollowUpSection.tsx'
  );

  assert.match(
    source,
    /const isEditable = !isRetryActive && !hasPendingApproval;/
  );
  assert.match(source, /<SessionComposerInput[\s\S]*disabled=\{!isEditable\}/);
});

test('session input typeahead menus are not suppressed by initial query state', () => {
  const slashSource = readFrontendFile(
    'src/components/ui/wysiwyg/plugins/slash-command-typeahead-plugin.tsx'
  );
  const fileTagSource = readFrontendFile(
    'src/components/ui/wysiwyg/plugins/file-tag-typeahead-plugin.tsx'
  );
  const dollarSource = readFrontendFile(
    'src/components/ui/wysiwyg/plugins/dollar-command-typeahead-plugin.tsx'
  );

  assert.doesNotMatch(
    slashSource,
    /if \(!executor \|\| activeQuery === null\)/
  );
  assert.doesNotMatch(fileTagSource, /if \(activeQuery === null\)/);
  assert.match(slashSource, /const isThisMenuOpenRef = useRef\(false\)/);
  assert.match(fileTagSource, /const isThisMenuOpenRef = useRef\(false\)/);
  assert.match(dollarSource, /const isThisMenuOpenRef = useRef\(false\)/);
});

test('wysiwyg editor keeps full markdown mode while the session input preset stays plain text', () => {
  const source = readFrontendFile('src/components/ui/wysiwyg.tsx');

  assert.match(
    source,
    /export type WysiwygMarkdownPreset = 'default' \| 'session-input-minimal'/
  );
  assert.match(source, /markdownPreset = 'default'/);
  assert.match(source, /const isSessionInputMinimalPreset =/);
  assert.match(source, /HEADING,/);
  assert.match(source, /sessionInputMinimalTransformers/);
  assert.doesNotMatch(source, /UNORDERED_LIST/);
  assert.doesNotMatch(source, /ORDERED_LIST/);
  assert.match(source, /isSessionInputMinimalPreset\s*\?\s*\[\]/);
  assert.match(
    source,
    /!isSessionInputMinimalPreset[\s\S]*<MarkdownShortcutPlugin/
  );
  assert.match(
    source,
    /!isSessionInputMinimalPreset[\s\S]*<PasteMarkdownPlugin/
  );
  assert.match(
    source,
    /!isSessionInputMinimalPreset[\s\S]*<CodeBlockShortcutPlugin \/>/
  );
  assert.match(source, /activeTransformers\.filter\(\(t\) => t !== HEADING\)/);
});

test('session input keeps image paste support outside the full markdown paste path', () => {
  const source = readFrontendFile(
    'src/components/tasks/follow-up/SessionComposerInput.tsx'
  );
  const followUpSource = readFrontendFile(
    'src/components/tasks/TaskFollowUpSection.tsx'
  );
  const queueApiSource = readFrontendFile('src/lib/api/config.ts');
  const sharedTypes = readFrontendFile('../shared/types.ts');
  const wysiwygSource = readFrontendFile('src/components/ui/wysiwyg.tsx');

  assert.match(source, /onPaste=\{handlePaste\}/);
  assert.match(source, /extractImageFilesFromClipboardData/);
  assert.match(source, /readImageFilesFromNavigatorClipboard/);
  assert.match(source, /clipboardDataHasTextPayload/);
  assert.match(source, /onAttachImages\(files\)/);
  assert.match(source, /onAttachImages\(clipboardFiles\)/);
  assert.match(source, /useImageMetadata/);
  assert.match(source, /ImagePreviewDialog\.show/);
  assert.match(source, /fileTreeApi[\s\S]*readBinaryAsset/);
  assert.match(source, /previewUrlFailed/);
  assert.doesNotMatch(source, /revokeObjectURL\(image\.previewUrl\)/);
  assert.match(source, /<img[\s\S]*src=\{imageUrl\}/);
  assert.match(followUpSource, /URL\.createObjectURL\(file\)/);
  assert.match(followUpSource, /revokeImagePreviewUrl/);
  assert.match(followUpSource, /taskAttemptId=\{workspaceId\}/);
  assert.match(followUpSource, /images: attachedImagePaths/);
  assert.match(
    followUpSource,
    /queueMessage\(prompt, effectiveExecutorProfile, attachedImagePaths\)/
  );
  assert.doesNotMatch(followUpSource, /`!\[/);
  assert.match(queueApiSource, /images: data\.images \?\? \[\]/);
  assert.match(sharedTypes, /DraftFollowUpData = \{ message: string, images:/);
  assert.doesNotMatch(wysiwygSource, /ImagePastePlugin/);
  assert.doesNotMatch(wysiwygSource, /onPasteFiles/);
});

test('image uploads use the snake_case payload expected by Tauri commands', () => {
  const source = readFrontendFile('src/lib/api/misc.ts');

  assert.match(source, /file_name: file\.name/);
  assert.match(source, /data_base64: await fileToBase64\(file\)/);
  assert.doesNotMatch(source, /fileName: file\.name/);
  assert.doesNotMatch(source, /dataBase64: await fileToBase64\(file\)/);
});

test('iframe clipboard bridge lets editable paste use the native paste event', () => {
  const bridgeSource = readFrontendFile('src/vscode/bridge.ts');

  assert.match(bridgeSource, /else if \(isPaste\(e\)\)/);
  assert.match(bridgeSource, /if \(el\) \{\s*return;\s*\}/);
  assert.doesNotMatch(
    bridgeSource,
    /readClipboardText\(\)[\s\S]*insertTextAtCaretGeneric\(text\)/
  );
});

test('minimal session-input preset does not bleed into the shared conversation markdown renderer', () => {
  const source = readFrontendFile(
    'src/components/NormalizedConversation/Markdown.tsx'
  );

  assert.doesNotMatch(source, /session-input-minimal/);
});

test('user message images render as thumbnails outside the text bubble', () => {
  const source = readFrontendFile(
    'src/components/NormalizedConversation/UserMessage.tsx'
  );

  assert.match(source, /splitDisplayContentImages/);
  assert.match(source, /\.vibe-images/);
  assert.match(source, /ImagePreviewDialog\.show/);
  assert.match(source, /useImageMetadata/);
  assert.match(source, /readBinaryAsset/);
  assert.match(source, /userMessageImageUrlCache/);
  assert.match(source, /userMessageImageUrlRequests/);
  assert.match(source, /userMessageThumbnailCache/);
  assert.match(source, /ensureUserMessageThumbnailFromAsset/);
  assert.match(source, /USER_MESSAGE_THUMBNAIL_SIZE/);
  assert.match(source, /rememberUserMessageImageUrl/);
  assert.match(source, /getCachedUserMessageImageUrl/);
  assert.match(source, /src=\{displayImageUrl\}/);
  assert.match(source, /value=\{displayText\}/);
  assert.doesNotMatch(source, /value=\{displayContent\}/);
  assert.match(
    source,
    /displayImages\.length > 0[\s\S]*UserMessageImageAttachment/
  );
  assert.match(
    source,
    /className="flex w-full max-w-full flex-col items-end gap-1\.5"/
  );
  assert.match(source, /className="flex h-20 w-20/);
});
