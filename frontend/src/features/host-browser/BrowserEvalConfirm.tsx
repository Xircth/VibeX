import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlert } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { NativeSurfaceOcclusionHold } from '@/contexts/WorkspaceOverlayContext';
import { backendCall } from '@/lib/backendTransport';
import {
  getEvalRequest,
  setEvalRequest,
  subscribeBrowserChrome,
} from './browserChromeStore';

export function BrowserEvalConfirm() {
  const { t } = useTranslation('panels');
  const pending = useSyncExternalStore(
    subscribeBrowserChrome,
    getEvalRequest,
    getEvalRequest
  );

  const answer = useCallback((requestId: string, allow: boolean) => {
    setEvalRequest(null);
    void backendCall('plugin_invoke_contribution', {
      pluginId: 'vibex.browser',
      handler: 'browser.dispatch',
      input: {
        operation: 'eval.decide',
        input: { requestId, allow },
      },
    }).catch(() => {
      /* timeout on the host is already a refusal */
    });
  }, []);

  useEffect(() => {
    if (!pending) return undefined;
    const wait = Math.max(0, pending.expiresAt - Date.now());
    const timer = window.setTimeout(() => answer(pending.requestId, false), wait);
    return () => window.clearTimeout(timer);
  }, [pending, answer]);

  if (!pending) return null;
  const site = pending.origin || pending.tabId;

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) answer(pending.requestId, false);
      }}
    >
      <NativeSurfaceOcclusionHold />
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" />
            {t('browserPanel.evalTitle', { site })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {pending.title
              ? t('browserPanel.evalDescriptionWithTitle', {
                  site,
                  title: pending.title,
                })
              : t('browserPanel.evalDescription', { site })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <pre className="max-h-64 overflow-auto rounded border border-border/60 bg-muted/50 p-3 text-xs leading-relaxed break-words whitespace-pre-wrap">
          <code>{pending.code}</code>
        </pre>
        <p className="text-xs text-muted-foreground">{t('browserPanel.evalEveryTime')}</p>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => answer(pending.requestId, false)}>
            {t('browserPanel.evalDeny')}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              answer(pending.requestId, true);
            }}
          >
            {t('browserPanel.evalAllow')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
