const SKIP_TAGS = new Set([
  'button',
  'svg',
  'script',
  'style',
  'textarea',
  'input',
  'select',
]);

function isElement(node: Node): node is HTMLElement {
  return node.nodeType === Node.ELEMENT_NODE;
}

function shouldSkip(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (el.classList.contains('conv-md-codeblock-header')) return true;
  if (el.classList.contains('conv-md-codeblock-copy')) return true;
  return false;
}

function languageFromClass(className: string | null | undefined): string {
  const match = className?.match(/language-([\w-]+)/i);
  return match?.[1] ?? '';
}

function codeLanguage(el: HTMLElement): string {
  return (
    el.getAttribute('data-language')?.trim() ||
    el
      .querySelector('.conv-md-codeblock-language')
      ?.textContent?.trim()
      .replace(/^text$/i, '') ||
    languageFromClass(el.querySelector('code')?.className) ||
    languageFromClass(el.className) ||
    ''
  );
}

function codeBody(el: HTMLElement): string {
  const lines = el.querySelectorAll('.conv-md-codeblock-line');
  if (lines.length > 0) {
    return Array.from(lines)
      .map((line) => line.textContent ?? '')
      .join('\n');
  }
  const code = el.querySelector('code');
  return (code?.textContent ?? el.textContent ?? '').replace(/\u00a0/g, ' ');
}

function serializeFence(el: HTMLElement): string {
  const lang = codeLanguage(el);
  const body = codeBody(el).replace(/\n+$/u, '');
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

function enclosingCodeBlock(range: Range): HTMLElement | null {
  const start =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const block = start?.closest<HTMLElement>(
    '.conv-md-codeblock, pre, .user-message-code-block'
  );
  if (!block) return null;
  const end =
    range.endContainer instanceof Element
      ? range.endContainer
      : range.endContainer.parentElement;
  if (!end || !block.contains(end)) return null;
  return block;
}

function isListItem(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  return (
    tag === 'li' ||
    el.getAttribute('role') === 'listitem' ||
    el.classList.contains('astryx-list-item')
  );
}

function isOrderedList(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.tagName.toLowerCase() === 'ol') return true;
  return el.getAttribute('data-list-style') === 'decimal';
}

function listItemChildren(el: HTMLElement): Node[] {
  const children = Array.from(el.childNodes);
  const first = children[0];
  if (!first || !isElement(first) || first.tagName.toLowerCase() !== 'span') {
    return children;
  }
  const text = first.textContent?.trim() ?? '';
  const marker =
    first.getAttribute('aria-hidden') === 'true' ||
    text === '' ||
    /^\d+\.?$/.test(text) ||
    /^[•·\-*]$/.test(text);
  return marker ? children.slice(1) : children;
}

function serializeChildren(nodes: Iterable<Node>): string {
  let result = '';
  for (const child of nodes) {
    result += serializeNode(child);
  }
  return result;
}

function wrapInline(inner: string, marker: string): string {
  if (!inner) return '';
  return `${marker}${inner}${marker}`;
}

function serializeInlineCode(el: HTMLElement): string {
  const text = (el.textContent ?? '').replace(/\u00a0/g, ' ');
  if (!text) return '';
  const ticks = text.includes('``') ? '```' : text.includes('`') ? '``' : '`';
  return `${ticks}${text}${ticks}`;
}

