import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from 'shared/types';

import { useKeyBindingOverridesStore } from '@/keyboard/useKeyBindingOverrides';
import { ShortcutSettings } from './ShortcutSettings';

const mocks = vi.hoisted(() => ({
  config: { send_message_shortcut: 'ModifierEnter' } as Config,
  updateAndSaveConfig: vi.fn(),
}));

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({
    config: mocks.config,
    loading: false,
    updateAndSaveConfig: mocks.updateAndSaveConfig,
  }),
}));

describe('ShortcutSettings', () => {
  beforeEach(() => {
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    mocks.updateAndSaveConfig.mockReset();
    mocks.updateAndSaveConfig.mockResolvedValue(true);
    useKeyBindingOverridesStore.setState({ overrides: {} });
  });

  it('persists the message sending shortcut', async () => {
    const user = userEvent.setup();
    render(<ShortcutSettings />);

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Enter' }));
    await user.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => {
      expect(mocks.updateAndSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({ send_message_shortcut: 'Enter' })
      );
    });
  });

  it('rebinding a shortcut updates the live persisted override store', async () => {
    const user = userEvent.setup();
    render(<ShortcutSettings />);

    await user.click(screen.getAllByRole('button', { name: '重绑' })[0]);
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', metaKey: true });

    expect(
      Object.values(useKeyBindingOverridesStore.getState().overrides)
    ).toContain('meta+k');
  });
});
