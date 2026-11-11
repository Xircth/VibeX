import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
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
import { cn } from '@/lib/utils';

import {
  AccountError,
  accountApi,
  accountToken,
  modelRouterUrl,
  type DeviceLogin,
  type RouterModel,
  type RouterOverview,
  type RouterProvision,
} from './account';
import { openExternal } from './openExternal';

const MICRO = 1_000_000;

type Phase =
  | { kind: 'loading' }
  | { kind: 'signed_out' }
  | { kind: 'login'; login: DeviceLogin; expiresAt: number }
  | { kind: 'ready'; overview: RouterOverview };

function credits(micro: number, digits: number) {
  return (micro / MICRO).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** What a million tokens cost after the discount, in credits. */
function chargedPrice(listMicro: number, permille: number) {
  return ((listMicro * permille) / 1000 / MICRO).toLocaleString('en-US', {
    maximumFractionDigits: 3,
  });
}

export function ModelRouterDialog({
  agentId,
  open,
  onOpenChange,
  onApply,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Writes the issued key and endpoint into this agent's provider settings. */
  onApply: (provision: RouterProvision) => Promise<void>;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [picked, setPicked] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const describe = useCallback(
    (cause: unknown) => {
      const code = cause instanceof AccountError ? cause.code : '';
      if (code === 'network')
        return t('settings:agents.modelRouterErrorNetwork');
      if (code === 'expired' || code === 'invalid') {
        return t('settings:agents.modelRouterErrorExpired');
      }
      if (code === 'denied') return t('settings:agents.modelRouterErrorDenied');
      if (code === 'signed_out') {
        return t('settings:agents.modelRouterErrorSignedOut');
      }
      if (!(cause instanceof AccountError) && cause instanceof Error) {
        return cause.message;
      }
      return t('settings:agents.modelRouterErrorFailed');
    },
    [t]
  );

  const refresh = useCallback(async () => {
    if (!accountToken()) {
      setPhase({ kind: 'signed_out' });
      return;
    }
    try {
      setPhase({ kind: 'ready', overview: await accountApi.overview() });
      setError(null);
    } catch (cause) {
      setPhase({ kind: 'signed_out' });
      // A lapsed token simply lands on the sign-in view; only real failures
      // need words.
      if (!(cause instanceof AccountError && cause.code === 'signed_out')) {
        setError(describe(cause));
      }
    }
  }, [describe]);

  useEffect(() => {
    if (!open) return;
    setPhase({ kind: 'loading' });
    setError(null);
    void refresh();
  }, [open, refresh]);

  // A purchase is finished in the browser, so pick up the new balance when
  // the user comes back to the app.
  useEffect(() => {
    if (!open || phase.kind !== 'ready') return;
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [open, phase.kind, refresh]);

  const login = phase.kind === 'login' ? phase : null;
  useEffect(() => {
    if (!open || !login) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      if (Date.now() >= login.expiresAt) {
        window.clearInterval(timer);
        setPhase({ kind: 'signed_out' });
        setError(t('settings:agents.modelRouterErrorExpired'));
        return;
      }
      try {
        const approved = await accountApi.pollLogin(login.login);
        if (stopped || !approved) return;
        window.clearInterval(timer);
        setPhase({ kind: 'loading' });
        await refresh();
      } catch (cause) {
        if (stopped) return;
        // One dropped poll is not a failed login; the next tick retries.
        if (cause instanceof AccountError && cause.code === 'network') return;
        window.clearInterval(timer);
        setPhase({ kind: 'signed_out' });
        setError(describe(cause));
      }
    }, login.login.interval * 1000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [open, login, refresh, describe, t]);

  const overview = phase.kind === 'ready' ? phase.overview : null;
  const agent = overview?.agents.find((item) => item.id === agentId) ?? null;
  const task = overview?.tasks.find((item) => item.agentId === agentId) ?? null;
  const models = useMemo(() => {
    if (!overview || !agent) return [];
    const byId = new Map(overview.models.map((model) => [model.id, model]));
    return [...agent.native, ...agent.others]
      .map((id) => byId.get(id))
      .filter((model): model is RouterModel => Boolean(model));
  }, [overview, agent]);

  // Derived rather than stored so the list never paints once without a
  // selection: the user's pick wins, then a purchase waiting to be applied.
  const selected =
    models.find((model) => model.id === picked)?.id ??
    models.find((model) => model.id === task?.modelId)?.id ??
    models[0]?.id ??
    null;
  const startLogin = async () => {
    setWorking(true);
    setError(null);
    try {
      const next = await accountApi.startLogin();
      setPhase({
        kind: 'login',
        login: next,
        expiresAt: Date.now() + next.expiresIn * 1000,
      });
      await openExternal(next.verifyUrl);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setWorking(false);
    }
  };

  const signOut = async () => {
    await accountApi.signOut();
    setPhase({ kind: 'signed_out' });
  };

  const apply = async () => {
    if (!selected) return;
    setWorking(true);
    setError(null);
    try {
      const provision = await accountApi.provision(
        agentId,
        selected,
        task && task.modelId === selected ? task.id : null
      );
      await onApply(provision);
      toast.success(
        t('settings:agents.modelRouterApplied', { model: provision.model.name })
      );
      onOpenChange(false);
    } catch (cause) {
      if (cause instanceof AccountError && cause.code === 'signed_out') {
        setPhase({ kind: 'signed_out' });
      }
      setError(describe(cause));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Dialog open={open} className="!max-w-md" onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings:agents.modelRouterTitle')}</DialogTitle>
          <DialogDescription>
            {t('settings:agents.modelRouterIntro')}
          </DialogDescription>
        </DialogHeader>

        {phase.kind === 'loading' ? (
          <div
            role="status"
            aria-busy="true"
            className="flex h-24 items-center justify-center"
          >
            <Loader2
              aria-hidden="true"
              className="h-4 w-4 animate-spin text-muted-foreground"
            />
          </div>
        ) : null}

        {phase.kind === 'login' ? (
          <div className="flex flex-col items-center gap-2 py-2 text-center">
            <output className="font-mono text-2xl font-semibold tabular-nums tracking-widest">
              {phase.login.userCode}
            </output>
            <p className="text-xs text-muted-foreground">
              {t('settings:agents.modelRouterCodeHint')}
            </p>
          </div>
        ) : null}

        {overview ? (
          <>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0 truncate text-muted-foreground">
                {overview.user.email || overview.user.displayName}
              </span>
              <span className="shrink-0 tabular-nums">
                {t('settings:agents.modelRouterBalance', {
                  amount: credits(overview.balanceMicro, 2),
                })}
              </span>
            </div>
            {models.length ? (
              <div
                role="radiogroup"
                aria-label={t('settings:agents.modelRouterTitle')}
                className="flex max-h-64 flex-col gap-1 overflow-y-auto"
              >
                {models.map((model) => {
                  const active = model.id === selected;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={working}
                      className={cn(
                        'flex items-center gap-3 rounded-md border px-3 py-2 text-left',
                        active
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:bg-[var(--surface-control-hover)]'
                      )}
                      onClick={() => setPicked(model.id)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-sm">
                          <span className="truncate">{model.name}</span>
                          {model.discountPermille < 1000 ? (
                            <span className="shrink-0 rounded-full bg-primary/10 px-1.5 text-xs tabular-nums text-primary">
                              {t('settings:agents.modelRouterDiscount', {
                                fold: Number(
                                  (model.discountPermille / 100).toFixed(1)
                                ),
                                percent: Math.round(
                                  100 - model.discountPermille / 10
                                ),
                              })}
                            </span>
                          ) : null}
                          {task?.modelId === model.id ? (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {t('settings:agents.modelRouterPurchased')}
                            </span>
                          ) : null}
                        </span>
                        <span className="block text-xs tabular-nums text-muted-foreground">
                          {t('settings:agents.modelRouterPrice', {
                            input: chargedPrice(
                              model.inputMicro,
                              model.discountPermille
                            ),
                            output: chargedPrice(
                              model.outputMicro,
                              model.discountPermille
                            ),
                          })}
                        </span>
                      </span>
                      <Check
                        aria-hidden="true"
                        className={cn(
                          'h-4 w-4 shrink-0 text-primary',
                          !active && 'invisible'
                        )}
                      />
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="py-4 text-center text-xs text-muted-foreground">
                {t('settings:agents.modelRouterNoModels')}
              </p>
            )}
            {models.length && overview.balanceMicro <= 0 ? (
              <p className="text-xs text-muted-foreground">
                {t('settings:agents.modelRouterEmptyBalance')}
              </p>
            ) : null}
          </>
        ) : null}

        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          {phase.kind === 'signed_out' ? (
            <Button disabled={working} onClick={() => void startLogin()}>
              {t('settings:agents.modelRouterSignIn')}
            </Button>
          ) : null}
          {phase.kind === 'login' ? (
            <>
              <Button
                variant="outline"
                onClick={() => setPhase({ kind: 'signed_out' })}
              >
                {t('common:cancel')}
              </Button>
              <Button
                variant="outline"
                onClick={() => void openExternal(phase.login.verifyUrl)}
              >
                {t('settings:agents.modelRouterReopen')}
              </Button>
            </>
          ) : null}
          {overview ? (
            <>
              <Button
                variant="ghost"
                className="sm:mr-auto"
                disabled={working}
                onClick={() => void signOut()}
              >
                {t('settings:agents.modelRouterSignOut')}
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  void openExternal(modelRouterUrl(agentId, selected))
                }
              >
                {t('settings:agents.modelRouterBuy')}
              </Button>
              <Button
                disabled={working || !selected || !models.length}
                onClick={() => void apply()}
              >
                {t('settings:agents.modelRouterApply')}
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
