import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import FileIcon from '@/components/FileIcon';

export function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function looksLikeFilePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/')) return true;
  if (trimmed.includes('/') || trimmed.includes('\\')) return true;
  return /\.[a-zA-Z0-9]{1,12}$/.test(trimmed);
}

type ToolCallTargetProps = {
  text: string;
  path?: string | null;
  isFolder?: boolean;
  suffix?: ReactNode;
  onClick?: () => void;
};

function stopRowToggle(event: MouseEvent<HTMLButtonElement>) {
  event.stopPropagation();
}

function stopRowKey(event: KeyboardEvent<HTMLButtonElement>) {
  event.stopPropagation();
}

export function ToolCallTarget({
  text,
  path,
  isFolder = false,
  suffix,
  onClick,
}: ToolCallTargetProps) {
  const isPath = Boolean(path) || looksLikeFilePath(text);
  const resolvedPath = path || (isPath ? text : null);
  const label = resolvedPath ? fileNameFromPath(resolvedPath) : text;
  const title = resolvedPath || text;
  const labelRef = useRef<HTMLButtonElement | HTMLSpanElement | null>(null);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const node = labelRef.current;
    if (!node) return;

    const update = () => {
      setOverflows(node.scrollWidth - node.clientWidth > 1);
    };
    update();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(update);
    if (typeof observer.observe !== 'function') return undefined;
    observer.observe(node);
    return () => observer.disconnect();
  }, [label]);

  const labelClass = overflows
    ? 'vibex-tool-call-target-label is-overflow'
    : 'vibex-tool-call-target-label';

  const name = onClick ? (
    <button
      type="button"
      ref={labelRef}
      className={labelClass}
      title={title}
      aria-label={title}
      onClick={(event) => {
        stopRowToggle(event);
        onClick();
      }}
      onKeyDown={stopRowKey}
    >
      {label}
    </button>
  ) : (
    <span ref={labelRef} className={labelClass} title={title}>
      {label}
    </span>
  );

  return (
    <span className="vibex-tool-call-target">
      {resolvedPath ? (
        <FileIcon
          filePath={resolvedPath}
          isFolder={isFolder}
          className="vibex-tool-call-file-icon"
        />
      ) : null}
      {name}
      {suffix ? (
        <span className="vibex-tool-call-target-suffix">{suffix}</span>
      ) : null}
    </span>
  );
}
