import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openInSystemBrowserMock = vi.hoisted(() => vi.fn(async () => {}));
const persistFrontendPreferenceMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useOpenLink', () => ({
  openInSystemBrowser: openInSystemBrowserMock,
}));

vi.mock('@/lib/frontendPreferences', () => ({
  persistFrontendPreference: persistFrontendPreferenceMock,
}));

import { StartupOverlayContext } from '@/contexts/StartupOverlayContext';
import { clearLocalStorageCache, writeLocalStorage } from '@/lib/safeStorage';
import {
  GITHUB_STAR_PROMPT_KEY,
  GITHUB_STAR_REPO_URL,
  GITHUB_STAR_THRESHOLD_MS,
  GithubStarPrompt,
  parseGithubStarPromptState,
} from './GithubStarPrompt';

function setVisibilityState(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

describe('GithubStarPrompt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    clearLocalStorageCache();
    openInSystemBrowserMock.mockReset();
    persistFrontendPreferenceMock.mockReset();
    setVisibilityState('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
    setVisibilityState('visible');
  });

  it('parses malformed stored state safely', () => {
    expect(parseGithubStarPromptState(null)).toEqual({
      activeMs: 0,
      status: 'pending',
    });
    expect(parseGithubStarPromptState('{invalid')).toEqual({
      activeMs: 0,
      status: 'pending',
    });
    expect(
      parseGithubStarPromptState(
        JSON.stringify({ activeMs: -10, status: 'unknown' })
      )
    ).toEqual({
      activeMs: 0,
      status: 'pending',
    });
  });

  it('stays hidden before 5 minutes and appears once 5 minutes of active usage elapse', () => {
    render(<GithubStarPrompt />);

    expect(screen.queryByTestId('github-star-prompt')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(GITHUB_STAR_THRESHOLD_MS - 1_000);
    });
    expect(screen.queryByTestId('github-star-prompt')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    const dialog = screen.getByTestId('github-star-prompt');
    expect(dialog).toBeInTheDocument();
    expect(
      screen.getByText('如果 Dimo 帮助到了您，不如在 GitHub 点上 Star？')
    ).toBeInTheDocument();
    expect(screen.getByAltText('Dimo Logo')).toBeInTheDocument();

    const cta = screen.getByRole('link', { name: /前往 GitHub 点 Star/i });
    expect(cta).toHaveAttribute('href', GITHUB_STAR_REPO_URL);
    expect(cta).toHaveClass('primary-control', 'bg-primary');
  });

  it('pauses counting while document is hidden and preserves accumulated time across remounts', () => {
    const { unmount } = render(<GithubStarPrompt />);

    act(() => {
      vi.advanceTimersByTime(120_000);
      setVisibilityState('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    });

    act(() => {
      vi.advanceTimersByTime(240_000);
    });
    expect(screen.queryByTestId('github-star-prompt')).not.toBeInTheDocument();

    unmount();

    setVisibilityState('visible');
    render(<GithubStarPrompt />);
    expect(screen.queryByTestId('github-star-prompt')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(180_000);
    });
    expect(screen.getByTestId('github-star-prompt')).toBeInTheDocument();
  });

  it('does not track or display while StartupOverlayContext is active', () => {
    writeLocalStorage(
      GITHUB_STAR_PROMPT_KEY,
      JSON.stringify({ activeMs: GITHUB_STAR_THRESHOLD_MS, status: 'pending' })
    );

    render(
      <StartupOverlayContext.Provider value={<div>onboarding</div>}>
        <GithubStarPrompt />
      </StartupOverlayContext.Provider>
    );

    expect(screen.queryByTestId('github-star-prompt')).not.toBeInTheDocument();
  });

  it('opens GitHub externally, closes prompt, and persists starred status on CTA click', () => {
    writeLocalStorage(
      GITHUB_STAR_PROMPT_KEY,
      JSON.stringify({ activeMs: GITHUB_STAR_THRESHOLD_MS, status: 'pending' })
    );

    const { rerender } = render(<GithubStarPrompt />);
    const cta = screen.getByRole('link', { name: /前往 GitHub 点 Star/i });
    fireEvent.click(cta);

    expect(openInSystemBrowserMock).toHaveBeenCalledWith(GITHUB_STAR_REPO_URL);
    expect(screen.queryByTestId('github-star-prompt')).not.toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem(GITHUB_STAR_PROMPT_KEY) || '{}')
    ).toMatchObject({ status: 'starred' });
    expect(persistFrontendPreferenceMock).toHaveBeenCalledWith(
      GITHUB_STAR_PROMPT_KEY,
      expect.objectContaining({ status: 'starred' })
    );

    rerender(<GithubStarPrompt />);
    expect(screen.queryByTestId('github-star-prompt')).not.toBeInTheDocument();
  });

  it('dismisses permanently when clicking later or close button', () => {
    writeLocalStorage(
      GITHUB_STAR_PROMPT_KEY,
      JSON.stringify({ activeMs: GITHUB_STAR_THRESHOLD_MS, status: 'pending' })
    );

    const { unmount } = render(<GithubStarPrompt />);
    fireEvent.click(screen.getByRole('button', { name: '以后再说' }));

    expect(screen.queryByTestId('github-star-prompt')).not.toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem(GITHUB_STAR_PROMPT_KEY) || '{}')
    ).toMatchObject({ status: 'dismissed' });
    unmount();

    // Also verify close X button works from a fresh pending threshold
    writeLocalStorage(
      GITHUB_STAR_PROMPT_KEY,
      JSON.stringify({ activeMs: GITHUB_STAR_THRESHOLD_MS, status: 'pending' })
    );
    render(<GithubStarPrompt />);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByTestId('github-star-prompt')).not.toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem(GITHUB_STAR_PROMPT_KEY) || '{}')
    ).toMatchObject({ status: 'dismissed' });
  });
});
