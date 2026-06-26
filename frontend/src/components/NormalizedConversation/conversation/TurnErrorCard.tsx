import { useState } from 'react';
import { Ban, RefreshCw, ShieldAlert, TriangleAlert } from 'lucide-react';
import type { ConversationError } from 'shared/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Turn-failure surface, keyed on the agent's *real* ACP error code so each
 * failure reads as what it actually is — an expired session, an auth prompt, a
 * user cancellation, or a generic error — and offers the matching recovery
 * instead of a single flat "something went wrong" banner. Codes come straight
 * from `ConversationError.code` (mapped from the ACP/JSON-RPC error); nothing is
 * inferred from message text.
 */
export function TurnErrorCard({
  error,
  onReload,
}: {
  error: ConversationError;
  onReload?: () => void | Promise<unknown>;
}) {
  const [reloading, setReloading] = useState(false);
  const view = describeError(error);

  const handleReload = () => {
    if (!onReload) return;
    setReloading(true);
    void Promise.resolve(onReload()).finally(() => setReloading(false));
  };

  return (
    <div
      className={cn(
        'conv-entry-item mb-2 rounded-lg border px-3 py-2.5 text-sm',
        view.tone === 'neutral'
          ? 'border-border bg-muted/40 text-muted-foreground'
          : 'border-destructive/40 bg-destructive/10 text-destructive'
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0">{view.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="font-medium">{view.title}</div>
          {view.detail ? (
            <div className="mt-0.5 whitespace-pre-wrap break-words leading-5 opacity-90">
              {view.detail}
            </div>
          ) : null}
          {view.canReload && onReload ? (
            <div className="mt-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={reloading}
                onClick={handleReload}
              >
                <RefreshCw
                  className={cn('mr-1 h-3.5 w-3.5', reloading && 'animate-spin')}
                />
                重新加载会话
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type ErrorTone = 'neutral' | 'error';

type ErrorView = {
  title: string;
  detail: string | null;
  tone: ErrorTone;
  icon: React.ReactNode;
  canReload: boolean;
};

function describeError(error: ConversationError): ErrorView {
  const message = error.message?.trim() || null;
  switch (error.code) {
    case 'cancelled':
    case 'request_cancelled':
      return {
        title: '已取消',
        detail: message,
        tone: 'neutral',
        icon: <Ban className="h-4 w-4" />,
        canReload: false,
      };
    case 'resource_not_found':
      return {
        title: '代理会话已过期',
        detail:
          message ??
          '该会话在代理侧已不存在。重新加载会在下一条消息时重新建立会话。',
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canReload: true,
      };
    case 'idle_timeout':
      return {
        title: '代理无响应',
        detail:
          '代理长时间未返回任何内容，已自动结束本回合。常见原因：网络/代理无法连接模型，或代理需要重新登录认证。',
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canReload: true,
      };
    case 'connection_closed':
      return {
        title: '连接已断开',
        detail: message ?? '代理连接在本回合完成前断开。',
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canReload: true,
      };
    case 'auth_required':
      return {
        title: '需要重新认证',
        detail: message ?? '代理要求重新认证后才能继续。',
        tone: 'error',
        icon: <ShieldAlert className="h-4 w-4" />,
        canReload: false,
      };
    default:
      return {
        title: '会话出错',
        detail: errorDetail(message, error.code),
        tone: 'error',
        icon: <TriangleAlert className="h-4 w-4" />,
        canReload: true,
      };
  }
}

function errorDetail(
  message: string | null,
  code: string | null | undefined
): string | null {
  if (message && code) return `${message}（${code}）`;
  if (message) return message;
  if (code) return code;
  return null;
}
