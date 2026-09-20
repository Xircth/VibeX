import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { astryxTextInputSurfaceStyle } from '@/components/ui/astryx-text-input';
import { pickHostDirectory } from '@/lib/hostFs';
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
import { Label } from '@/components/ui/label';
import { useProjectMutations } from '@/hooks/useProjectMutations';
import { projectsApi, repoApi } from '@/lib/api';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import type { ProjectImportPreview } from '@/lib/api/projects';
import { defineModal } from '@/lib/modals';
import { joinLocalPath, normalizeDisplayPath } from '@/utils/displayPath';

export interface ProjectFormDialogProps {
  autoOpenFolderPicker?: boolean;
  initialFolderPath?: string;
}

export type ProjectFormDialogResult =
  | { status: 'saved'; project: Project }
  | { status: 'canceled' };

function setReadOnly(input: HTMLInputElement | null) {
  if (input) input.readOnly = true;
}

interface ProjectPathPreviewProps {
  label: string;
  placeholder: string;
  value: string;
}

function ProjectPathPreview({
  label,
  placeholder,
  value,
}: ProjectPathPreviewProps) {
  return (
    <div className="min-w-0 flex-1" title={normalizeDisplayPath(value)}>
      <TextInput
        ref={setReadOnly}
        label={label}
        isLabelHidden
        size="sm"
        value={value}
        placeholder={placeholder}
        onChange={() => undefined}
        width="100%"
        aria-readonly="true"
        className="[&_input]:cursor-default [&_input]:truncate [&_input]:font-mono [&_input]:text-xs [&_input]:text-muted-foreground"
        style={astryxTextInputSurfaceStyle}
      />
    </div>
  );
}

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
  ({ autoOpenFolderPicker = false, initialFolderPath }) => {
    const { t } = useTranslation(['dialogs', 'common']);
    const modal = useModal();
    const isOpenExistingFolderMode =
      autoOpenFolderPicker || Boolean(initialFolderPath);
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
    const [initGitRepo, setInitGitRepo] = useState(false);
    const [importPreview, setImportPreview] =
      useState<ProjectImportPreview | null>(null);
    const [isScanningChildren, setIsScanningChildren] = useState(false);
    const [selectedChildPaths, setSelectedChildPaths] = useState<string[]>([]);

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
      setInitGitRepo(false);
      setImportPreview(null);
      setSelectedChildPaths([]);
      setIncludeReadme(true);
      setIncludeGitignore(true);
      setIncludeLicense(false);
      setIsPickingFolder(false);
      setIsSubmitting(false);
      setError('');
    }, [modal.visible]);

    const applyExistingFolderPath = useCallback(async (selected: string) => {
      const normalizedSelected = normalizeDisplayPath(selected);
      const isGitRepo = await repoApi.checkGitRepoPath(normalizedSelected);
      setSelectedFolderPath(normalizedSelected);
      setSelectedFolderIsGitRepo(isGitRepo);
      setProjectName(getPathName(normalizedSelected));
      setInitGitRepo(false);
      setSelectedChildPaths([]);
      setIsScanningChildren(true);
      try {
        const preview = await projectsApi.previewImport(normalizedSelected);
        setImportPreview(preview);
      } catch {
        setImportPreview(null);
      } finally {
        setIsScanningChildren(false);
      }
    }, []);

    const handlePickFolder = useCallback(async () => {
      setError('');
      try {
        setIsPickingFolder(true);
        const selected = await pickHostDirectory({
          title: isOpenExistingFolderMode
            ? t('projectForm.pickFolderTitleExisting')
            : t('projectForm.pickFolderTitleNew'),
        });
        if (!selected || typeof selected !== 'string') {
          return;
        }

        const normalizedSelected = normalizeDisplayPath(selected);

        if (isOpenExistingFolderMode) {
          await applyExistingFolderPath(normalizedSelected);
          return;
        }

        setParentFolderPath(normalizedSelected);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t('projectForm.pickFolderFailed')
        );
      } finally {
        setIsPickingFolder(false);
      }
    }, [applyExistingFolderPath, isOpenExistingFolderMode, t]);

    useEffect(() => {
      if (!modal.visible || hasAutoOpenedFolderRef.current) {
        return;
      }

      if (initialFolderPath) {
        hasAutoOpenedFolderRef.current = true;
        setIsPickingFolder(true);
        void applyExistingFolderPath(initialFolderPath)
          .catch((err) => {
            setError(
              err instanceof Error
                ? err.message
                : t('projectForm.pickFolderFailed')
            );
          })
          .finally(() => {
            setIsPickingFolder(false);
          });
        return;
      }

      if (!autoOpenFolderPicker) {
        return;
      }

      hasAutoOpenedFolderRef.current = true;
      void handlePickFolder();
    }, [
      applyExistingFolderPath,
      autoOpenFolderPicker,
      handlePickFolder,
      initialFolderPath,
      modal.visible,
      t,
    ]);

    const handleCancel = () => {
      modal.resolve({ status: 'canceled' } as ProjectFormDialogResult);
      modal.hide();
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
        setError(t('projectForm.nameRequired'));
        return;
      }

      if (!folderName) {
        setError(t('projectForm.invalidFolderName'));
        return;
      }

      if (!parentFolderPath) {
        setError(t('projectForm.locationRequired'));
        return;
      }

      setError('');
      setIsSubmitting(true);

      try {
        const templates = {
          ...(includeReadme
            ? {
                readme: createReadme(finalProjectName, projectDescription),
              }
            : {}),
          ...(includeGitignore ? { gitignore: GITIGNORE_TEMPLATE } : {}),
          ...(includeLicense ? { license: MIT_LICENSE_TEMPLATE } : {}),
        };
        const project = await createProject.mutateAsync({
          name: finalProjectName,
          repositories: [],
          init: {
            parentPath: parentFolderPath,
            folderName,
            templates:
              Object.keys(templates).length > 0 ? templates : undefined,
          },
        });
        modal.resolve({ status: 'saved', project } as ProjectFormDialogResult);
        modal.hide();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t('projectForm.createFailed')
        );
      } finally {
        setIsSubmitting(false);
      }
    };

    const handleOpenExistingFolder = async () => {
      const finalProjectName =
        projectName.trim() || getPathName(selectedFolderPath);

      if (!selectedFolderPath) {
        setError(t('projectForm.selectFolderRequired'));
        return;
      }

      const shouldInitGit =
        initGitRepo && selectedFolderIsGitRepo === false;
      if (shouldInitGit && (importPreview?.children.length ?? 0) > 0) {
        const confirmed = await ConfirmDialog.show({
          title: t('projectForm.nestedGitConfirmTitle'),
          message: t('projectForm.nestedGitConfirmMessage'),
          confirmText: t('projectForm.nestedGitConfirmAction'),
          cancelText: t('common:cancel'),
        });
        if (confirmed !== 'confirmed') {
          return;
        }
      }

      setError('');
      setIsSubmitting(true);

      try {
        if (shouldInitGit) {
          await repoApi.initAtPath({
            path: selectedFolderPath,
            display_name: finalProjectName,
          });
        }

        const repositories =
          selectedFolderIsGitRepo || shouldInitGit
            ? [
                {
                  display_name: finalProjectName,
                  git_repo_path: selectedFolderPath,
                },
              ]
            : [];

        const project = await createProject.mutateAsync({
          name: finalProjectName,
          rootPath: selectedFolderPath,
          repositories,
        });

        for (const childPath of selectedChildPaths) {
          const child = importPreview?.children.find(
            (entry) => entry.path === childPath
          );
          if (!child) continue;
          await createProject.mutateAsync({
            name: child.name,
            rootPath: child.path,
            parentProjectId: project.id,
            repositories: [
              {
                display_name: child.name,
                git_repo_path: child.path,
              },
            ],
          });
        }

        modal.resolve({ status: 'saved', project } as ProjectFormDialogResult);
        modal.hide();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t('projectForm.openFolderFailed')
        );
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
      ? t('projectForm.submitOpenFolder')
      : t('projectForm.submitCreate');

    const handleOpenChange = (openState: boolean) => {
      if (!openState && !isBusy) {
        handleCancel();
      }
    };

    return (
      <Dialog
        open={modal.visible}
        onOpenChange={handleOpenChange}
        className="welcome-project-form-surface border-0 sm:max-w-[640px]"
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {isOpenExistingFolderMode
                ? t('projectForm.titleExisting')
                : t('projectForm.titleNew')}
            </DialogTitle>
            <DialogDescription>
              {isOpenExistingFolderMode
                ? t('projectForm.descriptionExisting')
                : t('projectForm.descriptionNew')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {isOpenExistingFolderMode ? (
              <div className="space-y-2">
                <Label>{t('projectForm.folderLabel')}</Label>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void handlePickFolder()}
                    disabled={isBusy}
                    className="gap-1.5 bg-[var(--surface-control-hover)] text-foreground hover:bg-foreground/[0.14]"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    {t('projectForm.chooseFolder')}
                  </Button>
                  <ProjectPathPreview
                    label={t('projectForm.folderLabel')}
                    value={selectedFolderPath}
                    placeholder={t('projectForm.noFolderSelected')}
                  />
                </div>
                {selectedFolderPath && selectedFolderIsGitRepo !== null ? (
                  <div className="flex flex-col gap-3">
                    <p
                      className={
                        selectedFolderIsGitRepo
                          ? 'text-sm text-[hsl(var(--success))]'
                          : 'text-sm text-[hsl(var(--warning))]'
                      }
                    >
                      {selectedFolderIsGitRepo
                        ? t('projectForm.recognizedGitRepo')
                        : t('projectForm.notGitRepoHint')}
                    </p>
                    {selectedFolderIsGitRepo === false ? (
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={initGitRepo}
                          onCheckedChange={(checked) =>
                            setInitGitRepo(checked === true)
                          }
                          disabled={isBusy}
                        />
                        {t('projectForm.initGitOptional')}
                      </label>
                    ) : null}
                    {initGitRepo &&
                    (importPreview?.children.length ?? 0) > 0 ? (
                      <Alert>
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription>
                          {t('projectForm.nestedGitWarning')}
                        </AlertDescription>
                      </Alert>
                    ) : null}
                    {isScanningChildren ? (
                      <div className="flex flex-col gap-2">
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-8 w-full" />
                      </div>
                    ) : null}
                    {importPreview && importPreview.children.length > 0 ? (
                      <div className="flex flex-col gap-2">
                        <p className="text-sm font-medium">
                          {t('projectForm.discoveredGitRepos', {
                            count: importPreview.children.length,
                          })}
                        </p>
                        <ScrollArea className="max-h-40 rounded-lg border border-border">
                          <div className="flex flex-col gap-1 p-2">
                            {importPreview.children.map((child) => {
                              const checked =
                                selectedChildPaths.includes(child.path);
                              return (
                                <label
                                  key={child.path}
                                  className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60"
                                >
                                  <Checkbox
                                    checked={checked}
                                    onCheckedChange={(value) => {
                                      setSelectedChildPaths((current) =>
                                        value === true
                                          ? [...current, child.path]
                                          : current.filter(
                                              (path) => path !== child.path
                                            )
                                      );
                                    }}
                                    disabled={isBusy}
                                  />
                                  <span className="min-w-0">
                                    <span className="block truncate font-medium">
                                      {child.name}
                                    </span>
                                    <span className="block truncate font-mono text-xs text-muted-foreground">
                                      {child.path}
                                    </span>
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        </ScrollArea>
                        <p className="text-xs text-muted-foreground">
                          {t('projectForm.discoveredGitReposHint')}
                        </p>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label>{t('projectForm.nameLabel')}</Label>
                  <TextInput
                    label={t('projectForm.nameLabel')}
                    isLabelHidden
                    value={projectName}
                    onChange={setProjectName}
                    placeholder={t('projectForm.namePlaceholder')}
                    isDisabled={isBusy}
                    hasAutoFocus
                    width="100%"
                    className="[&_input]:text-sm"
                    style={astryxTextInputSurfaceStyle}
                  />
                </div>

                <div className="space-y-2">
                  <Label>{t('projectForm.descriptionLabel')}</Label>
                  <TextArea
                    label={t('projectForm.descriptionLabel')}
                    isLabelHidden
                    value={projectDescription}
                    onChange={setProjectDescription}
                    placeholder={t('projectForm.descriptionPlaceholder')}
                    rows={4}
                    isDisabled={isBusy}
                    width="100%"
                    className="project-form-description-field [&_textarea]:resize-none [&_textarea]:text-sm"
                    style={astryxTextInputSurfaceStyle}
                  />
                </div>

                <div className="space-y-2">
                  <Label>{t('projectForm.locationLabel')}</Label>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void handlePickFolder()}
                      disabled={isBusy}
                      className="gap-1.5 bg-[var(--surface-control-hover)] text-foreground hover:bg-foreground/[0.14]"
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      {t('projectForm.chooseLocation')}
                    </Button>
                    <ProjectPathPreview
                      label={t('projectForm.locationLabel')}
                      value={parentFolderPath}
                      placeholder={t('projectForm.noLocationSelected')}
                    />
                  </div>
                  {targetProjectPath ? (
                    <p className="truncate text-xs text-muted-foreground">
                      {t('projectForm.willCreate', { path: targetProjectPath })}
                    </p>
                  ) : null}
                </div>

                <div className="rounded-lg border bg-muted/20 p-3">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                    <GitBranch className="h-4 w-4 text-muted-foreground" />
                    {t('projectForm.gitInitNote')}
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
                      {t('projectForm.createReadme')}
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={includeGitignore}
                        onCheckedChange={(checked) =>
                          setIncludeGitignore(checked === true)
                        }
                        disabled={isBusy}
                      />
                      {t('projectForm.createGitignore')}
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={includeLicense}
                        onCheckedChange={(checked) =>
                          setIncludeLicense(checked === true)
                        }
                        disabled={isBusy}
                      />
                      {t('projectForm.createLicense')}
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
              {t('common:cancel')}
            </Button>
            <Button
              type="button"
              onClick={handleSubmit}
              disabled={isBusy || !canSubmit}
            >
              {isBusy ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('projectForm.processing')}
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
