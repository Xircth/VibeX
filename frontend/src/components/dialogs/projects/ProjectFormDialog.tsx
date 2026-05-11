import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { open } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { AlertCircle, FolderOpen, GitBranch, Loader2 } from 'lucide-react';
import type { CreateProject, Project } from 'shared/types';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useProjectMutations } from '@/hooks/useProjectMutations';
import { repoApi } from '@/lib/api';
import { defineModal } from '@/lib/modals';
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

function toFolderName(projectName: string): string {
  const invalidCharacters = new Set([
    '<',
    '>',
    ':',
    '"',
    '/',
    '\\',
    '|',
    '?',
    '*',
  ]);

  return Array.from(projectName)
    .map((character) =>
      invalidCharacters.has(character) || character.charCodeAt(0) < 32
        ? '-'
        : character
    )
    .join('')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '');
}

function joinLocalPath(parent: string, child: string): string {
  const separator = parent.includes('\\') ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/, '')}${separator}${child}`;
}

function createReadme(projectName: string, projectDescription: string): string {
  const description = projectDescription.trim();

  return [
    `# ${projectName}`,
    '',
    description || 'Project created with VibeX.',
    '',
  ].join('\n');
}

const GITIGNORE_TEMPLATE = [
  'node_modules/',
  'dist/',
  'build/',
  '.env',
  '.env.*',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
  '',
].join('\n');

const MIT_LICENSE_TEMPLATE = [
  'MIT License',
  '',
  `Copyright (c) ${new Date().getFullYear()}`,
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
  'SOFTWARE.',
  '',
].join('\n');

