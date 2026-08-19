import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PluginArtifactEditor } from './PluginArtifactEditor';

vi.mock('@/features/workflow/WorkflowArtifactStudio', () => ({
  WorkflowArtifactStudio: ({ filePath }: { filePath: string }) => (
    <div data-testid="native-workflow-studio">{filePath}</div>
  ),
}));

vi.mock('@/components/plugins/AppSurfaceHost', () => ({
  AppSurfaceHost: () => <div data-testid="plugin-app-surface" />,
}));

const opener = {
  pluginId: 'vibex.workflow-creator',
  contributionId: 'workflow-source-opener',
  label: 'Workflow Studio',
  handler: 'workflow-studio',
  target: 'app_surface' as const,
  priority: 200,
  generation: 4,
};

describe('PluginArtifactEditor', () => {
  it('uses the shared native Workflow Studio declared by the plugin', () => {
    render(
      <PluginArtifactEditor
        opener={{ ...opener, nativeRenderer: 'workflow.studio' }}
        filePath="/workspace/review.vibex-workflow.json"
      />
    );

    expect(screen.getByTestId('native-workflow-studio')).toHaveTextContent(
      '/workspace/review.vibex-workflow.json'
    );
    expect(screen.queryByTestId('plugin-app-surface')).not.toBeInTheDocument();
  });

  it('keeps generic artifact editors on the SDK App surface host', () => {
    render(
      <PluginArtifactEditor
        opener={opener}
        filePath="/workspace/diagram.json"
      />
    );

    expect(screen.getByTestId('plugin-app-surface')).toBeInTheDocument();
  });
});
