import {
  Check,
  ChevronDown,
  Pencil,
  Plus,
  RefreshCw,
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
import { AgentSessionControlsErrorCard } from '@/components/sessions/SessionCreationStatusCard';
import { resolveEffectiveSessionConfig } from '@/components/settings/AgentSessionConfigPicker';
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
import { usePortalContainer } from '@/contexts/PortalContainerContext';
import { useManagedAgentOptions } from '@/features/agent-management';
import { agentManagementApi } from '@/features/agent-management/api';
import { agentsApi } from '@/features/agents/api';
import { loadAgentSessionControlsCatalog } from '@/features/agents/sessionControlsQuery';

import { collaborationCall } from './collaborationApi';
import './collaboration.css';
import { surfaceErrorCopy } from './spaceModel';
import i18n from '@/i18n';

const DEFAULT_AGENT_ROLE_PREFIX = 'default-agent:';

type CustomRole = {
  id: string;
  name: string;
  team_id?: string | null;
  summary?: string;
  persona_prompt?: string;
  agent_id: string;
  mode_id?: string | null;
  config_values?: Record<string, string>;
  isDefaultAgentRole?: boolean;
  backendRoleId?: string;
};

export function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].trim() !== ''
    )
  );
}

export function CustomRoleSessionControls({
  agentId,
  modeId,
  values,
  onModeId,
  onValues,
  onCatalogChange,
  reloadToken = 0,
}: {
  agentId: string;
  modeId: string;
  values: Record<string, string>;
  onModeId: (modeId: string) => void;
  onValues: (values: Record<string, string>) => void;
  onCatalogChange?: (catalog: AgentSessionControlsSnapshot | null) => void;
  reloadToken?: number;
}) {
  const [catalog, setCatalog] = useState<AgentSessionControlsSnapshot | null>(
    null
  );
  const [loadError, setLoadError] = useState<unknown>(null);
  const prevReloadTokenRef = useRef(reloadToken);

  useEffect(() => {
    const trimmed = agentId.trim();
    const isManualRefresh = prevReloadTokenRef.current !== reloadToken;
    prevReloadTokenRef.current = reloadToken;
    if (!trimmed) {
      setCatalog(null);
      setLoadError(null);
      onCatalogChange?.(null);
      return;
    }
    let active = true;
    setCatalog(null);
    setLoadError(null);
    onCatalogChange?.(null);
    const loadPromise = isManualRefresh
      ? agentsApi
          .refreshCapabilityCatalog(trimmed.toLowerCase())
          .then((refreshed) => {
            if (refreshed === false) {
              throw new Error('Agent session controls discovery failed');
            }
            return loadAgentSessionControlsCatalog(trimmed);
          })
      : loadAgentSessionControlsCatalog(trimmed);

    void loadPromise
      .then((next) => {
        if (active) {
          setCatalog(next ?? null);
          setLoadError(null);
          onCatalogChange?.(next ?? null);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setCatalog(null);
          setLoadError(error);
          onCatalogChange?.(null);
        }
      });
    return () => {
      active = false;
    };
  }, [agentId, onCatalogChange, reloadToken]);

  if (!agentId.trim()) {
    return (
      <div className="custom-role-session-fallback flex h-8 items-center rounded-[var(--radius)] border border-[var(--border-subtle)] bg-white px-2.5 text-xs text-muted-foreground dark:bg-[var(--surface-control-solid)]">
        {i18n.t('panels:ui.multiAgent.chooseAnAgentFirst')}
      </div>
    );
  }

  if (loadError) {
    return (
      <AgentSessionControlsErrorCard
        agentId={agentId.trim()}
        error={loadError}
      />
    );
  }

  if (!catalog) {
    return (
      <div className="custom-role-session-fallback flex h-8 items-center rounded-[var(--radius)] border border-[var(--border-subtle)] bg-white px-2.5 text-xs text-muted-foreground dark:bg-[var(--surface-control-solid)]">
        {i18n.t('panels:ui.multiAgent.defaultSessionSettings')}
      </div>
    );
  }

  const hasModes = (catalog.modes ?? []).length > 0;
  const hasOptions = (catalog.config_options ?? []).length > 0;
  if (!hasModes && !hasOptions) {
    return (
      <div className="custom-role-session-fallback flex h-8 items-center rounded-[var(--radius)] border border-[var(--border-subtle)] bg-white px-2.5 text-xs text-muted-foreground dark:bg-[var(--surface-control-solid)]">
        {i18n.t('panels:ui.multiAgent.defaultSessionSettings')}
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

  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [defaultRolePersonas, setDefaultRolePersonas] = useState<
    Record<string, string>
  >({});
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [roleDialogLeft, setRoleDialogLeft] = useState('12.5rem');

  useEffect(() => {
    if (!roleDialogOpen) return;
    const settingsShell = document.querySelector('.settings-page');
    settingsShell?.classList.add('collaboration-settings-window-blurred');

    const syncOverlayLeft = () => {
      const settingsContent = document.querySelector<HTMLElement>(
        '[data-settings-content]'
      );
      const settingsSidebar =
        document.querySelector<HTMLElement>('.settings-sidebar');
      const contentLeft = settingsContent?.getBoundingClientRect().left ?? 0;
      const sidebarRight = settingsSidebar?.getBoundingClientRect().right ?? 0;
      const measuredLeft = contentLeft > 0 ? contentLeft : sidebarRight;
      if (measuredLeft > 0) {
        setRoleDialogLeft(`${Math.round(measuredLeft)}px`);
        return;
      }
      setRoleDialogLeft(
        settingsSidebar?.classList.contains('settings-sidebar--flush')
          ? '11rem'
          : '12.5rem'
      );
    };

    syncOverlayLeft();
    window.addEventListener('resize', syncOverlayLeft);
    return () => {
      window.removeEventListener('resize', syncOverlayLeft);
      settingsShell?.classList.remove('collaboration-settings-window-blurred');
    };
  }, [roleDialogOpen]);

  const [editingRoleId, setEditingRoleId] = useState<string>('');
  const [editingBackendRoleId, setEditingBackendRoleId] = useState<string>('');
  const [roleName, setRoleName] = useState('');
  const [roleAgentId, setRoleAgentId] = useState('');
  const [roleModeId, setRoleModeId] = useState('');
  const [roleConfigValues, setRoleConfigValues] = useState<
    Record<string, string>
  >({});
  const [roleCatalog, setRoleCatalog] =
    useState<AgentSessionControlsSnapshot | null>(null);
  const [roleCatalogReloadToken, setRoleCatalogReloadToken] = useState(0);
  const [rolePersonaPrompt, setRolePersonaPrompt] = useState('');
  const [roleError, setRoleError] = useState('');
  const [isSavingRole, setIsSavingRole] = useState(false);
  const personaTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const isEditingDefaultRole = editingRoleId.startsWith(
    DEFAULT_AGENT_ROLE_PREFIX
  );

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

  const storedDefaults = useMemo(
    () => draft.multi_agent_agent_defaults ?? {},
    [draft.multi_agent_agent_defaults]
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

  const displayRoles = useMemo(() => {
    const matchedBackendIds = new Set<string>();
    const defaultRoles: CustomRole[] = availableAgents.map((agent) => {
      const normalizedKey = agent.value.trim().toLowerCase();
      const defaultName = i18n.t('panels:ui.multiAgent.defaultAgentRoleName', {
        agent: agent.label,
        defaultValue: `${agent.label} · 默认配置`,
      });
      const matchedBackendRole = roles.find(
        (role) =>
          role.id === `${DEFAULT_AGENT_ROLE_PREFIX}${agent.value}` ||
          (role.agent_id.trim().toLowerCase() === normalizedKey &&
            role.name.trim() === defaultName)
      );
      if (matchedBackendRole) {
        matchedBackendIds.add(matchedBackendRole.id);
      }
      const storedRow =
        storedDefaults[normalizedKey] ?? storedDefaults[agent.value.trim()];
      const storedConfigValues = stringRecord(storedRow?.config_values);
      const effectiveConfigValues =
        Object.keys(storedConfigValues).length > 0
          ? storedConfigValues
          : stringRecord(matchedBackendRole?.config_values);
      const effectiveModeId =
        storedRow?.mode_id ?? matchedBackendRole?.mode_id ?? null;
      const effectivePersona =
        defaultRolePersonas[normalizedKey] ??
        matchedBackendRole?.persona_prompt ??
        '';

      return {
        id: `${DEFAULT_AGENT_ROLE_PREFIX}${agent.value}`,
        backendRoleId: matchedBackendRole?.id,
        isDefaultAgentRole: true,
        name: defaultName,
        agent_id: agent.value,
        mode_id: effectiveModeId,
        config_values: effectiveConfigValues,
        persona_prompt: effectivePersona,
      };
    });

    const userCustomRoles: CustomRole[] = roles
      .filter((role) => !matchedBackendIds.has(role.id))
      .map((role) => ({
        ...role,
        isDefaultAgentRole: false,
      }));

    return [...defaultRoles, ...userCustomRoles];
  }, [availableAgents, defaultRolePersonas, roles, storedDefaults]);

  const openCreateRoleDialog = () => {
    setEditingRoleId('');
    setEditingBackendRoleId('');
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
    setEditingBackendRoleId(role.backendRoleId ?? '');
    setRoleName(role.name);
    setRoleAgentId(role.agent_id);
    setRoleModeId(role.mode_id ?? '');
    setRoleConfigValues(stringRecord(role.config_values));
    setRolePersonaPrompt(role.persona_prompt ?? '');
    setRoleError('');
    setRoleDialogOpen(true);
  };

  const handleRefreshRoleSessionControls = () => {
    if (!roleAgentId.trim()) return;
    setRoleCatalogReloadToken((prev) => prev + 1);
  };

  const handleSaveRole = async () => {
    const trimmedName = roleName.trim();
    const trimmedAgentId = roleAgentId.trim();
    if (!trimmedName || !trimmedAgentId || isSavingRole) return;
    setIsSavingRole(true);
    setRoleError('');

    const effective = resolveEffectiveSessionConfig(
      roleCatalog,
      roleModeId.trim() || null,
      roleConfigValues
    );
    const effectiveModeId = effective.modeId?.trim() ?? '';
    const effectiveConfigValues = stringRecord(effective.configValues);

    if (isEditingDefaultRole) {
      try {
        commitAgentDefault(trimmedAgentId, {
          modeId: effectiveModeId || null,
          configValues: effectiveConfigValues,
        });
        setDefaultRolePersonas((prev) => ({
          ...prev,
          [trimmedAgentId.toLowerCase()]: rolePersonaPrompt.trim(),
        }));
        const backendId = editingBackendRoleId.trim();
        const payload = {
          ...(backendId ? { id: backendId } : {}),
          name: trimmedName,
          teamId: '',
          summary: rolePersonaPrompt.trim(),
          personaPrompt: rolePersonaPrompt.trim(),
          agentId: trimmedAgentId,
          modeId: effectiveModeId,
          configValues: effectiveConfigValues,
        };
        try {
          const saved = await collaborationCall<CustomRole | undefined>(
            'collaboration',
            backendId ? 'role.update' : 'role.create',
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
          }
        } catch {
          // Collaboration host may be offline in test mode; default config is persisted via updateDraft
        }
        setRoleDialogOpen(false);
      } finally {
        setIsSavingRole(false);
      }
      return;
    }

    const payload = {
      ...(editingRoleId ? { id: editingRoleId } : {}),
      name: trimmedName,
      teamId: '',
      summary: rolePersonaPrompt.trim(),
      personaPrompt: rolePersonaPrompt.trim(),
      agentId: trimmedAgentId,
      modeId: effectiveModeId,
      configValues: effectiveConfigValues,
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
    if (roleId.startsWith(DEFAULT_AGENT_ROLE_PREFIX)) return;
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
    <div className="min-w-0 space-y-4">
      <div className="min-w-0 space-y-2">
        <div className="settings-row">
          <div>
            <Label>{i18n.t('panels:ui.multiAgent.customRoles')}</Label>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="custom-roles-header-create-btn"
            onClick={openCreateRoleDialog}
          >
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {i18n.t('panels:ui.multiAgent.newRole')}
          </Button>
        </div>

        <div
          className="settings-bounded-list-container min-w-0 overflow-hidden rounded-lg border border-border bg-background/50"
          data-testid="custom-roles-list-container"
        >
          {displayRoles.length === 0 ? (
            <div className="flex min-h-24 items-center justify-center p-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="custom-roles-empty-create-btn"
                onClick={openCreateRoleDialog}
              >
                <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                {i18n.t('panels:ui.multiAgent.newRole')}
              </Button>
            </div>
          ) : (
            <div
              className="settings-bounded-list max-h-56 divide-y divide-border/60 overflow-y-auto"
              data-testid="custom-roles-scroll-box"
            >
              {displayRoles.map((role) => {
                const agentLabel =
                  availableAgents.find((item) => item.value === role.agent_id)
                    ?.label ||
                  getAgentName(role.agent_id) ||
                  role.agent_id;
                const sessionConfigParts = [
                  role.mode_id?.trim() || '',
                  ...Object.values(stringRecord(role.config_values)),
                ].filter(Boolean);
                return (
                  <div
                    key={role.id}
                    data-testid={`custom-role-row-${role.id}`}
                    className="flex min-h-10 min-w-0 items-center justify-between gap-3 px-3 py-2"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                      <AgentIcon
                        agent={role.agent_id as ExecutorProfileId['executor']}
                        className="h-4 w-4 shrink-0"
                      />
                      <span className="max-w-[14rem] shrink-0 truncate text-xs font-medium text-foreground">
                        {role.name}
                      </span>
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {agentLabel}
                      </span>
                      {sessionConfigParts.length > 0 ? (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {sessionConfigParts.join(' · ')}
                        </span>
                      ) : null}
                      {role.persona_prompt ? (
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
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
                        aria-label={i18n.t(
                          'panels:ui.multiAgent.editRoleName',
                          { name: role.name }
                        )}
                        onClick={() => openEditRoleDialog(role)}
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                      {!role.isDefaultAgentRole ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          aria-label={i18n.t(
                            'panels:ui.multiAgent.deleteRoleName',
                            { name: role.name }
                          )}
                          onClick={() => void handleDeleteRole(role.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      ) : null}
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
              className="collaboration-thread-overlay collaboration-settings-modal-overlay fixed inset-y-0 right-0 z-[9999] flex items-center justify-center p-6"
              style={{
                left: roleDialogLeft,
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
                aria-label={
                  editingRoleId
                    ? i18n.t('panels:ui.multiAgent.editRole')
                    : i18n.t('panels:ui.multiAgent.newRole')
                }
                className="dialog-surface relative flex max-h-[calc(100dvh-3rem)] w-full max-w-[440px] flex-col overflow-y-auto rounded-xl border border-border/70 p-4 shadow-xl"
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="text-[14px] font-semibold text-foreground">
                    {editingRoleId
                      ? i18n.t('panels:ui.multiAgent.editRole')
                      : i18n.t('panels:ui.multiAgent.newRole')}
                  </h3>
                  <Button
                    type="button"
                    variant="icon"
                    size="icon"
                    className="collaboration-expand h-7 w-7"
                    aria-label={t('panels:tabCreation.close', '关闭')}
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
                    <Label htmlFor="custom-role-name-input">
                      {i18n.t('panels:ui.multiAgent.roleName')}
                    </Label>
                    <Input
                      id="custom-role-name-input"
                      aria-label={i18n.t('panels:ui.multiAgent.roleName')}
                      value={roleName}
                      disabled={isEditingDefaultRole}
                      readOnly={isEditingDefaultRole}
                      onChange={(event) => {
                        if (isEditingDefaultRole) return;
                        setRoleName(event.target.value);
                      }}
                      placeholder={i18n.t(
                        'panels:ui.multiAgent.frontendEngineer'
                      )}
                      className="h-8 px-2.5 text-[13px]"
                      autoFocus={!isEditingDefaultRole}
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
                          disabled={isEditingDefaultRole}
                          aria-label={i18n.t(
                            'panels:ui.multiAgent.chooseRoleAgent'
                          )}
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
                              {selectedRoleAgentLabel ||
                                i18n.t('panels:ui.multiAgent.chooseAgent')}
                            </span>
                          </span>
                          <ChevronDown
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                        </Button>
                      </DropdownMenuTrigger>
                      {!isEditingDefaultRole ? (
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
                                  <span className="truncate">
                                    {agent.label}
                                  </span>
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
                      ) : null}
                    </DropdownMenu>
                  </div>

                  <div
                    className="space-y-1.5"
                    data-testid="custom-role-session-config"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Label>
                        {i18n.t('panels:ui.multiAgent.sessionSettings')}
                      </Label>
                      {roleAgentId ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          aria-label={t('general.refreshSessionControls')}
                          onClick={() =>
                            void handleRefreshRoleSessionControls()
                          }
                        >
                          <RefreshCw className="h-3 w-3" aria-hidden="true" />
                        </Button>
                      ) : null}
                    </div>
                    <CustomRoleSessionControls
                      agentId={roleAgentId}
                      modeId={roleModeId}
                      values={roleConfigValues}
                      onModeId={setRoleModeId}
                      onValues={setRoleConfigValues}
                      onCatalogChange={setRoleCatalog}
                      reloadToken={roleCatalogReloadToken}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="custom-role-persona-input">
                      {i18n.t('panels:ui.multiAgent.personaPromptOptional')}
                    </Label>
                    <Textarea
                      ref={personaTextareaRef}
                      id="custom-role-persona-input"
                      aria-label={i18n.t(
                        'panels:ui.multiAgent.personaPromptOptional'
                      )}
                      placeholder={i18n.t(
                        'panels:ui.multiAgent.personaPromptOptional'
                      )}
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
                      {i18n.t('panels:ui.multiAgent.cancel')}
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      data-dialog-primary="true"
                      disabled={
                        !roleName.trim() || !roleAgentId || isSavingRole
                      }
                    >
                      {editingRoleId
                        ? i18n.t('panels:ui.multiAgent.save')
                        : i18n.t('panels:ui.multiAgent.newRole')}
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