const ProjectFormDialogImpl = NiceModal.create<ProjectFormDialogProps>(
  ({ autoOpenFolderPicker = false }) => {
    const modal = useModal();
    const isOpenExistingFolderMode = autoOpenFolderPicker;
    const { createProject } = useProjectMutations();

    const [projectName, setProjectName] = useState('');
    const [projectDescription, setProjectDescription] = useState('');
    const [parentFolderPath, setParentFolderPath] = useState('');
    const [selectedFolderPath, setSelectedFolderPath] = useState('');
    const [selectedFolderIsGitRepo, setSelectedFolderIsGitRepo] = useState<
      boolean | null
    >(null);
    const [includeReadme, setIncludeReadme] = useState(true);
    const [includeGitignore, setIncludeGitignore] = useState(true);
    const [includeLicense, setIncludeLicense] = useState(false);
    const [isPickingFolder, setIsPickingFolder] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState('');

    const hasAutoOpenedFolderRef = useRef(false);
    const folderName = toFolderName(projectName);
    const targetProjectPath = useMemo(() => {
      if (!parentFolderPath || !folderName) {
        return '';
      }

      return joinLocalPath(parentFolderPath, folderName);
    }, [folderName, parentFolderPath]);

    useEffect(() => {
      if (!modal.visible) {
        hasAutoOpenedFolderRef.current = false;
        return;
      }

      setProjectName('');
      setProjectDescription('');
      setParentFolderPath('');
      setSelectedFolderPath('');
      setSelectedFolderIsGitRepo(null);
      setIncludeReadme(true);
      setIncludeGitignore(true);
      setIncludeLicense(false);
      setIsPickingFolder(false);
      setIsSubmitting(false);
      setError('');
    }, [modal.visible]);

    const handlePickFolder = useCallback(async () => {
      setError('');
      try {
        setIsPickingFolder(true);
        const selected = await open({
          directory: true,
          multiple: false,
          title: isOpenExistingFolderMode
            ? '选择项目文件夹'
            : '选择项目创建位置',
        });
        if (!selected || typeof selected !== 'string') {
          return;
        }

        const normalizedSelected = normalizeDisplayPath(selected);

        if (isOpenExistingFolderMode) {
          const isGitRepo = await repoApi.checkGitRepoPath(normalizedSelected);
          setSelectedFolderPath(normalizedSelected);
          setSelectedFolderIsGitRepo(isGitRepo);
          setProjectName(getPathName(normalizedSelected));
          return;
        }

        setParentFolderPath(normalizedSelected);
      } catch (err) {
        setError(err instanceof Error ? err.message : '选择文件夹失败');
      } finally {
        setIsPickingFolder(false);
      }
    }, [isOpenExistingFolderMode]);

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

    const handleCancel = () => {
      modal.resolve({ status: 'canceled' } as ProjectFormDialogResult);
      modal.hide();
    };

    const writeTemplateFiles = async (repoPath: string) => {
      const writes: Array<Promise<void>> = [];

      if (includeReadme) {
        writes.push(
          writeTextFile(
            joinLocalPath(repoPath, 'README.md'),
            createReadme(projectName.trim(), projectDescription)
          )
        );
      }

      if (includeGitignore) {
        writes.push(
          writeTextFile(
            joinLocalPath(repoPath, '.gitignore'),
            GITIGNORE_TEMPLATE
          )
        );
      }

      if (includeLicense) {
        writes.push(
          writeTextFile(
            joinLocalPath(repoPath, 'LICENSE'),
            MIT_LICENSE_TEMPLATE
          )
        );
      }

      await Promise.all(writes);
    };

    const createProjectRecord = async (
      finalProjectName: string,
      repoPathForProject: string
    ) => {
      const createData: CreateProject = {
        name: finalProjectName,
        repositories: [
          {
            display_name: finalProjectName,
            git_repo_path: repoPathForProject,
          },
        ],
      };

      return createProject.mutateAsync(createData);
    };

    const handleCreateNewProject = async () => {
      const finalProjectName = projectName.trim();

      if (!finalProjectName) {
        setError('请输入项目名称');
        return;
      }

      if (!folderName) {
        setError('项目名称无法作为文件夹名称，请修改项目名称');
        return;
      }

      if (!parentFolderPath) {
        setError('请选择项目创建位置');
        return;
      }

      setError('');
      setIsSubmitting(true);

      try {
        const repo = await repoApi.init({
          parent_path: parentFolderPath,
          folder_name: folderName,
        });
        await writeTemplateFiles(repo.path);
        const project = await createProjectRecord(finalProjectName, repo.path);
        modal.resolve({ status: 'saved', project } as ProjectFormDialogResult);
        modal.hide();
      } catch (err) {
        setError(err instanceof Error ? err.message : '创建项目失败');
      } finally {
        setIsSubmitting(false);
      }
    };

    const handleOpenExistingFolder = async () => {
      const finalProjectName =
        projectName.trim() || getPathName(selectedFolderPath);

      if (!selectedFolderPath) {
        setError('请先选择项目文件夹');
        return;
      }

      setError('');
      setIsSubmitting(true);

      try {
        const repo = selectedFolderIsGitRepo
          ? await repoApi.register({
              path: selectedFolderPath,
              display_name: finalProjectName,
            })
          : await repoApi.initAtPath({
              path: selectedFolderPath,
              display_name: finalProjectName,
            });

        const project = await createProjectRecord(finalProjectName, repo.path);
        modal.resolve({ status: 'saved', project } as ProjectFormDialogResult);
        modal.hide();
      } catch (err) {
        setError(err instanceof Error ? err.message : '打开文件夹失败');
      } finally {
        setIsSubmitting(false);
      }
    };

    const handleSubmit = () => {
      if (isOpenExistingFolderMode) {
        void handleOpenExistingFolder();
        return;
      }

      void handleCreateNewProject();
    };

    const isBusy = isSubmitting || isPickingFolder || createProject.isPending;
    const canSubmit = isOpenExistingFolderMode
      ? !!selectedFolderPath
      : !!projectName.trim() && !!parentFolderPath && !!folderName;
    const submitLabel = isOpenExistingFolderMode
      ? selectedFolderPath && selectedFolderIsGitRepo === false
        ? '初始化 Git 并打开'
        : '打开文件夹'
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
              {isOpenExistingFolderMode ? '选择文件夹' : '创建新项目'}
            </DialogTitle>
            <DialogDescription>
              {isOpenExistingFolderMode
                ? '打开已有项目文件夹；如果还不是 Git 仓库，会先完成 Git 初始化。'
                : '创建新项目会在指定位置新建文件夹，并自动完成 Git 初始化。'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {isOpenExistingFolderMode ? (
              <div className="space-y-2">
                <Label>项目文件夹</Label>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handlePickFolder()}
                    disabled={isBusy}
                    className="h-9"
                  >
                    <FolderOpen className="mr-2 h-4 w-4" />
                    选择文件夹
                  </Button>
                  <div
                    className="flex h-9 min-w-0 flex-1 items-center truncate rounded-md border px-3 text-xs text-muted-foreground"
                    title={normalizeDisplayPath(selectedFolderPath)}
                  >
                    {selectedFolderPath || '未选择文件夹'}
                  </div>
                </div>
                {selectedFolderPath && selectedFolderIsGitRepo !== null ? (
                  <p
                    className={
                      selectedFolderIsGitRepo
                        ? 'text-sm text-emerald-600'
                        : 'text-sm text-amber-600'
                    }
                  >
                    {selectedFolderIsGitRepo
                      ? '已识别为 Git 仓库'
                      : '该文件夹还不是 Git 仓库，打开时会先初始化 Git。'}
                  </p>
                ) : null}
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="project-name">项目名称</Label>
                  <Input
                    id="project-name"
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                    placeholder="例如：Marketing Site"
                    disabled={isBusy}
                    autoFocus
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="project-description">
                    项目简介（可选，用于 README）
                  </Label>
                  <Textarea
                    id="project-description"
                    value={projectDescription}
                    onChange={(event) =>
                      setProjectDescription(event.target.value)
                    }
                    placeholder="简单描述这个项目要解决的问题"
                    disabled={isBusy}
                    className="min-h-20 resize-none"
                  />
                </div>

                <div className="space-y-2">
                  <Label>创建位置</Label>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void handlePickFolder()}
                      disabled={isBusy}
                      className="h-9"
                    >
                      <FolderOpen className="mr-2 h-4 w-4" />
                      选择位置
                    </Button>
                    <div
                      className="flex h-9 min-w-0 flex-1 items-center truncate rounded-md border px-3 text-xs text-muted-foreground"
                      title={normalizeDisplayPath(parentFolderPath)}
                    >
                      {parentFolderPath || '未选择创建位置'}
                    </div>
                  </div>
                  {targetProjectPath ? (
                    <p className="truncate text-xs text-muted-foreground">
                      将创建：{targetProjectPath}
                    </p>
                  ) : null}
                </div>

                <div className="rounded-lg border bg-muted/20 p-3">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                    <GitBranch className="h-4 w-4 text-muted-foreground" />
                    创建后会自动初始化 Git 仓库
                  </div>
                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={includeReadme}
                        onCheckedChange={(checked) =>
                          setIncludeReadme(checked === true)
                        }
                        disabled={isBusy}
                      />
                      创建 README.md
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={includeGitignore}
                        onCheckedChange={(checked) =>
                          setIncludeGitignore(checked === true)
                        }
                        disabled={isBusy}
                      />
                      创建 .gitignore
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={includeLicense}
                        onCheckedChange={(checked) =>
                          setIncludeLicense(checked === true)
                        }
                        disabled={isBusy}
                      />
                      创建 MIT LICENSE
                    </label>
                  </div>
                </div>
              </>
            )}

            {error ? (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
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
              onClick={handleSubmit}
              disabled={isBusy || !canSubmit}
            >
              {isBusy ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  处理中...
                </>
              ) : (
                submitLabel
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
