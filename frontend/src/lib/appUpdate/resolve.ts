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
  const error = checked
    ? null
    : github.error || signedResult.error || 'Update check failed';

  return {
    currentVersion: currentVersion || github.current_version || '',
    update,
    lastCheckedAt: deps.now(),
    checked,
    error,
  };
}
