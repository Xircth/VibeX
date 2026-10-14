import * as React from 'react';
import { X } from 'lucide-react';
import { twMerge } from 'tailwind-merge';

import { cn } from '@/lib/utils';
import { useHotkeysContext } from 'react-hotkeys-hook';
import { useKeyExit, useKeySubmit, Scope } from '@/keyboard';
import { NativeSurfaceOcclusionHold } from '@/contexts/WorkspaceOverlayContext';

interface DialogContextValue {
  titleId?: string;
  registerTitleId: (id: string | undefined) => void;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

const SURFACE_CLASS_TOKEN_RE =
  /^(?:(?:sm|md|lg|xl|2xl):)?(?:max-w-|min-w-|w-|p-0$|px-0$|py-0$)/;

function splitDialogContentClasses(className?: string): {
  surfaceClasses: string;
  contentClasses: string;
} {
  if (!className) {
    return { surfaceClasses: '', contentClasses: '' };
  }
  const surfaceTokens: string[] = [];
  const contentTokens: string[] = [];
  for (const token of className.trim().split(/\s+/)) {
    if (!token) continue;
    if (SURFACE_CLASS_TOKEN_RE.test(token)) {
      surfaceTokens.push(token);
    } else {
      contentTokens.push(token);
    }
  }
  return {
    surfaceClasses: surfaceTokens.join(' '),
    contentClasses: contentTokens.join(' '),
  };
}

const Dialog = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    uncloseable?: boolean;
  }
>(({ className, open, onOpenChange, children, uncloseable, ...props }, ref) => {
  const { enableScope, disableScope } = useHotkeysContext();
  const internalRef = React.useRef<HTMLDivElement | null>(null);
  const [titleId, setTitleId] = React.useState<string | undefined>(undefined);

  const setDialogRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      internalRef.current = node;
      if (typeof ref === 'function') {
        ref(node);
      } else if (ref) {
        (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }
    },
    [ref]
  );

  const contextValue = React.useMemo<DialogContextValue>(
    () => ({
      titleId,
      registerTitleId: setTitleId,
    }),
    [titleId]
  );

  // Manage dialog scope when open/closed
  React.useEffect(() => {
    if (open) {
      enableScope(Scope.DIALOG);
      disableScope(Scope.KANBAN);
      disableScope(Scope.PROJECTS);
    } else {
      disableScope(Scope.DIALOG);
      enableScope(Scope.KANBAN);
      enableScope(Scope.PROJECTS);
    }
    return () => {
      disableScope(Scope.DIALOG);
      enableScope(Scope.KANBAN);
      enableScope(Scope.PROJECTS);
    };
  }, [open, enableScope, disableScope]);

  // Dialog keyboard shortcuts using semantic hooks
  useKeyExit(
    (e) => {
      if (uncloseable) return;

      // Two-step Esc behavior:
      // 1. If input/textarea is focused, blur it first
      const activeElement = document.activeElement as HTMLElement;
      if (
        activeElement &&
        (activeElement.tagName === 'INPUT' ||
          activeElement.tagName === 'TEXTAREA' ||
          activeElement.isContentEditable)
      ) {
        activeElement.blur();
        e?.preventDefault();
        return;
      }

      // 2. Otherwise close the dialog
      onOpenChange?.(false);
    },
    {
      scope: Scope.DIALOG,
      when: () => !!open,
    }
  );

  useKeySubmit(
    (e) => {
      // Don't interfere if user is typing in textarea (allow new lines)
      const activeElement = document.activeElement as HTMLElement;
      if (
        activeElement?.tagName === 'TEXTAREA' ||
        activeElement?.isContentEditable
      ) {
        return;
      }

      const root = internalRef.current;
      if (!root) return;

      // 1. Explicit submit or primary dialog button
      const explicitSubmit = root.querySelector(
        'button[type="submit"]:not(:disabled), button[data-dialog-primary="true"]:not(:disabled)'
      ) as HTMLButtonElement | null;
      if (explicitSubmit) {
        e?.preventDefault();
        explicitSubmit.click();
        return;
      }

      // 2. Primary/destructive button inside DialogFooter (never toolbar/outline buttons in the body)
      const footerPrimary = root.querySelector(
        '[data-dialog-footer] button.primary-control:not(:disabled), [data-dialog-footer] button.destructive-control:not(:disabled)'
      ) as HTMLButtonElement | null;
      if (footerPrimary) {
        e?.preventDefault();
        footerPrimary.click();
      }
    },
    {
      scope: Scope.DIALOG,
      when: () => !!open,
    }
  );

  const childContentClasses = React.useMemo(() => {
    const collected: string[] = [];
    React.Children.forEach(children, (child) => {
      if (
        React.isValidElement<{ className?: string }>(child) &&
        (child.type === DialogContent ||
          (child.type as { displayName?: string })?.displayName ===
            'DialogContent')
      ) {
        const { surfaceClasses } = splitDialogContentClasses(
          child.props.className
        );
        if (surfaceClasses) {
          collected.push(surfaceClasses);
        }
      }
    });
    return collected.join(' ');
  }, [children]);

  if (!open) return null;

  return (
    <DialogContext.Provider value={contextValue}>
      <div
        data-floating-layer="modal"
        className="fixed inset-0 z-[9999] flex items-start justify-center p-4 overflow-y-auto"
      >
        <NativeSurfaceOcclusionHold />
        <div
          className="dialog-backdrop fixed inset-0"
          aria-hidden="true"
          onClick={() => (uncloseable ? {} : onOpenChange?.(false))}
        />
        <div
          ref={setDialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={props['aria-labelledby'] ?? titleId}
          className={twMerge(
            cn(
              'dialog-surface relative z-[9999] my-8 flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col gap-4 overflow-y-auto rounded-lg border p-5',
              childContentClasses,
              className
            )
          )}
          {...props}
        >
          {!uncloseable && (
            <button
              type="button"
              aria-label="Close"
              className="absolute right-4 top-4 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--surface-control-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              onClick={() => onOpenChange?.(false)}
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </button>
          )}
          {children}
        </div>
      </div>
    </DialogContext.Provider>
  );
});
Dialog.displayName = 'Dialog';

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col space-y-1.5 text-center sm:text-left',
      className
    )}
    {...props}
  />
);
DialogHeader.displayName = 'DialogHeader';

const DialogTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, id: idProp, ...props }, ref) => {
  const generatedId = React.useId();
  const dialogContext = React.useContext(DialogContext);
  const resolvedId = idProp ?? `dialog-title-${generatedId}`;

  React.useEffect(() => {
    if (!dialogContext) return;
    dialogContext.registerTitleId(resolvedId);
    return () => {
      dialogContext.registerTitleId(undefined);
    };
  }, [dialogContext, resolvedId]);

  return (
    <h3
      ref={ref}
      id={resolvedId}
      className={cn(
        'text-base font-semibold leading-6 tracking-normal',
        className
      )}
      {...props}
    />
  );
});
DialogTitle.displayName = 'DialogTitle';

const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = 'DialogDescription';

const DialogContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => {
  const dialogContext = React.useContext(DialogContext);
  const effectiveClassName = dialogContext
    ? splitDialogContentClasses(className).contentClasses
    : className;
  return (
    <div
      ref={ref}
      className={cn('flex flex-col gap-4', effectiveClassName)}
      {...props}
    />
  );
});
DialogContent.displayName = 'DialogContent';

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-dialog-footer="true"
    className={cn(
      'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end',
      className
    )}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
};
