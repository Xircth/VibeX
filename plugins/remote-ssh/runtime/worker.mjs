import { definePluginWorker } from '@vibex/plugin-sdk';

import { createPipeline, emptyJob } from './pipeline.mjs';
import { nonce, secretKey } from './ssh.mjs';
import {
  HISTORY_KEY,
  historyRecord,
  matchingSavedProfile,
  replaceHistory,
  upsertHistory,
} from './ui.mjs';

async function readHistory(host) {
  const stored = await host.call('storage', 'kv.get', { key: HISTORY_KEY });
  return Array.isArray(stored) ? stored : [];
}

async function hydrateHistory(host, list) {
  const entries = Array.isArray(list) ? list : [];
  const hydrated = [];
  for (const entry of entries) {
    if (entry.password) {
      hydrated.push(entry);
      continue;
    }
    const stored = await host.call('storage', 'kv.get', {
      key: secretKey(entry),
    });
    hydrated.push({
      ...entry,
      password: typeof stored === 'string' ? stored : '',
    });
  }
  return hydrated;
}

async function writeHistory(host, target, status) {
  const record = historyRecord(target, status);
  if (!record.host || !record.user) return;
  const next = upsertHistory(await readHistory(host), record);
  await host.call('storage', 'kv.put', { key: HISTORY_KEY, value: next });
}

async function storePassword(host, target, previous) {
  const nextKey = secretKey(target);
  await host.call('storage', 'kv.put', {
    key: nextKey,
    value: String(target.password ?? ''),
  });
  if (previous?.host && previous?.user) {
    const previousKey = secretKey(previous);
    if (previousKey !== nextKey) {
      await host.call('storage', 'kv.put', { key: previousKey, value: '' });
    }
  }
}

async function updateSavedProfile(host, previous, next) {
  const listed = await host.call('remote', 'profile.list', {});
  const profiles = listed?.profiles ?? listed ?? [];
  const match = matchingSavedProfile(profiles, previous);
  if (!match?.origin) return null;
  const provision = match.provision ?? {};
  return host.call('remote', 'profile.upsert', {
    id: match.id,
    origin: match.origin,
    name: next.name,
    provisionKind: 'ssh',
    provision: {
      ...provision,
      host: next.host,
      port: next.port,
      user: next.user,
      jump: next.jump || undefined,
    },
  });
}

const jobs = new Map();
const pipeline = createPipeline({});

function readTarget(input) {
  return {
    name: String(input.name ?? '').trim(),
    host: String(input.host ?? '').trim(),
    port: Number(input.port ?? 22),
    user: String(input.user ?? '').trim(),
    password: String(input.password ?? ''),
    jump: String(input.jump ?? '').trim(),
    dataDir: String(input.dataDir ?? '').trim(),
    rememberPassword: Boolean(input.rememberPassword),
  };
}

export default definePluginWorker((plugin) => {
  plugin.handle('surface.createSession', () => ({ ready: true }));

  plugin.handle('session.load', async (_input, { host }) => {
    const settings = await host.call('storage', 'settings.get', {});
    return settings && typeof settings === 'object' ? settings : {};
  });

  plugin.handle('session.history', async (_input, { host }) => {
    return hydrateHistory(host, await readHistory(host));
  });

  plugin.handle('session.test', async (input, { host }) => {
    const target = readTarget(input ?? {});
    if (!target.host || !target.user) {
      throw new Error('host and user are required');
    }
    return pipeline.testLogin(target, host);
  });

  plugin.handle('session.historySave', async (input, { host }) => {
    const index = Number(input?.index);
    const current = await readHistory(host);
    const previous = Number.isInteger(index) ? current[index] : undefined;
    if (!previous) {
      throw new Error('history entry is missing');
    }
    const target = {
      ...readTarget(input ?? {}),
      profileId: String(input?.profileId ?? previous.profileId ?? ''),
      origin: String(input?.origin ?? previous.origin ?? ''),
    };
    if (!target.host || !target.user) {
      throw new Error('host and user are required');
    }
    const record = historyRecord(
      target,
      previous.status || 'completed',
      Date.now()
    );
    await pipeline.forgetTarget(previous);
    await pipeline.forgetTarget(target);
    await storePassword(host, target, previous);
    const saved = await updateSavedProfile(host, previous, record);
    if (saved?.id) record.profileId = saved.id;
    if (saved?.origin) record.origin = saved.origin;
    const stored = replaceHistory(current, index, record);
    await host.call('storage', 'kv.put', { key: HISTORY_KEY, value: stored });
    return hydrateHistory(host, stored);
  });

  plugin.handle('session.start', async (input, { host }) => {
    const target = readTarget(input ?? {});
    if (!target.host || !target.user) {
      throw new Error('host and user are required');
    }
    const id = nonce();
    const job = emptyJob(id);
    jobs.set(id, job);
    void pipeline
      .provision(job, target, host)
      .then(async () => {
        await host.call('storage', 'settings.put', {
          name: target.name,
          host: target.host,
          port: target.port,
          user: target.user,
          jump: target.jump,
          dataDir: target.dataDir,
          rememberPassword: target.rememberPassword,
        });
        await writeHistory(
          host,
          {
            ...target,
            profileId: job.profileId,
            origin: job.origin,
          },
          'completed'
        );
        await host.call('app', 'notify.toast', {
          message: '已接入远端 Host',
        });
      })
      .catch(async (error) => {
        job.status = job.status === 'cancelled' ? 'cancelled' : 'failed';
        job.error = error.message;
        await writeHistory(
          host,
          target,
          job.status === 'cancelled' ? 'cancelled' : 'failed'
        );
      });
    return { jobId: id, job };
  });

  plugin.handle('session.status', async (input) => {
    const jobId = String(input?.jobId ?? '');
    const job = jobs.get(jobId);
    if (!job) return { status: 'unknown' };
    return job;
  });

  plugin.handle('session.cancel', async (input) => {
    const jobId = String(input?.jobId ?? '');
    const job = jobs.get(jobId);
    if (job && job.status === 'running') {
      job.status = 'cancelled';
      job.error = 'cancelled';
      await pipeline.cancel(job);
    }
    return { cancelled: true };
  });

  plugin.handle('provision.ensure', async (input, { host }) => {
    return pipeline.ensure(input ?? {}, host);
  });

  plugin.onDispose({
    dispose() {
      jobs.clear();
      return pipeline.dispose();
    },
  });
});
