import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openModelMarketplaceMock = vi.hoisted(() =>
  vi.fn(async () => 'https://vibex.xforever.xin/account/models')
);
const persistFrontendPreferenceMock = vi.hoisted(() => vi.fn());

vi.mock('@/features/model-router', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/features/model-router')>();
  return {
    ...actual,
    openModelMarketplace: openModelMarketplaceMock,
  };
});

vi.mock('@/lib/frontendPreferences', () => ({
  persistFrontendPreference: persistFrontendPreferenceMock,
}));

import { clearLocalStorageCache, writeLocalStorage } from '@/lib/safeStorage';
import {
  AGENT_MODEL_MARKET_INTRO_KEY,
  AgentModelMarketIntroDialog,
  hasSeenAgentModelMarketIntro,
} from './AgentModelMarketIntroDialog';

describe('AgentModelMarketIntroDialog', () => {
  beforeEach(() => {
    localStorage.clear();
    clearLocalStorageCache();
    openModelMarketplaceMock.mockReset();
    persistFrontendPreferenceMock.mockReset();
  });

  it('pops up on first ready visit and does not show when already seen', () => {
    const { rerender } = render(
      <AgentModelMarketIntroDialog ready={false} selectedAgentId="codex" />
    );
    expect(
      screen.queryByTestId('agent-model-market-intro-card')
    ).not.toBeInTheDocument();

    rerender(<AgentModelMarketIntroDialog ready selectedAgentId="codex" />);
    expect(
      screen.getByTestId('agent-model-market-intro-card')
    ).toBeInTheDocument();
    expect(screen.getByText('试试 Dimo 官方模型市场？')).toBeInTheDocument();
    expect(screen.getByText('低价，高速，满血，一键配置')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '暂不需要' }));
    expect(
      screen.queryByTestId('agent-model-market-intro-card')
    ).not.toBeInTheDocument();
    expect(hasSeenAgentModelMarketIntro()).toBe(true);
    expect(persistFrontendPreferenceMock).toHaveBeenCalledWith(
      AGENT_MODEL_MARKET_INTRO_KEY,
      'seen'
    );

    // Re-mounting never shows the card again
    render(<AgentModelMarketIntroDialog ready selectedAgentId="codex" />);
    expect(
      screen.queryByTestId('agent-model-market-intro-card')
    ).not.toBeInTheDocument();
  });

  it('jumps to the official Model Market and persists seen state on CTA click', () => {
    render(<AgentModelMarketIntroDialog ready selectedAgentId="codex" />);

    const cta = screen.getByRole('button', { name: '前往官网模型市场' });
    expect(cta).toHaveClass('primary-control', 'bg-primary');
    fireEvent.click(cta);

    expect(openModelMarketplaceMock).toHaveBeenCalledWith('codex');
    expect(hasSeenAgentModelMarketIntro()).toBe(true);
    expect(
      screen.queryByTestId('agent-model-market-intro-card')
    ).not.toBeInTheDocument();
  });

  it('does not auto-open when already marked seen in storage', () => {
    writeLocalStorage(AGENT_MODEL_MARKET_INTRO_KEY, 'seen');
    render(<AgentModelMarketIntroDialog ready selectedAgentId="codex" />);
    expect(
      screen.queryByTestId('agent-model-market-intro-card')
    ).not.toBeInTheDocument();
  });

  it('dismisses permanently when clicking the close button', () => {
    render(<AgentModelMarketIntroDialog ready selectedAgentId="codex" />);
    expect(screen.getByAltText('Dimo Logo')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(
      screen.queryByTestId('agent-model-market-intro-card')
    ).not.toBeInTheDocument();
    expect(hasSeenAgentModelMarketIntro()).toBe(true);
  });
});
