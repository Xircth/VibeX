import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, Send, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { BaseCodingAgent, type Session } from 'shared/types';
import { tauriInvoke, tauriListen } from '@/lib/tauriApi';
import { sessionsApi } from '@/lib/api';
import { conversationApi } from '@/features/conversation/conversationApi';
import { agentTypeFromExecutor } from '@/features/agents/sendAgentRuntimeTurn';
import type { AgentType } from '@/features/agents/types';

type DesktopToastKind = 'success' | 'error';

type DesktopToastPayload = {
  projectId: string;
  workspaceId: string;
  sessionId: string;
  title: string;
  description: string;
  kind: DesktopToastKind;
  durationMs?: number | null;
};

type DesktopToastItem = DesktopToastPayload & {
  id: string;
};

type ReplyStatus = 'idle' | 'sending' | 'sent' | 'error';

const DEFAULT_DURATION_MS = 15_000;
const SENT_DISMISS_MS = 1_600;

/**
 * 解析会话应使用的 ACP 智能体类型：优先用规范字段 `agent_type`，回退到旧的
 * `executor` 键（架构报告 A-6 过渡期）。用于在独立通知窗口里直接发起追问。
 */
function resolveAgentType(session: Session): AgentType {
  if (session.agent_type) {
    return session.agent_type as AgentType;
  }
  if (session.executor) {
    return agentTypeFromExecutor(session.executor as BaseCodingAgent);
  }
  throw new Error('无法确定该会话的智能体类型');
}

