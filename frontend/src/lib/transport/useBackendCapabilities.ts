import { useEffect, useMemo, useState } from 'react';

import { useBackendTransport } from './BackendTransportProvider';

export function useBackendCapabilities() {
  const transport = useBackendTransport();
  const [capabilities, setCapabilities] = useState<Set<string> | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    setCapabilities(null);
    setError(null);
    if (!transport.capabilities) {
      setCapabilities(new Set());
      return;
    }
    void transport
      .capabilities()
      .then((result) => {
        if (active) setCapabilities(new Set(result.capabilities));
      })
      .catch((nextError) => {
        if (active) {
          setCapabilities(new Set());
          setError(nextError);
        }
      });
    return () => {
      active = false;
    };
  }, [transport]);

  return useMemo(
    () => ({
      capabilities,
      error,
      supports: (capability: string) => capabilities?.has(capability) ?? false,
    }),
    [capabilities, error]
  );
}
