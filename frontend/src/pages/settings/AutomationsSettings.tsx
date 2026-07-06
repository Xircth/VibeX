import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Clock, Play, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsPageHeader, SettingsSection } from './SettingsUi';
import { useProjects } from '@/hooks/useProjects';
import { automationApi } from '@/lib/api/automations';
import type { Automation, AutomationInput, AutomationRun } from 'shared/types';

const EXECUTORS = ['CLAUDE_CODE', 'CODEX', 'OPENCODE'] as const;

function emptyInput(projectId: string): AutomationInput {
  return {
    name: '',
    project_id: projectId,
    executor: 'CLAUDE_CODE',
    prompt: '',
    isolation: 'in_place',
    trigger_kind: 'manual',
    cron: null,
    enabled: true,
  };
}

export function AutomationsSettings() {
  const { projects } = useProjects();
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [draft, setDraft] = useState<AutomationInput | null>(null);
  const [runsByAutomation, setRunsByAutomation] = useState<
    Record<string, AutomationRun[]>
  >({});
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setAutomations(await automationApi.list());
    } catch (error) {
      toast.error(`加载自动化失败：${error}`);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const startNew = () => {
    const projectId = projects[0]?.id ?? '';
    setDraft(emptyInput(projectId));
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.prompt.trim()) {
      toast.error('请填写名称与提示词');
      return;
    }
    if (!draft.project_id) {
      toast.error('请选择项目');
      return;
    }
    if (draft.trigger_kind === 'cron' && !draft.cron?.trim()) {
      toast.error('定时触发需要填写 cron 表达式');
      return;
    }
    setBusy(true);
    try {
      await automationApi.create(draft);
      toast.success('已创建自动化');
      setDraft(null);
      await reload();
    } catch (error) {
      toast.error(`保存失败：${error}`);
    } finally {
      setBusy(false);
    }
  };

  const runNow = async (automation: Automation) => {
    try {
      await automationApi.runNow(automation.id);
      toast.success('已触发运行');
      await loadRuns(automation.id);
    } catch (error) {
      toast.error(`运行失败：${error}`);
    }
  };

  const toggle = async (automation: Automation, enabled: boolean) => {
    try {
      await automationApi.setEnabled(automation.id, enabled);
      await reload();
    } catch (error) {
      toast.error(`操作失败：${error}`);
    }
  };

  const remove = async (automation: Automation) => {
    try {
      await automationApi.remove(automation.id);
      await reload();
    } catch (error) {
      toast.error(`删除失败：${error}`);
    }
  };

  const loadRuns = useCallback(async (automationId: string) => {
    try {
      const runs = await automationApi.runs(automationId, 5);
      setRunsByAutomation((prev) => ({ ...prev, [automationId]: runs }));
    } catch {
      // ignore
    }
  }, []);

  const patchDraft = (patch: Partial<AutomationInput>) =>
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title="自动化"
        description="把一次“发起回合”存为可复用的自动化，手动或按 cron 定时无头运行；运行会创建真实会话，可在工作区打开查看。"
      />

      <SettingsSection
        icon={Clock}
        title="自动化"
        description="应用运行时才会触发；错过的定时不补跑。"
      >
        <div className="mb-3">
          {draft ? null : (
            <Button size="sm" variant="outline" onClick={startNew}>
              <Plus className="mr-1 h-4 w-4" />
              新建自动化
            </Button>
          )}
        </div>

        {draft ? (
          <div className="mb-4 space-y-3 rounded-[10px] border border-border p-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">名称</label>
                <Input
                  value={draft.name}
                  onChange={(e) => patchDraft({ name: e.target.value })}
                  placeholder="如：夜间跑测试"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">项目</label>
                <Select
                  value={draft.project_id}
                  onValueChange={(v) => patchDraft({ project_id: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择项目" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium">提示词</label>
              <Textarea
                value={draft.prompt}
                onChange={(e) => patchDraft({ prompt: e.target.value })}
                placeholder="要让 agent 做什么…"
                rows={3}
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">执行器</label>
                <Select
                  value={draft.executor ?? 'CLAUDE_CODE'}
                  onValueChange={(v) => patchDraft({ executor: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXECUTORS.map((ex) => (
                      <SelectItem key={ex} value={ex}>
                        {ex}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">触发</label>
                <Select
                  value={draft.trigger_kind}
                  onValueChange={(v) =>
                    patchDraft({
                      trigger_kind: v,
                      cron: v === 'cron' ? (draft.cron ?? '0 3 * * *') : null,
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">手动</SelectItem>
                    <SelectItem value="cron">定时 (cron)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">cron（本地时间）</label>
                <Input
                  value={draft.cron ?? ''}
                  onChange={(e) => patchDraft({ cron: e.target.value })}
                  placeholder="0 3 * * *"
                  disabled={draft.trigger_kind !== 'cron'}
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground">
                v1 在项目根工作区就地运行（不隔离 worktree）。
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                  取消
                </Button>
                <Button size="sm" onClick={() => void save()} disabled={busy}>
                  保存
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        {automations.length === 0 ? (
          <p className="text-xs text-muted-foreground">暂无自动化。</p>
        ) : (
          <ul className="space-y-2">
            {automations.map((automation) => (
              <li
                key={automation.id}
                className="rounded-[10px] border border-border p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {automation.name}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {automation.trigger_kind === 'cron'
                        ? `cron ${automation.cron}`
                        : '手动'}{' '}
                      · {automation.executor ?? '默认'}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Switch
                      checked={automation.enabled}
                      onCheckedChange={(v) => void toggle(automation, v)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => void runNow(automation)}
                    >
                      <Play className="mr-1 h-3.5 w-3.5" />
                      运行
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => void loadRuns(automation.id)}
                    >
                      历史
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-destructive"
                      onClick={() => void remove(automation)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {runsByAutomation[automation.id]?.length ? (
                  <ul className="mt-2 space-y-1 border-t border-border pt-2">
                    {runsByAutomation[automation.id].map((run) => (
                      <li
                        key={run.id}
                        className="flex items-center justify-between text-[11px] text-muted-foreground"
                      >
                        <span>{run.started_at}</span>
                        <span
                          className={
                            run.status === 'failed' ||
                            run.status === 'interrupted'
                              ? 'text-destructive'
                              : ''
                          }
                        >
                          {run.status}
                          {run.error ? `：${run.error}` : ''}
                          {run.summary ? `：${run.summary}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    </div>
  );
}
