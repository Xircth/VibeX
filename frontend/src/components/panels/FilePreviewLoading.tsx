import { useRef } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { FileCode2 } from 'lucide-react';

gsap.registerPlugin(useGSAP);

const SKELETON_LINE_WIDTHS = ['72%', '48%', '64%', '38%', '58%', '44%'];

export function FilePreviewLoading({
  fileName,
  label,
}: {
  fileName?: string | null;
  label: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const media = gsap.matchMedia();

      media.add(
        {
          reduceMotion: '(prefers-reduced-motion: reduce)',
        },
        (context) => {
          const reduceMotion = context.conditions?.reduceMotion;
          if (reduceMotion) {
            gsap.set('[data-preview-loading-row]', { autoAlpha: 0.58 });
            gsap.set('[data-preview-loading-caret]', { autoAlpha: 0.7 });
            return;
          }

          gsap.fromTo(
            '[data-preview-loading-row]',
            { autoAlpha: 0.34 },
            {
              autoAlpha: 0.78,
              duration: 0.72,
              ease: 'power2.inOut',
              repeat: -1,
              stagger: { each: 0.08, from: 'start' },
              yoyo: true,
            }
          );
          gsap.fromTo(
            '[data-preview-loading-caret]',
            { autoAlpha: 0.3, xPercent: -110 },
            {
              autoAlpha: 0.85,
              duration: 1.1,
              ease: 'power3.inOut',
              repeat: -1,
              xPercent: 410,
            }
          );
        }
      );

      return () => media.revert();
    },
    { scope: containerRef }
  );

  return (
    <div
      ref={containerRef}
      className="h-full overflow-hidden bg-background px-6 py-8"
      role="status"
      aria-label={label}
    >
      <div className="mx-auto w-full max-w-3xl" aria-hidden="true">
        <div className="mb-6 flex items-center gap-2 text-xs text-muted-foreground">
          <FileCode2 className="h-4 w-4 text-primary/75" />
          <span className="min-w-0 truncate font-mono">
            {fileName ?? 'File preview'}
          </span>
        </div>

        <div className="relative overflow-hidden rounded-lg bg-muted/25 px-4 py-5">
          <span
            data-preview-loading-caret
            className="absolute left-0 top-0 h-px w-1/4 bg-primary/70"
          />
          <div className="space-y-3">
            {SKELETON_LINE_WIDTHS.map((width, index) => (
              <div key={width} className="flex items-center gap-3">
                <span className="w-5 shrink-0 text-right font-mono text-[10px] text-muted-foreground/45">
                  {index + 1}
                </span>
                <span
                  data-preview-loading-row
                  className="h-2 rounded-sm bg-muted-foreground/20"
                  style={{ width }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
