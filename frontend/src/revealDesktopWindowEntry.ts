import {
  revealDesktopWindowWithRetry,
  shouldRevealDesktopWindowOnBoot,
} from '@/lib/revealDesktopWindow';

if (shouldRevealDesktopWindowOnBoot(window.location.pathname)) {
  void revealDesktopWindowWithRetry();
}
