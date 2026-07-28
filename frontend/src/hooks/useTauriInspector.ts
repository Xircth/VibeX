import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from '@/components/ui/toast';
import { useClickedElements } from '@/contexts/ClickedElementsProvider';
import { redlineDocumentToPayloads } from '@/features/tauri-inspector/tauriInspector';
import { attemptsApi } from '@/lib/api';

const CAPTURE_POLL_INTERVAL_MS = 700;

export function useTauriInspector(workspaceId: string | undefined) {
  const { t } = useTranslation('panels');
  const queryClient = useQueryClient();
  const { addElement } = useClickedElements();
  const [isActivating, setIsActivating] = useState(false);

  const statusQuery = useQuery({
    queryKey: ['tauriInspectorStatus', workspaceId],
    queryFn: () => attemptsApi.getTauriInspectorStatus(workspaceId!),
    enabled: Boolean(workspaceId),
    staleTime: 5_000,
    retry: false,
  });

  useEffect(() => {
    if (!workspaceId || !statusQuery.data?.installed) return undefined;

    let cancelled = false;
    const poll = async () => {
      try {
        const capture =
          await attemptsApi.takeTauriInspectorCapture(workspaceId);
        if (cancelled || !capture) return;
        const payloads = redlineDocumentToPayloads(capture);
        payloads.forEach(addElement);
        if (payloads.length > 0) {
          toast.success(
            t('rightPanelSidebar.tauriInspectorCaptured', {
              count: payloads.length,
            })
          );
        }
      } catch (error) {
        console.warn('Failed to receive Tauri inspector capture:', error);
      }
    };

    void poll();
    const timer = window.setInterval(
      () => void poll(),
      CAPTURE_POLL_INTERVAL_MS
    );
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [addElement, statusQuery.data?.installed, t, workspaceId]);

  const activate = useCallback(async () => {
    if (!workspaceId || isActivating) return;
    setIsActivating(true);
    try {
      let status =
        statusQuery.data ??
        (await attemptsApi.getTauriInspectorStatus(workspaceId));
      if (!status.is_tauri) {
        toast.error(t('rightPanelSidebar.tauriInspectorNotTauri'));
        return;
      }
      if (!status.installed) {
        status = await attemptsApi.installTauriInspector(workspaceId);
        queryClient.setQueryData(['tauriInspectorStatus', workspaceId], status);
        toast.success(t('rightPanelSidebar.tauriInspectorInstalled'));
        return;
      }

      await attemptsApi.controlTauriInspector(workspaceId, 'activate');
      toast.success(t('rightPanelSidebar.tauriInspectorActivated'));
    } catch (error) {
      toast.error(
        t('rightPanelSidebar.tauriInspectorFailed', {
          error: String(error),
        })
      );
    } finally {
      setIsActivating(false);
    }
  }, [isActivating, queryClient, statusQuery.data, t, workspaceId]);

  return {
    activate,
    isActivating,
    status: statusQuery.data,
  };
}
