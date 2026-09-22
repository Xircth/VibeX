import { useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP);

export function BrowserLoadingBar({ label }: { label: string }) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useGSAP(
    () => {
      const dots = rootRef.current?.querySelectorAll<HTMLElement>(
        '[data-browser-loading-dot]'
      );
      if (!dots?.length) return;
      const reduce = window.matchMedia(
        '(prefers-reduced-motion: reduce)'
      ).matches;
      if (reduce) {
        gsap.set(dots, { opacity: 0.65, y: 0 });
        return;
      }
      gsap.to(dots, {
        y: -3,
        opacity: 1,
        duration: 0.32,
        ease: 'power1.inOut',
        stagger: { each: 0.11, repeat: -1, yoyo: true },
      });
    },
    { scope: rootRef }
  );

  return (
    <div
      ref={rootRef}
      className="flex flex-col items-center gap-2 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <span className="flex items-end gap-0.5" aria-hidden="true">
        <span
          data-browser-loading-dot
          className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground will-change-transform"
        />
        <span
          data-browser-loading-dot
          className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground will-change-transform"
        />
        <span
          data-browser-loading-dot
          className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground will-change-transform"
        />
      </span>
      {label}
    </div>
  );
}
