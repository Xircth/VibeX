import { useEffect, useCallback, useState, useMemo } from 'react';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { defineModal } from '@/lib/modals';
import { useDropzone } from 'react-dropzone';
import { useForm, useStore } from '@tanstack/react-form';
import { Image as ImageIcon } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import WYSIWYGEditor from '@/components/ui/wysiwyg';
import type { LocalImageMetadata } from '@/components/ui/wysiwyg/context/task-attempt-context';
import BranchSelector from '@/components/tasks/BranchSelector';
import RepoBranchSelector from '@/components/tasks/RepoBranchSelector';
import { TerminalProfileControls } from '@/components/tasks/TerminalProfileControls';
import { useUserSystem } from '@/components/ConfigProvider';
import {
  useTaskImages,
  useImageUpload,
  useTaskMutations,
  useProjectRepos,
  useRepoBranchSelection,
} from '@/hooks';
import {
  useKeySubmitTask,
  useKeyExit,
  Scope,
} from '@/keyboard';
import { useHotkeysContext } from 'react-hotkeys-hook';
import { cn } from '@/lib/utils';
import { getFirstAvailableProfile } from '@/utils/executor';
import type {
  TaskStatus,
  ExecutorProfileId,
  ImageResponse,
} from 'shared/types';

interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export type TaskFormDialogProps =
  | { mode: 'create'; projectId: string; initialStatus?: TaskStatus }
  | { mode: 'edit'; projectId: string; task: Task }
  | { mode: 'duplicate'; projectId: string; initialTask: Task }
  | {
      mode: 'subtask';
      projectId: string;
      parentTaskAttemptId: string;
      initialBaseBranch: string;
    };

type RepoBranch = { repoId: string; branch: string };

type TaskFormValues = {
  title: string;
  description: string;
  status: TaskStatus;
  executorProfileId: ExecutorProfileId | null;
  repoBranches: RepoBranch[];
  useWorktree: boolean;
};

