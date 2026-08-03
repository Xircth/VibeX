import type { BackendTransport } from '@/lib/backendTransport';

/**
 * Enabled plugins must not project their entire action catalog into the
 * composer. PluginAction drafts enter through explicit workflow surfaces.
 */
export function ComposerPluginActions({
  transport: _transport,
}: {
  transport: BackendTransport;
}) {
  return null;
}
