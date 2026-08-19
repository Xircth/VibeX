import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

import type { BackendTransport } from '@/lib/backendTransport';
import { BackendTransportProvider } from '@/lib/transport';
import { AutomationCenter } from './AutomationCenter';

describe('AutomationCenter', () => {
  it('chooses the automation type in a dialog instead of navigating to a chooser page', async () => {
    const user = userEvent.setup();
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async (command: string) => {
        if (command === 'automation_engine_status') return { active: true };
        if (command === 'automation_list') return [];
        if (command === 'automation_templates') return [];
        throw new Error(`Unexpected command: ${command}`);
      }),
    };

    render(
      <BackendTransportProvider transport={transport}>
        <MemoryRouter initialEntries={['/settings/automations']}>
          <AutomationCenter />
        </MemoryRouter>
      </BackendTransportProvider>
    );

    await waitFor(() =>
      expect(screen.queryByText(/正在加载|loading/i)).not.toBeInTheDocument()
    );
    await user.click(screen.getByRole('button', { name: /新建|new/i }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(
      screen.getByText(/选择自动化类型|choose an automation type/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /单次会话|single session/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /工作流|workflow/i })
    ).toBeInTheDocument();
  });
});
