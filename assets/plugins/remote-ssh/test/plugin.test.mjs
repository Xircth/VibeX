import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkerHarness } from '@vibex/plugin-sdk/testing';

import { createPipeline, emptyJob } from '../runtime/pipeline.mjs';
import worker from '../runtime/worker.mjs';

function memoryHost() {
  const kv = new Map();
  const calls = [];
  const profiles = [];
  return {
    calls,
    profiles,
    async call(capability, operation, input) {
      calls.push({ capability, operation, input });
      if (capability === 'storage' && operation === 'kv.get') {
        return kv.get(input.key) ?? null;
      }
      if (capability === 'storage' && operation === 'kv.put') {
        kv.set(input.key, input.value);
        return input.value;
      }
      if (capability === 'storage' && operation === 'settings.get') {
        return kv.get('settings') ?? {};
      }
      if (capability === 'storage' && operation === 'settings.put') {
        kv.set('settings', input);
        return input;
      }
      if (capability === 'remote' && operation === 'profile.upsert') {
        const profile = {
          id: input.id ?? 'profile-1',
          origin: input.origin,
          name: input.name,
          provisionKind: input.provisionKind,
          provision: input.provision,
          hasCredential: false,
          connected: false,
        };
        profiles.splice(0, profiles.length, profile);
        return profile;
      }
      if (capability === 'remote' && operation === 'connect') {
        return {
          profile: { ...profiles[0], connected: true, id: input.profileId },
          stoppedHost: true,
        };
      }
      if (capability === 'app' && operation === 'notify.toast') {
        return {};
      }
      throw new Error(`unexpected ${capability}.${operation}`);
    },
  };
}

function fakeSession() {
  const commands = [];
  return {
    commands,
    async exec(command) {
      commands.push(command);
      if (command.includes('uname')) {
        return 'os=linux\narch=x86_64\nhome=/root\n';
      }
      if (command.includes('already-installed') || command.includes('install.sh')) {
        return 'already-installed\n';
      }
      if (command.includes('already-running') || command.includes('nohup')) {
        return 'started\n';
      }
      if (command.includes('host.token')) {
        return 'host-token-secret\n';
      }
      return '';
    },
    async forward() {
      return { origin: 'http://127.0.0.1:41234', localPort: 41234, async close() {} };
    },
    async close() {},
  };
}

test('every contributed handler is registered', async () => {
  const harness = await createWorkerHarness(worker, { host: memoryHost() });
  assert.deepEqual(harness.handlers.sort(), [
    'provision.ensure',
    'session.cancel',
    'session.load',
    'session.start',
    'session.status',
    'surface.createSession',
  ]);
  await harness.dispose();
});

test('provision upserts an ssh Host and asks the Host to connect', async () => {
  const host = memoryHost();
  const session = fakeSession();
  const pipeline = createPipeline({
    createSession: () => session,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/auth/pairings') && init.method === 'POST') {
        return {
          ok: true,
          async json() {
            return { pairing_token: 'K7M2NPQX' };
          },
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  const job = emptyJob('job-1');
  const result = await pipeline.provision(
    job,
    { host: '203.0.113.8', port: 22, user: 'root', password: 'secret', rememberPassword: true },
    host
  );
  assert.equal(result.origin, 'http://127.0.0.1:41234');
  assert.equal(result.token, 'K7M2NPQX');
  assert.equal(host.profiles[0].provisionKind, 'ssh');
  assert.equal(host.profiles[0].provision.host, '203.0.113.8');
  assert.equal(
    host.calls.some((call) => call.capability === 'remote' && call.operation === 'connect'),
    true
  );
  assert.equal(host.calls.some((call) => call.operation === 'profile.forget'), false);
  assert.equal(job.status, 'completed');
  await pipeline.dispose();
});

test('ensure does not forget saved Hosts and skips pairing when a credential already exists', async () => {
  const host = memoryHost();
  const session = fakeSession();
  const pipeline = createPipeline({
    createSession: () => session,
    fetchImpl: async () => {
      throw new Error('pairing must not run');
    },
  });
  const ensured = await pipeline.ensure(
    {
      profile: {
        id: 'kept',
        origin: 'http://127.0.0.1:1',
        hasCredential: true,
        provision: { host: '203.0.113.8', port: 22, user: 'root' },
      },
    },
    host
  );
  assert.equal(ensured.origin, 'http://127.0.0.1:41234');
  assert.equal(
    host.calls.some((call) => call.operation === 'profile.forget'),
    false
  );
  await pipeline.dispose();
});

test('disposing the worker does not forget Hosts', async () => {
  const host = memoryHost();
  const harness = await createWorkerHarness(worker, { host });
  await harness.dispose();
  assert.equal(
    host.calls.some((call) => call.capability === 'remote' && call.operation === 'profile.forget'),
    false
  );
});
