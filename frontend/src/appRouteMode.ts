export type AppRouteMode = 'desktop-toast' | 'project-rail' | 'main';

export function getAppRouteMode(pathname: string): AppRouteMode {
  if (pathname === '/desktop-toast') return 'desktop-toast';
  if (pathname === '/project-rail') return 'project-rail';
  return 'main';
}
