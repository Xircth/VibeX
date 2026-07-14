import { useEffect, useRef } from 'react';
import { listenPluginHook } from '@/lib/pluginHookBus';

/**
 * Composer side of the plugin hook bus: answers `check` probes and applies
 * `insert` requests from the right-panel plugin buttons. A request is only
 * honored when this composer belongs to the requested workspace, no turn is
 * running, and the input is empty — otherwise it reports `blocked` so the
 * caller can toast.
 */
export function useSessionComposerPluginHookInsertion({
  workspaceId,
  isAttemptRunning,
  getMessage,
  onChange,
}: {
  workspaceId: string | undefined;
  isAttemptRunning: boolean;
  getMessage: () => string;
  onChange: (message: string) => void;
}) {
  const isAttemptRunningRef = useRef(isAttemptRunning);
  const getMessageRef = useRef(getMessage);
  const onChangeRef = useRef(onChange);

  isAttemptRunningRef.current = isAttemptRunning;
  getMessageRef.current = getMessage;
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!workspaceId) return undefined;

    return listenPluginHook((detail) => {
      if (detail.workspaceId !== workspaceId) return;
      // Another mounted composer for the same workspace already answered.
      if (detail.result === 'ok' || detail.result === 'blocked') return;

      if (isAttemptRunningRef.current || getMessageRef.current().trim()) {
        detail.result = 'blocked';
        return;
      }
      if (detail.action === 'insert') {
        if (!detail.text) {
          detail.result = 'blocked';
          return;
        }
        onChangeRef.current(detail.text);
      }
      detail.result = 'ok';
    });
  }, [workspaceId]);
}
