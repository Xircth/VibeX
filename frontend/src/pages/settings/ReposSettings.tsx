import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';import { isEqual } from 'lodash';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2 } from 'lucide-react';
import { useScriptPlaceholders } from '@/hooks/useScriptPlaceholders';
import { AutoExpandingTextarea } from '@/components/ui/auto-expanding-textarea';
import { MultiFileSearchTextarea } from '@/components/ui/multi-file-search-textarea';
import { repoApi } from '@/lib/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Repo, UpdateRepo } from 'shared/types';

interface RepoScriptsFormState {
  display_name: string;
  setup_script: string;
  parallel_setup_script: boolean;
  cleanup_script: string;
  copy_files: string;
  dev_server_script: string;
}

function repoToFormState(repo: Repo): RepoScriptsFormState {
  return {
    display_name: repo.display_name,
    setup_script: repo.setup_script ?? '',
    parallel_setup_script: repo.parallel_setup_script,
    cleanup_script: repo.cleanup_script ?? '',
    copy_files: repo.copy_files ?? '',
    dev_server_script: repo.dev_server_script ?? '',
  };
}

export function ReposSettings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const repoIdParam = searchParams.get('repoId') ?? '';  const queryClient = useQueryClient();

  // Fetch all repos
  const {
    data: repos,
    isLoading: reposLoading,
    error: reposError,
  } = useQuery({
    queryKey: ['repos'],
    queryFn: () => repoApi.list(),
  });

  // Selected repo state
  const [selectedRepoId, setSelectedRepoId] = useState<string>(repoIdParam);
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);

  // Form state
  const [draft, setDraft] = useState<RepoScriptsFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Get OS-appropriate script placeholders
  const placeholders = useScriptPlaceholders();

  // Check for unsaved changes
  const hasUnsavedChanges = useMemo(() => {
    if (!draft || !selectedRepo) return false;
    return !isEqual(draft, repoToFormState(selectedRepo));
  }, [draft, selectedRepo]);

  // Handle repo selection from dropdown
  const handleRepoSelect = useCallback(
    (id: string) => {
      if (id === selectedRepoId) return;

      if (hasUnsavedChanges) {
        const confirmed = window.confirm(
          '您有未保存的更改。您确定要切换仓库吗？您的更改将丢失。'
        );
        if (!confirmed) return;
        setDraft(null);
        setSelectedRepo(null);
        setSuccess(false);
        setError(null);
      }

      setSelectedRepoId(id);
      if (id) {
        setSearchParams({ repoId: id });
      } else {
        setSearchParams({});
      }
    },
    [hasUnsavedChanges, selectedRepoId, setSearchParams]
  );

  // Sync selectedRepoId when URL changes
  useEffect(() => {
    if (repoIdParam === selectedRepoId) return;

    if (hasUnsavedChanges) {
      const confirmed = window.confirm('您有未保存的更改。您确定要切换仓库吗？您的更改将丢失。');
      if (!confirmed) {
        if (selectedRepoId) {
          setSearchParams({ repoId: selectedRepoId });
        } else {
          setSearchParams({});
        }
        return;
      }
      setDraft(null);
      setSelectedRepo(null);
      setSuccess(false);
      setError(null);
    }

    setSelectedRepoId(repoIdParam);
  }, [repoIdParam, hasUnsavedChanges, selectedRepoId, setSearchParams]);

  // Populate draft from server data
  useEffect(() => {
    if (!repos) return;

    const nextRepo = selectedRepoId
      ? repos.find((r) => r.id === selectedRepoId)
      : null;

    setSelectedRepo((prev) =>
      prev?.id === nextRepo?.id ? prev : (nextRepo ?? null)
    );

    if (!nextRepo) {
      if (!hasUnsavedChanges) setDraft(null);
      return;
    }

    if (hasUnsavedChanges) return;

    setDraft(repoToFormState(nextRepo));
  }, [repos, selectedRepoId, hasUnsavedChanges]);

  // Warn on tab close/navigation with unsaved changes
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedChanges]);

  const handleSave = async () => {
    if (!draft || !selectedRepo) return;

    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const updateData: UpdateRepo = {
        display_name: draft.display_name.trim() || null,
        setup_script: draft.setup_script.trim() || null,
        cleanup_script: draft.cleanup_script.trim() || null,
        copy_files: draft.copy_files.trim() || null,
        parallel_setup_script: draft.parallel_setup_script,
        dev_server_script: draft.dev_server_script.trim() || null,
      };

      const updatedRepo = await repoApi.update(selectedRepo.id, updateData);
      setSelectedRepo(updatedRepo);
      setDraft(repoToFormState(updatedRepo));
      queryClient.setQueryData(['repos'], (old: Repo[] | undefined) =>
        old?.map((r) => (r.id === updatedRepo.id ? updatedRepo : r))
      );
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : '保存仓库设置失败'
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    if (!selectedRepo) return;
    setDraft(repoToFormState(selectedRepo));
  };

  const updateDraft = (updates: Partial<RepoScriptsFormState>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, ...updates };
    });
  };

  if (reposLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-8 w-8 animate-spin" />
        <span className="ml-2">{'加载仓库中...'}</span>
      </div>
    );
  }

  if (reposError) {
    return (
      <div className="py-8">
        <Alert variant="destructive">
          <AlertDescription>
            {reposError instanceof Error
              ? reposError.message
              : '加载仓库失败。'}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert variant="success">
          <AlertDescription className="font-medium">
            {'仓库设置保存成功！'}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{'仓库配置'}</CardTitle>
          <CardDescription>{'配置此仓库在工作区中使用时运行的脚本。'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="repo-selector">
              {'选择仓库'}
            </Label>
            <Select value={selectedRepoId} onValueChange={handleRepoSelect}>
              <SelectTrigger id="repo-selector">
                <SelectValue
                  placeholder={'选择要配置的仓库'}
                />
              </SelectTrigger>
              <SelectContent>
                {repos && repos.length > 0 ? (
                  repos.map((repo) => (
                    <SelectItem key={repo.id} value={repo.id}>
                      {repo.display_name}
                    </SelectItem>
                  ))
                ) : (
                  <SelectItem value="no-repos" disabled>
                    {'没有可用的仓库'}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              {'选择仓库以查看和编辑其配置。'}
            </p>
          </div>
        </CardContent>
      </Card>

      {selectedRepo && draft && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{'常规设置'}</CardTitle>
              <CardDescription>
                {'配置仓库基本信息。'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="display-name">
                  {'显示名称'}
                </Label>
                <Input
                  id="display-name"
                  type="text"
                  value={draft.display_name}
                  onChange={(e) =>
                    updateDraft({ display_name: e.target.value })
                  }
                  placeholder={'输入显示名称'}
                />
                <p className="text-sm text-muted-foreground">
                  {'此仓库的友好名称。'}
                </p>
              </div>

              <div className="space-y-2">
                <Label>{'仓库路径'}</Label>
                <div className="text-sm text-muted-foreground font-mono bg-muted px-3 py-2 rounded-md">
                  {selectedRepo.path}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{'脚本和配置'}</CardTitle>
              <CardDescription>
                {'配置此仓库的设置脚本、清理脚本和要复制的文件。这些脚本在仓库用于任何工作区时都会运行。'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="dev-server-script">
                  {'开发服务器脚本'}
                </Label>
                <AutoExpandingTextarea
                  id="dev-server-script"
                  value={draft.dev_server_script}
                  onChange={(e) =>
                    updateDraft({
                      dev_server_script: e.target.value,
                    })
                  }
                  placeholder={placeholders.dev}
                  maxRows={12}
                  className="w-full px-3 py-2 border border-input bg-background text-foreground rounded-md focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                />
                <p className="text-sm text-muted-foreground">
                  {'为此仓库启动开发服务器。脚本从仓库的工作树目录执行。'}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="setup-script">
                  {'设置脚本'}
                </Label>
                <AutoExpandingTextarea
                  id="setup-script"
                  value={draft.setup_script}
                  onChange={(e) =>
                    updateDraft({ setup_script: e.target.value })
                  }
                  placeholder={placeholders.setup}
                  maxRows={12}
                  className="w-full px-3 py-2 border border-input bg-background text-foreground rounded-md focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                />
                <p className="text-sm text-muted-foreground">
                  {'此脚本从工作树内部运行，在创建后、编码代理启动前执行。用于设置任务，如安装依赖项或准备环境。'}
                </p>

                <div className="flex items-center space-x-2 pt-2">
                  <Checkbox
                    id="parallel-setup-script"
                    checked={draft.parallel_setup_script}
                    onCheckedChange={(checked) =>
                      updateDraft({
                        parallel_setup_script: checked === true,
                      })
                    }
                    disabled={!draft.setup_script.trim()}
                  />
                  <Label
                    htmlFor="parallel-setup-script"
                    className="text-sm font-normal cursor-pointer"
                  >
                    {'与编码代理并行运行设置脚本'}
                  </Label>
                </div>
                <p className="text-sm text-muted-foreground pl-6">
                  {'启用后，设置脚本将与编码代理同时运行，而不是等待设置完成后再启动。'}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="cleanup-script">
                  {'清理脚本'}
                </Label>
                <AutoExpandingTextarea
                  id="cleanup-script"
                  value={draft.cleanup_script}
                  onChange={(e) =>
                    updateDraft({
                      cleanup_script: e.target.value,
                    })
                  }
                  placeholder={placeholders.cleanup}
                  maxRows={12}
                  className="w-full px-3 py-2 border border-input bg-background text-foreground rounded-md focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                />
                <p className="text-sm text-muted-foreground">
                  {'此脚本从工作树内部运行，在编码代理执行后执行（仅在进行了更改时）。用于质量保证任务，如运行 linter、格式化程序、测试或其他验证步骤。'}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="copy-files">
                  {'复制文件'}
                </Label>
                <MultiFileSearchTextarea
                  value={draft.copy_files}
                  onChange={(value) => updateDraft({ copy_files: value })}
                  placeholder={'文件路径或 glob 模式（例如：.env、config/*.json）'}
                  maxRows={6}
                  repoId={selectedRepo.id}
                  className="w-full px-3 py-2 border border-input bg-background text-foreground rounded-md focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                />
                <p className="text-sm text-muted-foreground">
                  {'要从原始仓库目录复制到工作树的文件的逗号分隔列表。对 .env 等环境文件很有用。确保这些文件被 gitignore！'}
                </p>
              </div>

              {/* Save Buttons */}
              <div className="flex items-center justify-between pt-4 border-t">
                {hasUnsavedChanges ? (
                  <span className="text-sm text-muted-foreground">
                    {'您有未保存的更改'}
                  </span>
                ) : (
                  <span />
                )}
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={handleDiscard}
                    disabled={!hasUnsavedChanges || saving}
                  >
                    {'放弃'}
                  </Button>
                  <Button
                    onClick={handleSave}
                    disabled={!hasUnsavedChanges || saving}
                  >
                    {saving && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    {'保存仓库设置'}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
