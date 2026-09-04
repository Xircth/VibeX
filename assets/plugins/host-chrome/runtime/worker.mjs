import { definePluginWorker } from '@vibex/plugin-sdk';

/**
 * Reference consumer for the six Host chrome slots plus `host.service`.
 *
 * Everything it reports comes from its own KV storage, so it needs no
 * privileged access — any author can reproduce this with the public SDK.
 */

const DIGEST_KEY = 'digest';

function emptyDigest() {
  return { refreshedAt: null, refreshCount: 0 };
}

async function readDigest(host) {
  const stored = await host.call('storage', 'kv.get', { key: DIGEST_KEY });
  return stored && typeof stored === 'object' ? stored : emptyDigest();
}

async function refreshDigest(host) {
  const previous = await readDigest(host);
  const digest = {
    refreshedAt: new Date().toISOString(),
    refreshCount: (previous.refreshCount ?? 0) + 1,
  };
  await host.call('storage', 'kv.put', { key: DIGEST_KEY, value: digest });
  return digest;
}

function statusText(digest) {
  if (!digest.refreshedAt) return '速览未刷新';
  const at = new Date(digest.refreshedAt);
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(
    at.getMinutes()
  ).padStart(2, '0')}`;
  return `速览 ${clock}`;
}

export default definePluginWorker((plugin) => {
  // Command palette entry.
  plugin.handle('digest.show', async (_input, { host }) => {
    const digest = await refreshDigest(host);
    return { text: statusText(digest), digest };
  });

  // The toolbar button and the background service share one handler.
  plugin.handle('digest.refresh', async (_input, { host }) => {
    const digest = await refreshDigest(host);
    return { text: statusText(digest), digest };
  });

  // Status bar. `text` and `tooltip` are what the Host reads, both for the
  // first render and for each refresh tick.
  plugin.handle('digest.status', async (_input, { host }) => {
    const digest = await readDigest(host);
    return {
      text: statusText(digest),
      tooltip: `已刷新 ${digest.refreshCount} 次`,
    };
  });

  // Read-only method the timeline card and the settings section both call.
  plugin.handle('digest.read', async (_input, { host }) => readDigest(host));

  // Both synthesized surfaces enter through the standard session handler.
  plugin.handle('surface.createSession', () => ({ ready: true }));
});
