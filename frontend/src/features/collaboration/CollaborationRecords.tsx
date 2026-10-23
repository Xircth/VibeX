import { Check, ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type {
  AgentSessionControlsSnapshot,
  ExecutorProfileId,
} from 'shared/types';

import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { SessionControlsFields } from '@/components/sessions/SessionControlsFields';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { loadAgentSessionControlsCatalog } from '@/features/agents/sessionControlsQuery';

import { collaborationCall } from './collaborationApi';
import { COPY, surfaceErrorCopy } from './spaceModel';
import './collaboration.css';

type Team = { id: string; name: string; summary?: string | null };
type Role = {
  id: string;
  name: string;
  team_id?: string | null;
  summary: string;
  persona_prompt: string;
  agent_id: string;
  mode_id?: string | null;
  config_values?: Record<string, string>;
};
type AgentOption = { agent_id: string; name: string };

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

function RoleControls({
  agentId,
  modeId,
  values,
  onModeId,
  onValues,
}: {
  agentId: string;
  modeId: string;
  values: Record<string, string>;
  onModeId: (modeId: string) => void;
  onValues: (values: Record<string, string>) => void;
}) {
  const [catalog, setCatalog] = useState<AgentSessionControlsSnapshot | null>(
    null
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!agentId) {
      setFailed(true);
      return;
    }
    let active = true;
    setFailed(false);
    setCatalog(null);
    void loadAgentSessionControlsCatalog(agentId)
      .then((next) => {
        if (active) setCatalog(next);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [agentId]);

  if (!agentId || failed) {
    return <p className="settings-row__description">{COPY.controlsUnavailable}</p>;
  }
  if (!catalog) return null;
  return (
    <SessionControlsFields
      modes={catalog.modes}
      currentModeId={catalog.current_mode ?? null}
      configOptions={catalog.config_options}
      selectedModeId={modeId || null}
      pendingConfigValues={values}
      onSelectMode={onModeId}
      onSelectConfigValue={(key, value) => {
        const next = { ...values };
        if (value) next[key] = value;
        else delete next[key];
        onValues(next);
      }}
    />
  );
}

export function CollaborationRecords() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [error, setError] = useState('');
  const [teamName, setTeamName] = useState('');
  const [teamSummary, setTeamSummary] = useState('');
  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Role | null>(null);

  const load = useCallback(async () => {
    const [teamPage, rolePage, agentPage] = await Promise.all([
      collaborationCall<{ teams?: Team[] }>('collaboration', 'team.list'),
      collaborationCall<{ roles?: Role[] }>('collaboration', 'role.list'),
      collaborationCall<{ agents?: AgentOption[] }>(
        'collaboration',
        'role.agents'
      ),
    ]);
    setTeams(teamPage.teams ?? []);
    setRoles(
      (rolePage.roles ?? []).map((role) => ({
        ...role,
        config_values: stringRecord(role.config_values),
      }))
    );
    setAgents(agentPage.agents ?? []);
  }, []);

  useEffect(() => {
    void load().catch((cause: unknown) => setError(surfaceErrorCopy(cause)));
  }, [load]);

  const createTeam = async () => {
    if (!teamName.trim()) return;
    await collaborationCall('collaboration', 'team.create', {
      name: teamName.trim(),
      summary: teamSummary.trim(),
    });
    setTeamName('');
    setTeamSummary('');
    await load();
  };

  return (
    <div className="collaboration-records">
      {error ? <p className="collaboration-error">{error}</p> : null}
      <section className="space-y-2">
        <h3 className="text-sm font-medium">团队</h3>
        {teams.length === 0 ? (
          <p className="settings-row__description">{COPY.emptyTeams}</p>
        ) : (
          teams.map((team) => (
            <TeamRow
              key={team.id}
              team={team}
              onRename={async (name, summary) => {
                await collaborationCall('collaboration', 'team.update', {
                  id: team.id,
                  name,
                  summary,
                });
                await load();
              }}
              onDelete={async () => {
                await collaborationCall('collaboration', 'team.delete', {
                  id: team.id,
                });
                await load();
              }}
              onError={setError}
            />
          ))
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="团队名称"
            placeholder="团队名称"
            value={teamName}
            onChange={(event) => setTeamName(event.target.value)}
          />
          <Input
            aria-label="团队简介"
            placeholder="简介"
            value={teamSummary}
            onChange={(event) => setTeamSummary(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              void createTeam().catch((cause: unknown) =>
                setError(surfaceErrorCopy(cause))
              )
            }
          >
            {COPY.newTeam}
          </Button>
        </div>
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-medium">角色</h3>
        {roles.length === 0 ? (
          <p className="settings-row__description">{COPY.emptyRoles}</p>
        ) : (
          roles.map((role) => (
            <div className="collaboration-record-card" key={role.id}>
              <span>
                {role.name}
                <small className="settings-row__description"> {role.agent_id}</small>
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setEditingRole(role)}
              >
                编辑
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setPendingDelete(role)}
              >
                删除
              </Button>
            </div>
          ))
        )}
        <Button
          type="button"
          size="sm"
          onClick={() =>
            setEditingRole({
              id: '',
              name: '',
              summary: '',
              persona_prompt: '',
              agent_id: agents[0]?.agent_id ?? '',
              config_values: {},
            })
          }
        >
          {COPY.newRole}
        </Button>
        {agents.length === 0 ? (
          <p className="settings-row__description">{COPY.emptyAgents}</p>
        ) : null}
        {pendingDelete ? (
          <div role="dialog" aria-label="删除角色" className="space-y-2">
            <p>{COPY.deleteRole}</p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  const role = pendingDelete;
                  setPendingDelete(null);
                  void collaborationCall('collaboration', 'role.delete', {
                    id: role.id,
                  })
                    .then(load)
                    .catch((cause: unknown) => setError(surfaceErrorCopy(cause)));
                }}
              >
                删除
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setPendingDelete(null)}
              >
                取消
              </Button>
            </div>
          </div>
        ) : null}
        {editingRole ? (
          <RoleEditor
            key={editingRole.id || 'new'}
            role={editingRole}
            teams={teams}
            agents={agents}
            onCancel={() => setEditingRole(null)}
            onSave={async (draft) => {
              await collaborationCall(
                'collaboration',
                draft.id ? 'role.update' : 'role.create',
                {
                  ...(draft.id ? { id: draft.id } : {}),
                  name: draft.name,
                  teamId: draft.team_id ?? '',
                  summary: draft.summary,
                  personaPrompt: draft.persona_prompt,
                  agentId: draft.agent_id,
                  modeId: draft.mode_id ?? '',
                  configValues: draft.config_values ?? {},
                }
              );
              setEditingRole(null);
              await load();
            }}
            onError={setError}
          />
        ) : null}
      </section>
    </div>
  );
}

