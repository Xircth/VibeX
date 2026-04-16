import { Toaster as Sonner } from 'sonner';

type ToasterProps = React.ComponentProps<typeof Sonner>;

function Toaster({ ...props }: ToasterProps) {
  return (
    <Sonner
      className="toaster group"
      position="bottom-right"
      closeButton
      expand={false}
      visibleToasts={4}
      offset={20}
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-background/98 group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-2xl group-[.toaster]:rounded-2xl group-[.toaster]:backdrop-blur-md group-[.toaster]:min-h-[92px] group-[.toaster]:w-[320px]',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton:
            'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton:
            'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
          closeButton:
            'group-[.toast]:border-border group-[.toast]:bg-background/80 group-[.toast]:text-muted-foreground group-[.toast]:hover:text-foreground',
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
