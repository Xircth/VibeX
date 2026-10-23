export function mountConfigPanel(
  root: HTMLElement,
  invoke: (handler: string, input?: Record<string, unknown> | null) => Promise<unknown>
): Promise<() => void>;
