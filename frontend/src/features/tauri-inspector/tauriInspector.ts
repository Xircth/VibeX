import type { OpenInEditorPayload } from '@/features/browser/inspectTypes';

export type TauriInspectorStatus = {
  is_tauri: boolean;
  installed: boolean;
  project_root: string | null;
  tauri_dir: string | null;
  message: string;
};

export type RedlineAnnotation = {
  type?: string;
  selector?: string;
  nearSelector?: string;
  tagName?: string;
  nearTagName?: string;
  classes?: string;
  nearClasses?: string;
  comment?: string;
  html?: string;
  computedCss?: Record<string, string>;
  position?: { x?: number; y?: number };
  to?: { x?: number; y?: number };
};

export type RedlineDocument = {
  view?: string;
  url?: string;
  timestamp?: string;
  annotations?: RedlineAnnotation[];
};

function annotationSelector(annotation: RedlineAnnotation): string | null {
  return annotation.selector ?? annotation.nearSelector ?? null;
}

function annotationTag(annotation: RedlineAnnotation): string | undefined {
  return (annotation.tagName ?? annotation.nearTagName)?.toLowerCase();
}

function annotationClasses(annotation: RedlineAnnotation): string | undefined {
  return annotation.classes ?? annotation.nearClasses ?? undefined;
}

export function redlineDocumentToPayloads(
  document: RedlineDocument
): OpenInEditorPayload[] {
  return (document.annotations ?? []).flatMap((annotation) => {
    const selector = annotationSelector(annotation);
    if (!selector) return [];

    const coordinates = annotation.position ?? annotation.to;
    const dataset: Record<string, string> = {
      redlineSelector: selector,
    };
    if (annotation.html) dataset.preview = annotation.html;
    if (annotation.comment) dataset.redlineComment = annotation.comment;
    if (annotation.computedCss) {
      dataset.redlineComputedCss = JSON.stringify(annotation.computedCss);
    }

    return [
      {
        selected: {
          name: selector,
          props: {},
          source: {
            fileName: '',
            lineNumber: 0,
            columnNumber: 0,
          },
          pathToSource: '',
          editor: '',
          url: document.url ?? '',
        },
        components: [],
        trigger: 'tauri-inspector',
        coords: coordinates,
        clickedElement: {
          tag: annotationTag(annotation),
          className: annotationClasses(annotation),
          dataset,
        },
      },
    ];
  });
}