export function DesktopToastWindow() {
  const [toasts, setToasts] = useState<DesktopToastItem[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [replyStatus, setReplyStatus] = useState<Record<string, ReplyStatus>>(
    {}
  );
  const [replyError, setReplyError] = useState<Record<string, string>>({});
  const timersRef = useRef(new Map<string, number>());

  const removeToast = useCallback((toastId: string) => {
    setToasts((previous) => previous.filter((toast) => toast.id !== toastId));
    setDrafts((previous) => {
      if (!(toastId in previous)) return previous;
      const next = { ...previous };
      delete next[toastId];
      return next;
    });
    setReplyStatus((previous) => {
      if (!(toastId in previous)) return previous;
      const next = { ...previous };
      delete next[toastId];
      return next;
    });
    setReplyError((previous) => {
      if (!(toastId in previous)) return previous;
      const next = { ...previous };
      delete next[toastId];
      return next;
    });

    const timer = timersRef.current.get(toastId);
    if (timer != null) {
      window.clearTimeout(timer);
      timersRef.current.delete(toastId);
    }
  }, []);

  const closeWindow = useCallback(async () => {
    await getCurrentWindow()
      .hide()
      .catch(() => {});
  }, []);

  const scheduleRemoval = useCallback(
    (toastId: string, durationMs?: number | null) => {
      const existing = timersRef.current.get(toastId);
      if (existing != null) {
        window.clearTimeout(existing);
      }
      const timeout = window.setTimeout(() => {
        removeToast(toastId);
      }, durationMs ?? DEFAULT_DURATION_MS);
      timersRef.current.set(toastId, timeout);
    },
    [removeToast]
  );

  // 用户开始与卡片交互（聚焦输入框）时，暂停自动消失，避免回复到一半窗口被关闭。
  const holdToast = useCallback((toastId: string) => {
    const timer = timersRef.current.get(toastId);
    if (timer != null) {
      window.clearTimeout(timer);
      timersRef.current.delete(toastId);
    }
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const timers = timersRef.current;

    const pushToast = (toast: DesktopToastPayload) => {
      const toastId = `${toast.sessionId}-${Date.now()}-${Math.random()}`;
      setToasts((previous) => [
        ...previous,
        {
          ...toast,
          id: toastId,
        },
      ]);
      scheduleRemoval(toastId, toast.durationMs);
    };

    (async () => {
      try {
        unlisten = await tauriListen<DesktopToastPayload>(
          'desktop-toast',
          (payload) => {
            if (cancelled) {
              return;
            }
            pushToast(payload);
          }
        );

        if (cancelled) {
          unlisten?.();
          return;
        }

        const pendingToasts = await tauriInvoke<DesktopToastPayload[]>(
          'desktop_toast_window_ready'
        );

        if (cancelled) {
          return;
        }

        pendingToasts.forEach(pushToast);
      } catch {
        // Best-effort window hydration only.
      } finally {
        if (!cancelled) {
          setIsHydrated(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, [scheduleRemoval]);

  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    document.body.style.margin = '0';
    return () => {
      document.documentElement.style.background = '';
      document.body.style.background = '';
      document.body.style.margin = '';
    };
  }, []);

  useEffect(() => {
    if (!isHydrated || toasts.length > 0) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void closeWindow();
    }, 150);

    return () => window.clearTimeout(timeout);
  }, [closeWindow, isHydrated, toasts.length]);

  // 点击卡片标题区域：唤起主窗口并跳转到对应会话（与窗口内快捷回复相互独立）。
  const handleActivate = useCallback(
    async (toast: DesktopToastItem) => {
      removeToast(toast.id);
      await tauriInvoke('activate_desktop_toast', {
        payload: {
          projectId: toast.projectId,
          workspaceId: toast.workspaceId,
          sessionId: toast.sessionId,
          title: toast.title,
          description: toast.description,
          kind: toast.kind,
          durationMs: toast.durationMs ?? DEFAULT_DURATION_MS,
        },
      }).catch(() => {});
    },
    [removeToast]
  );

  // 窗口内直接回复：复用 conversation_start_turn 向会话发起新一轮追问。
  // 发送后保持主窗口在后台（不抢焦点），仅在卡片内提示「已发送」后淡出。
  const handleReplySubmit = useCallback(
    async (toast: DesktopToastItem) => {
      const text = (drafts[toast.id] ?? '').trim();
      if (!text || replyStatus[toast.id] === 'sending') {
        return;
      }

      holdToast(toast.id);
      setReplyStatus((previous) => ({ ...previous, [toast.id]: 'sending' }));
      setReplyError((previous) => {
        if (!(toast.id in previous)) return previous;
        const next = { ...previous };
        delete next[toast.id];
        return next;
      });

      try {
        const session = await sessionsApi.getById(toast.sessionId);
        await conversationApi.startTurn({
          agentType: resolveAgentType(session),
          workspaceId: toast.workspaceId,
          conversationId: toast.sessionId,
          text,
        });
        setReplyStatus((previous) => ({ ...previous, [toast.id]: 'sent' }));
        scheduleRemoval(toast.id, SENT_DISMISS_MS);
      } catch (error) {
        setReplyStatus((previous) => ({ ...previous, [toast.id]: 'error' }));
        setReplyError((previous) => ({
          ...previous,
          [toast.id]:
            error instanceof Error ? error.message : '回复发送失败，请稍后重试。',
        }));
        // 失败后重新计时消失；用户若回来重试，聚焦输入框会再次暂停计时。
        scheduleRemoval(toast.id, DEFAULT_DURATION_MS);
      }
    },
    [drafts, holdToast, replyStatus, scheduleRemoval]
  );

  return (
    <div className="min-h-screen bg-transparent p-4">
      <div className="pointer-events-none flex min-h-screen items-end justify-end">
        <div className="flex w-[388px] flex-col gap-3">
          {toasts.map((toast) => {
            const status = replyStatus[toast.id] ?? 'idle';
            const draft = drafts[toast.id] ?? '';
            const isSending = status === 'sending';

            return (
              <div
                key={toast.id}
                className="tahoe-popover pointer-events-auto relative overflow-hidden rounded-[14px]"
              >
                <button
                  type="button"
                  className="flex w-full flex-col gap-1.5 px-4 pt-3 pr-10 text-left transition-colors hover:bg-[var(--surface-control-hover)]"
                  onClick={() => void handleActivate(toast)}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={
                        toast.kind === 'error'
                          ? 'tahoe-status-dot-danger h-2.5 w-2.5 shrink-0 rounded-full'
                          : 'tahoe-status-dot-success h-2.5 w-2.5 shrink-0 animate-pulse rounded-full'
                      }
                    />
                    <span className="min-w-0 truncate text-sm font-semibold text-foreground">
                      {toast.title}
                    </span>
                  </div>
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {toast.description}
                  </span>
                </button>

                <div className="px-4 pb-3 pt-2">
                  {status === 'sent' ? (
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-[hsl(var(--success))]">
                      <Check className="h-3.5 w-3.5 shrink-0" />
                      已发送，可在主窗口查看回复
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <input
                          value={draft}
                          disabled={isSending}
                          placeholder="直接回复…"
                          aria-label="回复该会话"
                          className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-control)] px-2.5 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-[hsl(var(--primary)/0.5)] disabled:opacity-60"
                          onChange={(event) => {
                            const value = event.target.value;
                            setDrafts((previous) => ({
                              ...previous,
                              [toast.id]: value,
                            }));
                            holdToast(toast.id);
                          }}
                          onFocus={() => holdToast(toast.id)}
                          onBlur={(event) => {
                            // 失焦且无草稿时恢复自动消失；发送中（输入禁用）不重排。
                            if (
                              !event.target.value.trim() &&
                              status !== 'sending'
                            ) {
                              scheduleRemoval(toast.id, DEFAULT_DURATION_MS);
                            }
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                              event.preventDefault();
                              void handleReplySubmit(toast);
                            }
                          }}
                        />
                        <button
                          type="button"
                          aria-label="发送回复"
                          disabled={isSending || draft.trim().length === 0}
                          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90 disabled:opacity-40"
                          onClick={() => void handleReplySubmit(toast)}
                        >
                          {isSending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Send className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                      {status === 'error' ? (
                        <div className="mt-1.5 text-[11px] text-[hsl(var(--destructive))]">
                          {replyError[toast.id] ?? '回复发送失败，请稍后重试。'}
                        </div>
                      ) : (
                        <div className="mt-1.5 text-[11px] text-muted-foreground">
                          点击上方卡片回到该会话
                        </div>
                      )}
                    </>
                  )}
                </div>

                <button
                  type="button"
                  className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--surface-control-hover)] hover:text-foreground"
                  aria-label="关闭通知"
                  onClick={() => removeToast(toast.id)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
