import { create } from 'zustand';

type State = {
  expanded: Record<string, boolean>;
  revision: number;
  setKey: (key: string, value: boolean) => void;
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

export function useExpandableRevision(): number {
  return useExpandableStore((s) => s.revision);
}
