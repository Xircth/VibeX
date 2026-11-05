import { loader, type Monaco } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

import { getCodeEditorService } from '@/features/plugins/providers/hostProviderServices';

let configured = false;

function configureLocalMonaco() {
  if (configured) return;

  self.MonacoEnvironment = {
    getWorker(_moduleId, label) {
      if (label === 'json') return new jsonWorker();
      if (label === 'css' || label === 'scss' || label === 'less') {
        return new cssWorker();
      }
      if (label === 'html' || label === 'handlebars' || label === 'razor') {
        return new htmlWorker();
      }
      if (label === 'typescript' || label === 'javascript') {
        return new tsWorker();
      }
      return new editorWorker();
    },
  };

  loader.config({ monaco });
  getCodeEditorService().setMonacoInstance(monaco);
  configured = true;
}

export async function initializeLocalMonaco(): Promise<Monaco> {
  configureLocalMonaco();
  const initialized = await loader.init();
  getCodeEditorService().setMonacoInstance(initialized);
  return initialized;
}
