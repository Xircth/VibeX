import { useEffect, useState } from 'react';
import { getMermaidTheme, type MermaidTheme } from '@/lib/mermaid/mermaidRuntime';

export function useMermaidTheme(): MermaidTheme {
  const [theme, setTheme] = useState(getMermaidTheme);

  useEffect(() => {
    if (
      typeof document === 'undefined' ||
      typeof MutationObserver === 'undefined'
    ) {
      return undefined;
    }

    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setTheme(getMermaidTheme());
    });

    observer.observe(root, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  return theme;
}
