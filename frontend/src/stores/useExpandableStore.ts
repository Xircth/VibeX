import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

type State = {
  expanded: Record<string, boolean>;
  revision: number;
  setKey: (key: string, value: boolean) => void;
  setKeys: (keys: readonly string[], value: boolean) => void;
  toggleKey: (key: string, fallback?: boolean) => void;
  clear: () => void;
};

const useExpandableStore = create<State>((set) => ({
  expanded: {},
  revision: 0,
  setKey: (key, value) =>
    set((s) =>
      s.expanded[key] === value
        ? s
        : {
            expanded: { ...s.expanded, [key]: value },
            revision: s.revision + 1,
          }
    ),
  setKeys: (keys, value) =>
    set((s) =>
      keys.every((key) => s.expanded[key] === value)
        ? s
        : {
            expanded: {
              ...s.expanded,
              ...Object.fromEntries(keys.map((key) => [key, value])),
            },
            revision: s.revision + 1,
          }
    ),
  toggleKey: (key, fallback = false) =>
    set((s) => {
      const next = !(s.expanded[key] ?? fallback);
      return {
        expanded: { ...s.expanded, [key]: next },
        revision: s.revision + 1,
      };
    }),
  clear: () => set((s) => ({ expanded: {}, revision: s.revision + 1 })),
}));

export function useExpandable(
  key: string,
  defaultValue = false
): [boolean, (next?: boolean) => void] {
  const expandedValue = useExpandableStore((s) => s.expanded[key]);
  const setKey = useExpandableStore((s) => s.setKey);
  const toggleKey = useExpandableStore((s) => s.toggleKey);

  const set = (next?: boolean) => {
    if (typeof next === 'boolean') setKey(key, next);
    else toggleKey(key, defaultValue);
  };

  return [expandedValue ?? defaultValue, set];
}

/** Preserve opened content when a group gains, loses, or splits its members. */
export function useExpandableGroup(
  keys: readonly string[]
): [boolean, (next?: boolean) => void] {
  const expanded = useExpandableStore((s) =>
    keys.some((key) => s.expanded[key] === true)
  );
  const setKeys = useExpandableStore((s) => s.setKeys);
  return [expanded, (next) => setKeys(keys, next ?? !expanded)];
}

export function useExpandableRevision(): number {
  return useExpandableStore((s) => s.revision);
}

export function useExpandableItems(
  keys: readonly string[]
): [boolean[], (key: string, expanded: boolean) => void] {
  const expanded = useExpandableStore(
    useShallow((s) => keys.map((key) => s.expanded[key] ?? false))
  );
  const setKey = useExpandableStore((s) => s.setKey);
  return [expanded, setKey];
}

export function useExpandableSection<T extends string>(
  key: string,
  sections: readonly T[]
): [T | null, (section: T) => void] {
  const keys = sections.map((section) => `${key}:${section}`);
  const [expanded, setExpanded] = useExpandableItems(keys);
  const openSection = sections.find((_, index) => expanded[index]) ?? null;
  return [
    openSection,
    (section) => {
      sections.forEach((candidate, index) =>
        setExpanded(
          keys[index],
          candidate === section && openSection !== section
        )
      );
    },
  ];
}
