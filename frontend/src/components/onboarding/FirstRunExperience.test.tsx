import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorType, type AgentManagementView } from 'shared/types';
import i18n from '@/i18n';
import { FirstRunExperience } from './FirstRunExperience';

const api = vi.hoisted(() => ({
  bar: vi.fn(),
  discoveryProgress: vi.fn(),
  registry: vi.fn(),
  refreshRegistry: vi.fn(),
  setEnabled: vi.fn(),
  reorder: vi.fn(),
  preflight: vi.fn(),
}));
vi.mock('@/features/agent-management', async (original) => ({
  ...(await original<typeof import('@/features/agent-management')>()),
  agentManagementApi: api,
}));
vi.mock('@/lib/backendTransport', async (original) => ({
  ...(await original<typeof import('@/lib/backendTransport')>()),
  backendListen: vi.fn(async () => () => undefined),
}));
vi.mock('@gsap/react', () => ({ useGSAP: vi.fn() }));
vi.mock('gsap', () => ({ default: { registerPlugin: vi.fn() } }));
vi.mock('@/components/settings/ExternalEditorPicker', () => ({
  ExternalEditorPicker: () => <div />,
}));
vi.mock('./OnboardingAccount', () => ({
  OnboardingAccount: () => <section aria-label="browser-account" />,
}));
vi.mock('./OnboardingAgents', async () => {
  const { AgentSetupPicker } = await import('./AgentSetupPicker');
  return {
    OnboardingAgents: ({
      picker,
    }: {
      picker: import('react').ComponentProps<typeof AgentSetupPicker>;
    }) => <AgentSetupPicker {...picker} />,
  };
});
vi.mock('./OnboardingProjects', () => ({
  OnboardingProjects: ({
    sourceAgentIds,
    onFinish,
  }: {
    sourceAgentIds: string[];
    onFinish: (ids: string[]) => Promise<void>;
  }) => (
    <section aria-label="projects">
      <p>{sourceAgentIds.join(',')}</p>
      <button onClick={() => void onFinish(['home', 'imported'])}>
        finish projects
      </button>
    </section>
  ),
}));

const t = (key: string) => i18n.t(`dialogs:onboarding.${key}`);
const editor = {
  editor_type: EditorType.FILE_MANAGER,
  custom_command: null,
  remote_ssh_host: null,
  remote_ssh_user: null,
};
function agent(id: string, ready: boolean): AgentManagementView {
  return {
    agent_id: id,
    display_name: id,
    description: '',
    source: 'built_in_profile',
    built_in: true,
    retired: false,
    enabled: ready,
    position: 0,
    lifecycle: ready ? 'ready' : 'uninstalled',
    authentication: ready ? 'account' : 'not_logged_in',
    runtime_version: null,
    acp_version: ready ? '1.0' : null,
    icon_light: null,
    icon_dark: null,
    icon_svg: null,
    active_operation: null,
    rollback_available: false,
  };
}
function setup(
  props: Partial<
    import('react').ComponentProps<typeof FirstRunExperience>
  > = {},
  strict = false
) {
  const onPersist = vi.fn().mockResolvedValue(undefined);
  const onFinish = vi.fn().mockResolvedValue(undefined);
  const component = (
    <FirstRunExperience
      open
      initialEditor={editor}
      initialDefaultAgentId="codex"
      onPersist={onPersist}
      onFinish={onFinish}
      {...props}
    />
  );
  render(strict ? <StrictMode>{component}</StrictMode> : component);
  return { onPersist, onFinish };
}
async function configure() {
  fireEvent.click(screen.getByRole('button', { name: t('next') }));
  await screen.findByRole('checkbox', {
    name: i18n.t('dialogs:onboarding.enableAgentAria', { agent: 'codex' }),
  });
}
describe('production first-run flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.bar.mockResolvedValue([
      agent('codex', true),
      agent('claude_code', false),
    ]);
    api.discoveryProgress.mockResolvedValue({
      phase: 'complete',
      completed: 2,
      total: 2,
      found: 1,
      checked_agent_ids: ['codex', 'claude_code'],
      timed_out: false,
    });
    api.registry.mockResolvedValue({
      installed: [],
      uninstalled: [],
      fresh: true,
    });
    api.preflight.mockResolvedValue({
      agent_id: 'codex',
      checked_at: '',
      items: [],
    });
    api.reorder.mockResolvedValue([]);
    api.setEnabled.mockResolvedValue(undefined);
  });
  it('replaces folded screenshots with optional browser account sign-in', async () => {
    setup();
    expect(
      screen.getByRole('region', { name: 'browser-account' })
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('onboarding-product-stack')
    ).not.toBeInTheDocument();
    await waitFor(() => expect(api.bar).toHaveBeenCalledTimes(1));
  });
  it('loads the catalogue under StrictMode and retains enabled/default choices', async () => {
    setup({}, true);
    await configure();
    expect(
      screen.getByRole('checkbox', {
        name: i18n.t('dialogs:onboarding.enableAgentAria', { agent: 'codex' }),
      })
    ).toBeChecked();
    expect(screen.getByRole('combobox')).toHaveTextContent('codex');
    expect(api.bar).toHaveBeenCalledTimes(1);
  });
  it('persists Agent choices and enters projects without a separate installation page', async () => {
    const callbacks = setup();
    await configure();
    fireEvent.click(screen.getByRole('button', { name: t('next') }));
    await screen.findByRole('region', { name: 'projects' });
    expect(callbacks.onPersist).toHaveBeenCalledWith({
      editor,
      defaultAgentId: 'codex',
      skipped: false,
    });
    expect(screen.getByRole('region', { name: 'projects' })).toHaveTextContent(
      'codex'
    );
    expect(callbacks.onFinish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'finish projects' }));
    await waitFor(() =>
      expect(callbacks.onFinish).toHaveBeenCalledWith(['home', 'imported'])
    );
  });
  it('keeps configuration open when the default Agent fails preflight', async () => {
    api.preflight.mockResolvedValue({
      agent_id: 'codex',
      checked_at: '',
      items: [
        {
          id: 'authentication',
          status: 'fail',
          label: 'Authentication',
          detail: 'Credential expired',
        },
      ],
    });
    const callbacks = setup();
    await configure();
    fireEvent.click(screen.getByRole('button', { name: t('next') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Credential expired'
    );
    expect(callbacks.onPersist).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('region', { name: 'projects' })
    ).not.toBeInTheDocument();
  });
  it('keeps the welcome page retryable if finishing a skipped setup fails', async () => {
    const onFinish = vi
      .fn()
      .mockRejectedValue(new Error('Cannot save preferences'));
    setup({ onFinish });
    fireEvent.click(screen.getByRole('button', { name: t('skip') }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cannot save preferences'
    );
    expect(screen.getByRole('button', { name: t('skip') })).toBeEnabled();
  });
  it('shows a recoverable catalogue failure and retries without dismissing onboarding', async () => {
    api.bar.mockRejectedValueOnce(new Error('Host unavailable'));
    setup();
    await configure().catch(() => undefined);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Host unavailable'
    );
    fireEvent.click(screen.getByRole('button', { name: t('retry') }));
    await screen.findByRole('checkbox', {
      name: i18n.t('dialogs:onboarding.enableAgentAria', { agent: 'codex' }),
    });
  });
});
