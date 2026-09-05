/**
 * Raw-HTML support for the Astryx markdown renderer.
 *
 * Astryx's markdown parser has no HTML tokens, so inline/block HTML would be
 * rendered as literal text. We instead protect well-formed, allowlisted HTML
 * into private-use placeholders before parsing; the renderer later expands
 * each placeholder through DOMPurify into real elements (see
 * `RawHtmlElement`). Anything not in the allowlist — including conversation
 * pseudo-tags such as `<system-reminder>` and `<script>` — is left as literal
 * text, exactly as before.
 *
 * Code (fenced blocks and inline spans) is masked before scanning so HTML
 * shown as code examples is never captured.
 */

/** Placeholder matched by inline plugins after parsing. */
export const HTML_PLACEHOLDER_PATTERN = /HTML(\d+)/g;

export type ProtectedHtmlEntry = { html: string; block: boolean };

export const RAW_HTML_ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'article',
  'aside',
  'b',
  'bdi',
  'bdo',
  'blockquote',
  'br',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'details',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'main',
  'mark',
  'nav',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'samp',
  'section',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'u',
  'ul',
  'var',
  'wbr',
]);

const VOID_TAGS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

export function isBlockHtmlTag(tag: string): boolean {
  return BLOCK_TAGS.has(tag.toLowerCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CODE_PLACEHOLDER_PATTERN = /CODE(\d+)/g;

/** Replace fenced code blocks and inline code spans with opaque placeholders. */
function maskCode(value: string): { text: string; code: string[] } {
  const code: string[] = [];
  const out: string[] = [];
  let lineStart = true;
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let fenceStart = 0;

  const pushCodePlaceholder = (raw: string) => {
    const index = code.length;
    code.push(raw);
    out.push(`CODE${index}`);
  };

  let index = 0;
  while (index < value.length) {
    const char = value[index];

    if (!inFence) {
      if (lineStart) {
        // Fence opening: up to three leading spaces, then ``` or ~~~.
        const fenceMatch = value
          .slice(index)
          .match(/^ {0,3}(`{3,}|~{3,})/);
        if (fenceMatch) {
          inFence = true;
          fenceChar = fenceMatch[1][0];
          fenceLen = fenceMatch[1].length;
          fenceStart = index;
          // Consume the whole opening line.
          const newline = value.indexOf('\n', index);
          index = newline === -1 ? value.length : newline + 1;
          lineStart = false;
          continue;
        }
      }

      if (char === '`') {
        let run = 1;
        while (value[index + run] === '`') run += 1;
        const tickRun = '`'.repeat(run);
        const closing = value.indexOf(tickRun, index + run);
        if (closing >= 0) {
          const end = closing + run;
          pushCodePlaceholder(value.slice(index, end));
          index = end;
          lineStart = false;
          continue;
        }
      }

      out.push(char);
      lineStart = char === '\n';
      index += 1;
      continue;
    }

    // Inside a fenced block: find a closing fence line.
    if (lineStart) {
      const closeMatch = value.slice(index).match(/^ {0,3}(`{3,}|~{3,})/);
      if (
        closeMatch &&
        closeMatch[1][0] === fenceChar &&
        closeMatch[1].length >= fenceLen
      ) {
        const closingEnd = value.indexOf('\n', index);
        const blockEnd = closingEnd === -1 ? value.length : closingEnd;
        pushCodePlaceholder(value.slice(fenceStart, blockEnd));
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
        index = blockEnd;
        lineStart = false;
        continue;
      }
    }

    const newline = value.indexOf('\n', index);
    index = newline === -1 ? value.length : newline + 1;
    if (index >= value.length) break;
    lineStart = value[index - 1] === '\n';
  }

  // Unclosed fence at EOF: keep it masked as code.
  if (inFence) {
    pushCodePlaceholder(value.slice(fenceStart));
  }

  return { text: out.join(''), code };
}

function restoreCode(value: string, code: string[]): string {
  return value.replace(CODE_PLACEHOLDER_PATTERN, (_match, index: string) => {
    return code[Number(index)] ?? '';
  });
}

type ParsedTag = {
  name: string;
  end: number;
  closing: boolean;
  selfClosing: boolean;
};

/** Parse a well-formed HTML tag starting at `start`. Returns null if not a tag. */
function parseTagAt(
  text: string,
  start: number,
  allowedTags: ReadonlySet<string>,
  voidTags: ReadonlySet<string>
): ParsedTag | null {
  let pos = start + 1; // skip '<'
  const closing = text[pos] === '/';
  if (closing) pos += 1;

  const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(text.slice(pos));
  if (!nameMatch) return null;
  const name = nameMatch[0].toLowerCase();
  if (!allowedTags.has(name)) return null;
  pos += nameMatch[0].length;

  if (closing) {
    // Optional whitespace then '>'.
    while (pos < text.length && /\s/.test(text[pos])) pos += 1;
    if (text[pos] !== '>') return null;
    return { name, end: pos + 1, closing, selfClosing: false };
  }

  const isVoid = voidTags.has(name);

  // After the tag name the next char must be whitespace, '>', or '/>' — this
  // excludes autolinks like `<https://…>` and `<a@b>` where a punctuation
  // char immediately follows the name.
  const next = text[pos];
  if (next === '>') {
    return { name, end: pos + 1, closing: false, selfClosing: isVoid };
  }
  if (next === '/' && text[pos + 1] === '>') {
    return { name, end: pos + 2, closing: false, selfClosing: true };
  }
  if (next === undefined || !/\s/.test(next)) {
    return null;
  }

  // Attribute-aware scan (whitespace between attributes is significant).
  while (pos < text.length) {
    while (pos < text.length && /\s/.test(text[pos])) pos += 1;
    const char = text[pos];
    if (char === '>') {
      return { name, end: pos + 1, closing: false, selfClosing: isVoid };
    }
    if (char === '/') {
      if (text[pos + 1] === '>') {
        return { name, end: pos + 2, closing: false, selfClosing: true };
      }
      return null;
    }
    if (char === undefined || !/[a-zA-Z_:]/.test(char)) {
      return null;
    }

    // Attribute name.
    while (pos < text.length && !/[\s=/>]/.test(text[pos])) pos += 1;
    // Optional = "value".
    if (text[pos] === '=') {
      pos += 1;
      while (pos < text.length && /\s/.test(text[pos])) pos += 1;
      const quote = text[pos];
      if (quote === '"' || quote === "'") {
        const closingQuote = text.indexOf(quote, pos + 1);
        if (closingQuote === -1) return null;
        pos = closingQuote + 1;
      } else {
        while (pos < text.length && !/[\s>]/.test(text[pos])) pos += 1;
      }
    }
  }

  return null;
}

/** Index of the first blank line at or after `from`, or text.length. */
function blankLineBound(text: string, from: number): number {
  const match = /\n[ \t]*(?:\n|$)/.exec(text.slice(from));
  return match ? from + match.index : text.length;
}

/** Find a balanced `</name>` for an open tag, bounded to the same paragraph. */
function findBalancedClose(
  text: string,
  name: string,
  from: number,
  bound: number
): number | null {
  const pattern = new RegExp(
    `<\\/\\s*${escapeRegExp(name)}(?=[\\s/>])|<${escapeRegExp(name)}(?=[\\s/>])`,
    'gi'
  );
  pattern.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index >= bound) break;
    const isClosing = match[0][1] === '/';
    depth += isClosing ? -1 : 1;
    if (depth === 0) {
      const closeEnd = text.indexOf('>', match.index);
      return closeEnd === -1 ? null : closeEnd + 1;
    }
  }
  return null;
}

function capturePlaceholder(html: ProtectedHtmlEntry[], htmlString: string): string {
  const index = html.length;
  html.push({ html: htmlString, block: isBlockHtmlTag(firstTagName(htmlString)) });
  return `HTML${index}`;
}

function firstTagName(value: string): string {
  const match = /<\/?[a-zA-Z][a-zA-Z0-9-]*/.exec(value);
  return match ? match[0].replace(/^<\/?/, '') : '';
}

export type ProtectRawHtmlOptions = {
  allowedTags?: ReadonlySet<string>;
};

/**
 * Protect allowlisted raw HTML into placeholders. Fenced/inline code is left
 * untouched, and non-allowlisted or malformed constructs (autolinks,
 * pseudo-tags, `<script>`) remain literal.
 */
export function protectRawHtml(
  value: string,
  options: ProtectRawHtmlOptions = {}
): { text: string; html: ProtectedHtmlEntry[] } {
  const allowedTags = options.allowedTags ?? RAW_HTML_ALLOWED_TAGS;
  const masked = maskCode(value);
  const html: ProtectedHtmlEntry[] = [];
  const text = masked.text;
  let result = '';
  let index = 0;

  while (index < text.length) {
    if (text[index] !== '<') {
      result += text[index];
      index += 1;
      continue;
    }

    // HTML comment.
    if (text.startsWith('<!--', index)) {
      const end = text.indexOf('-->', index + 4);
      if (end >= 0) {
        const segment = text.slice(index, end + 3);
        result += capturePlaceholder(html, segment);
        index = end + 3;
        continue;
      }
      result += '<';
      index += 1;
      continue;
    }

    const tag = parseTagAt(text, index, allowedTags, VOID_TAGS);
    if (!tag) {
      result += '<';
      index += 1;
      continue;
    }

    if (tag.closing || tag.selfClosing || VOID_TAGS.has(tag.name)) {
      const segment = text.slice(index, tag.end);
      result += capturePlaceholder(html, segment);
      index = tag.end;
      continue;
    }

    // Non-void open tag: prefer a balanced close within the same paragraph.
    const bound = blankLineBound(text, tag.end);
    const closeEnd = findBalancedClose(text, tag.name, tag.end, bound);
    const end = closeEnd ?? tag.end;
    const segment = text.slice(index, end);
    result += capturePlaceholder(html, segment);
    index = end;
  }

  // Code placeholders can appear inside captured HTML (e.g. a fenced block
  // inside a wrapper div); restore them everywhere before returning.
  return {
    text: restoreCode(result, masked.code),
    html: html.map((entry) => ({
      ...entry,
      html: restoreCode(entry.html, masked.code),
    })),
  };
}
