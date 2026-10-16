import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import FileIcon from '@/components/FileIcon';
import { fileNameFromPath, looksLikeFilePath } from './toolCallPath';

export { fileNameFromPath, looksLikeFilePath };

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
  const labelRef = useRef<HTMLElement | null>(null);
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
      ref={(node) => {
        labelRef.current = node;
      }}
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
    <span
      ref={(node) => {
        labelRef.current = node;
      }}
      className={labelClass}
      title={title}
    >
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
