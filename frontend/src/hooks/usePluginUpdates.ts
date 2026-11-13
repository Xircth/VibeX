import { useEffect, useMemo, useState } from 'react';
import {
  createPluginControlApi,
  type PluginUpdateStatus,
} from '@/lib/api/plugins';
import { useBackendTransport } from '@/lib/transport';
import { getInvokeErrorMessage } from '@/lib/errors';

/** Observations belong to the bound Host; only the Host schedules network checks. */
export function usePluginUpdates() {
  const transport = useBackendTransport();
  const api = useMemo(() => createPluginControlApi(transport), [transport]);
  const [updates, setUpdates] = useState<PluginUpdateStatus[]>([]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    setUpdates([]);
    setError(null);
    const refresh = () =>
      api
        .checkUpdates(true)
        .then((items) => {
          if (!disposed) setUpdates(items);
        })
        .catch((cause: unknown) => {
          if (!disposed) setError(getInvokeErrorMessage(cause));
        });
    void transport
      .listen?.('plugin-updates-changed', () => {
        void refresh();
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(getInvokeErrorMessage(cause));
      });
    void refresh();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [api, transport]);
  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      setUpdates(await api.checkUpdates());
    } catch (cause) {
      setError(getInvokeErrorMessage(cause));
    } finally {
      setChecking(false);
    }
  };
  return { updates, checking, error, check };
}
