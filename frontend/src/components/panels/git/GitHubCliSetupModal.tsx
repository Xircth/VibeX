import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Check,
  Download,
  Github,
  Loader2,
  LogIn,
  RefreshCw,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { TextInput } from '@astryxdesign/core/TextInput';
import { type GitHubCliStatus, versionControlApi } from '@/lib/api';
import { writeClipboardViaBridge } from '@/vscode/bridge';
import i18n from '@/i18n';

interface GitHubCliSetupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfigured?: () => void;
}

export function GitHubCliSetupModal({
  open,
  onOpenChange,
  onConfigured,
}: GitHubCliSetupModalProps) {
  const [host, setHost] = useState('github.com');
  const [status, setStatus] = useState<GitHubCliStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [awaitingLogin, setAwaitingLogin] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedCmd, setCopiedCmd] = useState(false);

  const checkStatus = useCallback(
    async (targetHost?: string, silent = false) => {
      const effectiveHost = (targetHost ?? host).trim() || 'github.com';
      if (!silent) {
        setChecking(true);
        setActionError(null);
      }
      try {
        const nextStatus =
          await versionControlApi.getGithubCliStatus(effectiveHost);
        setStatus(nextStatus);
        if (nextStatus.authenticated) {
          setAwaitingLogin(false);
          setActionMessage(
            nextStatus.username
              ? i18n.t('panels:ui.ghSetup.signedInToGithubUsername', {
                  username: nextStatus.username,
                })
              : i18n.t('panels:ui.ghSetup.signedInToGithub')
          );
          onConfigured?.();
        }
        return nextStatus;
      } catch (err) {
        if (!silent) {
          setActionError(
            err instanceof Error
              ? err.message
              : i18n.t('panels:ui.ghSetup.failedToCheckGithubCli')
          );
        }
        return null;
      } finally {
        if (!silent) {
          setChecking(false);
        }
      }
    },
    [host, onConfigured]
  );

  useEffect(() => {
    if (!open) {
      setAwaitingLogin(false);
      setActionMessage(null);
      setActionError(null);
      return;
    }
    void checkStatus('github.com');
  }, [open, checkStatus]);

  useEffect(() => {
    if (!open) return;
    const handleFocus = () => {
      void checkStatus(undefined, true);
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [open, checkStatus]);

  useEffect(() => {
    if (!open || !awaitingLogin) return;
    const timer = window.setInterval(() => {
      void checkStatus(undefined, true);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [open, awaitingLogin, checkStatus]);

  const handleInstallGh = async () => {
    setInstalling(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const effectiveHost = host.trim() || 'github.com';
      const nextStatus =
        await versionControlApi.installGithubCli(effectiveHost);
      setStatus(nextStatus);
      if (nextStatus.gh_installed) {
        setActionMessage(
          i18n.t('panels:ui.ghSetup.githubCliGhInstalledContinue')
        );
      } else {
        setActionError(
          nextStatus.message ||
            i18n.t('panels:ui.ghSetup.automaticInstallDidNotFinish')
        );
      }
    } catch (err) {
      setActionError(
        err instanceof Error
          ? err.message
          : i18n.t('panels:ui.ghSetup.failedToInstallGithubCli')
      );
    } finally {
      setInstalling(false);
    }
  };

  const handleStartLogin = async () => {
    setLoggingIn(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const effectiveHost = host.trim() || 'github.com';
      await versionControlApi.openGithubCliLogin(effectiveHost);
      setAwaitingLogin(true);
      setActionMessage(i18n.t('panels:ui.ghSetup.aSignInTerminalIs'));
    } catch (err) {
      setActionError(
        err instanceof Error
          ? err.message
          : i18n.t('panels:ui.ghSetup.couldnTOpenASign')
      );
    } finally {
      setLoggingIn(false);
    }
  };

  const loginCommand =
    (host.trim() || 'github.com') === 'github.com'
      ? 'gh auth login --web --git-protocol https'
      : `gh auth login --web --git-protocol https --hostname ${host.trim()}`;

  const handleCopyCommand = async () => {
    await writeClipboardViaBridge(loginCommand);
    setCopiedCmd(true);
    window.setTimeout(() => setCopiedCmd(false), 1800);
  };

  const handleComplete = async () => {
    await checkStatus();
    onConfigured?.();
    onOpenChange(false);
  };

  const ghInstalled = Boolean(status?.gh_installed);
  const authenticated = Boolean(status?.authenticated);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Github className="h-4 w-4" />
            <span>{i18n.t('panels:ui.ghSetup.setUpGithubCliAnd')}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-1 text-xs">
          {/* Step 1: Check / Install gh */}
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {checking ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
                ) : ghInstalled ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-[hsl(var(--success))] shrink-0" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5 text-[hsl(var(--warning))] shrink-0" />
                )}
                <span className="font-medium text-foreground">
                  1. GitHub CLI (gh)
                </span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => void checkStatus()}
                  disabled={checking || installing}
                >
                  <RefreshCw
                    className={`mr-1 h-3 w-3 ${checking ? 'animate-spin' : ''}`}
                  />
                  {i18n.t('panels:ui.ghSetup.check')}
                </Button>
                {!ghInstalled && (
                  <Button
                    type="button"
                    size="sm"
                    className="h-6 px-2.5 text-[11px]"
                    onClick={() => void handleInstallGh()}
                    disabled={installing || checking}
                  >
                    {installing ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <Download className="mr-1 h-3 w-3" />
                    )}
                    {installing
                      ? i18n.t('panels:ui.ghSetup.installing')
                      : i18n.t('panels:ui.ghSetup.installGh')}
                  </Button>
                )}
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground break-all">
              {ghInstalled
                ? i18n.t('panels:ui.ghSetup.installedGhPath', {
                    gh_path: status?.gh_path ?? 'gh',
                  })
                : i18n.t('panels:ui.ghSetup.githubCliNotFoundClick')}
            </p>
          </div>

          {/* Step 2: GitHub Login */}
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {checking || awaitingLogin ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
                ) : authenticated ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-[hsl(var(--success))] shrink-0" />
                ) : (
                  <AlertCircle className="h-3.5 w-3.5 text-[hsl(var(--warning))] shrink-0" />
                )}
                <span className="font-medium text-foreground">
                  {i18n.t('panels:ui.ghSetup.2SignInToGithub')}
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                variant={authenticated ? 'outline' : 'default'}
                className="h-6 px-2.5 text-[11px]"
                onClick={() => void handleStartLogin()}
                disabled={!ghInstalled || loggingIn || installing}
              >
                {loggingIn ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <LogIn className="mr-1 h-3 w-3" />
                )}
                {authenticated
                  ? i18n.t('panels:ui.ghSetup.signInAgain')
                  : i18n.t('panels:ui.ghSetup.signInToGithub')}
              </Button>
            </div>

            <p className="text-[11px] text-muted-foreground">
              {authenticated
                ? i18n.t('panels:ui.ghSetup.signedInAsUsername', {
                    username:
                      status?.username ??
                      i18n.t('panels:ui.ghSetup.authorized'),
                  })
                : i18n.t('panels:ui.ghSetup.clickSignInToGithub')}
            </p>

            <div className="space-y-1.5">
              <TextInput
                label="GitHub Host"
                isLabelHidden
                size="sm"
                width="100%"
                value={host}
                onChange={setHost}
                placeholder="github.com"
                className="git-log-search-input"
              />
              <div className="flex items-center justify-between gap-1.5 rounded border border-border/50 bg-background/70 px-2 py-1">
                <code className="text-[10px] font-mono text-muted-foreground truncate">
                  {loginCommand}
                </code>
                <button
                  type="button"
                  onClick={() => void handleCopyCommand()}
                  className="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                  title={i18n.t('panels:ui.ghSetup.copySignInCommand')}
                >
                  {copiedCmd ? (
                    <Check className="h-3 w-3 text-[hsl(var(--success))]" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </button>
              </div>
            </div>
          </div>

          {actionMessage && (
            <div className="rounded-md border border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.08)] px-2.5 py-1.5 text-[11px] text-[hsl(var(--success))]">
              {actionMessage}
            </div>
          )}

          {actionError && (
            <div className="rounded-md border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.1)] px-2.5 py-1.5 text-[11px] text-[hsl(var(--warning))]">
              {actionError}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            {i18n.t('panels:ui.ghSetup.close')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleComplete()}
            disabled={checking || installing}
          >
            {i18n.t('panels:ui.ghSetup.doneAndRefresh')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
