import DOMPurify, { type Config } from 'dompurify';

const MERMAID_SVG_SANITIZE: Config = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true },
  ADD_TAGS: ['foreignobject', 'use'],
  HTML_INTEGRATION_POINTS: { foreignobject: true },
  FORBID_TAGS: [
    'script',
    'iframe',
    'object',
    'embed',
    'form',
    'input',
    'button',
    'textarea',
    'link',
    'meta',
    'a',
  ],
  FORBID_ATTR: [
    'onclick',
    'onload',
    'onerror',
    'onmouseover',
    'onfocus',
    'onblur',
  ],
};

export function sanitizeMermaidSvg(svg: string): string {
  const sanitized = DOMPurify.sanitize(svg, MERMAID_SVG_SANITIZE);
  return /<svg[\s>]/i.test(sanitized) ? sanitized : '';
}