function TeamRow({
  team,
  onRename,
  onDelete,
  onError,
}: {
  team: Team;
  onRename: (name: string, summary: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(team.name);
  const [summary, setSummary] = useState(team.summary ?? '');
  return (
    <div className="collaboration-record-card">
      <Input
        aria-label={`${team.name} 名称`}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <Input
        aria-label={`${team.name} 简介`}
        value={summary}
        onChange={(event) => setSummary(event.target.value)}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() =>
          void onRename(name.trim(), summary.trim()).catch((cause: unknown) =>
            onError(surfaceErrorCopy(cause))
          )
        }
      >
        重命名
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() =>
          void onDelete().catch((cause: unknown) =>
            onError(surfaceErrorCopy(cause))
          )
        }
      >
        删除
      </Button>
    </div>
  );
}

function RoleEditor({
  role,
  teams,
  agents,
  onCancel,
  onSave,
  onError,
}: {
  role: Role;
  teams: Team[];
  agents: AgentOption[];
  onCancel: () => void;
  onSave: (role: Role) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState(role);
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(draft).catch((cause: unknown) =>
          onError(surfaceErrorCopy(cause))
        );
      }}
    >
      <div className="collaboration-record-fields">
        <Label htmlFor="role-name">名称</Label>
        <Input
          id="role-name"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <Label htmlFor="role-team">团队</Label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              id="role-team"
              type="button"
              variant="outline"
              role="combobox"
              aria-label="团队"
              className="raised-control h-8 w-full justify-between px-2.5 text-[13px] font-normal"
            >
              <span className="truncate">
                {teams.find((team) => team.id === draft.team_id)?.name ?? '无'}
              </span>
              <ChevronDown
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[180px]"
          >
            <DropdownMenuItem
              data-state={!draft.team_id ? 'checked' : undefined}
              onSelect={() => setDraft({ ...draft, team_id: null })}
            >
              <span className="flex-1 truncate">无</span>
              {!draft.team_id ? (
                <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              ) : null}
            </DropdownMenuItem>
            {teams.map((team) => {
              const selected = draft.team_id === team.id;
              return (
                <DropdownMenuItem
                  key={team.id}
                  data-state={selected ? 'checked' : undefined}
                  onSelect={() => setDraft({ ...draft, team_id: team.id })}
                >
                  <span className="flex-1 truncate">{team.name}</span>
                  {selected ? (
                    <Check
                      className="h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
        <Label htmlFor="role-summary">简介</Label>
        <Input
          id="role-summary"
          value={draft.summary}
          onChange={(event) =>
            setDraft({ ...draft, summary: event.target.value })
          }
        />
        <Label htmlFor="role-persona">人设提示词</Label>
        <Textarea
          id="role-persona"
          value={draft.persona_prompt}
          onChange={(event) =>
            setDraft({ ...draft, persona_prompt: event.target.value })
          }
        />
        <Label htmlFor="role-agent">Agent</Label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              id="role-agent"
              type="button"
              variant="outline"
              role="combobox"
              aria-label="Agent"
              className="raised-control h-8 w-full justify-between px-2.5 text-[13px] font-normal"
            >
              <span className="flex min-w-0 items-center gap-2 truncate">
                {draft.agent_id ? (
                  <AgentIcon
                    agent={draft.agent_id as ExecutorProfileId['executor']}
                    className="h-3.5 w-3.5 shrink-0"
                  />
                ) : null}
                <span className="truncate">
                  {getAgentName(draft.agent_id) ||
                    agents.find((agent) => agent.agent_id === draft.agent_id)
                      ?.name ||
                    draft.agent_id}
                </span>
              </span>
              <ChevronDown
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[180px]"
          >
            {agents.map((agent) => {
              const selected = draft.agent_id === agent.agent_id;
              return (
                <DropdownMenuItem
                  key={agent.agent_id}
                  data-state={selected ? 'checked' : undefined}
                  onSelect={() =>
                    setDraft({ ...draft, agent_id: agent.agent_id })
                  }
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
                    <AgentIcon
                      agent={agent.agent_id as ExecutorProfileId['executor']}
                      className="h-3.5 w-3.5 shrink-0"
                    />
                    <span className="truncate">
                      {getAgentName(agent.agent_id) || agent.name}
                    </span>
                  </span>
                  {selected ? (
                    <Check
                      className="h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <RoleControls
        agentId={draft.agent_id}
        modeId={draft.mode_id ?? ''}
        values={draft.config_values ?? {}}
        onModeId={(modeId) => setDraft({ ...draft, mode_id: modeId })}
        onValues={(configValues) =>
          setDraft({ ...draft, config_values: configValues })
        }
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          保存
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}
