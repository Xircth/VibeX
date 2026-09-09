import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./WorkspaceRouteContent', () => ({
  WorkspaceRouteContent: () => <div data-testid="workspace-route-content" />,
}));

import { IDEWorkspaceRoute } from './IDEWorkspaceRoute';

describe('IDEWorkspaceRoute', () => {
  it('keeps the workspace chrome mounted while route content loads', async () => {
    render(<IDEWorkspaceRoute />);

    expect(screen.getByTestId('workspace-route-shell')).toBeInTheDocument();
    expect(
      await screen.findByTestId('workspace-route-content')
    ).toBeInTheDocument();
  });
});
