import { createElement, useEffect, useState } from 'react';

const GROUPING_PRESETS = ['status', 'priority', 'assignee', 'sprint'];

function scoreTaskPriority(task) {
  const rawPriority = String(task?.priority ?? 'normal').toLowerCase();
  const status = String(task?.status ?? 'todo').toLowerCase();
  const title = String(task?.title ?? '').toLowerCase();
  const blocked =
    Boolean(task?.blocked) ||
    status === 'blocked' ||
    title.includes('[blocked]') ||
    title.includes('blocker');

  let score = 50;
  if (rawPriority === 'urgent' || rawPriority === 'critical') score = 95;
  else if (rawPriority === 'high') score = 80;
  else if (rawPriority === 'low') score = 25;

  if (blocked) score += 15;
  if (status === 'in_progress' || status === 'inreview') score += 5;
  if (status === 'done' || status === 'completed') score = 0;

  const bucket =
    score >= 90
      ? 'urgent'
      : score >= 75
        ? 'high'
        : score >= 40
          ? 'normal'
          : 'low';

  const recommendedStatus =
    status === 'done' || status === 'completed'
      ? 'done'
      : blocked
        ? 'blocked'
        : score >= 80 && status === 'backlog'
          ? 'todo'
          : status;

  return {
    id: String(task?.id ?? `task-${Math.random().toString(36).slice(2, 8)}`),
    title: String(task?.title ?? 'Untitled task'),
    status,
    priority: rawPriority,
    blocked,
    assignee: task?.assignee ?? null,
    score,
    bucket,
    recommendedStatus,
  };
}

function computeVelocityMetrics(tasks = []) {
  const list = Array.isArray(tasks) ? tasks : [];
  let completedCount = 0;
  let inProgressCount = 0;
  let blockedCount = 0;
  let todoCount = 0;

  for (const item of list) {
    const status = String(item?.status ?? 'todo').toLowerCase();
    if (status === 'done' || status === 'completed') {
      completedCount += 1;
    } else if (Boolean(item?.blocked) || status === 'blocked') {
      blockedCount += 1;
    } else if (
      status === 'in_progress' ||
      status === 'inprogress' ||
      status === 'inreview' ||
      status === 'review'
    ) {
      inProgressCount += 1;
    } else {
      todoCount += 1;
    }
  }

  const totalCount = list.length;
  const completionRate =
    totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return {
    totalCount,
    completedCount,
    inProgressCount,
    blockedCount,
    todoCount,
    completionRate,
  };
}

function createKanbanTriageMatrixComponent(kanbanService) {
  return function KanbanTriageMatrixView() {
    const [report, setReport] = useState(() =>
      kanbanService.getLastTriageReport()
    );
    const [preset, setPreset] = useState(() => kanbanService.getFilterPreset());

    useEffect(() => {
      return kanbanService.subscribe((state) => {
        setReport(state.lastReport);
        setPreset(state.filterPreset);
      });
    }, []);

    return createElement(
      'div',
      {
        className: 'dimo-kanban-triage-view p-4 flex flex-col gap-3',
        'data-testid': 'kanban-triage-matrix-view',
      },
      createElement(
        'div',
        { className: 'flex items-center justify-between gap-2' },
        createElement(
          'strong',
          null,
          `Kanban Triage Matrix (Grouping: ${preset})`
        ),
        createElement(
          'div',
          { className: 'flex gap-2' },
          createElement(
            'button',
            {
              type: 'button',
              'data-testid': 'kanban-run-triage-btn',
              onClick: () => void kanbanService.triageTasks(),
            },
            'Run Triage'
          ),
          createElement(
            'button',
            {
              type: 'button',
              'data-testid': 'kanban-cycle-preset-btn',
              onClick: () => void kanbanService.cycleFilterPreset(),
            },
            'Cycle Filter Preset'
          )
        )
      ),
      createElement(
        'div',
        { 'data-testid': 'kanban-triage-summary' },
        report
          ? `Triaged ${report.totalTasks} tasks (Urgent: ${report.buckets.urgent.length}, High: ${report.buckets.high.length}, Blocked: ${report.metrics.blockedCount})`
          : 'No triage run yet.'
      )
    );
  };
}

function createKanbanVelocityTimelineComponent(kanbanService) {
  return function KanbanVelocityTimelineView() {
    const [report, setReport] = useState(() =>
      kanbanService.getLastTriageReport()
    );

    useEffect(() => {
      return kanbanService.subscribe((state) => {
        setReport(state.lastReport);
      });
    }, []);

    const metrics = report?.metrics ?? computeVelocityMetrics([]);

    return createElement(
      'div',
      {
        className: 'dimo-kanban-velocity-view p-4 flex flex-col gap-2',
        'data-testid': 'kanban-velocity-timeline-view',
      },
      createElement('strong', null, 'Sprint Velocity & Throughput'),
      createElement(
        'div',
        { 'data-testid': 'kanban-velocity-metrics' },
        `Completion Rate: ${metrics.completionRate}% (${metrics.completedCount}/${metrics.totalCount} done, ${metrics.inProgressCount} active, ${metrics.blockedCount} blocked)`
      )
    );
  };
}

