import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentPermissionPanel } from './AgentPermissionPanel';

describe('AgentPermissionPanel', () => {
  it('responds with selected permission option', () => {
    const onRespond = vi.fn();

    render(
      <AgentPermissionPanel
        respondingPermissionId={null}
        permissions={[
          {
            connectionId: 'connection',
            request: {
              id: 'permission',
              session_id: 'session',
              title: 'Run command',
              options: [{ id: 'allow', label: 'Allow' }],
            },
          },
        ]}
        onRespond={onRespond}
      />
    );

    fireEvent.click(screen.getByText('Allow'));

    expect(onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'connection' }),
      'allow'
    );
  });
});
