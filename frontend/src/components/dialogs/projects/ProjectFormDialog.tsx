import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertCircle,
  CheckCircle2,
  FolderGit,
  FolderOpen,
  Loader2,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import type { CreateProject, DirectoryEntry, Project } from 'shared/types';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { useProjectMutations } from '@/hooks/useProjectMutations';
import { defineModal } from '@/lib/modals';
import { fileSystemApi, repoApi } from '@/lib/api';
import { normalizeDisplayPath } from '@/utils/displayPath';

export interface ProjectFormDialogProps {
  autoOpenFolderPicker?: boolean;
}

export type ProjectFormDialogResult =
  | { status: 'saved'; project: Project }
  | { status: 'canceled' };

function getPathName(path: string): string {
  const normalized = normalizeDisplayPath(path).replace(/[\\/]+$/, '');
  if (!normalized) return '';
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

const ProjectFormDialogImpl = NiceModal.create<ProjectFormDialogProps>(
  ({ autoOpenFolderPicker = false }) => {
    const modal = useModal();
    const isFolderEntryMode = autoOpenFolderPicker;
    const { createProject } = useProjectMutations();

    const [allRepos, setAllRepos] = useState<DirectoryEntry[]>([]);
    const [reposLoading, setReposLoading] = useState(false);
    const [selectedRepoPath, setSelectedRepoPath] = useState('');
    const [selectedFolderPath, setSelectedFolderPath] = useState('');
    const [selectedFolderIsGitRepo, setSelectedFolderIsGitRepo] = useState<
      boolean | null
    >(null);
    const [projectName, setProjectName] = useState('');
    const [isPickingFolder, setIsPickingFolder] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState('');

    const hasAutoOpenedFolderRef = useRef(false);

    const loadGitRepos = useCallback(async () => {
      setReposLoading(true);
      setError('');
      try {
        const repos = await fileSystemApi.listGitRepos();
        setAllRepos(repos);
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载 Git 仓库列表失败');
      } finally {
        setReposLoading(false);
      }
    }, []);

    useEffect(() => {
      if (!modal.visible) {
        hasAutoOpenedFolderRef.current = false;
        return;
      }

      setAllRepos([]);
      setSelectedRepoPath('');
      setSelectedFolderPath('');
      setSelectedFolderIsGitRepo(null);
      setProjectName('');
      setIsPickingFolder(false);
      setIsSubmitting(false);
      setError('');

      if (!isFolderEntryMode) {
        void loadGitRepos();
      }
    }, [isFolderEntryMode, loadGitRepos, modal.visible]);

    const handlePickFolder = useCallback(async () => {
      setError('');
      try {
        setIsPickingFolder(true);
        const selected = await open({
          directory: true,
          multiple: false,
          title: '选择项目文件夹',
        });
        if (!selected || typeof selected !== 'string') {
          return;
        }

        const normalizedSelected = normalizeDisplayPath(selected);
        const isGitRepo = await repoApi.checkGitRepoPath(normalizedSelected);
        setSelectedRepoPath('');
        setSelectedFolderPath(normalizedSelected);
        setSelectedFolderIsGitRepo(isGitRepo);
        setProjectName(getPathName(normalizedSelected));
      } catch (err) {
        setError(err instanceof Error ? err.message : '选择文件夹失败');
      } finally {
        setIsPickingFolder(false);
      }
    }, []);

    useEffect(() => {
      if (
        !modal.visible ||
        !autoOpenFolderPicker ||
        hasAutoOpenedFolderRef.current
      ) {
        return;
      }

      hasAutoOpenedFolderRef.current = true;
      void handlePickFolder();
    }, [autoOpenFolderPicker, handlePickFolder, modal.visible]);

    const handleSelectRepo = (repo: DirectoryEntry) => {
      setSelectedRepoPath(normalizeDisplayPath(repo.path));
      setSelectedFolderPath('');
      setSelectedFolderIsGitRepo(null);
      setProjectName(repo.name);
      setError('');
    };

    const handleCancel = () => {
      modal.resolve({ status: 'canceled' } as ProjectFormDialogResult);
      modal.hide();
    };

    const handleCreateProject = async () => {
      const selectedPath = isFolderEntryMode
        ? selectedFolderPath
        : selectedRepoPath || selectedFolderPath;
      const normalizedName =
        projectName.trim() ||
        getPathName(selectedFolderPath || selectedRepoPath);
      const finalProjectName = normalizedName || 'New Project';

      if (!selectedPath) {
        setError('请先选择项目文件夹');
        return;
      }

      if (!isFolderEntryMode && !projectName.trim()) {
        setError('请输入项目名称');
        return;
      }

      setError('');
      setIsSubmitting(true);

      try {
        let repoPathForProject = '';

        if (selectedRepoPath) {
          const repo = await repoApi.register({ path: selectedRepoPath });
          repoPathForProject = repo.path;
        } else if (selectedFolderIsGitRepo) {
          const repo = await repoApi.register({ path: selectedFolderPath });
          repoPathForProject = repo.path;
        } else {
          const repo = await repoApi.initAtPath({
            path: selectedFolderPath,
            display_name: finalProjectName,
          });
          repoPathForProject = repo.path;
        }

        const createData: CreateProject = {
          name: finalProjectName,
          repositories: [
            {
              display_name: finalProjectName,
              git_repo_path: repoPathForProject,
            },
          ],
        };

        const project = await createProject.mutateAsync(createData);
        modal.resolve({ status: 'saved', project } as ProjectFormDialogResult);
        modal.hide();
      } catch (err) {
        setError(err instanceof Error ? err.message : '创建项目失败');
      } finally {
        setIsSubmitting(false);
      }
    };

    const isBusy = isSubmitting || isPickingFolder || createProject.isPending;
    const createButtonLabel =
      selectedFolderPath && selectedFolderIsGitRepo === false
        ? '下一步（默认初始化 Git）'
        : '创建项目';

    const handleOpenChange = (openState: boolean) => {
      if (!openState && !isBusy) {
        handleCancel();
      }
    };

    return (
      <Dialog open={modal.visible} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle>
              {isFolderEntryMode ? '选择项目文件夹' : '创建新项目'}
            </DialogTitle>
            <DialogDescription>
              {isFolderEntryMode
                ? '选择文件夹后自动检测 Git；未初始化时默认初始化。'
                : '选择本机 Git 仓库，或选择文件夹并自动完成 Git 初始化。'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {!isFolderEntryMode && (
              <div className="space-y-2">
                <Label>已扫描到的 Git 仓库</Label>
                {reposLoading ? (
                  <div className="border rounded-md p-4 text-sm text-muted-foreground flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在扫描仓库...
                  </div>
                ) : allRepos.length > 0 ? (
                  <div className="max-h-56 overflow-auto space-y-2 border rounded-md p-2">
                    {allRepos.map((repo) => {
                      const isSelected = selectedRepoPath === repo.path;

                      return (
                        <button
                          key={repo.path}
                          type="button"
                          onClick={() => handleSelectRepo(repo)}
                          className={`w-full text-left border rounded-md p-3 transition-colors ${
                            isSelected
                              ? 'border-primary bg-primary/5'
                              : 'hover:bg-muted/60'
                          }`}
                          disabled={isBusy}
                        >
                          <div className="flex items-start gap-2">
                            <FolderGit className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium">
                                {repo.name}
                              </div>
                              <div className="text-xs text-muted-foreground truncate mt-1">
                                {normalizeDisplayPath(repo.path)}
                              </div>
                            </div>
                            {isSelected && (
                              <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="border rounded-md p-4 text-sm text-muted-foreground">
                    未扫描到可用 Git 仓库
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {isFolderEntryMode
                  ? '请选择项目的位置'
                  : '若不在以上列表中，请选择项目的位置'}
              </p>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handlePickFolder()}
                  disabled={isBusy}
                  className="h-9"
                >
                  <FolderOpen className="h-4 w-4 mr-2" />
                  选择文件夹
                </Button>

                <div
                  className="flex-1 min-w-0 h-9 border rounded-md px-3 text-xs text-muted-foreground truncate flex items-center"
                  title={normalizeDisplayPath(selectedFolderPath)}
                >
                  {selectedFolderPath || '未选择文件夹'}
                </div>
              </div>

              {selectedFolderPath && selectedFolderIsGitRepo !== null && (
                <div
                  className={`text-sm ${
                    selectedFolderIsGitRepo
                      ? 'text-emerald-600'
                      : 'text-amber-600'
                  }`}
                >
                  {selectedFolderIsGitRepo
                    ? '已识别到Git仓库'
                    : '当前项目未进行Git初始化，点击下一步默认进行初始化'}
                </div>
              )}
            </div>

            {!isFolderEntryMode && (
              <div className="space-y-2">
                <Label htmlFor="project-name">项目名称</Label>
                <Input
                  id="project-name"
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  placeholder="请输入项目名称"
                  disabled={isBusy}
                />
              </div>
            )}

            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleCancel}
              disabled={isBusy}
            >
              取消
            </Button>
            <Button
              type="button"
              onClick={() => void handleCreateProject()}
              disabled={
                isBusy ||
                (isFolderEntryMode
                  ? !selectedFolderPath
                  : !projectName.trim() ||
                    (!selectedRepoPath && !selectedFolderPath))
              }
            >
              {isBusy ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  处理中...
                </>
              ) : (
                createButtonLabel
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
);

export const ProjectFormDialog = defineModal<
  ProjectFormDialogProps,
  ProjectFormDialogResult
>(ProjectFormDialogImpl);
