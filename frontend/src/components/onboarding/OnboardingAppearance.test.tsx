import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeMode } from 'shared/types';
import { ThemeProvider } from '@/components/ThemeProvider';
import {
  getWorkspaceStageStyle,
  resetWorkspaceStageStyle,
} from '@/lib/workspaceStageStyle';
import i18n from '@/i18n';
import { saveUserColorTheme } from '@/lib/theme/colorThemeStore';
import { clearLocalStorageCache } from '@/lib/safeStorage';
import { followThemeAccent, getAccentOverride } from '@/lib/uiAccent';
import { frontendPreferencesApi } from '@/lib/api/config';
import { OnboardingAppearance } from './OnboardingAppearance';
import { resolveOnboardingVideoSources } from './OnboardingLayoutPreview';

vi.mock('@/lib/backendTransport', () => ({
  backendListen: vi.fn(async () => () => undefined),
}));

const t = (key: string, options?: Record<string, unknown>) =>
  i18n.t(`dialogs:onboarding.${key}`, options);

describe('onboarding appearance', () => {
  beforeEach(() => {
    vi.spyOn(frontendPreferencesApi, 'update').mockResolvedValue({});
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() =>
      Promise.resolve()
    );
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(
      () => undefined
    );
    localStorage.clear();
    clearLocalStorageCache();
    followThemeAccent();
    resetWorkspaceStageStyle();
  });

  it('previews the remote demo video for the selected workspace view and persists choices before entering', async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    render(
      <ThemeProvider initialTheme={ThemeMode.LIGHT}>
        <OnboardingAppearance onBack={vi.fn()} onContinue={finish} />
      </ThemeProvider>
    );

    const tabsVideo = document.querySelector(
      'video.onboarding-demo-video'
    ) as HTMLVideoElement | null;
    expect(tabsVideo).not.toBeNull();
    expect(tabsVideo?.getAttribute('src')).toContain(
      '/videos/onboarding/free-tabs.mp4'
    );

    fireEvent.click(screen.getByRole('radio', { name: t('appearanceSystem') }));
    const pairDarkBtn = screen.getByRole('button', {
      name: t('appearancePairDark'),
    });
    fireEvent.click(pairDarkBtn);
    expect(pairDarkBtn).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('radiogroup', { name: t('appearanceDarkPalette') })
    ).toBeVisible();

    fireEvent.click(screen.getByRole('radio', { name: t('appearanceDark') }));
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'));

    fireEvent.click(screen.getByRole('radio', { name: t('appearanceCanvas') }));
    expect(getWorkspaceStageStyle()).toBe('canvas');
    const canvasVideo = document.querySelector(
      'video.onboarding-demo-video'
    ) as HTMLVideoElement | null;
    expect(canvasVideo?.getAttribute('src')).toContain(
      '/videos/onboarding/infinite-canvas.mp4'
    );

    fireEvent.click(screen.getByRole('button', { name: t('enterWorkspace') }));
    await waitFor(() => expect(finish).toHaveBeenCalledWith(ThemeMode.DARK));
  });

  it('keeps choices and allows retry when saving fails', async () => {
    const finish = vi
      .fn()
      .mockRejectedValueOnce(new Error('Disk full'))
      .mockResolvedValue(undefined);
    render(
      <ThemeProvider>
        <OnboardingAppearance onBack={vi.fn()} onContinue={finish} />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: t('enterWorkspace') }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Disk full');
    fireEvent.click(screen.getByRole('button', { name: t('enterWorkspace') }));
    await waitFor(() => expect(finish).toHaveBeenCalledTimes(2));
  });

  it('applies palette swatches, accent presets, video playback controls, and offline fallback gracefully', () => {
    const themeKey = saveUserColorTheme({
      id: 'onboarding-test',
      label: 'Onboarding test theme',
      scheme: 'light',
      colors: { background: '#f4f5f6', foreground: '#202020' },
    });
    render(
      <ThemeProvider initialTheme={ThemeMode.LIGHT}>
        <OnboardingAppearance onBack={vi.fn()} onContinue={vi.fn()} />
      </ThemeProvider>
    );

    fireEvent.click(
      screen.getByRole('radio', { name: 'Onboarding test theme' })
    );
    expect(localStorage.getItem('vibex:color-theme-light')).toBe(themeKey);
    expect(
      document.querySelector('style[data-vibex-color-theme]')?.textContent
    ).toContain('--surface-shell: #f4f5f6;');

    const amberSwatch = screen.getByRole('radio', {
      name: t('appearanceAccentPreset', { name: 'Amber' }),
    });
    fireEvent.click(amberSwatch);
    expect(getAccentOverride()).toBe('#cf6610');
    expect(screen.getByText('#CF6610')).toBeVisible();

    fireEvent.click(
      screen.getByRole('radio', { name: t('appearanceAccentFollowTheme') })
    );
    expect(getAccentOverride()).toBeNull();

    const video = document.querySelector(
      'video.onboarding-demo-video'
    ) as HTMLVideoElement;
    expect(screen.getByRole('status')).toHaveTextContent(t('previewLoading'));

    fireEvent.loadedData(video);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(video).toHaveAttribute('data-ready', 'true');

    const pauseBtn = screen.getByRole('button', { name: t('previewPause') });
    expect(pauseBtn).not.toBeDisabled();
    fireEvent.click(pauseBtn);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();

    const replayBtn = screen.getByRole('button', { name: t('previewReplay') });
    fireEvent.click(replayBtn);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();

    // Switch to canvas and verify graceful fallback when all remote sources fail
    fireEvent.click(screen.getByRole('radio', { name: t('appearanceCanvas') }));
    const sources = resolveOnboardingVideoSources('canvas');
    for (let index = 0; index < sources.length; index += 1) {
      const currentVideo = document.querySelector(
        'video.onboarding-demo-video'
      );
      expect(currentVideo).not.toBeNull();
      fireEvent.error(currentVideo!);
    }

    expect(screen.getByText(t('previewOfflineBadge'))).toBeVisible();
    expect(
      screen.getByRole('region', { name: t('appearanceCanvas') })
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole('button', { name: t('previewRetryVideo') })
    );
    expect(
      document.querySelector('video.onboarding-demo-video')
    ).not.toBeNull();
  });

  it('resolves remote video URLs without bundling local media assets', () => {
    expect(
      resolveOnboardingVideoSources('tabs', {
        customBaseUrl: 'https://cdn.example.com/onboarding/',
        devLocal: false,
      })
    ).toEqual([
      'https://cdn.example.com/onboarding/free-tabs.mp4',
      'https://vibex.xforever.xin/videos/onboarding/free-tabs.mp4',
    ]);
    expect(resolveOnboardingVideoSources('canvas', { devLocal: true })[0]).toBe(
      '/__dev/onboarding-videos/infinite-canvas.mp4'
    );
  });

  it('navigates to prior steps via the 5-step breadcrumb', () => {
    const onBack = vi.fn();
    const onNavigateStep = vi.fn();
    render(
      <ThemeProvider initialTheme={ThemeMode.LIGHT}>
        <OnboardingAppearance
          onBack={onBack}
          onNavigateStep={onNavigateStep}
          onContinue={vi.fn()}
        />
      </ThemeProvider>
    );

    expect(screen.getByText('5 / 5')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('agentStep') }));
    expect(onNavigateStep).toHaveBeenCalledWith('configure');

    fireEvent.click(screen.getByRole('button', { name: t('back') }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
