import type { FocusEventHandler, MouseEvent, ReactNode } from 'react';
import { cn } from '@/lib/utils';

const INTERACTIVE_CLICK_TARGET_SELECTOR = [
  'button',
  'a',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  '[role="button"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="switch"]',
  '[popover]',
  '[data-radix-popper-content-wrapper]',
  '[data-astryx-token]',
  '[contenteditable]',
].join(', ');

function handleComposerBodyClick(event: MouseEvent<HTMLDivElement>) {
  if (event.defaultPrevented) return;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.closest(INTERACTIVE_CLICK_TARGET_SELECTOR)) return;

  const selection = window.getSelection();
  if (
    selection &&
    !selection.isCollapsed &&
    selection.anchorNode &&
    event.currentTarget.contains(selection.anchorNode)
  ) {
    return;
  }

  const editable = event.currentTarget.querySelector<HTMLElement>(
    '[contenteditable="true"]'
  );
  if (!editable || editable.getAttribute('aria-disabled') === 'true') {
    return;
  }

  editable.focus();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

export function SessionComposerFrame({
  status,
  drawer,
  overlay,
  widthClassName = 'max-w-3xl',
  onFocus,
  onBlur,
  children,
}: {
  status?: ReactNode;
  drawer?: ReactNode;
  overlay?: ReactNode;
  widthClassName?: string;
  onFocus?: FocusEventHandler<HTMLDivElement>;
  onBlur?: FocusEventHandler<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div className="shrink-0 px-3 pb-2.5 pt-1.5">
      <div
        className={cn(
          'agent-question-composer-stack relative z-10 mx-auto w-full',
          widthClassName
        )}
        data-testid="session-composer-stack"
        data-basic-guide="session-composer"
        data-has-overlay={overlay ? 'true' : undefined}
      >
        {status}
        {overlay}
        {drawer}
        <div
          className="session-composer-anchor relative"
          data-testid="session-composer-anchor"
        >
          <div
            className="composer-shell session-composer-body relative z-10 flex flex-col gap-0.5 overflow-visible rounded-[var(--radius-composer,0.75rem)] px-3 py-2"
            data-testid="session-composer-body"
            data-typeahead-surface="composer"
            onClick={handleComposerBodyClick}
            onFocus={onFocus}
            onBlur={onBlur}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
