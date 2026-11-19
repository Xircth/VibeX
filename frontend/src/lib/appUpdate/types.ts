export interface AppUpdateInfo {
  version: string;
  body: string;
  date: string | null;
  releaseUrl: string | null;
  canInstall: boolean;
}

export interface CachedUpdateCheck {
  at: number;
  currentVersion: string;
  update: AppUpdateInfo | null;
}

export interface AppUpdateDiagnostic {
  stage: 'signed_feed' | 'github_release' | 'both' | 'install';
  signedError: string | null;
  githubError: string | null;
  httpStatus: number | null;
  endpoint: string | null;
  proxySource: string | null;
  checkedAt: string;
  fallbackReleaseUrl: string | null;
}

export interface AppUpdateSnapshot {
  currentVersion: string;
  update: AppUpdateInfo | null;
  lastCheckedAt: number;
  checked: boolean;
  error: string | null;
  diagnostic?: AppUpdateDiagnostic | null;
}

export type AppUpdateLifecycleStatus =
  | 'idle'
  | 'downloading'
  | 'installing'
  | 'ready_to_restart'
  | 'restarting'
  | 'error';

export interface AppUpdateLifecycleState {
  status: AppUpdateLifecycleStatus;
  version: string | null;
  downloaded: number;
  total: number | null;
  error: string | null;
}

export interface SignedFeedUpdate {
  version: string;
  body: string;
  date: string | null;
}

export interface GitHubReleaseCheck {
  current_version: string;
  latest_version: string | null;
  update_available: boolean;
  release_url: string | null;
  repository: string | null;
  checked: boolean;
  error: string | null;
  body: string | null;
  published_at: string | null;
  checked_at: string;
  http_status?: number | null;
  endpoint?: string | null;
  proxy_source?: string | null;
}

export interface AppUpdateDependencies {
  getCurrentVersion: () => Promise<string>;
  checkSignedFeed: () => Promise<SignedFeedUpdate | null>;
  checkGitHubRelease: () => Promise<GitHubReleaseCheck>;
  now: () => number;
}
