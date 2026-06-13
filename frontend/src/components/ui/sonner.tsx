import { Toaster as Sonner } from 'sonner';

type ToasterProps = React.ComponentProps<typeof Sonner>;

function Toaster({ ...props }: ToasterProps) {
  return (
    <Sonner
      className="toaster group vu-sonner-toaster"
      position="bottom-right"
      closeButton
      expand={false}
      visibleToasts={5}
      offset={18}
      toastOptions={{
        classNames: {
          toast: 'vu-sonner-toast group toast',
          content: 'group-[.toast]:min-w-0 group-[.toast]:gap-1',
          title:
            'group-[.toast]:text-[13px] group-[.toast]:font-semibold group-[.toast]:leading-5 group-[.toast]:tracking-normal group-[.toast]:text-foreground',
          description:
            'group-[.toast]:text-xs group-[.toast]:leading-5 group-[.toast]:text-muted-foreground',
          actionButton:
            'group-[.toast]:h-7 group-[.toast]:rounded-full group-[.toast]:bg-foreground/90 group-[.toast]:px-3 group-[.toast]:text-xs group-[.toast]:font-medium group-[.toast]:text-background group-[.toast]:transition-colors group-[.toast]:hover:bg-foreground',
          cancelButton:
            'group-[.toast]:h-7 group-[.toast]:rounded-full group-[.toast]:bg-foreground/[0.08] group-[.toast]:px-3 group-[.toast]:text-xs group-[.toast]:font-medium group-[.toast]:text-foreground group-[.toast]:transition-colors group-[.toast]:hover:bg-foreground/[0.12]',
          closeButton:
            'group-[.toast]:border-border group-[.toast]:bg-[var(--surface-control)] group-[.toast]:text-muted-foreground group-[.toast]:shadow-none group-[.toast]:transition-colors group-[.toast]:hover:bg-[var(--surface-control-hover)] group-[.toast]:hover:text-foreground',
          success: 'vu-sonner-toast-success',
          info: 'vu-sonner-toast-info',
          warning: 'vu-sonner-toast-warning',
          error: 'vu-sonner-toast-error',
          loading: 'vu-sonner-toast-loading',
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
