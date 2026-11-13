import {
  act,
  renderHook,
  render,
  screen,
  fireEvent,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  createPluginControlApi,
  type PluginUpdatePreview,
} from '@/lib/api/plugins';
import {
  PluginUpdateDialog,
  usePluginUpdateConfirmation,
} from './PluginUpdateDialog';
import '@/i18n';

const preview: PluginUpdatePreview = {
  confirmationId: 'exact-package-123',
  currentVersion: '1.0.0',
  targetVersion: '2.0.0',
  packageDigest: 'digest-v2',
  releaseNotes: 'Fixes data export.',
  source: {
    sourceKind: 'github',
    origin: 'https://github.com/acme/notes',
    owner: 'acme',
    pluginName: 'notes',
    tag: 'v2.0.0',
    version: '2.0.0',
    packageDigest: 'digest-v2',
  },
  plugin: {
    id: 'acme.notes',
    publisher: 'acme',
    name: 'Notes',
    version: '2.0.0',
    description: 'Work with notes.',
    enabled: false,
    builtin: false,
    sourceKind: 'snapshot',
    sourcePath: '',
    formats: ['vibex'],
    skills: [],
    runtimes: [],
    warnings: [],
    hasWorker: true,
  },
};

describe('plugin update confirmation', () => {
  it('prepares without publishing and confirms the exact package without enabling or rebinding', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(preview)
      .mockResolvedValueOnce(preview.plugin);
    const api = createPluginControlApi({ environment: 'desktop', call });
    const updated = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      usePluginUpdateConfirmation(api, updated)
    );
    await act(() => result.current.prepare('acme.notes'));
    expect(call).toHaveBeenCalledTimes(1);
    expect(result.current.preview).toEqual(preview);
    await act(() => result.current.confirm());
    expect(call.mock.calls).toEqual([
      ['plugin_control_update', { pluginId: 'acme.notes', tag: undefined }],
      [
        'plugin_control_update',
        { pluginId: 'acme.notes', confirmationId: 'exact-package-123' },
      ],
    ]);
    expect(updated).toHaveBeenCalledOnce();
    expect(result.current.preview).toBeNull();
  });

  it('shows identity, executable capabilities, digest and notes before confirmation', () => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    render(
      <PluginUpdateDialog
        preview={preview}
        busy={false}
        error={null}
        confirm={confirm}
        cancel={cancel}
        prepare={vi.fn()}
      />
    );
    expect(screen.getByText('acme/acme.notes')).toBeInTheDocument();
    expect(screen.getByText('Worker')).toBeInTheDocument();
    expect(screen.getByText('digest-v2')).toBeInTheDocument();
    expect(screen.getByText('Fixes data export.')).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', {
        name: /\u786e\u8ba4\u66f4\u65b0|Confirm update/,
      })
    );
    expect(confirm).toHaveBeenCalledOnce();
  });
});
