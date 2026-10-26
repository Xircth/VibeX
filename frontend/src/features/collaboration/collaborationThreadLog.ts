export const COLLAB_THREAD_BOTTOM_THRESHOLD_PX = 48;

export type CollabThreadLogMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

export function isCollabThreadLogAtBottom(
  el: CollabThreadLogMetrics
): boolean {
  return (
    el.scrollHeight - el.scrollTop - el.clientHeight <=
    COLLAB_THREAD_BOTTOM_THRESHOLD_PX
  );
}

export function scrollCollabThreadLogToBottom(
  el: CollabThreadLogMetrics & {
    scrollTo?: (options: { top: number; behavior?: ScrollBehavior }) => void;
  },
  behavior: ScrollBehavior = 'auto'
): void {
  const top = Math.max(0, el.scrollHeight - el.clientHeight);
  if (behavior === 'smooth' && typeof el.scrollTo === 'function') {
    el.scrollTo({ top, behavior });
    return;
  }
  el.scrollTop = top;
}