function createKanbanPulseDeckComponent(ctx) {
  return function KanbanPulseDeckPluginView(props) {
    const [snapshot, setSnapshot] = useState(null);
    const [modeFilter, setModeFilter] = useState('all');

    useEffect(() => {
      let cancelled = false;
      async function loadSnapshot() {
        try {
          if (typeof ctx?.host?.call === 'function') {
            const res = await ctx.host.call('pulse', 'deckSnapshot', {
              projectId: props?.projectId ?? null,
            });
            if (!cancelled && res && typeof res === 'object') {
              setSnapshot(res);
              return;
            }
          }
          const cached = await ctx?.storage?.kv?.get?.('pulseDeckSnapshot');
          if (!cancelled && cached && typeof cached === 'object') {
            setSnapshot(cached);
          }
        } catch {
          // Best-effort plugin snapshot lookup.
        }
      }
      void loadSnapshot();
      return () => {
        cancelled = true;
      };
    }, [props?.projectId]);

    const sources = Array.isArray(snapshot?.sources) ? snapshot.sources : [];
    const rules = Array.isArray(snapshot?.rules) ? snapshot.rules : [];
    const candidates = Array.isArray(snapshot?.observedCandidates)
      ? snapshot.observedCandidates
      : [];
    const subscriptions = Array.isArray(snapshot?.subscriptions)
      ? snapshot.subscriptions
      : [];
    const visibleRules =
      modeFilter === 'all'
        ? rules
        : rules.filter((rule) => rule?.spec?.evalMode === modeFilter);

    return createElement(
      'div',
      {
        className:
          'vibex-kanban-pulse-deck bg-background text-foreground p-4 flex flex-col gap-4 h-full overflow-y-auto',
        'data-testid': 'kanban-pulse-deck-plugin-view',
      },
      createElement(
        'div',
        {
          className:
            'flex items-center justify-between gap-3 border-b border-border pb-3',
        },
        createElement(
          'div',
          { className: 'flex flex-col gap-0.5' },
          createElement(
            'strong',
            { className: 'text-sm font-semibold' },
            'Event Pulse Deck'
          ),
          createElement(
            'span',
            { className: 'text-xs text-muted-foreground tabular-nums' },
            `Sources: ${sources.length} · Observe Candidates: ${candidates.length} · Subscriptions: ${subscriptions.length}`
          )
        ),
        createElement(
          'div',
          { className: 'flex items-center gap-1' },
          ['all', 'observe', 'auto', 'off'].map((mode) =>
            createElement(
              'button',
              {
                key: mode,
                type: 'button',
                className:
                  modeFilter === mode
                    ? 'rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-foreground'
                    : 'rounded-md px-2 py-1 text-xs text-muted-foreground',
                onClick: () => setModeFilter(mode),
              },
              mode.toUpperCase()
            )
          )
        )
      ),
      createElement(
        'div',
        {
          className: 'grid grid-cols-3 gap-3 text-xs',
          'data-testid': 'kanban-pulse-deck-summary',
        },
        createElement(
          'div',
          { className: 'rounded-lg border border-border p-3' },
          createElement(
            'div',
            { className: 'font-medium text-foreground' },
            'Source Health & Watermarks'
          ),
          createElement(
            'div',
            { className: 'mt-1 text-muted-foreground tabular-nums' },
            sources.length > 0
              ? `${sources.filter((s) => s.healthy).length}/${sources.length} healthy`
              : 'Feishu · Jira · GitHub · Webhook · Temporal ready'
          )
        ),
        createElement(
          'div',
          { className: 'rounded-lg border border-border p-3' },
          createElement(
            'div',
            { className: 'font-medium text-foreground' },
            'Observe Candidate Stream'
          ),
          createElement(
            'div',
            { className: 'mt-1 text-muted-foreground tabular-nums' },
            `${candidates.filter((c) => !c.promoted).length} pending promotion`
          )
        ),
        createElement(
          'div',
          { className: 'rounded-lg border border-border p-3' },
          createElement(
            'div',
            { className: 'font-medium text-foreground' },
            'Rules & Thread Subscriptions'
          ),
          createElement(
            'div',
            { className: 'mt-1 text-muted-foreground tabular-nums' },
            `${visibleRules.length} rules · ${subscriptions.filter((s) => s.active).length} active threads`
          )
        )
      )
    );
  };
}

