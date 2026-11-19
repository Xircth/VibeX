import { isGenericUpdaterNotes } from './localizeNotes';
import type {
  AppUpdateDependencies,
  AppUpdateInfo,
  AppUpdateSnapshot,
  GitHubReleaseCheck,
  SignedFeedUpdate,
} from './types';

function pickNotes(
  signed: SignedFeedUpdate | null,
  github: GitHubReleaseCheck | null
): string {
  const githubBody = github?.body?.trim() ?? '';
  const signedBody = signed?.body?.trim() ?? '';
  if (githubBody && (!signedBody || isGenericUpdaterNotes(signedBody))) {
    return githubBody;
  }
  return signedBody || githubBody;
}

function mergeUpdate(
  signed: SignedFeedUpdate | null,
  github: GitHubReleaseCheck | null
): AppUpdateInfo | null {
  const signedVersion = signed?.version?.trim() ?? '';
  const githubVersion = github?.update_available
    ? (github.latest_version?.trim() ?? '')
    : '';
  const version = signedVersion || githubVersion;
  if (!version) return null;

  return {
    version,
    body: pickNotes(signed, github),
    date: signed?.date || github?.published_at || null,
    releaseUrl: github?.release_url ?? null,
    canInstall: Boolean(signedVersion),
  };
}

const DEFAULT_RELEASES_URL = 'https://github.com/DimoADE/Dimo/releases/latest';

function resolveFallbackReleaseUrl(github: GitHubReleaseCheck): string {
  const direct = github.release_url?.trim();
  if (direct) return direct;
  const repo = github.repository?.trim();
  if (repo) return `https://github.com/${repo}/releases/latest`;
  return DEFAULT_RELEASES_URL;
}

export async function resolveAppUpdate(
  deps: AppUpdateDependencies
): Promise<AppUpdateSnapshot> {
  const [currentVersion, signedResult, github] = await Promise.all([
    deps.getCurrentVersion().catch(() => ''),
    deps.checkSignedFeed().then(
      (update) => ({ update, error: null as string | null }),
      (error: unknown) => ({
        update: null as SignedFeedUpdate | null,
        error: error instanceof Error ? error.message : String(error),
      })
    ),
    deps.checkGitHubRelease().catch(
      (error: unknown): GitHubReleaseCheck => ({
        current_version: '',
        latest_version: null,
        update_available: false,
        release_url: null,
        repository: null,
        checked: false,
        error: error instanceof Error ? error.message : String(error),
        body: null,
        published_at: null,
        checked_at: new Date(deps.now()).toISOString(),
      })
    ),
  ]);

  const signed = signedResult.update;
  const update = mergeUpdate(signed, github);
  const checked = Boolean(signed) || github.checked;
  const signedError = signedResult.error?.trim() || null;
  const githubError = github.error?.trim() || null;
  const error = checked
    ? null
    : signedError && githubError
      ? `${githubError} (signed feed: ${signedError})`
      : githubError || signedError || 'Update check failed';

  const diagnostic = checked
    ? null
    : {
        stage:
          signedError && githubError
            ? ('both' as const)
            : signedError
              ? ('signed_feed' as const)
              : ('github_release' as const),
        signedError,
        githubError,
        httpStatus: github.http_status ?? null,
        endpoint: github.endpoint ?? null,
        proxySource: github.proxy_source ?? null,
        checkedAt: github.checked_at,
        fallbackReleaseUrl: resolveFallbackReleaseUrl(github),
      };

  return {
    currentVersion: currentVersion || github.current_version || '',
    update,
    lastCheckedAt: deps.now(),
    checked,
    error,
    ...(diagnostic ? { diagnostic } : {}),
  };
}
