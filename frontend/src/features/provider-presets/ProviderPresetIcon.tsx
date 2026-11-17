import type { CSSProperties } from 'react';

import { cn } from '@/lib/utils';

import iconIndex from './icons.json';

type IconEntry = { file: string; ink?: boolean; backing?: boolean };

const ICONS: Record<string, IconEntry> = iconIndex;

function initials(name: string): string {
  return Array.from(
    name
      .trim()
      .split(/\s+/)
      .map((word) => Array.from(word)[0] ?? '')
      .join('')
  )
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function ProviderPresetIcon({
  icon,
  name,
  className,
}: {
  icon?: string | null;
  name: string;
  className?: string;
}) {
  const entry = icon ? ICONS[icon] : undefined;
  if (!entry) {
    return (
      <span
        aria-hidden="true"
        className={cn('provider-preset-icon is-initials', className)}
      >
        {initials(name)}
      </span>
    );
  }
  const url = `/provider-icons/${entry.file}`;
  if (entry.ink) {
    return (
      <span
        aria-hidden="true"
        className={cn('provider-preset-icon is-ink', className)}
        style={{ '--provider-preset-icon': `url("${url}")` } as CSSProperties}
      />
    );
  }
  return (
    <img
      alt=""
      aria-hidden="true"
      className={cn(
        'provider-preset-icon',
        entry.backing && 'has-backing',
        className
      )}
      decoding="async"
      draggable={false}
      loading="lazy"
      src={url}
    />
  );
}
