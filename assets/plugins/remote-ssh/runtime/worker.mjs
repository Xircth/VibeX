import { definePluginWorker } from '@vibex/plugin-sdk';

import { createPipeline, emptyJob } from './pipeline.mjs';
import { nonce } from './ssh.mjs';

const jobs = new Map();
const pipeline = createPipeline({});

function readTarget(input) {
  return {
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
          host: target.host,
          port: target.port,
          user: target.user,
          jump: target.jump,
          dataDir: target.dataDir,
          rememberPassword: target.rememberPassword,
        });
        await host.call('app', 'notify.toast', {
          message: '已接入远端 Host',
        });
      })
      .catch((error) => {
        job.status = 'failed';
        job.error = error.message;
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
    }
    await pipeline.dispose();
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
