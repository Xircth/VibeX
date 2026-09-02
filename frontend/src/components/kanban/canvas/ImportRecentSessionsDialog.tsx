import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import {
  getExecutorDisplayName,
  sessionListAgentKey,
} from '@/components/kanban/session-hub/utils';
import {
  DEFAULT_RECENT_SESSION_DAYS,
  RECENT_SESSION_DAY_OPTIONS,
  filterRecentSessions,
  type RecentSessionDays,
} from './canvasModel';

export type CanvasImportMode = 'recent' | 'project' | 'agent';

interface ImportRecentSessionsDialogProps {
  open: boolean;
  mode?: CanvasImportMode;
  projectName?: string;
  sessions: KanbanProjectSessionRecord[];
  presentSessionIds: ReadonlySet<string>;
  onOpenChange: (open: boolean) => void;
  onImport: (sessionIds: string[], groupName: string) => void;
}

export function ImportRecentSessionsDialog({
  open,
  mode = 'recent',
  projectName = '',
  sessions,
  presentSessionIds,
  onOpenChange,
  onImport,
}: ImportRecentSessionsDialogProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const [days, setDays] = useState<RecentSessionDays>(
    DEFAULT_RECENT_SESSION_DAYS
  );
  const agents = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of sessions) {
      const key = sessionListAgentKey(session);
      if (!key || map.has(key)) continue;
      map.set(key, getExecutorDisplayName(key));
    }
    return [...map.entries()].map(([id, label]) => ({ id, label }));
  }, [sessions]);
  const [agentId, setAgentId] = useState<string>('');

  const title =
    mode === 'project'
      ? t('hubCanvas.importByProject')
      : mode === 'agent'
        ? t('hubCanvas.importByAgent')
        : t('hubCanvas.importByRecent');

  const candidates = useMemo(() => {
    return filterRecentSessions(sessions, days).filter((session) => {
      if (presentSessionIds.has(session.id)) return false;
      if (mode === 'agent') {
        const selected = agentId || agents[0]?.id;
        return sessionListAgentKey(session) === selected;
      }
      return true;
    });
  }, [agentId, agents, days, mode, presentSessionIds, sessions]);

  const groupName =
    mode === 'project'
      ? projectName || t('hubCanvas.importByProject')
      : mode === 'agent'
        ? (agents.find((agent) => agent.id === (agentId || agents[0]?.id))
            ?.label ?? t('hubCanvas.importByAgent'))
        : t('hubCanvas.importRecentGroup', { count: days });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {t('hubCanvas.importRecentDescription')}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        {mode === 'project' ? (
          <div className="flex items-center justify-between gap-3">
            <Label>{t('hubCanvas.importProject')}</Label>
            <span className="text-sm font-medium">{projectName}</span>
          </div>
        ) : null}
        {mode === 'agent' ? (
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="canvas-import-agent">
              {t('hubCanvas.importAgent')}
            </Label>
            <Select
              value={agentId || agents[0]?.id || ''}
              onValueChange={setAgentId}
            >
              <SelectTrigger id="canvas-import-agent" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="canvas-import-days">
            {t('hubCanvas.importRange')}
          </Label>
          <Select
            value={String(days)}
            onValueChange={(value) =>
              setDays(Number(value) as RecentSessionDays)
            }
          >
            <SelectTrigger id="canvas-import-days" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RECENT_SESSION_DAY_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {t('hubCanvas.importDays', { count: option })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-sm text-muted-foreground">
          {candidates.length === 0
            ? t('hubCanvas.importEmpty')
            : t('hubCanvas.importCount', { count: candidates.length })}
        </p>
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          onClick={() => onOpenChange(false)}
        >
          {t('common:cancel')}
        </Button>
        <Button
          type="submit"
          disabled={candidates.length === 0}
          onClick={() => {
            onImport(
              candidates.map((session) => session.id),
              groupName
            );
            onOpenChange(false);
          }}
        >
          {t('hubCanvas.importConfirm')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
