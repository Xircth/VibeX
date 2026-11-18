import { describe, expect, it } from 'vitest';

import {
  CANONICAL_UNNAMED_WORKFLOW_PATH,
  isUnnamedWorkflowName,
  namedWorkflowSourcePath,
  sourcePathForWorkflowName,
} from './canvasDraft';

describe('canvas draft identity', () => {
  it('treats the default names as the single overwrite-able draft', () => {
    expect(isUnnamedWorkflowName('新建任务')).toBe(true);
    expect(isUnnamedWorkflowName(' New Task ')).toBe(true);
    expect(isUnnamedWorkflowName('')).toBe(true);
    expect(isUnnamedWorkflowName('CI 修复')).toBe(false);
  });

  it('keeps one canonical path for the unnamed draft and a stable path after naming', () => {
    expect(sourcePathForWorkflowName('新建任务')).toBe(
      CANONICAL_UNNAMED_WORKFLOW_PATH
    );
    expect(sourcePathForWorkflowName('New Task')).toBe(
      CANONICAL_UNNAMED_WORKFLOW_PATH
    );
    expect(namedWorkflowSourcePath('CI 修复')).toBe(
      '~/.dimo/workflows/CI 修复.dimo-workflow.json'
    );
    expect(namedWorkflowSourcePath('bad:name')).toBe(
      '~/.dimo/workflows/bad name.dimo-workflow.json'
    );
  });
});
