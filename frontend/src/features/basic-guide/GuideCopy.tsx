import type { ReactNode } from 'react';

const ACTION_VERBS = [
  '点击',
  '打开',
  '点选',
  '选择',
  '创建',
  '发送',
  '启用',
  '进入',
] as const;

const ACTION_PATTERN = new RegExp(`(${ACTION_VERBS.join('|')})`, 'g');

function isActionPhrase(text: string): boolean {
  const value = text.trim();
  return ACTION_VERBS.some((verb) => value === verb || value.startsWith(verb));
}

function wrapActions(
  text: string,
  prefix: string,
  nextKey: () => string
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  ACTION_PATTERN.lastIndex = 0;
  while ((match = ACTION_PATTERN.exec(text))) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    nodes.push(
      <strong key={`${prefix}-${nextKey()}`} className="basic-guide-action">
        {match[1]}
      </strong>
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function GuideCopy({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const nodes: ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let serial = 0;
  const nextKey = () => {
    serial += 1;
    return String(serial);
  };
  while ((match = pattern.exec(text))) {
    if (match.index > last) {
      nodes.push(
        ...wrapActions(text.slice(last, match.index), 'plain', nextKey)
      );
    }
    const marked = match[1] ?? '';
    nodes.push(
      <strong
        key={`mark-${nextKey()}`}
        className={isActionPhrase(marked) ? 'basic-guide-action' : undefined}
      >
        {marked}
      </strong>
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    nodes.push(...wrapActions(text.slice(last), 'tail', nextKey));
  }
  return <p className={className}>{nodes}</p>;
}
