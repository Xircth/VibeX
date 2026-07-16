import type { AgentKind } from 'shared/types';
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
 * A usable session always starts with the local Agent CLI.  For Codex and
 * Claude, the backend installs a missing ACP bridge as part of a successful
 * CLI install, so running a second `install_npm` action afterwards would be
 * redundant. Keep this policy here as well as in Settings: onboarding uses
 * this helper directly.
 */
function orderFixActions(actions: string[]): string[] {
  const prerequisites = actions.filter(
    (action) => action === 'install_uv' || action.startsWith('open_url:')
  );
  if (prerequisites.length > 0) return prerequisites;

  const priority = (action: string): number => {
    if (action === 'install_cli' || action === 'upgrade_cli') return 0;
    if (action === 'install_npm' || action === 'upgrade_npm') return 1;
    return 2;
  };

  return actions
    .map((action, index) => ({ action, index }))
    .sort((left, right) => {
      const difference = priority(left.action) - priority(right.action);
      return difference || left.index - right.index;
    })
    .map(({ action }) => action);
}

/**
 * Apply every distinct fix surfaced by a fresh preflight, in sequence.
 * npm actions run on the backend; download / uv-install actions open the
 * relevant page (VibeX does not auto-download binaries).
 *
 * Returns the number of fix actions applied; 0 means preflight surfaced
 * nothing fixable (e.g. only manual steps remain).
 */
export async function applyAgentQuickFix(agentType: AgentKind): Promise<number> {
  const report = await agentSettingsApi.preflight(agentType);
  const actions = Array.from(
    new Set(
      (report.checks ?? []).flatMap((check) =>
        check.fixes.map((fix) => fix.action)
      )
    )
  );

  const orderedActions = orderFixActions(actions);
  let installedCli = false;
  let applied = 0;
  for (const action of orderedActions) {
    // `run_agent_fix(install_cli)` verifies the CLI and then installs its
    // matching separate ACP bridge when required. Do not immediately repeat
    // that adapter install from a stale preflight report.
    if (installedCli && action === 'install_npm') continue;
    if (action.startsWith('open_url:')) {
      await openExternalUrl(action.slice('open_url:'.length));
      applied += 1;
      continue;
    }
    if (action === 'install_uv') {
      await openExternalUrl(
        'https://docs.astral.sh/uv/getting-started/installation/'
      );
      applied += 1;
      continue;
    }
    await agentSettingsApi.runFix({ agentType, action });
    applied += 1;
    if (action === 'install_cli' || action === 'upgrade_cli') {
      installedCli = true;
    }
  }

  return applied;
}
