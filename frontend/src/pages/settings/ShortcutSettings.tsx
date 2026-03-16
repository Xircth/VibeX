/**
 * Shortcut Settings page.
 *
 * Displays all keyboard shortcuts organized by group.
 * Currently read-only — shows the registered bindings from registry.ts.
 */

import { useMemo } from 'react';
import { Keyboard } from 'lucide-react';
import {
  keyBindings,
  sequentialBindings,
  formatSequentialKeys,
} from '@/keyboard/registry';
import type { KeyBinding, SequentialBinding } from '@/keyboard/registry';

// ── Helpers ────────────────────────────────────────────────────

function formatKeys(keys: string | string[]): string {
  const keyList = Array.isArray(keys) ? keys : [keys];
  return keyList
    .map((k) =>
      k
        .replace(/meta/gi, 'Cmd')
        .replace(/ctrl/gi, 'Ctrl')
        .replace(/shift/gi, 'Shift')
        .replace(/alt/gi, 'Alt')
        .replace(/\+/g, ' + ')
        .replace(/^(.)/, (m) => m.toUpperCase())
    )
    .join(' / ');
}

interface GroupedBindings {
  group: string;
  items: Array<{
    description: string;
    keysLabel: string;
  }>;
}

function groupBindings(
  bindings: KeyBinding[],
  sequential: SequentialBinding[]
): GroupedBindings[] {
  const map = new Map<string, GroupedBindings['items']>();

  for (const binding of bindings) {
    const group = binding.group ?? 'Other';
    if (!map.has(group)) map.set(group, []);
    map.get(group)!.push({
      description: binding.description,
      keysLabel: formatKeys(binding.keys),
    });
  }

  for (const seq of sequential) {
    const group = seq.group ?? 'Sequential';
    if (!map.has(group)) map.set(group, []);
    map.get(group)!.push({
      description: seq.description,
      keysLabel: formatSequentialKeys(seq.keys),
    });
  }

  return Array.from(map.entries()).map(([group, items]) => ({ group, items }));
}

// ── Component ──────────────────────────────────────────────────

export function ShortcutSettings() {
  const groups = useMemo(
    () => groupBindings(keyBindings, sequentialBindings),
    []
  );

  return (
    <div className="max-w-2xl mx-auto py-6 px-4">
      <div className="mb-4">
        <h2 className="text-base font-semibold">快捷键</h2>
        <p className="text-xs text-muted-foreground mt-1">
          查看所有可用的键盘快捷键。
        </p>
      </div>

      <div className="space-y-3">
        {groups.map((group) => (
          <section
            key={group.group}
            className="rounded-xl border bg-card p-4 space-y-3"
          >
            <div className="flex items-center gap-2">
              <Keyboard className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">{group.group}</h3>
            </div>

            <div className="space-y-1">
              {group.items.map((item, idx) => (
                <div
                  key={`${group.group}-${idx}`}
                  className="rounded-lg border px-3 py-2 flex items-center justify-between gap-4 hover:bg-muted/30 transition-colors"
                >
                  <span className="text-xs text-foreground min-w-0 truncate">
                    {item.description}
                  </span>
                  <kbd className="shrink-0 rounded-md border bg-muted px-2 py-0.5 text-[11px] font-mono text-muted-foreground">
                    {item.keysLabel}
                  </kbd>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
