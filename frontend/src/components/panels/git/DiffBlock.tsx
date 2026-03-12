import { memo, useMemo } from 'react';

export type DiffStyle = 'split' | 'unified';

interface DiffBlockProps {
  diff: string;
  diffStyle?: DiffStyle;
  showLineNumbers?: boolean;
}

interface ParsedLine {
  type: 'add' | 'del' | 'ctx' | 'hunk';
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

function parseDiff(raw: string): ParsedLine[] {
  const lines = raw.split('\n');
  const result: ParsedLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    // Skip diff header lines
    if (
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('similarity') ||
      line.startsWith('rename') ||
      line.startsWith('Binary')
    ) {
      continue;
    }

    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
        result.push({ type: 'hunk', content: line, oldLine: null, newLine: null });
      }
      continue;
    }

    if (line.startsWith('+')) {
      result.push({ type: 'add', content: line.slice(1), oldLine: null, newLine });
      newLine++;
    } else if (line.startsWith('-')) {
      result.push({ type: 'del', content: line.slice(1), oldLine, newLine: null });
      oldLine++;
    } else if (line.startsWith(' ') || line === '') {
      result.push({ type: 'ctx', content: line.startsWith(' ') ? line.slice(1) : line, oldLine, newLine });
      oldLine++;
      newLine++;
    }
  }

  return result;
}

const LINE_COLORS: Record<string, string> = {
  add: 'bg-green-500/10',
  del: 'bg-red-500/10',
  ctx: '',
  hunk: 'bg-accent/30',
};

const LINE_TEXT_COLORS: Record<string, string> = {
  add: 'text-green-400',
  del: 'text-red-400',
  ctx: 'text-foreground',
  hunk: 'text-muted-foreground italic',
};

const GUTTER_COLORS: Record<string, string> = {
  add: 'text-green-500/50',
  del: 'text-red-500/50',
  ctx: 'text-muted-foreground/40',
  hunk: '',
};

function UnifiedView({ lines, showLineNumbers }: { lines: ParsedLine[]; showLineNumbers: boolean }) {
  return (
    <div className="font-mono text-xs leading-[1.6]">
      {lines.map((line, i) => (
        <div key={i} className={`flex ${LINE_COLORS[line.type]}`}>
          {showLineNumbers && (
            <span className={`shrink-0 w-8 text-right pr-1 select-none ${GUTTER_COLORS[line.type]}`}>
              {line.oldLine ?? ''}
            </span>
          )}
          {showLineNumbers && (
            <span className={`shrink-0 w-8 text-right pr-2 select-none ${GUTTER_COLORS[line.type]}`}>
              {line.newLine ?? ''}
            </span>
          )}
          <span className={`flex-1 min-w-0 whitespace-pre-wrap break-all px-1 ${LINE_TEXT_COLORS[line.type]}`}>
            {line.type === 'hunk' ? line.content : line.content || '\u00A0'}
          </span>
        </div>
      ))}
    </div>
  );
}

function SplitView({ lines, showLineNumbers }: { lines: ParsedLine[]; showLineNumbers: boolean }) {
  // Build paired rows for split view
  const pairs = useMemo(() => {
    const result: { left: ParsedLine | null; right: ParsedLine | null }[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.type === 'hunk') {
        result.push({ left: line, right: line });
        i++;
      } else if (line.type === 'ctx') {
        result.push({ left: line, right: line });
        i++;
      } else if (line.type === 'del') {
        // Collect consecutive del lines, then pair with add lines
        const dels: ParsedLine[] = [];
        while (i < lines.length && lines[i].type === 'del') {
          dels.push(lines[i]);
          i++;
        }
        const adds: ParsedLine[] = [];
        while (i < lines.length && lines[i].type === 'add') {
          adds.push(lines[i]);
          i++;
        }
        const max = Math.max(dels.length, adds.length);
        for (let j = 0; j < max; j++) {
          result.push({ left: dels[j] ?? null, right: adds[j] ?? null });
        }
      } else if (line.type === 'add') {
        result.push({ left: null, right: line });
        i++;
      } else {
        i++;
      }
    }
    return result;
  }, [lines]);

  const renderSide = (line: ParsedLine | null, side: 'left' | 'right') => {
    if (!line) {
      return (
        <div className="flex flex-1 min-w-0 bg-muted/20">
          {showLineNumbers && <span className="shrink-0 w-8 text-right pr-2 select-none" />}
          <span className="flex-1 px-1">&nbsp;</span>
        </div>
      );
    }
    const type = line.type === 'hunk' ? 'hunk' : line.type;
    return (
      <div className={`flex flex-1 min-w-0 ${LINE_COLORS[type]}`}>
        {showLineNumbers && (
          <span className={`shrink-0 w-8 text-right pr-2 select-none ${GUTTER_COLORS[type]}`}>
            {side === 'left' ? (line.oldLine ?? '') : (line.newLine ?? '')}
          </span>
        )}
        <span className={`flex-1 min-w-0 whitespace-pre-wrap break-all px-1 ${LINE_TEXT_COLORS[type]}`}>
          {line.type === 'hunk' ? line.content : (line.content || '\u00A0')}
        </span>
      </div>
    );
  };

  return (
    <div className="font-mono text-xs leading-[1.6]">
      {pairs.map((pair, i) => (
        <div key={i} className="flex">
          {renderSide(pair.left, 'left')}
          <div className="w-px bg-border/30 shrink-0" />
          {renderSide(pair.right, 'right')}
        </div>
      ))}
    </div>
  );
}

export const DiffBlock = memo(function DiffBlock({
  diff,
  diffStyle = 'unified',
  showLineNumbers = true,
}: DiffBlockProps) {
  const lines = useMemo(() => parseDiff(diff), [diff]);

  if (lines.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic px-3 py-2">
        No diff content
      </div>
    );
  }

  return (
    <div className="overflow-x-auto text-[11px]">
      {diffStyle === 'unified' ? (
        <UnifiedView lines={lines} showLineNumbers={showLineNumbers} />
      ) : (
        <SplitView lines={lines} showLineNumbers={showLineNumbers} />
      )}
    </div>
  );
});
