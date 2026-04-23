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

test('session execution input opts into the minimal markdown preset only for follow-up composition', () => {
  const source = readFrontendFile(
    'src/components/tasks/TaskFollowUpSection.tsx'
  );

  assert.match(source, /markdownPreset="session-input-minimal"/);
  assert.match(source, /text-\[15px\] leading-7 tracking-\[0\.01em\]/);
});

test('wysiwyg editor keeps the default full markdown mode while exposing a minimal session-input preset', () => {
  const source = readFrontendFile('src/components/ui/wysiwyg.tsx');

  assert.match(
    source,
    /export type WysiwygMarkdownPreset = 'default' \| 'session-input-minimal'/
  );
  assert.match(source, /markdownPreset = 'default'/);
  assert.match(source, /const isSessionInputMinimalPreset =/);
  assert.match(source, /HEADING,/);
  assert.match(source, /UNORDERED_LIST,/);
  assert.match(source, /ORDERED_LIST,/);
  assert.match(source, /sessionInputMinimalTransformers/);
  assert.match(source, /allowRichHtmlPaste=\{!isSessionInputMinimalPreset\}/);
  assert.match(
    source,
    /!isSessionInputMinimalPreset[\s\S]*<CodeBlockShortcutPlugin \/>/
  );
  assert.match(source, /activeTransformers\.filter\(\(t\) => t !== HEADING\)/);
});

test('minimal session-input preset does not bleed into the shared conversation markdown renderer', () => {
  const source = readFrontendFile(
    'src/components/NormalizedConversation/Markdown.tsx'
  );

  assert.doesNotMatch(source, /session-input-minimal/);
});
