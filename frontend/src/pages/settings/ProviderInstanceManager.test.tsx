import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProviderInstanceSelector } from '@/components/tasks/follow-up/ProviderInstanceSelector';
import type {
  ProviderInstanceConfig,
  ProviderInstancesApi,
} from '@/lib/providerInstancesApi';
import { ProviderInstanceManager } from './ProviderInstanceManager';

const INITIAL_INSTANCES: ProviderInstanceConfig[] = [
  {
    instanceId: 'claude-personal',
    agentId: 'claude-code',
    displayName: 'Claude (Personal)',
    authMode: {
      mode: 'OfficialOAuth',
      accountEmail: 'personal@example.com',
    },
    isDefault: true,
    hasActiveSessions: false,
  },
  {
    instanceId: 'claude-work',
    agentId: 'claude-code',
    displayName: 'Claude (Work)',
    authMode: {
      mode: 'ApiKey',
      maskedPreview: 'sk-ant-...9f2a',
    },
    isDefault: false,
    hasActiveSessions: false,
  },
  {
    instanceId: 'codex-ops',
    agentId: 'codex',
    displayName: 'Codex (Ops)',
    authMode: {
      mode: 'SecretManager',
      opReference: 'op://Engineering/Codex/api-key',
    },
    isDefault: false,
    hasActiveSessions: true,
  },
];

function makeMockApi(
  seed: ProviderInstanceConfig[] = INITIAL_INSTANCES
): ProviderInstancesApi {
  let state = [...seed];
  return {
    list: vi.fn(async () => [...state]),
    create: vi.fn(async (input) => {
      const created: ProviderInstanceConfig = {
        instanceId: `inst-${state.length + 1}`,
        agentId: input.agentId,
        displayName: input.displayName,
        authMode: input.authMode,
        isDefault: Boolean(input.isDefault),
        hasActiveSessions: false,
      };
      state = [...state, created];
      return created;
    }),
    update: vi.fn(async (instanceId, input) => {
      state = state.map((item) =>
        item.instanceId === instanceId
          ? {
              ...item,
              displayName: input.displayName,
              authMode: input.authMode,
              isDefault: Boolean(input.isDefault),
            }
          : item
      );
      return state.find((i) => i.instanceId === instanceId)!;
    }),
    setDefault: vi.fn(async (agentId, instanceId) => {
      state = state.map((item) =>
        item.agentId === agentId
          ? { ...item, isDefault: item.instanceId === instanceId }
          : item
      );
    }),
    remove: vi.fn(async (_agentId, instanceId) => {
      state = state.filter((item) => item.instanceId !== instanceId);
    }),
    testConnection: vi.fn(async (target) => {
      if ('instanceId' in target && target.instanceId === 'claude-work') {
        return { ok: false, error: 'Invalid API key' };
      }
      return { ok: true, latencyMs: 42 };
    }),
  };
}

describe('ProviderInstanceManager', () => {
  it('groups instances by agent type, disables delete for default and active instances, and tests connections', async () => {
    const api = makeMockApi();

    render(<ProviderInstanceManager api={api} />);

    expect(
      await screen.findByTestId('provider-instance-card-claude-personal')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('provider-group-claude-code')
    ).toHaveTextContent('Claude (Personal)');
    expect(
      screen.getByTestId('provider-group-claude-code')
    ).toHaveTextContent('Claude (Work)');
    expect(screen.getByTestId('provider-group-codex')).toHaveTextContent(
      'Codex (Ops)'
    );

    // Default instance cannot be deleted
    expect(screen.getByTestId('delete-instance-claude-personal')).toBeDisabled();
    // Active-session instance cannot be deleted
    expect(screen.getByTestId('delete-instance-codex-ops')).toBeDisabled();
    // Non-default idle instance can be deleted
    expect(
      screen.getByTestId('delete-instance-claude-work')
    ).not.toBeDisabled();

    // Test connection success
    fireEvent.click(screen.getByTestId('test-instance-claude-personal'));
    expect(
      await screen.findByTestId('test-result-claude-personal')
    ).toHaveTextContent('✓');

    // Test connection diagnostic failure
    fireEvent.click(screen.getByTestId('test-instance-claude-work'));
    expect(
      await screen.findByTestId('test-result-claude-work')
    ).toHaveTextContent('Invalid API key');
  });

  it('supports creating a 1Password op:// instance, locking agentId on edit, setting default, and deleting', async () => {
    const api = makeMockApi();

    render(<ProviderInstanceManager api={api} />);
    await screen.findByTestId('provider-instance-card-claude-personal');

    // Open create form for Codex
    fireEvent.click(screen.getByTestId('add-instance-codex'));
    expect(screen.getByTestId('form-agent-select')).not.toBeDisabled();

    fireEvent.change(screen.getByTestId('form-display-name-input'), {
      target: { value: 'Codex (1Password)' },
    });
    fireEvent.change(screen.getByTestId('form-auth-mode-select'), {
      target: { value: 'SecretManager' },
    });

    // Invalid op:// reference should trigger validation error
    fireEvent.change(screen.getByTestId('form-op-reference-input'), {
      target: { value: 'invalid-ref' },
    });
    fireEvent.click(screen.getByTestId('form-save-btn'));
    expect(
      await screen.findByTestId('form-validation-error')
    ).toHaveTextContent('op://');

    // Valid op:// reference saves cleanly
    fireEvent.change(screen.getByTestId('form-op-reference-input'), {
      target: { value: 'op://Personal/Codex/credential' },
    });
    fireEvent.click(screen.getByTestId('form-save-btn'));

    await waitFor(() => {
      expect(api.create).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'codex',
          displayName: 'Codex (1Password)',
          authMode: {
            mode: 'SecretManager',
            opReference: 'op://Personal/Codex/credential',
          },
        })
      );
    });

    // Edit locks agentId select
    fireEvent.click(screen.getByTestId('edit-instance-claude-work'));
    expect(screen.getByTestId('form-agent-select')).toBeDisabled();
    fireEvent.click(screen.getByTestId('form-cancel-btn'));

    // Set Claude (Work) as default -> now Claude (Personal) can be deleted
    fireEvent.click(screen.getByTestId('set-default-claude-work'));
    await waitFor(() => {
      expect(api.setDefault).toHaveBeenCalledWith('claude-code', 'claude-work');
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('delete-instance-claude-personal')
      ).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('delete-instance-claude-personal'));
    await waitFor(() => {
      expect(api.remove).toHaveBeenCalledWith(
        'claude-code',
        'claude-personal'
      );
    });
  });
});

describe('ProviderInstanceSelector', () => {
  it('renders formatted instance labels with auth mode and triggers callback on switch', () => {
    const onSelectInstance = vi.fn();

    render(
      <ProviderInstanceSelector
        instances={INITIAL_INSTANCES}
        selectedInstanceId="claude-personal"
        onSelectInstance={onSelectInstance}
      />
    );

    const select = screen.getByTestId(
      'provider-instance-select'
    ) as HTMLSelectElement;
    expect(select.value).toBe('claude-personal');
    expect(select).toHaveTextContent('Claude (Personal) (OAuth)');
    expect(select).toHaveTextContent('Claude (Work) (API Key)');
    expect(select).toHaveTextContent('Codex (Ops) (1Password)');

    fireEvent.change(select, { target: { value: 'codex-ops' } });
    expect(onSelectInstance).toHaveBeenCalledWith(INITIAL_INSTANCES[2]);
  });
});
