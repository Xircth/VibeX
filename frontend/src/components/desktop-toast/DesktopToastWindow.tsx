import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  CheckCircle2,
  CircleAlert,
  Loader2,
  MessageSquare,
  Send,
  X,
} from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { AgentId, Session } from 'shared/types';
import { backendCall, backendListen } from '@/lib/backendTransport';
import { sessionsApi } from '@/lib/api';
import { Logo } from '@/components/Logo';
import { conversationApi } from '@/features/conversation/conversationApi';
import { agentTypeFromExecutor } from '@/features/agents/sendAgentRuntimeTurn';

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
 * 解析会话应使用的 ACP 智能体类型：优先用规范字段 `agent_id`，回退到旧的
 * `executor` 键（架构报告 A-6 过渡期）。用于在独立通知窗口里直接发起追问。
 */
function resolveAgentType(
  session: Session,
  t: TFunction<['panels', 'common']>
): AgentId {
  if (session.agent_id) {
    return session.agent_id;
  }
  if (session.executor) {
    return agentTypeFromExecutor(session.executor);
  }
  throw new Error(t('desktopToast.resolveAgentTypeFailed'));
}

export function DesktopToastWindow() {
  const { t } = useTranslation(['panels', 'common']);
  const [toasts, setToasts] = useState<DesktopToastItem[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [expandedReplies, setExpandedReplies] = useState<
    Record<string, boolean>
  >({});
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
    setExpandedReplies((previous) => {
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
      setToasts((previous) => {
        const next = [
          ...previous,
          {
            ...toast,
            id: toastId,
          },
        ];
        const removed = next.slice(0, Math.max(0, next.length - 3));
        removed.forEach((item) => {
          const timer = timersRef.current.get(item.id);
          if (timer != null) window.clearTimeout(timer);
          timersRef.current.delete(item.id);
        });
        return next.slice(-3);
      });
      scheduleRemoval(toastId, toast.durationMs);
    };

    (async () => {
      try {
        unlisten = await backendListen<DesktopToastPayload>(
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

        const pendingToasts = await backendCall<DesktopToastPayload[]>(
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
      await backendCall('activate_desktop_toast', {
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

  // 窗口内直接回复：与主 Composer 共用持久 Conversation input 控制面。
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
        await conversationApi.submitInput(toast.sessionId, {
          agentId: resolveAgentType(session, t),
          workspaceId: toast.workspaceId,
          text,
        });
        setReplyStatus((previous) => ({ ...previous, [toast.id]: 'sent' }));
        scheduleRemoval(toast.id, SENT_DISMISS_MS);
      } catch (error) {
        setReplyStatus((previous) => ({ ...previous, [toast.id]: 'error' }));
        setReplyError((previous) => ({
          ...previous,
          [toast.id]:
            error instanceof Error
              ? error.message
              : t('desktopToast.replySendFailed'),
        }));
        // 失败后重新计时消失；用户若回来重试，聚焦输入框会再次暂停计时。
        scheduleRemoval(toast.id, DEFAULT_DURATION_MS);
      }
    },
    [drafts, holdToast, replyStatus, scheduleRemoval, t]
  );

  return (
    <div className="min-h-screen bg-transparent p-4">
      <div className="pointer-events-none flex min-h-screen items-end justify-end">
        <div className="flex w-[424px] max-w-full flex-col gap-3">
          {toasts.map((toast) => {
            const status = replyStatus[toast.id] ?? 'idle';
            const draft = drafts[toast.id] ?? '';
            const isSending = status === 'sending';
            const replyExpanded = expandedReplies[toast.id] ?? false;

            return (
              <article
                key={toast.id}
                className="vu-toast-surface pointer-events-auto"
                data-kind={toast.kind}
                role={toast.kind === 'error' ? 'alert' : 'status'}
              >
                <div className="vu-toast-heading">
                  <span className="vu-toast-icon-tile vu-desktop-toast-app-icon">
                    <Logo showText={false} />
                    {toast.kind === 'error' ? (
                      <CircleAlert
                        className="vu-desktop-toast-status-badge"
                        aria-hidden="true"
                      />
                    ) : (
                      <CheckCircle2
                        className="vu-desktop-toast-status-badge"
                        aria-hidden="true"
                      />
                    )}
                  </span>
                  <button
                    type="button"
                    className="vu-desktop-toast-copy"
                    onClick={() => void handleActivate(toast)}
                  >
                    <span className="vu-toast-title">{toast.title}</span>
                    <span className="vu-toast-summary">
                      {toast.description}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="vu-toast-close"
                    aria-label={t('desktopToast.closeAriaLabel')}
                    onClick={() => removeToast(toast.id)}
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>

                {replyExpanded ? (
                  <div className="vu-desktop-toast-reply">
                    {status === 'sent' ? (
                      <div className="vu-desktop-toast-sent">
                        <CheckCircle2 aria-hidden="true" />
                        {t('desktopToast.sentHint')}
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <input
                            value={draft}
                            disabled={isSending}
                            placeholder={t('desktopToast.replyPlaceholder')}
                            aria-label={t('desktopToast.replyInputAriaLabel')}
                            className="vu-desktop-toast-input"
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
                            aria-label={t('desktopToast.sendReplyAriaLabel')}
                            disabled={isSending || draft.trim().length === 0}
                            className="vu-desktop-toast-send"
                            onClick={() => void handleReplySubmit(toast)}
                          >
                            {isSending ? (
                              <Loader2 className="animate-spin" />
                            ) : (
                              <Send />
                            )}
                          </button>
                        </div>
                        {status === 'error' ? (
                          <div className="vu-desktop-toast-hint vu-desktop-toast-error">
                            {replyError[toast.id] ??
                              t('desktopToast.replySendFailed')}
                          </div>
                        ) : (
                          <div className="vu-desktop-toast-hint">
                            {t('desktopToast.clickCardHint')}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  <div className="vu-toast-actions">
                    <button
                      type="button"
                      className="vu-toast-action vu-toast-action-secondary vu-desktop-toast-reply-action"
                      onClick={() => {
                        holdToast(toast.id);
                        setExpandedReplies((previous) => ({
                          ...previous,
                          [toast.id]: true,
                        }));
                      }}
                    >
                      <MessageSquare aria-hidden="true" />
                      {t('desktopToast.quickReply')}
                    </button>
                    <button
                      type="button"
                      className="vu-toast-action vu-toast-action-primary"
                      onClick={() => void handleActivate(toast)}
                    >
                      {t('desktopToast.openConversation')}
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
