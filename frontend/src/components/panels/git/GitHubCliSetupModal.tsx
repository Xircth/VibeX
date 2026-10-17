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
              ? `已成功登录 GitHub (${nextStatus.username})`
              : '已成功登录 GitHub'
          );
          onConfigured?.();
        }
        return nextStatus;
      } catch (err) {
        if (!silent) {
          setActionError(
            err instanceof Error ? err.message : '检查 GitHub CLI 状态失败'
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
        setActionMessage('GitHub CLI (gh) 安装成功，请继续完成 GitHub 登录。');
      } else {
        setActionError(
          nextStatus.message ||
            '自动安装未能完成，请参考下方命令手动安装 GitHub CLI。'
        );
      }
    } catch (err) {
      setActionError(
        err instanceof Error
          ? err.message
          : '安装 GitHub CLI 失败，请手动安装后点击重新检查。'
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
      setActionMessage(
        '已打开登录终端，请在弹出的终端或浏览器中完成授权，完成后将自动同步状态。'
      );
    } catch (err) {
      setActionError(
        err instanceof Error
          ? err.message
          : '无法自动打开登录终端，请复制下方命令在终端中执行登录。'
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
            <span>配置 GitHub CLI 与登录</span>
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
                  检查
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
                    {installing ? '安装中...' : '安装 gh'}
                  </Button>
                )}
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground break-all">
              {ghInstalled
                ? `已安装：${status?.gh_path ?? 'gh'}`
                : '尚未检测到 GitHub CLI，可点击「安装 gh」自动安装，或访问 cli.github.com 安装。'}
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
                  2. GitHub 账号登录
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
                {authenticated ? '重新登录' : '登录 GitHub'}
              </Button>
            </div>

            <p className="text-[11px] text-muted-foreground">
              {authenticated
                ? `当前已登录账号：${status?.username ?? '已授权'}`
                : '点击「登录 GitHub」启动浏览器授权流程，或在终端运行下方登录命令：'}
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
                  title="复制登录命令"
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
            关闭
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleComplete()}
            disabled={checking || installing}
          >
            完成并刷新
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