export default {
  apiVersion: '2.0',
  id: 'dimo.kanban-views',
  activate(ctx) {
    const listeners = new Set();
    let activeFilterPreset = 'status';
    let lastTriageReport = null;
    let foundationService = null;

    ctx.effect(() => () => {
      listeners.clear();
      lastTriageReport = null;
      foundationService = null;
    });

    function notifyListeners() {
      const snapshot = {
        filterPreset: activeFilterPreset,
        lastReport: lastTriageReport,
        foundationConnected: Boolean(foundationService),
      };
      for (const listener of listeners) {
        try {
          listener(snapshot);
        } catch {
          // Isolate subscriber errors.
        }
      }
    }

    async function runTriage(inputTasks) {
      let sourceTasks = inputTasks;
      if (!Array.isArray(sourceTasks)) {
        try {
          const storedTasks = await ctx.storage.kv.get('tasks');
          sourceTasks = Array.isArray(storedTasks) ? storedTasks : [];
        } catch {
          sourceTasks = [];
        }
      }

      const scored = sourceTasks
        .map((task) => scoreTaskPriority(task))
        .sort((a, b) => b.score - a.score);

      const buckets = {
        urgent: scored.filter((t) => t.bucket === 'urgent'),
        high: scored.filter((t) => t.bucket === 'high'),
        normal: scored.filter((t) => t.bucket === 'normal'),
        low: scored.filter((t) => t.bucket === 'low'),
      };

      const metrics = computeVelocityMetrics(sourceTasks);
      const report = {
        triagedAt: Date.now(),
        filterPreset: activeFilterPreset,
        totalTasks: scored.length,
        triagedTasks: scored,
        buckets,
        metrics,
      };
      lastTriageReport = report;

      try {
        await ctx.storage.kv.set('triageReport', report);
      } catch {
        // Ignore KV failure when offline.
      }
      notifyListeners();
      ctx.events.emit('kanban:triage', report);
      return report;
    }

    async function setFilterPreset(preset) {
      const normalized = GROUPING_PRESETS.includes(preset) ? preset : 'status';
      activeFilterPreset = normalized;
      try {
        await ctx.storage.kv.set('activeFilterPreset', normalized);
      } catch {
        // Ignore KV error.
      }
      notifyListeners();
      ctx.events.emit('kanban:filter-changed', { preset: normalized });
      return normalized;
    }

    async function cycleFilterPreset() {
      const idx = GROUPING_PRESETS.indexOf(activeFilterPreset);
      const next = GROUPING_PRESETS[(idx + 1) % GROUPING_PRESETS.length];
      return await setFilterPreset(next);
    }

    const kanbanService = {
      defaultViews: ['board', 'list', 'timeline'],
      registeredViews: ['triage-board', 'velocity-timeline'],
      pulseDeckViewId: 'pulse-deck',
      groupingPresets: [...GROUPING_PRESETS],
      triageTasks: runTriage,
      computeVelocityMetrics,
      getLastTriageReport() {
        return lastTriageReport;
      },
      getFilterPreset() {
        return activeFilterPreset;
      },
      setFilterPreset,
      cycleFilterPreset,
      getFoundationStatus() {
        const currentFoundation =
          foundationService ?? ctx.services.get('dimo.webui.kanban') ?? null;
        return {
          connected: Boolean(currentFoundation),
          foundationPluginId: currentFoundation?.pluginId ?? null,
          serviceKey: 'dimo.webui.kanban',
        };
      },
      subscribe(listener) {
        if (typeof listener !== 'function') {
          return () => undefined;
        }
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };

    const TriageMatrixComponent =
      createKanbanTriageMatrixComponent(kanbanService);
    const VelocityTimelineComponent =
      createKanbanVelocityTimelineComponent(kanbanService);
    const PulseDeckComponent = createKanbanPulseDeckComponent(ctx);

    ctx.ui.registerKanbanView({
      id: 'triage-board',
      title: 'Triage Matrix',
      titleKey: 'kanbanViews.triageMatrix',
      icon: 'layers',
      hidesBottomDock: true,
      order: 50,
      component: TriageMatrixComponent,
    });

    ctx.ui.registerKanbanView({
      id: 'pulse-deck',
      title: 'Event Pulse Deck',
      titleKey: 'kanbanViews.pulseDeck',
      icon: 'activity',
      hidesBottomDock: true,
      order: 55,
      component: PulseDeckComponent,
    });

    ctx.ui.registerKanbanView({
      id: 'velocity-timeline',
      title: 'Sprint Velocity',
      titleKey: 'kanbanViews.sprintVelocity',
      icon: 'activity',
      hidesBottomDock: true,
      order: 60,
      component: VelocityTimelineComponent,
    });

    ctx.ui.registerCommand({
      id: 'dimo.kanban.triage',
      title: 'Triage Kanban Board Tasks',
      category: 'Kanban',
      icon: 'layers',
      handler: async () => {
        return await runTriage();
      },
    });

    ctx.ui.registerCommand({
      id: 'kanban-filter-command',
      title: 'Filter Kanban Tasks',
      category: 'Kanban',
      icon: 'filter',
      handler: async () => {
        return await cycleFilterPreset();
      },
    });

    ctx.ui.registerSlashCommand({
      name: 'kanban-triage',
      description:
        'Triage Kanban board tasks by priority, blockers, and sprint velocity',
      prompt:
        'Analyze and triage the current Kanban board tasks by priority and blockers:',
      execute: async () => {
        await runTriage();
        return 'Analyze and triage the current Kanban board tasks by priority and blockers:';
      },
    });

    ctx.services.inject(['dimo.webui.kanban'], ([webuiKanban]) => {
      foundationService = webuiKanban;
      notifyListeners();
      return () => {
        foundationService = null;
        notifyListeners();
      };
    });

    ctx.services.provide('dimo.kanban-views', kanbanService);
  },
};