function serializeTable(el: HTMLElement): string {
  const rows = Array.from(el.querySelectorAll('tr'));
  if (rows.length === 0) return serializeChildren(el.childNodes);
  const lines = rows.map((row) => {
    const cells = Array.from(row.querySelectorAll('th, td')).map((cell) =>
      serializeChildren(cell.childNodes).replace(/\|/g, '\\|').trim()
    );
    return `| ${cells.join(' | ')} |`;
  });
  const columns = rows[0].querySelectorAll('th, td').length;
  lines.splice(1, 0, `| ${Array(columns).fill('---').join(' | ')} |`);
  return `\n${lines.join('\n')}\n`;
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    return serializeChildren(node.childNodes);
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? '').replace(/\u00a0/g, ' ');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  if (shouldSkip(el)) return '';

  const tag = el.tagName.toLowerCase();
  if (
    el.classList.contains('conv-md-codeblock') ||
    el.classList.contains('user-message-code-block') ||
    tag === 'pre'
  ) {
    return `\n${serializeFence(el)}\n`;
  }
  if (el.classList.contains('conv-md-codeblock-line')) {
    return `${(el.textContent ?? '').replace(/\u00a0/g, ' ')}\n`;
  }
  if (tag === 'br') return '\n';
  if (tag === 'hr') return '\n---\n';
  if (tag === 'img') {
    const alt = el.getAttribute('alt') ?? '';
    const src = el.getAttribute('src') ?? '';
    return src ? `![${alt}](${src})` : alt;
  }
  if (tag === 'code' && el.closest('pre') == null) {
    return serializeInlineCode(el);
  }
  if (tag === 'a') {
    const href = el.getAttribute('href') ?? '';
    const inner = serializeChildren(el.childNodes).trim();
    if (!inner) return '';
    if (!href || href === '#') return inner;
    return `[${inner}](${href})`;
  }
  if (tag === 'strong' || tag === 'b') {
    return wrapInline(serializeChildren(el.childNodes), '**');
  }
  if (tag === 'em' || tag === 'i') {
    return wrapInline(serializeChildren(el.childNodes), '*');
  }
  if (tag === 'del' || tag === 's') {
    return wrapInline(serializeChildren(el.childNodes), '~~');
  }
  if (tag === 'u') {
    return wrapInline(serializeChildren(el.childNodes), '__');
  }
  if (tag === 'blockquote') {
    const inner = serializeChildren(el.childNodes).trim();
    if (!inner) return '';
    return `\n${inner
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}\n`;
  }
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    const inner = serializeChildren(el.childNodes).trim();
    if (!inner) return '';
    return `\n${'#'.repeat(level)} ${inner}\n`;
  }
  if (tag === 'table') {
    return serializeTable(el);
  }
  if (tag === 'ul' || tag === 'ol' || el.getAttribute('role') === 'list') {
    const inner = serializeChildren(el.childNodes).trim();
    return inner ? `\n${inner}\n\n` : '';
  }
  if (isListItem(el)) {
    const parent = el.parentElement;
    const ordered = isOrderedList(parent);
    const index = parent
      ? Array.from(parent.children)
          .filter((child) => child instanceof HTMLElement && isListItem(child))
          .indexOf(el) + 1
      : 1;
    const marker = ordered ? `${Math.max(index, 1)}. ` : '- ';
    const inner = serializeChildren(listItemChildren(el)).trim();
    return `${marker}${inner}\n`;
  }

  const inner = serializeChildren(el.childNodes);
  if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'li') {
    const trimmed = inner.replace(/\n+$/u, '');
    return trimmed ? `${trimmed}\n\n` : '';
  }
  return inner;
}

function cleanupMarkdown(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function markdownFromRange(range: Range): string {
  const codeBlock = enclosingCodeBlock(range);
  if (codeBlock) {
    const fragment = range.cloneContents();
    const lines = fragment.querySelectorAll('.conv-md-codeblock-line');
    const body =
      lines.length > 0
        ? Array.from(lines)
            .map((line) => line.textContent ?? '')
            .join('\n')
        : (fragment.textContent ?? '').replace(/\u00a0/g, ' ');
    const lang = codeLanguage(codeBlock);
    return cleanupMarkdown(
      `\`\`\`${lang}\n${body.replace(/\n+$/u, '')}\n\`\`\``
    );
  }

  const markdown = cleanupMarkdown(serializeNode(range.cloneContents()));
  if (markdown) return markdown;
  return cleanupMarkdown(range.toString());
}
