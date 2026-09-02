type MermaidTransform = (source: string) => string;

function pipe(...transforms: MermaidTransform[]): MermaidTransform {
  return (source) => transforms.reduce((current, transform) => transform(current), source);
}

import { hashString } from './utils';

function slugifyLabel(value: string): string {
  const slug = value
    .trim()
    .replace(/[^\w\u4e00-\u9fff-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || `sg_${hashString(value)}`;
}

const prepareSource = pipe(
  (value) => value.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, ''),
  (value) => value.trim()
);

const applyCompatibilityFixes = pipe(
  (value) => value.replace(/^(\s*)graph(\s+|$)/im, '$1flowchart$2'),
  (value) =>
    value.replace(/^(\s*subgraph\s+)(.+)$/gm, (line, prefix: string, titlePart: string) => {
      const trimmed = titlePart.trim();
      if (!trimmed || /^[\w-]+\s*\[/.test(trimmed) || /^"[^"]*"$/.test(trimmed)) {
        return line;
      }

      const id = slugifyLabel(trimmed);
      const escapedTitle = trimmed.replace(/"/g, '#quot;');
      return `${prefix}${id}["${escapedTitle}"]`;
    }),
  (value) =>
    value
      .replace(/<br\s*\/?>\s*-\s+/gi, '<br/>')
      .replace(/(\[[^\]]*?)<br\s*\/?>\s*-\s+/gi, '$1<br/>'),
  (value) =>
    value.replace(/(\b[\w-]+)\[([^\]"\n]+)\]/g, (match, nodeId: string, label: string) => {
      if (label.includes('"')) return match;
      if (!/[<,;:]/.test(label) && !label.includes('<br')) return match;
      const escaped = label.replace(/"/g, '#quot;');
      return `${nodeId}["${escaped}"]`;
    })
);

export function normalizeMermaidSource(value: string): string {
  return applyCompatibilityFixes(prepareSource(value));
}

export function buildMermaidRenderCandidates(value: string): string[] {
  const prepared = prepareSource(value);
  if (!prepared) return [''];

  const normalized = normalizeMermaidSource(prepared);
  return normalized === prepared ? [prepared] : [prepared, normalized];
}
