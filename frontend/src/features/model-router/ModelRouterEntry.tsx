import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, Waypoints } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';

import {
  AccountError,
  accountApi,
  accountToken,
  modelMarketplacePath,
  openModelMarketplace,
  type DeviceLogin,
  type RouterProvision,
} from './account';
import { openExternal } from './openExternal';
import { supportsModelRouter } from './preset';

/**
 * The ModelRouter entry in an agent's provider toolbar.
 * - Signed in: jumps straight to the web Model Marketplace (`/account/models?agent=<agentId>`)
 *   via a single-use web-handoff ticket (falling back to the direct URL).
 * - Signed out: starts the desktop device login flow with `nextPath` set to the
 *   agent's Model Marketplace page, opens the browser authorization page, and
 *   polls in the background so the desktop stores the account token once approved.
 */
export function ModelRouterEntry({
  agentId,
  disabled,
}: {
  agentId: string;
  disabled?: boolean;
  onApply?: (provision: RouterProvision) => Promise<void>;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState<DeviceLogin | null>(null);

  useEffect(() => {
    if (!login) return;
    let cancelled = false;
    const stepMs = Math.max(login.interval, 2) * 1000;
    const deadline = Date.now() + login.expiresIn * 1000;

    const timer = window.setInterval(async () => {
      if (Date.now() > deadline) {
        window.clearInterval(timer);
        if (!cancelled) {
          setLogin(null);
          toast.error(t('settings:agents.modelRouterErrorExpired'));
        }
        return;
      }
      try {
        const approved = await accountApi.pollLogin(login);
        if (!approved || cancelled) return;
        window.clearInterval(timer);
        setLogin(null);
      } catch (err) {
        if (cancelled) return;
        window.clearInterval(timer);
        setLogin(null);
        toast.error(errorText(err, t));
      }
    }, stepMs);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [login, t]);

  if (!supportsModelRouter(agentId)) return null;

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (accountToken()) {
        await openModelMarketplace(agentId);
        return;
      }
      const next = await accountApi.startLogin(modelMarketplacePath(agentId));
      setLogin(next);
      await openExternal(next.verifyUrl);
    } catch (err) {
      toast.error(errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="h-8"
        disabled={disabled || busy}
        onClick={() => void handleClick()}
      >
        {busy ? (
          <Loader2
            aria-hidden="true"
            className="mr-1.5 h-3.5 w-3.5 animate-spin"
          />
        ) : (
          <Waypoints aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
        )}
        {t('settings:agents.modelRouterEntry')}
      </Button>

      {login ? (
        <Dialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setLogin(null);
          }}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t('settings:agents.modelRouterTitle')}</DialogTitle>
              <DialogDescription>
                {t('settings:agents.modelRouterCodeHint')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="rounded-md border bg-muted/30 px-4 py-3 text-center">
                <div className="font-mono text-lg tracking-widest select-all">
                  {login.userCode}
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('settings:agents.modelRouterCodeHint')}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => void openExternal(login.verifyUrl)}
                >
                  <ExternalLink className="mr-1 h-3 w-3" />
                  {t('settings:agents.modelRouterReopen')}
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setLogin(null)}>
                {t('common:cancel')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

function errorText(
  err: unknown,
  t: (key: string, opts?: Record<string, unknown>) => string
) {
  const code = err instanceof AccountError ? err.code : 'failed';
  if (code === 'network') return t('settings:agents.modelRouterErrorNetwork');
  if (code === 'expired') return t('settings:agents.modelRouterErrorExpired');
  if (code === 'denied') return t('settings:agents.modelRouterErrorDenied');
  if (code === 'signed_out')
    return t('settings:agents.modelRouterErrorSignedOut');
  return t('settings:agents.modelRouterErrorFailed');
}
