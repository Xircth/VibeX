import { buildMermaidRenderCandidates } from './normalizeMermaidSource';

export type MermaidTheme = 'default' | 'dark';

const MERMAID_FONT_FAMILY =
  'Noto Sans SC Variable, Source Han Sans SC, Source Han Sans CN, Noto Sans CJK SC, Noto Sans SC, 思源黑体, sans-serif';

let lastMermaidTheme: MermaidTheme | null = null;

export function getMermaidTheme(): MermaidTheme {
  if (typeof document === 'undefined') {
    return 'default';
  }

  return document.documentElement.classList.contains('dark') ? 'dark' : 'default';
}

async function loadMermaid(theme: MermaidTheme) {
  const { default: mermaid } = await import('mermaid');
  if (lastMermaidTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
      fontFamily: MERMAID_FONT_FAMILY,
      maxTextSize: 100_000,
      flowchart: {
        htmlLabels: true,
        useMaxWidth: true,
      },
      sequence: {
        useMaxWidth: true,
      },
      er: {
        useMaxWidth: true,
      },
      gantt: {
        useMaxWidth: true,
      },
      journey: {
        useMaxWidth: true,
      },
    });
    lastMermaidTheme = theme;
  }
  return mermaid;
}

export async function renderMermaidDiagram(
  diagramId: string,
  source: string,
  theme: MermaidTheme
): Promise<{ svg: string; source: string }> {
  const mermaid = await loadMermaid(theme);
  const candidates = buildMermaidRenderCandidates(source);
  let lastError: unknown;

  for (const [index, candidate] of candidates.entries()) {
    try {
      const renderId =
        index === 0 ? diagramId : `${diagramId}-fallback-${index}`;
      const { svg } = await mermaid.render(renderId, candidate);
      return { svg, source: candidate };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Mermaid render failed');
}
