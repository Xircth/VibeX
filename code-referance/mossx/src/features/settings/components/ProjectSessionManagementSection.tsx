import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import { EngineIcon } from "../../engine/components/EngineIcon";
import type { EngineType, ThreadSummary, WorkspaceInfo } from "../../../types";

export type ProjectSessionDeleteFailure = {
  threadId: string;
  code: string;
  message: string;
};

export type ProjectSessionDeleteResult = {
  succeededThreadIds: string[];
  failed: ProjectSessionDeleteFailure[];
};

type ProjectSessionManagementSectionProps = {
  workspace: WorkspaceInfo | null;
  workspaces: WorkspaceInfo[];
  groupedWorkspaces?: Array<{
    id: string | null;
    name: string;
    workspaces: WorkspaceInfo[];
  }>;
  selectedWorkspaceId: string | null;
  onWorkspaceChange: (workspaceId: string | null) => void;
  threads: ThreadSummary[];
  loading?: boolean;
  onRefresh?: (workspaceId: string) => void;
  onDeleteSessions: (
    workspaceId: string,
    threadIds: string[],
  ) => Promise<ProjectSessionDeleteResult>;
};

type NoticeState =
  | { kind: "success"; text: string }
  | { kind: "error"; text: string }
  | null;

type ProjectSessionWorkspaceOption = {
  id: string;
  label: string;
  kind: "main" | "worktree";
};

type ProjectSessionWorkspaceSection = {
  id: string | null;
  name: string;
  options: ProjectSessionWorkspaceOption[];
};

const SORT_ORDER_FALLBACK = Number.MAX_SAFE_INTEGER;

function getSortOrderValue(value: number | null | undefined) {
  return typeof value === "number" ? value : SORT_ORDER_FALLBACK;
}

function resolveEngineLabel(
  engine: ThreadSummary["engineSource"] | undefined,
  t: (key: string) => string,
) {
  if (engine === "claude") {
    return t("settings.projectSessionEngineClaude");
  }
  if (engine === "opencode") {
    return t("settings.projectSessionEngineOpencode");
  }
  return t("settings.projectSessionEngineCodex");
}

function resolveEngineType(engine: ThreadSummary["engineSource"] | undefined): EngineType {
  if (engine === "claude" || engine === "opencode") {
    return engine;
  }
  return "codex";
}

