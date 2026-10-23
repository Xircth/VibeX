import {
  Check,
  ChevronDown,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type {
  AgentManagementView,
  AgentSessionControlsSnapshot,
  Config,
  ExecutorProfileId,
  MultiAgentAgentDefault,
} from 'shared/types';

import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { SessionControlsFields } from '@/components/sessions/SessionControlsFields';
import { AgentSessionConfigPicker } from '@/components/settings/AgentSessionConfigPicker';
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
import { toast } from '@/components/ui/toast';
import { usePortalContainer } from '@/contexts/PortalContainerContext';
import { useManagedAgentOptions } from '@/features/agent-management';
import { agentManagementApi } from '@/features/agent-management/api';
import { loadAgentSessionControlsCatalog } from '@/features/agents/sessionControlsQuery';

import { collaborationCall } from './collaborationApi';
import './collaboration.css';
import { surfaceErrorCopy } from './spaceModel';

type CustomRole = {
  id: string;
  name: string;
  team_id?: string | null;
  summary?: string;
  persona_prompt?: string;
  agent_id: string;
  mode_id?: string | null;
  config_values?: Record<string, string>;
};

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].trim() !== ''
    )
  );
}

function CustomRoleSessionControls({
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

  useEffect(() => {
    const trimmed = agentId.trim();
    if (!trimmed) {
      setCatalog(null);
      return;
    }
    let active = true;
    setCatalog(null);
    void loadAgentSessionControlsCatalog(trimmed)
      .then((next) => {
        if (active && next) setCatalog(next);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [agentId]);

  if (!agentId.trim()) {
    return (
      <div className="custom-role-session-fallback flex h-8 items-center rounded-[var(--radius)] border border-[var(--border-subtle)] bg-white px-2.5 text-xs text-muted-foreground dark:bg-[var(--surface-control-solid)]">
        请先选择 Agent
      </div>
    );
  }

  if (!catalog) {
    return (
      <div className="custom-role-session-fallback flex h-8 items-center rounded-[var(--radius)] border border-[var(--border-subtle)] bg-white px-2.5 text-xs text-muted-foreground dark:bg-[var(--surface-control-solid)]">
        默认会话配置
      </div>
    );
  }

  const hasModes = (catalog.modes ?? []).length > 0;
  const hasOptions = (catalog.config_options ?? []).length > 0;
  if (!hasModes && !hasOptions) {
    return (
      <div className="custom-role-session-fallback flex h-8 items-center rounded-[var(--radius)] border border-[var(--border-subtle)] bg-white px-2.5 text-xs text-muted-foreground dark:bg-[var(--surface-control-solid)]">
        默认会话配置
      </div>
    );
  }

  return (
    <SessionControlsFields
      modes={catalog.modes ?? []}
      currentModeId={catalog.current_mode ?? null}
      configOptions={catalog.config_options ?? []}
      selectedModeId={modeId || null}
      pendingConfigValues={values}
      onSelectMode={onModeId}
      onSelectConfigValue={(key, value) => {
        const next = { ...values };
        if (value && value.trim() !== '') next[key] = value;
        else delete next[key];
        onValues(next);
      }}
    />
  );
}

export function MultiAgentSettings({
  draft,
  updateDraft,
  onRangeError,
}: {
  draft: Config;
  hostReady?: boolean;
  revision?: number;
  updateDraft: (patch: Partial<Config>) => void;
  onRangeError: (message: string | null) => void;
}) {
  const { t } = useTranslation('settings');
  const portalContainer = usePortalContainer();
  const managedOptions = useManagedAgentOptions(undefined, true);
  const [barAgents, setBarAgents] = useState<AgentManagementView[]>([]);
  const [selectedDefaultAgentId, setSelectedDefaultAgentId] =
    useState<string>('');

  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);

  useEffect(() => {
    const settingsShell = document.querySelector('.settings-page');
    if (!roleDialogOpen || !settingsShell) return;
    settingsShell.classList.add('collaboration-settings-window-blurred');
    return () => {
      settingsShell.classList.remove('collaboration-settings-window-blurred');
    };
  }, [roleDialogOpen]);
  const [editingRoleId, setEditingRoleId] = useState<string>('');
  const [roleName, setRoleName] = useState('');
  const [roleAgentId, setRoleAgentId] = useState('');
  const [roleModeId, setRoleModeId] = useState('');
  const [roleConfigValues, setRoleConfigValues] = useState<
    Record<string, string>
  >({});
  const [rolePersonaPrompt, setRolePersonaPrompt] = useState('');
  const [roleError, setRoleError] = useState('');
  const [isSavingRole, setIsSavingRole] = useState(false);
  const personaTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!roleDialogOpen) return;
    const node = personaTextareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    const nextHeight = Math.min(Math.max(node.scrollHeight, 68), 142);
    node.style.height = `${nextHeight}px`;
  }, [roleDialogOpen, rolePersonaPrompt]);

  useEffect(() => {
    onRangeError(null);
  }, [onRangeError]);

  useEffect(() => {
    let active = true;
    void agentManagementApi
      .bar()
      .then((rows) => {
        if (!active) return;
        setBarAgents(rows.filter((row) => row.enabled && !row.retired));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const availableAgents = useMemo(() => {
    if (barAgents.length > 0) {
      return barAgents.map((row) => ({
        value: row.agent_id,
        label: row.display_name || getAgentName(row.agent_id) || row.agent_id,
      }));
    }
    return managedOptions.map((item) => ({
      value: item.value,
      label: item.label || getAgentName(item.value) || item.value,
    }));
  }, [barAgents, managedOptions]);

  const loadRoles = useCallback(async () => {
    try {
      const page = await collaborationCall<{ roles?: CustomRole[] }>(
        'collaboration',
        'role.list'
      );
      if (Array.isArray(page?.roles)) {
        setRoles(
          page.roles.map((role) => ({
            ...role,
            config_values: stringRecord(role.config_values),
          }))
        );
      }
    } catch {
      // Ignore when collaboration host is not yet initialized in test/offline mode
    }
  }, []);

  useEffect(() => {
    void loadRoles();
  }, [loadRoles]);

  const storedDefaults = draft.multi_agent_agent_defaults ?? {};
  const selectedAgentKey = selectedDefaultAgentId.trim().toLowerCase();
  const selectedAgentStoredRow = selectedAgentKey
    ? (storedDefaults[selectedAgentKey] ??
      storedDefaults[selectedDefaultAgentId.trim()])
    : undefined;
  const selectedAgentConfigOverrides = useMemo(
    () => stringRecord(selectedAgentStoredRow?.config_values),
    [selectedAgentStoredRow?.config_values]
  );

  const commitAgentDefault = (
    agentKey: string,
    nextRow: { modeId?: string | null; configValues?: Record<string, string> }
  ) => {
    const normalizedKey = agentKey.trim().toLowerCase();
    if (!normalizedKey) return;
    const next: Record<string, MultiAgentAgentDefault> = {};
    for (const [id, existing] of Object.entries(storedDefaults)) {
      if (!existing || id.toLowerCase() === normalizedKey) continue;
      next[id] = existing;
    }

    const modeId = nextRow.modeId?.trim() ?? '';
    const configValues = Object.fromEntries(
      Object.entries(nextRow.configValues ?? {}).filter(
        ([, item]) => item != null && item.trim() !== ''
      )
    );
    if (modeId || Object.keys(configValues).length > 0) {
      next[normalizedKey] = {
        mode_id: modeId || null,
        config_values: configValues,
      };
    }

    updateDraft({ multi_agent_agent_defaults: next });
  };

  const openCreateRoleDialog = () => {
    setEditingRoleId('');
    setRoleName('');
    setRoleAgentId(availableAgents[0]?.value ?? '');
    setRoleModeId('');
    setRoleConfigValues({});
    setRolePersonaPrompt('');
    setRoleError('');
    setRoleDialogOpen(true);
  };

  const openEditRoleDialog = (role: CustomRole) => {
    setEditingRoleId(role.id);
    setRoleName(role.name);
    setRoleAgentId(role.agent_id);
    setRoleModeId(role.mode_id ?? '');
    setRoleConfigValues(stringRecord(role.config_values));
    setRolePersonaPrompt(role.persona_prompt ?? '');
    setRoleError('');
    setRoleDialogOpen(true);
  };

  const handleSaveRole = async () => {
    const trimmedName = roleName.trim();
    const trimmedAgentId = roleAgentId.trim();
    if (!trimmedName || !trimmedAgentId || isSavingRole) return;
    setIsSavingRole(true);
    setRoleError('');

    const payload = {
      ...(editingRoleId ? { id: editingRoleId } : {}),
      name: trimmedName,
      teamId: '',
      summary: rolePersonaPrompt.trim(),
      personaPrompt: rolePersonaPrompt.trim(),
      agentId: trimmedAgentId,
      modeId: roleModeId.trim(),
      configValues: roleConfigValues,
    };

    try {
      const saved = await collaborationCall<CustomRole | undefined>(
        'collaboration',
        editingRoleId ? 'role.update' : 'role.create',
        payload
      );
      if (saved && saved.id) {
        setRoles((current) => {
          const normalized: CustomRole = {
            ...saved,
            config_values: stringRecord(saved.config_values),
          };
          const exists = current.some((item) => item.id === normalized.id);
          return exists
            ? current.map((item) =>
                item.id === normalized.id ? normalized : item
              )
            : [...current, normalized];
        });
      } else {
        await loadRoles();
      }
      setRoleDialogOpen(false);
    } catch (cause) {
      setRoleError(surfaceErrorCopy(cause));
    } finally {
      setIsSavingRole(false);
    }
  };

  const handleDeleteRole = async (roleId: string) => {
    try {
      await collaborationCall('collaboration', 'role.delete', { id: roleId });
      setRoles((current) => current.filter((item) => item.id !== roleId));
    } catch (cause) {
      setRoleError(surfaceErrorCopy(cause));
    }
  };

  const selectedRoleAgentLabel =
    availableAgents.find((item) => item.value === roleAgentId)?.label ||
    getAgentName(roleAgentId) ||
    roleAgentId;

  return (
    <div className="space-y-4">
      <div
        className="multi-agent-default-picker"
        data-testid="multi-agent-default-picker"
      >
        <AgentSessionConfigPicker
          agentId={selectedDefaultAgentId}
          selectedModeId={selectedAgentStoredRow?.mode_id ?? null}
          pendingConfigValues={selectedAgentConfigOverrides}
          agentLabel={t('general.multiAgentDefaultsTitle')}
          onAgentChange={(value) => setSelectedDefaultAgentId(value)}
          onSelectMode={(modeId) => {
            if (!selectedDefaultAgentId) return;
            commitAgentDefault(selectedDefaultAgentId, {
              modeId,
              configValues: selectedAgentConfigOverrides,
            });
          }}
          onSelectConfigValue={(key, value) => {
            if (!selectedDefaultAgentId) return;
            const nextValues = { ...selectedAgentConfigOverrides };
            if (value && value.trim() !== '') {
              nextValues[key] = value;
            } else {
              delete nextValues[key];
            }
            commitAgentDefault(selectedDefaultAgentId, {
              modeId: selectedAgentStoredRow?.mode_id ?? null,
              configValues: nextValues,
            });
          }}
          onSave={({ modeId, configValues }) => {
            if (!selectedDefaultAgentId) return;
            commitAgentDefault(selectedDefaultAgentId, {
              modeId,
              configValues,
            });
            toast.success(t('general.settingsSaved'));
          }}
        />
      </div>

      <div className="space-y-2">
        <div className="settings-row">
          <div>
            <Label>自定义角色</Label>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="custom-roles-header-create-btn"
            onClick={openCreateRoleDialog}
          >
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            新建角色
          </Button>
        </div>

        <div
          className="rounded-lg border border-border bg-background/50"
          data-testid="custom-roles-list-container"
        >
          {roles.length === 0 ? (
            <div className="flex min-h-24 items-center justify-center p-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="custom-roles-empty-create-btn"
                onClick={openCreateRoleDialog}
              >
                <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                新建角色
              </Button>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {roles.map((role) => {
                const agentLabel =
                  availableAgents.find((item) => item.value === role.agent_id)
                    ?.label ||
                  getAgentName(role.agent_id) ||
                  role.agent_id;
                return (
                  <div
                    key={role.id}
                    data-testid={`custom-role-row-${role.id}`}
                    className="flex min-h-10 items-center justify-between gap-3 px-3 py-2"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <AgentIcon
                        agent={role.agent_id as ExecutorProfileId['executor']}
                        className="h-4 w-4 shrink-0"
                      />
                      <span className="truncate text-xs font-medium text-foreground">
                        {role.name}
                      </span>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {agentLabel}
                      </span>
                      {role.persona_prompt ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {role.persona_prompt}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={`编辑角色 ${role.name}`}
                        onClick={() => openEditRoleDialog(role)}
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        aria-label={`删除角色 ${role.name}`}
                        onClick={() => void handleDeleteRole(role.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {roleDialogOpen
        ? createPortal(
            <div
              data-testid="custom-role-modal-overlay"
              className="collaboration-thread-overlay collaboration-settings-modal-overlay fixed inset-0 z-[9999] flex items-center justify-center p-6"
              style={{
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
              }}
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  setRoleDialogOpen(false);
                }
              }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-label={editingRoleId ? '编辑角色' : '新建角色'}
                className="dialog-surface relative flex max-h-[calc(100dvh-3rem)] w-full max-w-[440px] flex-col overflow-y-auto rounded-xl border border-border/70 p-4 shadow-xl"
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="text-[14px] font-semibold text-foreground">
                    {editingRoleId ? '编辑角色' : '新建角色'}
                  </h3>
                  <Button
                    type="button"
                    variant="icon"
                    size="icon"
                    className="collaboration-expand h-7 w-7"
                    aria-label="Close"
                    onClick={() => setRoleDialogOpen(false)}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>

                <form
                  className="flex flex-col gap-3.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleSaveRole();
                  }}
                >
                  <div className="space-y-1.5">
                    <Label htmlFor="custom-role-name-input">角色名称</Label>
                    <Input
                      id="custom-role-name-input"
                      aria-label="角色名称"
                      value={roleName}
                      onChange={(event) => setRoleName(event.target.value)}
                      placeholder="前端工程师"
                      className="h-8 px-2.5 text-[13px]"
                      autoFocus
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label>Agent</Label>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          role="combobox"
                          aria-label="选择角色 Agent"
                          data-value={roleAgentId}
                          className="custom-role-agent-trigger raised-control h-8 w-full justify-between px-2.5 text-[13px] font-normal"
                        >
                          <span className="flex min-w-0 items-center gap-2 truncate">
                            {roleAgentId ? (
                              <AgentIcon
                                agent={
                                  roleAgentId as ExecutorProfileId['executor']
                                }
                                className="h-3.5 w-3.5 shrink-0"
                              />
                            ) : null}
                            <span className="truncate">
                              {selectedRoleAgentLabel || '选择 Agent'}
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
                        {availableAgents.map((agent) => {
                          const isSelected = roleAgentId === agent.value;
                          return (
                            <DropdownMenuItem
                              key={agent.value}
                              data-state={isSelected ? 'checked' : undefined}
                              onSelect={() => {
                                setRoleAgentId(agent.value);
                                setRoleModeId('');
                                setRoleConfigValues({});
                              }}
                            >
                              <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
                                <AgentIcon
                                  agent={
                                    agent.value as ExecutorProfileId['executor']
                                  }
                                  className="h-3.5 w-3.5 shrink-0"
                                />
                                <span className="truncate">{agent.label}</span>
                              </span>
                              {isSelected ? (
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

                  <div
                    className="space-y-1.5"
                    data-testid="custom-role-session-config"
                  >
                    <Label>会话配置</Label>
                    <CustomRoleSessionControls
                      agentId={roleAgentId}
                      modeId={roleModeId}
                      values={roleConfigValues}
                      onModeId={setRoleModeId}
                      onValues={setRoleConfigValues}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="custom-role-persona-input">
                      人设提示词（可选）
                    </Label>
                    <Textarea
                      ref={personaTextareaRef}
                      id="custom-role-persona-input"
                      aria-label="人设提示词（可选）"
                      placeholder="人设提示词（可选）"
                      rows={3}
                      value={rolePersonaPrompt}
                      onChange={(event) =>
                        setRolePersonaPrompt(event.target.value)
                      }
                      className="custom-role-persona-textarea px-2.5 py-1.5 text-[13px]"
                    />
                  </div>

                  {roleError ? (
                    <p className="collaboration-error text-xs">{roleError}</p>
                  ) : null}

                  <div className="flex justify-end gap-2 pt-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setRoleDialogOpen(false)}
                    >
                      取消
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      data-dialog-primary="true"
                      disabled={!roleName.trim() || !roleAgentId || isSavingRole}
                    >
                      {editingRoleId ? '保存' : '新建角色'}
                    </Button>
                  </div>
                </form>
              </div>
            </div>,
            portalContainer ?? document.body
          )
        : null}
    </div>
  );
}
