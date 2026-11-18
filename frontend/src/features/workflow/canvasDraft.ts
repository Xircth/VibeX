import type { WorkflowDefinition } from 'shared/types';

import type { BackendTransport } from '@/lib/backendTransport';

import {
  resolveWorkflowSourceRevision,
  type WorkflowSourceApi,
} from './workflowSourceApi';

/** Display names that mean the overwrite-able singleton draft. */
export const UNNAMED_WORKFLOW_NAMES = ['新建任务', 'New Task'] as const;

/** The only unnamed workflow file allowed under ~/.dimo/workflows/. */
export const CANONICAL_UNNAMED_WORKFLOW_PATH =
  '~/.dimo/workflows/新建任务.dimo-workflow.json';

/** Marker MCP catalog entries use for the workflow open on the canvas. */
export const CANVAS_VIEWING_MARKER = 'dimo.canvas.viewing';

export function isUnnamedWorkflowName(
  name: string | null | undefined
): boolean {
  const trimmed = name?.trim() ?? '';
  return (
    trimmed.length === 0 ||
    UNNAMED_WORKFLOW_NAMES.some((candidate) => candidate === trimmed)
  );
}

function sanitizeWorkflowFileName(name: string): string {
  let safe = '';
  for (const char of name.trim()) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || '<>:"/\\|?*'.includes(char)) {
      safe += ' ';
    } else {
      safe += char;
    }
  }
  return safe
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 80);
}

export function namedWorkflowSourcePath(name: string): string {
  const fileName = sanitizeWorkflowFileName(name) || 'workflow';
  return `~/.dimo/workflows/${fileName}.dimo-workflow.json`;
}

export function workflowSourceContent(definition: WorkflowDefinition): string {
  return `${JSON.stringify(definition, null, 2)}\n`;
}

export function sourcePathForWorkflowName(name: string): string {
  return isUnnamedWorkflowName(name)
    ? CANONICAL_UNNAMED_WORKFLOW_PATH
    : namedWorkflowSourcePath(name);
}

/**
 * Write a workflow source, re-reading the CAS revision once if the file
 * changed between the editor's last snapshot and this save.
 */
export async function writeWorkflowSourceFile(
  api: WorkflowSourceApi,
  path: string,
  definition: WorkflowDefinition,
  knownRevision: string | null
): Promise<string | null> {
  const content = workflowSourceContent(definition);
  const writeOnce = async (revision: string | null) => {
    const written = await api.write(path, content, revision ?? undefined);
    return written?.revision ?? null;
  };
  const revision =
    knownRevision ?? (await resolveWorkflowSourceRevision(api, path, null));
  try {
    return await writeOnce(revision);
  } catch (error) {
    const fresh = await resolveWorkflowSourceRevision(api, path, null);
    if (fresh && fresh !== revision) {
      return writeOnce(fresh);
    }
    throw error;
  }
}

export async function publishCanvasFocus(
  transport: BackendTransport,
  focus: {
    path?: string | null;
    name?: string | null;
    definitionId?: string | null;
    viewing: boolean;
  }
): Promise<void> {
  await transport.call('workflow_canvas_focus', {
    path: focus.path ?? null,
    name: focus.name ?? null,
    definitionId: focus.definitionId ?? null,
    viewing: focus.viewing,
  });
}
