import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useTheme } from '@/components/ThemeProvider';
import { COLOR_THEME_CHANGED_EVENT } from '@/lib/theme/colorThemeStore';
import {
  ACCENT_COLOR_CHANGED_EVENT,
  followThemeAccent,
  getAccentColor,
  getAccentOverride,
  hexToHsv,
  hsvToHex,
  resolveAccentForTheme,
  setAccentColor,
  type Hsv,
} from '@/lib/uiAccent';
import { cn } from '@/lib/utils';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hsvFromClient(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  hue: number
): Hsv {
  return {
    h: hue,
    s: clamp((clientX - rect.left) / rect.width, 0, 1),
    v: clamp(1 - (clientY - rect.top) / rect.height, 0, 1),
  };
}

export function AccentColorField() {
  const { t } = useTranslation('settings');
  const { resolvedTheme } = useTheme();
  const hueLabelId = useId();
  const currentHex = useCallback(
    () => getAccentOverride() ?? getAccentColor(resolvedTheme),
    [resolvedTheme]
  );
  const [hexDraft, setHexDraft] = useState(currentHex);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(currentHex()));
  const [open, setOpen] = useState(false);
  const [followsTheme, setFollowsTheme] = useState(
    () => getAccentOverride() === null
  );

  const commit = useCallback(
    (hex: string) => {
      setAccentColor(hex);
      const next = currentHex();
      setHexDraft(next);
      setHsv(hexToHsv(next));
    },
    [currentHex]
  );

  const commitHsv = useCallback((next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    setHexDraft(hex);
    setAccentColor(hex);
  }, []);

  useEffect(() => {
    const sync = () => {
      setFollowsTheme(getAccentOverride() === null);
      if (open) return;
      setHexDraft(currentHex());
      setHsv(hexToHsv(currentHex()));
    };
    sync();
    window.addEventListener(ACCENT_COLOR_CHANGED_EVENT, sync);
    window.addEventListener(COLOR_THEME_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener(ACCENT_COLOR_CHANGED_EVENT, sync);
      window.removeEventListener(COLOR_THEME_CHANGED_EVENT, sync);
    };
  }, [open, currentHex]);

  const handleHexChange = (value: string) => {
    setHexDraft(value);
    const trimmed = value.trim();
    if (/^#?[0-9a-f]{6}$/i.test(trimmed)) {
      commit(trimmed);
    }
  };

  const handleHexBlur = () => {
    commit(hexDraft);
  };

  const draft = hsvToHex(hsv);
  const applied = resolveAccentForTheme(draft, resolvedTheme);

  return (
    <div className="flex items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="h-8 w-8 shrink-0 rounded-lg border border-[var(--border-strong)] shadow-none"
            style={{ backgroundColor: applied }}
            aria-label={t('appearance.accent.picker')}
            aria-haspopup="dialog"
            aria-expanded={open}
          />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56 space-y-3 p-3">
          <div
            className="relative h-32 w-full cursor-crosshair touch-none rounded-lg"
            style={{
              backgroundColor: `hsl(${hsv.h} 100% 50%)`,
              backgroundImage:
                'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)',
            }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              const rect = event.currentTarget.getBoundingClientRect();
              commitHsv(
                hsvFromClient(event.clientX, event.clientY, rect, hsv.h)
              );
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              commitHsv(
                hsvFromClient(event.clientX, event.clientY, rect, hsv.h)
              );
            }}
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
              style={{
                left: `${hsv.s * 100}%`,
                top: `${(1 - hsv.v) * 100}%`,
                boxShadow: '0 0 0 1px rgb(0 0 0 / 0.35)',
                backgroundColor: draft,
              }}
            />
          </div>
          <div className="space-y-1.5">
            <label className="sr-only" htmlFor={hueLabelId}>
              {t('appearance.accent.hue')}
            </label>
            <input
              id={hueLabelId}
              type="range"
              min={0}
              max={360}
              step={1}
              value={Math.round(hsv.h)}
              aria-label={t('appearance.accent.hue')}
              className={cn(
                'h-3 w-full cursor-pointer appearance-none rounded-full',
                '[&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5',
                '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full',
                '[&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white',
                '[&::-webkit-slider-thumb]:bg-white'
              )}
              style={{
                background:
                  'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
              }}
              onChange={(event) =>
                commitHsv({ ...hsv, h: Number(event.target.value) })
              }
            />
          </div>
        </PopoverContent>
      </Popover>
      <Input
        value={hexDraft}
        onChange={(event) => handleHexChange(event.target.value)}
        onBlur={handleHexBlur}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
        }}
        aria-label={t('appearance.accent.hex')}
        spellCheck={false}
        autoComplete="off"
        className="w-[7.25rem] font-mono uppercase"
      />
      {followsTheme ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={followThemeAccent}
        >
          {t('appearance.accent.followTheme')}
        </Button>
      )}
    </div>
  );
}