function formatUpdatedAtDisplay(updatedAt: number, locale: string) {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  const now = new Date();
  const sameYear = now.getFullYear() === date.getFullYear();
  return new Intl.DateTimeFormat(locale || undefined, {
    year: sameYear ? undefined : "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function ProjectSessionManagementSection({
  workspace,
  workspaces,
  groupedWorkspaces = [],
  selectedWorkspaceId,
  onWorkspaceChange,
  threads,
  loading = false,
  onRefresh,
  onDeleteSessions,
}: ProjectSessionManagementSectionProps) {
  const { t, i18n } = useTranslation();
  const [selectedIds, setSelectedIds] = useState<Record<string, true>>({});
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [expanded, setExpanded] = useState(true);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const workspacePickerRef = useRef<HTMLDivElement | null>(null);
  const workspaceSearchInputRef = useRef<HTMLInputElement | null>(null);

  const orderedThreads = useMemo(
    () => [...threads].sort((left, right) => right.updatedAt - left.updatedAt),
    [threads],
  );
  const selectedCount = useMemo(
    () => Object.keys(selectedIds).length,
    [selectedIds],
  );
  const allSelected =
    orderedThreads.length > 0 &&
    orderedThreads.every((thread) => Boolean(selectedIds[thread.id]));
  const selectedWorkspace = useMemo(
    () =>
      workspaces.find((entry) => entry.id === selectedWorkspaceId) ??
      workspace ??
      null,
    [selectedWorkspaceId, workspace, workspaces],
  );
  const selectedWorkspaceLabel = selectedWorkspace?.name ?? t("settings.workspacePickerLabel");
  const workspacePickerSections = useMemo(() => {
    const rootsById = new Map<string, WorkspaceInfo>();
    const worktreesByParent = new Map<string, WorkspaceInfo[]>();
    workspaces.forEach((entry) => {
      if ((entry.kind ?? "main") === "worktree" && entry.parentId) {
        const bucket = worktreesByParent.get(entry.parentId) ?? [];
        bucket.push(entry);
        worktreesByParent.set(entry.parentId, bucket);
        return;
      }
      rootsById.set(entry.id, entry);
    });
    worktreesByParent.forEach((entries) => {
      entries.sort((left, right) => {
        const orderDiff =
          getSortOrderValue(left.settings.sortOrder) -
          getSortOrderValue(right.settings.sortOrder);
        if (orderDiff !== 0) {
          return orderDiff;
        }
        return left.name.localeCompare(right.name);
      });
    });

    const toOptions = (entry: WorkspaceInfo) => {
      const options: ProjectSessionWorkspaceOption[] = [
        { id: entry.id, label: entry.name, kind: "main" },
      ];
      const worktreeOptions = worktreesByParent.get(entry.id) ?? [];
      worktreeOptions.forEach((worktree) => {
        options.push({
          id: worktree.id,
          label: worktree.name,
          kind: "worktree",
        });
      });
      return options;
    };

    if (groupedWorkspaces.length > 0) {
      const sectionOptions = groupedWorkspaces
        .map((section) => ({
          id: section.id,
          name: section.name,
          options: section.workspaces.flatMap((entry) => {
            const matched = rootsById.get(entry.id) ?? entry;
            return toOptions(matched);
          }),
        }))
        .filter((section) => section.options.length > 0);
      if (sectionOptions.length > 0) {
        return sectionOptions;
      }
    }

    const ungroupedRoots = Array.from(rootsById.values()).sort((left, right) => {
      const orderDiff =
        getSortOrderValue(left.settings.sortOrder) - getSortOrderValue(right.settings.sortOrder);
      if (orderDiff !== 0) {
        return orderDiff;
      }
      return left.name.localeCompare(right.name);
    });
    return [
      {
        id: null,
        name: "",
        options: ungroupedRoots.flatMap((entry) => toOptions(entry)),
      } satisfies ProjectSessionWorkspaceSection,
    ];
  }, [groupedWorkspaces, workspaces]);
  const filteredWorkspaceSections = useMemo(() => {
    const keyword = workspaceQuery.trim().toLowerCase();
    if (!keyword) {
      return workspacePickerSections;
    }
    return workspacePickerSections
      .map((section) => ({
        ...section,
        options: section.options.filter((entry) => entry.label.toLowerCase().includes(keyword)),
      }))
      .filter((section) => section.options.length > 0);
  }, [workspacePickerSections, workspaceQuery]);
  const showWorkspaceGroupLabel = useMemo(
    () =>
      filteredWorkspaceSections.length > 1 &&
      filteredWorkspaceSections.some((section) => section.name.trim().length > 0),
    [filteredWorkspaceSections],
  );

  useEffect(() => {
    setSelectedIds({});
    setDeleteArmed(false);
    setIsDeleting(false);
    setNotice(null);
  }, [workspace?.id]);
  useEffect(() => {
    if (expanded) {
      return;
    }
    setWorkspacePickerOpen(false);
    setWorkspaceQuery("");
  }, [expanded]);
  useEffect(() => {
    if (!workspacePickerOpen) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (!workspacePickerRef.current?.contains(target)) {
        setWorkspacePickerOpen(false);
        setWorkspaceQuery("");
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setWorkspacePickerOpen(false);
        setWorkspaceQuery("");
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [workspacePickerOpen]);
  useEffect(() => {
    if (!workspacePickerOpen) {
      return;
    }
    const timer = window.setTimeout(() => {
      workspaceSearchInputRef.current?.focus();
      workspaceSearchInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [workspacePickerOpen]);

  const clearSelection = useCallback(() => {
    setSelectedIds({});
    setDeleteArmed(false);
  }, []);

  const toggleSelection = useCallback(
    (threadId: string) => {
      if (isDeleting) {
        return;
      }
      setSelectedIds((previous) => {
        if (previous[threadId]) {
          const { [threadId]: _unused, ...rest } = previous;
          return rest;
        }
        return {
          ...previous,
          [threadId]: true,
        };
      });
      setDeleteArmed(false);
    },
    [isDeleting],
  );

  const selectAll = useCallback(() => {
    if (isDeleting) {
      return;
    }
    const next: Record<string, true> = {};
    orderedThreads.forEach((thread) => {
      next[thread.id] = true;
    });
    setSelectedIds(next);
    setDeleteArmed(false);
  }, [isDeleting, orderedThreads]);

  const handleDeleteSelected = useCallback(async () => {
    if (!workspace || isDeleting || selectedCount === 0) {
      return;
    }
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setIsDeleting(true);
    setNotice(null);
    try {
      const targetIds = Object.keys(selectedIds);
      const result = await onDeleteSessions(workspace.id, targetIds);
      if (result.failed.length === 0) {
        setSelectedIds({});
        setNotice({
          kind: "success",
          text: t("settings.projectSessionDeleteSuccess", {
            count: result.succeededThreadIds.length,
          }),
        });
      } else {
        const failedOnly: Record<string, true> = {};
        result.failed.forEach((entry) => {
          failedOnly[entry.threadId] = true;
        });
        setSelectedIds(failedOnly);
        const firstReason =
          result.failed[0]?.message?.trim() ||
          result.failed[0]?.code ||
          t("settings.projectSessionDeleteUnknownReason");
        setNotice({
          kind: "error",
          text: `${t("settings.projectSessionDeletePartial", {
            succeeded: result.succeededThreadIds.length,
            failed: result.failed.length,
          })} ${firstReason}`,
        });
      }
      setDeleteArmed(false);
    } finally {
      setIsDeleting(false);
    }
  }, [
    deleteArmed,
    isDeleting,
    onDeleteSessions,
    selectedCount,
    selectedIds,
    t,
    workspace,
  ]);

  const deleteLabel = isDeleting
    ? t("settings.projectSessionDeleting")
    : deleteArmed
      ? t("settings.projectSessionConfirmDeleteSelected", { count: selectedCount })
      : t("settings.projectSessionDeleteSelected");
  const handleWorkspaceSelect = useCallback(
    (workspaceId: string) => {
      if (workspaceId && workspaceId !== selectedWorkspaceId) {
        onWorkspaceChange(workspaceId);
      }
      setWorkspacePickerOpen(false);
      setWorkspaceQuery("");
    },
    [onWorkspaceChange, selectedWorkspaceId],
  );

  return (
    <section
      className={`settings-project-sessions${expanded ? " is-open" : ""}`}
      data-testid="settings-project-session-management"
    >
      <button
        type="button"
        className={`settings-project-sessions-expand-btn${expanded ? " is-open" : ""}`}
        onClick={() => setExpanded((previous) => !previous)}
        aria-expanded={expanded}
        data-testid="settings-project-sessions-expand-toggle"
      >
        {expanded ? (
          <ChevronDown className="settings-project-sessions-expand-icon" size={14} aria-hidden />
        ) : (
          <ChevronRight className="settings-project-sessions-expand-icon" size={14} aria-hidden />
        )}
        <span className="settings-project-sessions-expand-label">
          {t("settings.projectSessionTitle")}
        </span>
        {expanded && orderedThreads.length > 0 && (
          <span className="settings-project-sessions-expand-count">({orderedThreads.length})</span>
        )}
      </button>

      {expanded && (
        <>
          <div className="settings-project-sessions-header">
            <div className="settings-project-sessions-title-wrap">
              <p>{t("settings.projectSessionDescription")}</p>
            </div>
            <div className="settings-project-sessions-header-actions">
              <div className="settings-project-sessions-workspace">
                <span className="settings-project-sessions-workspace-label">
                  <span className="codicon codicon-folder-opened" aria-hidden />
                  {t("settings.workspacePickerLabel")}
                </span>
                {workspaces.length > 0 ? (
                  <div
                    className={`settings-project-sessions-workspace-picker${workspacePickerOpen ? " is-open" : ""}`}
                    ref={workspacePickerRef}
                  >
                    <button
                      type="button"
                      className="settings-project-sessions-workspace-trigger"
                      aria-label={t("settings.workspacePickerLabel")}
                      aria-haspopup="listbox"
                      aria-expanded={workspacePickerOpen}
                      onClick={() => setWorkspacePickerOpen((previous) => !previous)}
                      data-testid="settings-project-sessions-workspace-picker-trigger"
                    >
                      <span className="settings-project-sessions-workspace-trigger-value">
                        {selectedWorkspaceLabel}
                      </span>
                      <span
                        className={`codicon ${
                          workspacePickerOpen ? "codicon-chevron-up" : "codicon-chevron-down"
                        }`}
                        aria-hidden
                      />
                    </button>
                    {workspacePickerOpen ? (
                      <div
                        className="settings-project-sessions-workspace-dropdown popover-surface"
                        role="listbox"
                        aria-label={t("settings.workspacePickerLabel")}
                      >
                        <div className="settings-project-sessions-workspace-search">
                          <input
                            ref={workspaceSearchInputRef}
                            value={workspaceQuery}
                            onChange={(event) => setWorkspaceQuery(event.target.value)}
                            placeholder={t("workspace.searchProjects")}
                            aria-label={t("workspace.searchProjects")}
                          />
                        </div>
                        <div className="settings-project-sessions-workspace-list">
                          {filteredWorkspaceSections.map((section) => (
                            <div
                              key={section.id ?? "ungrouped"}
                              className="settings-project-sessions-workspace-group"
                            >
                              {showWorkspaceGroupLabel && section.name.trim().length > 0 ? (
                                <div className="settings-project-sessions-workspace-group-label">
                                  {section.name}
                                </div>
                              ) : null}
                              {section.options.map((entry) => {
                                const selected = entry.id === selectedWorkspaceId;
                                return (
                                  <button
                                    key={entry.id}
                                    type="button"
                                    className={`settings-project-sessions-workspace-option${
                                      selected ? " is-active" : ""
                                    }`}
                                    role="option"
                                    aria-selected={selected}
                                    onClick={() => handleWorkspaceSelect(entry.id)}
                                  >
                                    <span
                                      className="settings-project-sessions-workspace-option-check"
                                      aria-hidden
                                    >
                                      {selected ? "✓" : ""}
                                    </span>
                                    <span
                                      className={`settings-project-sessions-workspace-option-label${
                                        entry.kind === "worktree" ? " is-worktree" : ""
                                      }`}
                                    >
                                      {entry.kind === "worktree" ? "↳ " : ""}
                                      {entry.label}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          ))}
                          {filteredWorkspaceSections.length === 0 ? (
                            <div className="settings-project-sessions-workspace-empty">
                              {t("workspace.noProjectsFound")}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="settings-inline-muted">
                    {t("settings.workspacePickerEmpty")}
                  </div>
                )}
              </div>
              {workspace && onRefresh && (
                <button
                  type="button"
                  className="settings-project-sessions-header-btn"
                  onClick={() => onRefresh(workspace.id)}
                  disabled={loading}
                >
                  <span
                    className={`codicon ${
                      loading ? "codicon-loading codicon-modifier-spin" : "codicon-refresh"
                    }`}
                    aria-hidden
                  />
                  {t("settings.projectSessionRefresh")}
                </button>
              )}
            </div>
          </div>

          <div className="settings-project-sessions-toolbar">
            <span className="settings-project-sessions-selected">
              {t("settings.projectSessionSelectedCount", { count: selectedCount })}
            </span>
            <button
              type="button"
              className="settings-project-sessions-btn"
              onClick={selectAll}
              disabled={allSelected || orderedThreads.length === 0 || isDeleting}
            >
              <span className="codicon codicon-check-all" aria-hidden />
              {t("settings.projectSessionSelectAll")}
            </button>
            <button
              type="button"
              className="settings-project-sessions-btn"
              onClick={clearSelection}
              disabled={selectedCount === 0 || isDeleting}
            >
              <span className="codicon codicon-clear-all" aria-hidden />
              {t("settings.projectSessionClearSelection")}
            </button>
            <button
              type="button"
              className="settings-project-sessions-btn is-danger"
              onClick={() => {
                void handleDeleteSelected();
              }}
              disabled={selectedCount === 0 || isDeleting}
              data-testid="settings-project-sessions-delete-selected"
            >
              <span className="codicon codicon-trash" aria-hidden />
              {deleteLabel}
            </button>
            <button
              type="button"
              className="settings-project-sessions-btn"
              onClick={() => {
                setDeleteArmed(false);
                setNotice(null);
              }}
              disabled={!deleteArmed || isDeleting}
            >
              <span className="codicon codicon-close" aria-hidden />
              {t("settings.projectSessionCancelDelete")}
            </button>
          </div>

          {notice && (
            <div
              className={`settings-project-sessions-notice is-${notice.kind}`}
              role={notice.kind === "error" ? "alert" : "status"}
            >
              {notice.text}
            </div>
          )}

          {!workspace ? (
            <div className="settings-project-sessions-empty">
              {t("settings.projectSessionWorkspaceRequired")}
            </div>
          ) : loading ? (
            <div className="settings-project-sessions-empty">{t("settings.projectSessionLoading")}</div>
          ) : orderedThreads.length === 0 ? (
            <div className="settings-project-sessions-empty">{t("settings.projectSessionEmpty")}</div>
          ) : (
            <ul className="settings-project-sessions-list">
              {orderedThreads.map((thread) => {
                const selected = Boolean(selectedIds[thread.id]);
                const engineType = resolveEngineType(thread.engineSource);
                const engineLabel = resolveEngineLabel(thread.engineSource, t);
                return (
                  <li key={thread.id}>
                    <button
                      type="button"
                      className={`settings-project-sessions-item${selected ? " is-selected" : ""}`}
                      onClick={() => toggleSelection(thread.id)}
                      aria-pressed={selected}
                      disabled={isDeleting}
                    >
                      <span className="settings-project-sessions-item-engine" aria-hidden title={engineLabel}>
                        <EngineIcon engine={engineType} size={14} />
                      </span>
                      <span className="settings-project-sessions-item-content">
                        <span className="settings-project-sessions-item-title">
                          {thread.name.trim() || t("settings.projectSessionItemUntitled")}
                        </span>
                        <span className="settings-project-sessions-item-meta">
                          {formatUpdatedAtDisplay(thread.updatedAt, i18n.language)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
