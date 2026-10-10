import { useQuery } from '@tanstack/react-query';
import { fileTreeApi } from '@/lib/api';
import { ToolCodeSnippet } from './ToolArtifact';
import { splitCodeLines } from './toolArtifactModel';

export function FileReadSnippet({
  path,
  resolvedPath,
  content,
  startLine = 1,
}: {
  path: string;
  resolvedPath: string | null;
  content: string;
  startLine?: number;
}) {
  const { data } = useQuery({
    queryKey: ['toolFileContext', resolvedPath],
    queryFn: () => fileTreeApi.readFileWithTruncation(resolvedPath!, 256_000),
    enabled: Boolean(resolvedPath && content),
    staleTime: 30_000,
    retry: false,
    meta: { suppressGlobalError: true },
  });
  const inspectedLines = splitCodeLines(content);
  const fileLines = data ? splitCodeLines(data.content) : [];
  const offset = Math.max(0, startLine - 1);
  // Only attach live context if it still matches the recorded read exactly.
  const matches =
    inspectedLines.length > 0 &&
    inspectedLines.every((line, index) => fileLines[offset + index] === line);
  const contextStart = Math.max(0, offset - 3);
  const displayContent = matches
    ? fileLines
        .slice(contextStart, offset + inspectedLines.length + 3)
        .join('\n')
    : content;

  return (
    <ToolCodeSnippet
      path={path}
      content={displayContent}
      startLine={matches ? contextStart + 1 : startLine}
      highlightedRange={{
        start: startLine,
        end: startLine + inspectedLines.length - 1,
      }}
    />
  );
}
