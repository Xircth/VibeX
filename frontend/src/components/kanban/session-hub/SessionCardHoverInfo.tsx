import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExecutorProfileId } from 'shared/types';
import { AgentIcon } from '@/components/agents/AgentIcon';
import { toast } from '@/components/ui/toast';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useOptionalProject } from '@/contexts/ProjectContext';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { cn } from '@/lib/utils';
import { writeClipboardViaBridge } from '@/vscode/bridge';
import { getExecutorDisplayName, sessionListAgentKey } from './utils';

export type SessionCardHoverCopyKind =
  | 'name'
  | 'project'
  | 'workspace'
  | 'path';

export interface SessionCardHoverDetails {
  name: string;
  agentKey: string | null;
  agentName: string;
  model: string | null;
  projectName: string;
  workspaceLabel: string;
  path: string;
}

export function sessionCardHoverDetails(
  session: Pick<
    KanbanProjectSessionRecord,
    | 'fullName'
    | 'agentId'
    | 'executor'
    | 'model'
    | 'workspaceName'
    | 'branch'
    | 'workspace'
  >,
  name: string,
  project?: { name: string; root_path: string } | null
): SessionCardHoverDetails {
  const agentKey = sessionListAgentKey(session);
  return {
    name,
    agentKey,
    agentName: getExecutorDisplayName(agentKey),
    model: session.model?.trim() || null,
    projectName: project?.name?.trim() || '',
    workspaceLabel:
      session.workspaceName?.trim() || session.branch?.trim() || '',
    path:
      session.workspace.container_ref?.trim() ||
      session.workspace.agent_working_dir?.trim() ||
      project?.root_path?.trim() ||
      '',
  };
}

function copyToastKey(kind: SessionCardHoverCopyKind) {
  switch (kind) {
    case 'name':
      return 'hubListItem.copiedSessionName';
    case 'project':
      return 'hubListItem.copiedProject';
    case 'workspace':
      return 'hubListItem.copiedWorkspace';
    case 'path':
      return 'hubListItem.copiedPath';
  }
}

export function SessionCardHoverInfo({
  name,
  agentKey,
  agentName,
  model,
  projectName,
  workspaceLabel,
  path,
}: SessionCardHoverDetails) {
  const { t } = useTranslation('tasks');

  const copy = (value: string, kind: SessionCardHoverCopyKind) => {
    if (!value) return;
    void writeClipboardViaBridge(value);
    toast.success(t(copyToastKey(kind)));
  };

  return (
    <div
      className="session-card-hover-body"
      data-testid="session-card-hover-info"
    >
      <button
        type="button"
        className="session-card-hover-name"
        data-testid="session-card-hover-copy-name"
        onClick={() => copy(name, 'name')}
      >
        {name}
      </button>
      <div className="session-card-hover-agent">
        {agentKey ? (
          <AgentIcon
            agent={agentKey as ExecutorProfileId['executor']}
            className="h-3.5 w-3.5"
          />
        ) : null}
        <span>{agentName}</span>
      </div>
      {model ? <div className="session-card-hover-model">· {model}</div> : null}
      <div className="session-card-hover-meta">
        <HoverCopyField
          kind="project"
          label={t('hubListItem.sessionInfoProject')}
          value={projectName}
          onCopy={() => copy(projectName, 'project')}
        />
        <HoverCopyField
          kind="workspace"
          label={t('hubListItem.sessionInfoWorkspace')}
          value={workspaceLabel}
          onCopy={() => copy(workspaceLabel, 'workspace')}
        />
        <HoverCopyField
          kind="path"
          label={t('hubListItem.sessionInfoPath')}
          value={path}
          onCopy={() => copy(path, 'path')}
        />
      </div>
    </div>
  );
}

export function SessionCardHoverCard({
  children,
  details,
  enabled = true,
}: {
  children: ReactNode;
  details: SessionCardHoverDetails;
  enabled?: boolean;
}) {
  if (!enabled) {
    return children;
  }

  return (
    <Tooltip delayDuration={280} disableHoverableContent={false}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        sideOffset={8}
        className="session-card-hover-info"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <SessionCardHoverInfo {...details} />
      </TooltipContent>
    </Tooltip>
  );
}

export function useSessionCardHoverDetails(
  session: KanbanProjectSessionRecord,
  name: string
): SessionCardHoverDetails {
  const project = useOptionalProject()?.project;
  return sessionCardHoverDetails(session, name, project ?? null);
}

function HoverCopyField({
  kind,
  label,
  value,
  onCopy,
}: {
  kind: Exclude<SessionCardHoverCopyKind, 'name'>;
  label: string;
  value: string;
  onCopy: () => void;
}) {
  return (
    <div className="session-card-hover-field">
      <div className="session-card-hover-label">{label}</div>
      <button
        type="button"
        className={cn('session-card-hover-value', !value && 'is-empty')}
        data-testid={`session-card-hover-copy-${kind}`}
        disabled={!value}
        onClick={onCopy}
      >
        {value || '—'}
      </button>
    </div>
  );
}
