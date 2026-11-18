import { definePluginWorker } from '@dimoai/plugin-sdk/worker';
import {
  callDaemon,
  ensureDaemonAuth,
  isDaemonHealthy,
} from './daemon-client.mjs';

export const RPC_METHODS = [
  'computer.getSettings',
  'computer.setEnabled',
  'computer.setPreferences',
  'computer.status',
  'computer.sharedState',
  'computer.listShareableWindows',
  'computer.windowThumbnail',
  'computer.shareWindow',
  'computer.shareWindows',
  'computer.shareApp',
  'computer.shareScreen',
  'computer.revokeAll',
  'computer.stop',
  'computer.stopKeyStatus',
  'computer.driverInfo',
  'computer.driverInstall',
  'computer.driverUninstall',
  'computer.requestPermission',
  'computer.openPermissionSettings',
  'computer.revealHelper',
  'computer.listLocalApps',
  'computer.pickExecutableFile',
  'computer.activity',
  'computer.clearActivity',
  'computer.snapshotState',
  'mcp.listTools',
  'mcp.callTool',
];

async function loadSnapshotState(env) {
  await ensureDaemonAuth(env);
  try {
    return await callDaemon(env, 'computer.snapshotState', {});
  } catch {
    const [settings, status, sharedState, stopKeyStatus, driverInfo, activity] =
      await Promise.all([
        callDaemon(env, 'computer.getSettings'),
        callDaemon(env, 'computer.status'),
        callDaemon(env, 'computer.sharedState'),
        callDaemon(env, 'computer.stopKeyStatus'),
        callDaemon(env, 'computer.driverInfo'),
        callDaemon(env, 'computer.activity'),
      ]);
    return {
      settings,
      status,
      sharedState,
      stopKeyStatus,
      driverInfo,
      activity,
    };
  }
}

export async function dispatchWorkerRpc(method, rawParams, env) {
  const params =
    rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
      ? rawParams
      : {};
  if (method === 'runtime.healthcheck') {
    try {
      const { url, token } = await ensureDaemonAuth(env);
      const healthy = await isDaemonHealthy(url, token);
      return {
        healthy,
        status: healthy ? 'running' : 'unreachable',
      };
    } catch (error) {
      return {
        healthy: false,
        status: 'error',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (method === 'computer.snapshotState') {
    return await loadSnapshotState(env);
  }
  if (!RPC_METHODS.includes(method)) {
    throw new Error(`Unsupported RPC method: ${method}`);
  }
  return await callDaemon(env, method, params);
}

export default definePluginWorker((plugin) => {
  plugin.handle('surface.createSession', async (input, env) => {
    const params =
      input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    if (typeof params.rpcMethod === 'string' && params.rpcMethod) {
      return await dispatchWorkerRpc(
        params.rpcMethod,
        params.rpcParams ?? {},
        env
      );
    }
    try {
      const snapshot = await loadSnapshotState(env);
      return {
        ready: true,
        surfaceId:
          typeof params.surfaceId === 'string'
            ? params.surfaceId
            : 'computer-use',
        title: '电脑控制',
        state: snapshot,
      };
    } catch (error) {
      return {
        ready: true,
        surfaceId:
          typeof params.surfaceId === 'string'
            ? params.surfaceId
            : 'computer-use',
        title: '电脑控制',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
});
