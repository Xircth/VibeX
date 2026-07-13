import { agentSettingsApi } from '@/lib/api';

async function openExternalUrl(url: string): Promise<void> {
  try {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/**
 * Apply every distinct fix surfaced by a fresh preflight, in sequence.
 * npm actions run on the backend; download / uv-install actions open the
 * relevant page (VibeX does not auto-download binaries).
 *
 * Returns the number of fix actions applied; 0 means preflight surfaced
 * nothing fixable (e.g. only manual steps remain).
 */
export async function applyAgentQuickFix(agentType: string): Promise<number> {
  const report = await agentSettingsApi.preflight(agentType);
  const actions = Array.from(
    new Set(
      (report.checks ?? []).flatMap((check) =>
        check.fixes.map((fix) => fix.action)
      )
    )
  );

  for (const action of actions) {
    if (action.startsWith('open_url:')) {
      await openExternalUrl(action.slice('open_url:'.length));
      continue;
    }
    if (action === 'install_uv') {
      await openExternalUrl(
        'https://docs.astral.sh/uv/getting-started/installation/'
      );
      continue;
    }
    await agentSettingsApi.runFix({ agentType, action });
  }

  return actions.length;
}
