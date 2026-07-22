export type AppRouteMode = 'desktop-toast' | 'main';

export function getAppRouteMode(pathname: string): AppRouteMode {
  if (pathname === '/desktop-toast') return 'desktop-toast';
  return 'main';
}
