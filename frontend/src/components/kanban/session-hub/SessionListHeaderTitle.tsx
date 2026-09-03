import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { sessionListTitleFits } from './sessionListTitleFits';

export function SessionListHeaderTitle({
  children,
  tooltip,
}: {
  children: ReactNode;
  tooltip?: ReactNode;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(true);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    const text = textRef.current;
    if (!slot || !text || typeof ResizeObserver !== 'function') {
      return;
    }

    const update = () => {
      setFits(sessionListTitleFits(slot.clientWidth, text.scrollWidth));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(slot);
    return () => observer.disconnect();
  }, [children]);

  const label = (
    <div
      ref={slotRef}
      data-session-list-title-slot=""
      className="flex h-7 min-w-0 flex-1 items-center overflow-hidden"
    >
      <div
        ref={textRef}
        data-session-list-title-text=""
        className={cn(
          'cursor-default whitespace-nowrap text-sm font-semibold leading-7 text-foreground',
          !fits && 'invisible'
        )}
      >
        {children}
      </div>
    </div>
  );

  if (!tooltip) {
    return label;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
