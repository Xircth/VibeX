import { useCallback, useState } from 'react';

export type GitPanelMode = 'diff' | 'log';
export type DiffViewStyle = 'split' | 'unified';
export type DiffListView = 'flat' | 'tree';

interface UseGitPanelControllerReturn {
  mode: GitPanelMode;
  setMode: (mode: GitPanelMode) => void;
  diffViewStyle: DiffViewStyle;
  setDiffViewStyle: (style: DiffViewStyle) => void;
  diffListView: DiffListView;
  setDiffListView: (view: DiffListView) => void;
  selectedDiffPath: string | null;
  setSelectedDiffPath: (path: string | null) => void;
  toggleDiffViewStyle: () => void;
  toggleDiffListView: () => void;
}

export function useGitPanelController(): UseGitPanelControllerReturn {
  const [mode, setMode] = useState<GitPanelMode>('diff');
  const [diffViewStyle, setDiffViewStyle] = useState<DiffViewStyle>('unified');
  const [diffListView, setDiffListView] = useState<DiffListView>('flat');
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);

  const toggleDiffViewStyle = useCallback(() => {
    setDiffViewStyle((prev) => (prev === 'split' ? 'unified' : 'split'));
  }, []);

  const toggleDiffListView = useCallback(() => {
    setDiffListView((prev) => (prev === 'flat' ? 'tree' : 'flat'));
  }, []);

  return {
    mode,
    setMode,
    diffViewStyle,
    setDiffViewStyle,
    diffListView,
    setDiffListView,
    selectedDiffPath,
    setSelectedDiffPath,
    toggleDiffViewStyle,
    toggleDiffListView,
  };
}
