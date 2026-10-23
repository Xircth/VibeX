export interface RemoteSshBridge {
  invoke: (handler: string, input?: Record<string, unknown> | null) => Promise<unknown>;
  ready: () => void;
}

export function mountRemoteSshApp(options: {
  bridge: RemoteSshBridge;
  root: HTMLElement;
  signal: AbortSignal;
}): Promise<void>;

export default mountRemoteSshApp;