const TaskFormDialogImpl = NiceModal.create<TaskFormDialogProps>((props) => {
  const { mode, projectId } = props;
  const editMode = mode === 'edit';
  const modal = useModal();
  const { createAndStart, updateTask } = useTaskMutations(projectId);
  const { system, profiles, loading: userSystemLoading } = useUserSystem();
  const { upload, uploadForTask } = useImageUpload();
  const { enableScope, disableScope } = useHotkeysContext();

  // Local UI state
  const [images, setImages] = useState<ImageResponse[]>([]);
  const [newlyUploadedImageIds, setNewlyUploadedImageIds] = useState<string[]>(
    []
  );
  const [showDiscardWarning, setShowDiscardWarning] = useState(false);

  const { data: taskImages } = useTaskImages(
    editMode ? props.task.id : undefined
  );
  const { data: projectRepos = [] } = useProjectRepos(projectId, {
    enabled: modal.visible,
  });
  const initialBranch =
    mode === 'subtask' ? props.initialBaseBranch : undefined;
  const { configs: repoBranchConfigs, isLoading: branchesLoading } =
    useRepoBranchSelection({
      repos: projectRepos,
      initialBranch,
      enabled: modal.visible && projectRepos.length > 0,
    });

  const defaultRepoBranches = useMemo((): RepoBranch[] => {
    return repoBranchConfigs
      .filter((c) => c.targetBranch !== null)
      .map((c) => ({ repoId: c.repoId, branch: c.targetBranch! }));
  }, [repoBranchConfigs]);

  // Get default form values based on mode
  const defaultValues = useMemo((): TaskFormValues => {
    const baseProfile = system.config?.executor_profile ?? getFirstAvailableProfile(profiles);

    switch (mode) {
      case 'edit': {
        return {
          title: props.task.title,
          description: props.task.description || '',
          status: props.task.status,
          executorProfileId: baseProfile,
          repoBranches: defaultRepoBranches,
          useWorktree: true,
        };
      }

      case 'duplicate':
        return {
          title: props.initialTask.title,
          description: props.initialTask.description || '',
          status: 'todo',
          executorProfileId: baseProfile,
          repoBranches: defaultRepoBranches,
          useWorktree: true,
        };

      case 'subtask':
      case 'create':
      default:
        return {
          title: '',
          description: '',
          status: 'todo',
          executorProfileId: baseProfile,
          repoBranches: defaultRepoBranches,
          useWorktree: true,
        };
    }
  }, [mode, props, system.config?.executor_profile, profiles, defaultRepoBranches]);

  // Form submission handler
  const handleSubmit = async ({ value }: { value: TaskFormValues }) => {
    if (editMode) {
      const title = value.title.trim();
      const description = value.description.trim() || null;
      await updateTask.mutateAsync(
        {
          taskId: props.task.id,
          data: {
            title,
            description,
            status: value.status,
            parent_workspace_id: null,
            image_ids: images.length > 0 ? images.map((img) => img.id) : null,
          },
        },
        { onSuccess: () => modal.remove() }
      );
    } else {
      const imageIds =
        newlyUploadedImageIds.length > 0 ? newlyUploadedImageIds : null;
      const title = value.title.trim();
      const description = value.description.trim() || null;
      const task = {
        project_id: projectId,
        title,
        description,
        status: null,
        parent_workspace_id:
          mode === 'subtask' ? props.parentTaskAttemptId : null,
        image_ids: imageIds,
      };
      const repos = value.repoBranches.map((rb) => ({
        repo_id: rb.repoId,
        target_branch: rb.branch,
      }));
      await createAndStart.mutateAsync(
        {
          task,
          executor_profile_id: value.executorProfileId!,
          repos,
          use_worktree: value.useWorktree,
        },
        { onSuccess: () => modal.remove() }
      );
    }
  };

  const validator = (value: TaskFormValues): string | undefined => {
    if (!value.title.trim().length) return 'need title';
    if (!editMode) {
      if (!value.executorProfileId) return 'need executor profile';
      if (
        value.repoBranches.length === 0 ||
        value.repoBranches.some((rb) => !rb.branch)
      ) {
        return 'need branch for all repos';
      }
    }
  };

  // Initialize TanStack Form
  const form = useForm({
    defaultValues: defaultValues,
    onSubmit: handleSubmit,
    validators: {
      // we use an onMount validator so that the primary action button can
      // enable/disable itself based on `canSubmit`
      onMount: ({ value }) => validator(value),
      onChange: ({ value }) => validator(value),
    },
  });

  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);
  const isDirty = useStore(form.store, (state) => state.isDirty);
  const canSubmit = useStore(form.store, (state) => state.canSubmit);
  const selectedExecutorProfile = useStore(
    form.store,
    (state) => state.values.executorProfileId
  );
  const selectedRepoId = useStore(
    form.store,
    (state) => state.values.repoBranches[0]?.repoId
  );

  useEffect(() => {
    if (isDirty) return;

    const currentValues = form.store.state.values;

    if (
      !currentValues.executorProfileId &&
      defaultValues.executorProfileId
    ) {
      form.setFieldValue(
        'executorProfileId',
        defaultValues.executorProfileId
      );
    }

    if (
      currentValues.repoBranches.length === 0 &&
      defaultValues.repoBranches.length > 0
    ) {
      form.setFieldValue('repoBranches', defaultValues.repoBranches);
    }
  }, [defaultValues, form, isDirty]);

  // Load images for edit mode
  useEffect(() => {
    if (!taskImages) return;
    setImages(taskImages);
  }, [taskImages]);

  const onDrop = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        try {
          // In edit mode, use uploadForTask to associate immediately
          // In create mode, use plain upload (will associate on task creation)
          const img = editMode
            ? await uploadForTask(props.task.id, file)
            : await upload(file);

          // Add markdown image reference to description
          const markdownText = `![${img.original_name}](${img.file_path})`;
          form.setFieldValue('description', (prev) =>
            prev.trim() === '' ? markdownText : `${prev} ${markdownText}`
          );
          setImages((prev) => [...prev, img]);
          setNewlyUploadedImageIds((prev) => [...prev, img.id]);
        } catch {
          // Silently ignore upload errors for now
        }
      }
    },
    [editMode, props, upload, uploadForTask, form]
  );

  const {
    getRootProps,
    getInputProps,
    isDragActive,
    open: dropzoneOpen,
  } = useDropzone({
    onDrop: onDrop,
    accept: { 'image/*': [] },
    disabled: isSubmitting,
    noClick: true,
    noKeyboard: true,
  });

  // Compute localImages for WYSIWYG rendering of uploaded images
  const localImages: LocalImageMetadata[] = useMemo(
    () =>
      images.map((img) => ({
        path: img.file_path,
        proxy_url: `/api/images/${img.id}/file`,
        file_name: img.original_name,
        size_bytes: Number(img.size_bytes),
        format: img.mime_type?.split('/')[1] ?? 'png',
      })),
    [images]
  );

  // Unsaved changes detection
  const hasUnsavedChanges = useCallback(() => {
    if (isDirty) return true;
    if (newlyUploadedImageIds.length > 0) return true;
    if (images.length > 0 && !editMode) return true;
    return false;
  }, [isDirty, newlyUploadedImageIds, images, editMode]);

  // beforeunload listener
  useEffect(() => {
    if (!modal.visible || isSubmitting) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges()) {
        e.preventDefault();
        return '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [modal.visible, isSubmitting, hasUnsavedChanges]);

  // Keyboard shortcuts
  const primaryAction = useCallback(() => {
    if (isSubmitting || !canSubmit) return;
    void form.handleSubmit();
  }, [form, isSubmitting, canSubmit]);

  const shortcutsEnabled =
    modal.visible && !isSubmitting && canSubmit && !showDiscardWarning;

  useKeySubmitTask(primaryAction, {
    enabled: shortcutsEnabled,
    scope: Scope.DIALOG,
    enableOnFormTags: ['input', 'INPUT', 'textarea', 'TEXTAREA'],
    preventDefault: true,
  });

  // Dialog close handling
  const handleDialogClose = (open: boolean) => {
    if (open) return;
    if (hasUnsavedChanges()) {
      setShowDiscardWarning(true);
    } else {
      modal.remove();
    }
  };

  const handleDiscardChanges = () => {
    form.reset();
    setImages([]);
    setNewlyUploadedImageIds([]);
    setShowDiscardWarning(false);
    modal.remove();
  };

  const handleContinueEditing = () => {
    setShowDiscardWarning(false);
  };

  // Manage CONFIRMATION scope when warning is shown
  useEffect(() => {
    if (showDiscardWarning) {
      disableScope(Scope.DIALOG);
      enableScope(Scope.CONFIRMATION);
    } else {
      disableScope(Scope.CONFIRMATION);
      enableScope(Scope.DIALOG);
    }
  }, [showDiscardWarning, enableScope, disableScope]);

  useKeyExit(handleContinueEditing, {
    scope: Scope.CONFIRMATION,
    when: () => modal.visible && showDiscardWarning,
  });

  const loading = branchesLoading || userSystemLoading;
  if (loading) return <></>;

  return (
    <>
      <Dialog
        open={modal.visible}
        onOpenChange={handleDialogClose}
        uncloseable={showDiscardWarning}
        className="max-w-[700px] my-auto"
      >
        <div
          {...getRootProps()}
          className="h-full flex flex-col gap-4 p-4 relative min-h-0"
        >
          <input {...getInputProps()} />
          {/* Drag overlay */}
          {isDragActive && (
            <div className="absolute inset-0 z-50 bg-accent/95 border-2 border-dashed border-foreground/30 rounded-lg flex items-center justify-center pointer-events-none">
              <div className="text-center">
                <ImageIcon className="h-12 w-12 mx-auto mb-2 text-foreground" />
                <p className="text-lg font-medium text-foreground">
                  {'\u5c06\u56fe\u7247\u62d6\u5230\u8fd9\u91cc'}
                </p>
              </div>
            </div>
          )}

          {/* Title */}
          <form.Field name="title">
            {(titleField) => (
              <div className="space-y-1">
                <label htmlFor="task-title" className="text-xs font-medium">
                  {'\u4efb\u52a1\u6807\u9898'}
                </label>
                <input
                  id="task-title"
                  type="text"
                  placeholder="请输入任务标题"
                  value={titleField.state.value}
                  onChange={(e) => titleField.handleChange(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring"
                  autoFocus
                />
              </div>
            )}
          </form.Field>

          {/* Description */}
          <form.Field name="description">
            {(field) => (
              <div className="border p-3">
                <WYSIWYGEditor
                  placeholder={'\u5728\u6b64\u586b\u5199\u4f60\u7684\u4efb\u52a1\u5185\u5bb9'}
                  className="w-full min-h-[360px] max-h-[500px] overflow-auto"
                  value={field.state.value}
                  onChange={(desc) => field.handleChange(desc)}
                  disabled={isSubmitting}
                  repoIds={projectRepos.map((r) => r.id)}
                  projectId={projectId}
                  executorProfile={selectedExecutorProfile}
                  repoId={selectedRepoId}
                  onPasteFiles={onDrop}
                  onCmdEnter={primaryAction}
                  taskId={editMode ? props.task.id : undefined}
                  localImages={localImages}
                />
              </div>
            )}
          </form.Field>

          {/* Edit mode status */}
          {editMode && (
            <form.Field name="status">
              {(field) => (
                <div className="space-y-2">
                  <Label htmlFor="task-status" className="text-sm font-medium">
                    {'\u72b6\u6001'}
                  </Label>
                  <Select
                    value={field.state.value}
                    onValueChange={(value) =>
                      field.handleChange(value as TaskStatus)
                    }
                    disabled={isSubmitting}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="todo">{'\u5f85\u529e'}</SelectItem>
                      <SelectItem value="inprogress">{'\u8fdb\u884c\u4e2d'}</SelectItem>
                      <SelectItem value="inreview">{'\u5ba1\u67e5\u4e2d'}</SelectItem>
                      <SelectItem value="done">{'\u5df2\u5b8c\u6210'}</SelectItem>
                      <SelectItem value="cancelled">{'\u5df2\u53d6\u6d88'}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </form.Field>
          )}

          {/* Create mode dropdowns */}
          {!editMode && (
            <div className="space-y-3">
              <form.Field name="executorProfileId">
                {(field) => (
                  <TerminalProfileControls
                    profiles={profiles}
                    selectedProfile={field.state.value}
                    onChange={field.handleChange}
                    disabled={isSubmitting}
                    className="w-full flex min-w-0 flex-wrap items-center gap-2"
                  />
                )}
              </form.Field>
              {repoBranchConfigs.length === 1 && (
                <div className="flex flex-wrap items-center gap-2">
                  <form.Field name="repoBranches">
                    {(field) => {
                      const config = repoBranchConfigs[0];
                      const selectedBranch =
                        field.state.value.find((v) => v.repoId === config.repoId)
                          ?.branch ?? config.targetBranch;
                      return (
                        <div
                          className={cn(
                            'min-w-[220px] flex-1',
                            isSubmitting && 'opacity-50 pointer-events-none'
                          )}
                        >
                          <BranchSelector
                            branches={config.branches}
                            selectedBranch={selectedBranch}
                            onBranchSelect={(branch) => {
                              field.handleChange([
                                { repoId: config.repoId, branch },
                              ]);
                            }}
                            placeholder={
                              branchesLoading
                                ? '\u52a0\u8f7d\u5206\u652f\u4e2d...'
                                : '\u9009\u62e9\u5206\u652f'
                            }
                          />
                        </div>
                      );
                    }}
                  </form.Field>
                  <form.Field name="useWorktree">
                    {(field) => (
                      <div className="flex items-center gap-2 rounded-md border px-3 py-2">
                        <Switch
                          id="task-use-worktree"
                          checked={field.state.value}
                          onCheckedChange={(checked) =>
                            field.handleChange(checked)
                          }
                          disabled={isSubmitting}
                        />
                        <Label
                          htmlFor="task-use-worktree"
                          className="text-sm cursor-pointer whitespace-nowrap"
                        >
                          {'\u521b\u5efa Worktree'}
                        </Label>
                      </div>
                    )}
                  </form.Field>
                </div>
              )}
              {repoBranchConfigs.length === 1 && (
                <form.Subscribe selector={(state) => state.values.useWorktree}>
                  {(useWorktree) => (
                    <p className="text-xs text-muted-foreground">
                      {useWorktree
                        ? '\u4f1a\u521b\u5efa\u72ec\u7acb\u7684 worktree \u548c\u4efb\u52a1\u5206\u652f\u3002'
                        : '\u5c06\u76f4\u63a5\u5728\u5f53\u524d\u5206\u652f\u4e2d\u6253\u5f00\uff0c\u4e0d\u521b\u5efa worktree\u3002'}
                    </p>
                  )}
                </form.Subscribe>
              )}
              {repoBranchConfigs.length !== 1 && (
                <form.Field name="repoBranches">
                  {(field) => {
                    const configs = repoBranchConfigs.map((config) => ({
                      ...config,
                      targetBranch:
                        field.state.value.find((v) => v.repoId === config.repoId)
                          ?.branch ?? config.targetBranch,
                    }));
                    return (
                      <RepoBranchSelector
                        configs={configs}
                        onBranchChange={(repoId, branch) => {
                          const newValue = field.state.value.map((v) =>
                            v.repoId === repoId ? { ...v, branch } : v
                          );
                          if (!newValue.find((v) => v.repoId === repoId)) {
                            newValue.push({ repoId, branch });
                          }
                          field.handleChange(newValue);
                        }}
                        isLoading={branchesLoading}
                        showLabel={true}
                        className={cn(
                          isSubmitting && 'opacity-50 pointer-events-none'
                        )}
                      />
                    );
                  }}
                </form.Field>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between gap-3">
            {/* Attach Image*/}
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={dropzoneOpen}
                className="h-9 w-9 rounded-md p-0"
                aria-label={'\u6dfb\u52a0\u56fe\u7247'}
              >
                <ImageIcon className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex items-center gap-3">
              {/* Create/Start/Update button*/}
              <form.Subscribe
                selector={(state) => ({
                  canSubmit: state.canSubmit,
                  isSubmitting: state.isSubmitting,
                })}
              >
                {({ canSubmit, isSubmitting }) => {
                  const buttonText = editMode
                    ? isSubmitting
                      ? '\u4fdd\u5b58\u4e2d...'
                      : '\u66f4\u65b0\u4efb\u52a1'
                    : isSubmitting
                      ? '启动中...'
                      : '启动';

                  return (
                    <Button onClick={form.handleSubmit} disabled={!canSubmit}>
                      {buttonText}
                    </Button>
                  );
                }}
              </form.Subscribe>
            </div>
          </div>
        </div>
      </Dialog>
      {showDiscardWarning && (
        <div className="fixed inset-0 z-[10000] flex items-start justify-center p-4 overflow-y-auto">
          <div
            className="fixed inset-0 bg-black/50"
            onClick={() => setShowDiscardWarning(false)}
          />
          <div className="relative z-[10000] grid w-full max-w-lg gap-4 bg-background border p-6 shadow-lg duration-200 sm:rounded-lg my-8">
            <DialogContent className="sm:max-w-[425px]">
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <DialogTitle>{'\u653e\u5f03\u672a\u4fdd\u5b58\u7684\u66f4\u6539\uff1f'}</DialogTitle>
                </div>
                <DialogDescription className="text-left pt-2">
                  {'\u60a8\u6709\u672a\u4fdd\u5b58\u7684\u66f4\u6539\uff0c\u786e\u5b9a\u8981\u653e\u5f03\u5417\uff1f'}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={handleContinueEditing}>
                  {'\u7ee7\u7eed\u7f16\u8f91'}
                </Button>
                <Button variant="destructive" onClick={handleDiscardChanges}>
                  {'\u653e\u5f03\u66f4\u6539'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </div>
        </div>
      )}
    </>
  );
});

export const TaskFormDialog = defineModal<TaskFormDialogProps, void>(
  TaskFormDialogImpl
);
