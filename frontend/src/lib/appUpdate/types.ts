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

export interface AppUpdateSnapshot {
  currentVersion: string;
  update: AppUpdateInfo | null;
  lastCheckedAt: number;
  checked: boolean;
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
}

export interface AppUpdateDependencies {
  getCurrentVersion: () => Promise<string>;
  checkSignedFeed: () => Promise<SignedFeedUpdate | null>;
  checkGitHubRelease: () => Promise<GitHubReleaseCheck>;
  now: () => number;
}
