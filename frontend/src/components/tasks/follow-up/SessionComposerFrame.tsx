import type { FocusEventHandler, ReactNode } from 'react';

export function SessionComposerFrame({
  status,
  drawer,
  overlay,
  onFocus,
  onBlur,
  children,
}: {
  status?: ReactNode;
  drawer?: ReactNode;
  overlay?: ReactNode;
  onFocus?: FocusEventHandler<HTMLDivElement>;
  onBlur?: FocusEventHandler<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div
      className="agent-question-composer-stack relative z-10 mx-3 mb-3 mt-2 shrink-0"
      data-testid="session-composer-stack"
      data-has-overlay={overlay ? 'true' : undefined}
    >
      {status}
      {overlay}
      {drawer}
      <div
        className="composer-shell session-composer-body relative z-10 flex flex-col gap-1 overflow-visible p-2"
        data-testid="session-composer-body"
        data-typeahead-surface="composer"
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {children}
      </div>
    </div>
  );
}
