import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  LocalUsageDailyUsage,
  LocalUsageSessionSummary,
  LocalUsageStatistics,
  WorkspaceInfo,
} from "../../../types";
import { localUsageStatistics } from "../../../services/tauri";
import { Button } from "@/components/ui/button";

type UsageSectionProps = {
  activeWorkspace: WorkspaceInfo | null;
  activeEngine: string | null;
  workspaces: WorkspaceInfo[];
  selectedWorkspaceId: string;
  onWorkspaceChange: (workspaceId: string) => void;
};

type UsageScope = "current" | "all";
type UsageTab = "overview" | "models" | "sessions" | "timeline";
type DateRange = "7d" | "30d" | "all";

const SESSIONS_PER_PAGE = 20;

function formatNumber(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  if (safe >= 1_000_000_000) return `${(safe / 1_000_000_000).toFixed(1)}B`;
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(1)}M`;
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(1)}K`;
  return Math.max(0, Math.round(safe)).toString();
}

function formatCost(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `$${safe.toFixed(4)}`;
}

export function UsageSection({
  activeWorkspace,
  activeEngine,
  workspaces,
  selectedWorkspaceId,
  onWorkspaceChange,
}: UsageSectionProps) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<UsageScope>("current");
  const [activeTab, setActiveTab] = useState<UsageTab>("overview");
  const [dateRange, setDateRange] = useState<DateRange>("7d");
  const [sessionPage, setSessionPage] = useState(1);
  const [sessionSortBy, setSessionSortBy] = useState<"cost" | "time">("cost");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statistics, setStatistics] = useState<LocalUsageStatistics | null>(null);
  const [tooltip, setTooltip] = useState<{
    visible: boolean;
    x: number;
    y: number;
    content: { date: string; cost: number; sessions: number };
  }>({
    visible: false,
    x: 0,
    y: 0,
    content: { date: "", cost: 0, sessions: 0 },
  });

  const loadStatistics = useCallback(async () => {
    const needWorkspace = scope === "current";
    if (needWorkspace && !activeWorkspace?.path) {
      setStatistics(null);
      setError(t("settings.usagePanel.workspaceRequired"));
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const next = await localUsageStatistics({
        scope,
        provider: activeEngine ?? "claude",
        dateRange,
        workspacePath: needWorkspace ? activeWorkspace?.path ?? null : null,
      });
      setStatistics(next);
    } catch (loadError) {
      setStatistics(null);
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [activeEngine, activeWorkspace?.path, dateRange, scope, t]);

  useEffect(() => {
    void loadStatistics();
  }, [loadStatistics]);

  useEffect(() => {
    setSessionPage(1);
  }, [scope, dateRange]);

  const formatDate = useCallback((timestamp: number): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return t("settings.usagePanel.today");
    if (diffDays === 1) return t("settings.usagePanel.yesterday");
    if (diffDays < 7) return `${diffDays}${t("settings.usagePanel.daysAgo")}`;

    return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  }, [t]);

  const formatRelativeTime = useCallback((timestamp: number): string => {
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);

    if (diffSec < 60) return t("settings.usagePanel.justNow");
    if (diffMin < 60) return `${diffMin}${t("settings.usagePanel.minutesAgo")}`;
    if (diffHour < 24) return `${diffHour}${t("settings.usagePanel.hoursAgo")}`;

    return formatDate(timestamp);
  }, [formatDate, t]);

  const formatShortDate = useCallback((dateStr: string): string => {
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) {
      return dateStr;
    }
    return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }, []);

  const renderTrend = useCallback((value: number) => {
    if (value === 0) {
      return (
        <span className="settings-usage-trend neutral">
          → 0% {t("settings.usagePanel.comparedToLastWeek")}
        </span>
      );
    }
    const isUp = value > 0;
    return (
      <span className={`settings-usage-trend ${isUp ? "up" : "down"}`}>
        {isUp ? "↑" : "↓"} {Math.abs(value).toFixed(1)}% {t("settings.usagePanel.comparedToLastWeek")}
      </span>
    );
  }, [t]);

  const filterByDateRange = useCallback(
    <T extends { timestamp?: number; date?: string }>(items: T[]) => {
      if (dateRange === "all") return items;
      const now = Date.now();
      const cutoff = dateRange === "7d"
        ? now - 7 * 24 * 60 * 60 * 1000
        : now - 30 * 24 * 60 * 60 * 1000;
      return items.filter((item) => {
        const time = item.timestamp ?? (item.date ? new Date(item.date).getTime() : 0);
        return time >= cutoff;
      });
    },
    [dateRange],
  );

  const filteredSessions = useMemo(() => {
    const source = filterByDateRange<LocalUsageSessionSummary>(statistics?.sessions ?? []);
    return source.slice().sort((a, b) => {
      if (sessionSortBy === "cost") {
        return b.cost - a.cost;
      }
      return b.timestamp - a.timestamp;
    });
  }, [filterByDateRange, sessionSortBy, statistics?.sessions]);

  const paginatedSessions = useMemo(
    () => filteredSessions.slice((sessionPage - 1) * SESSIONS_PER_PAGE, sessionPage * SESSIONS_PER_PAGE),
    [filteredSessions, sessionPage],
  );
  const totalPages = Math.max(1, Math.ceil(filteredSessions.length / SESSIONS_PER_PAGE));

  const filteredDailyUsage = useMemo(
    () => filterByDateRange<LocalUsageDailyUsage>(statistics?.dailyUsage ?? []),
    [filterByDateRange, statistics?.dailyUsage],
  );

  const maxDailyCost = useMemo(
    () => Math.max(1, ...filteredDailyUsage.map((day) => day.cost)),
    [filteredDailyUsage],
  );

  const getTokenPercentage = useCallback((value: number): number => {
    if (!statistics || statistics.totalUsage.totalTokens === 0) return 0;
    return (value / statistics.totalUsage.totalTokens) * 100;
  }, [statistics]);

  return (
    <section className="settings-section">
      <div className="settings-section-title">{t("settings.usagePanel.title")}</div>
      <div className="settings-section-subtitle">{t("settings.usagePanel.description")}</div>
      <div className="settings-usage-workspace-picker">
        {workspaces.length > 0 ? (
          <div className="settings-select-wrap">
            <select
              className="settings-select"
              value={selectedWorkspaceId}
              onChange={(event) => onWorkspaceChange(event.target.value)}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="settings-inline-muted">{t("settings.workspacePickerEmpty")}</div>
        )}
      </div>

      <div className="settings-usage-panel">
        <div className="settings-usage-notice">
          <span className="codicon codicon-warning" />
          {t("settings.usagePanel.estimateNotice")}
        </div>

        <div className="settings-usage-controls">
          <div className="settings-usage-controls-left">
            <div className="settings-usage-segmented">
              <button
                type="button"
                className={`settings-usage-segmented-btn ${scope === "current" ? "active" : ""}`}
                onClick={() => setScope("current")}
              >
                <span className="codicon codicon-folder" />
                {t("settings.usagePanel.scopeCurrent")}
              </button>
              <button
                type="button"
                className={`settings-usage-segmented-btn ${scope === "all" ? "active" : ""}`}
                onClick={() => setScope("all")}
              >
                <span className="codicon codicon-folder-library" />
                {t("settings.usagePanel.scopeAll")}
              </button>
            </div>

            <div className="settings-usage-segmented settings-usage-segmented--range">
              <button
                type="button"
                className={`settings-usage-segmented-btn ${dateRange === "7d" ? "active" : ""}`}
                onClick={() => setDateRange("7d")}
              >
                {t("settings.usagePanel.last7Days")}
              </button>
              <button
                type="button"
                className={`settings-usage-segmented-btn ${dateRange === "30d" ? "active" : ""}`}
                onClick={() => setDateRange("30d")}
              >
                {t("settings.usagePanel.last30Days")}
              </button>
              <button
                type="button"
                className={`settings-usage-segmented-btn ${dateRange === "all" ? "active" : ""}`}
                onClick={() => setDateRange("all")}
              >
                {t("settings.usagePanel.allTime")}
              </button>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={() => void loadStatistics()}
            disabled={loading}
            title={t("settings.usagePanel.refresh")}
            aria-label={t("settings.usagePanel.refresh")}
          >
            <span className={`codicon ${loading ? "codicon-loading codicon-modifier-spin" : "codicon-refresh"}`} />
          </Button>
        </div>

        {statistics?.lastUpdated ? (
          <div className="settings-help">
            {t("settings.usagePanel.lastUpdated")}: {formatRelativeTime(statistics.lastUpdated)}
          </div>
        ) : null}

        {error ? <div className="settings-inline-error">{error}</div> : null}
        {loading && !statistics ? <div className="settings-inline-muted">{t("settings.loading")}</div> : null}
        {!loading && !statistics && !error ? (
          <div className="settings-inline-muted">{t("settings.usagePanel.noData")}</div>
        ) : null}

        {statistics ? (
          <>
            <div className="settings-usage-tabs">
              <button
                type="button"
                className={`settings-usage-tab-btn ${activeTab === "overview" ? "active" : ""}`}
                onClick={() => setActiveTab("overview")}
              >
                <span className="codicon codicon-dashboard" />
                {t("settings.usagePanel.overview")}
              </button>
              <button
                type="button"
                className={`settings-usage-tab-btn ${activeTab === "models" ? "active" : ""}`}
                onClick={() => setActiveTab("models")}
              >
                <span className="codicon codicon-symbol-class" />
                {t("settings.usagePanel.models")}
              </button>
              <button
                type="button"
                className={`settings-usage-tab-btn ${activeTab === "sessions" ? "active" : ""}`}
                onClick={() => setActiveTab("sessions")}
              >
                <span className="codicon codicon-list-unordered" />
                {t("settings.usagePanel.sessions")}
              </button>
              <button
                type="button"
                className={`settings-usage-tab-btn ${activeTab === "timeline" ? "active" : ""}`}
                onClick={() => setActiveTab("timeline")}
              >
                <span className="codicon codicon-graph-line" />
                {t("settings.usagePanel.timeline")}
              </button>
            </div>

            <div className="settings-usage-content">
              {activeTab === "overview" ? (
                <div className="settings-usage-overview">
                  <div className="settings-usage-project-info">
                    <span className="codicon codicon-folder" />
                    <span className="project-name">
                      {scope === "all" ? t("settings.usagePanel.scopeAll") : statistics.projectName}
                    </span>
                  </div>

                  <div className="settings-usage-stat-cards">
                    <div className="settings-usage-stat-card cost-card">
                      <div className="stat-icon">
                        <span className="codicon codicon-credit-card" />
                      </div>
                      <div className="stat-content">
                        <div className="stat-label">{t("settings.usagePanel.totalCost")}</div>
                        <div className="stat-value">{formatCost(statistics.estimatedCost)}</div>
                        {renderTrend(statistics.weeklyComparison.trends.cost)}
                      </div>
                    </div>

                    <div className="settings-usage-stat-card sessions-card">
                      <div className="stat-icon">
                        <span className="codicon codicon-comment-discussion" />
                      </div>
                      <div className="stat-content">
                        <div className="stat-label">{t("settings.usagePanel.totalSessions")}</div>
                        <div className="stat-value">{statistics.totalSessions}</div>
                        {renderTrend(statistics.weeklyComparison.trends.sessions)}
                      </div>
                    </div>

                    <div className="settings-usage-stat-card tokens-card">
                      <div className="stat-icon">
                        <span className="codicon codicon-symbol-numeric" />
                      </div>
                      <div className="stat-content">
                        <div className="stat-label">{t("settings.usagePanel.totalTokens")}</div>
                        <div className="stat-value">{formatNumber(statistics.totalUsage.totalTokens)}</div>
                        {renderTrend(statistics.weeklyComparison.trends.tokens)}
                      </div>
                    </div>

                    <div className="settings-usage-stat-card avg-card">
                      <div className="stat-icon">
                        <span className="codicon codicon-graph" />
                      </div>
                      <div className="stat-content">
                        <div className="stat-label">{t("settings.usagePanel.avgPerSession")}</div>
                        <div className="stat-value">
                          {statistics.totalSessions > 0
                            ? formatCost(statistics.estimatedCost / statistics.totalSessions)
                            : "$0.0000"}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="settings-usage-token-breakdown">
                    <h4>{t("settings.usagePanel.tokenBreakdown")}</h4>
                    <div className="settings-usage-token-breakdown-inner">
                      <div className="settings-usage-token-row">
                        <div className="settings-usage-token-header">
                          <span>{t("settings.usagePanel.input")}</span>
                          <span>{formatNumber(statistics.totalUsage.inputTokens)}</span>
                        </div>
                        <div className="settings-usage-token-track">
                          <div
                            className="settings-usage-token-fill input"
                            style={{ width: `${getTokenPercentage(statistics.totalUsage.inputTokens)}%` }}
                          />
                        </div>
                      </div>

                      <div className="settings-usage-token-row">
                        <div className="settings-usage-token-header">
                          <span>{t("settings.usagePanel.output")}</span>
                          <span>{formatNumber(statistics.totalUsage.outputTokens)}</span>
                        </div>
                        <div className="settings-usage-token-track">
                          <div
                            className="settings-usage-token-fill output"
                            style={{ width: `${getTokenPercentage(statistics.totalUsage.outputTokens)}%` }}
                          />
                        </div>
                      </div>

                      <div className="settings-usage-token-row">
                        <div className="settings-usage-token-header">
                          <span>{t("settings.usagePanel.cacheWrite")}</span>
                          <span>{formatNumber(statistics.totalUsage.cacheWriteTokens)}</span>
                        </div>
                        <div className="settings-usage-token-track">
                          <div
                            className="settings-usage-token-fill cache-write"
                            style={{ width: `${getTokenPercentage(statistics.totalUsage.cacheWriteTokens)}%` }}
                          />
                        </div>
                      </div>

                      <div className="settings-usage-token-row">
                        <div className="settings-usage-token-header">
                          <span>{t("settings.usagePanel.cacheRead")}</span>
                          <span>{formatNumber(statistics.totalUsage.cacheReadTokens)}</span>
                        </div>
                        <div className="settings-usage-token-track">
                          <div
                            className="settings-usage-token-fill cache-read"
                            style={{ width: `${getTokenPercentage(statistics.totalUsage.cacheReadTokens)}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {statistics.byModel.length > 0 ? (
                    <div className="settings-usage-top-models">
                      <h4>{t("settings.usagePanel.topModels")}</h4>
                      <div className="settings-usage-top-models-list">
                        {statistics.byModel.slice(0, 3).map((model, index) => (
                          <div key={model.model} className="settings-usage-model-card">
                            <div className="model-rank">#{index + 1}</div>
                            <div className="model-info">
                              <div className="model-name">{model.model}</div>
                              <div className="model-stats">
                                <span>{formatCost(model.totalCost)}</span>
                                <span className="separator">•</span>
                                <span>{formatNumber(model.totalTokens)} tokens</span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {activeTab === "models" ? (
                <div className="settings-usage-models-tab">
                  <h4>{t("settings.usagePanel.byModel")}</h4>
                  <div className="settings-usage-model-list">
                    {statistics.byModel.map((model) => (
                      <div key={model.model} className="settings-usage-model-item">
                        <div className="model-header">
                          <span className="model-name">{model.model}</span>
                          <span className="model-cost">{formatCost(model.totalCost)}</span>
                        </div>
                        <div className="model-details">
                          <div className="detail-item">
                            <span className="detail-label">{t("settings.usagePanel.sessionCount")}:</span>
                            <span className="detail-value">{model.sessionCount}</span>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">{t("settings.usagePanel.totalTokens")}:</span>
                            <span className="detail-value">{formatNumber(model.totalTokens)}</span>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">{t("settings.usagePanel.input")}:</span>
                            <span className="detail-value">{formatNumber(model.inputTokens)}</span>
                          </div>
                          <div className="detail-item">
                            <span className="detail-label">{t("settings.usagePanel.output")}:</span>
                            <span className="detail-value">{formatNumber(model.outputTokens)}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {activeTab === "sessions" ? (
                <div className="settings-usage-sessions-tab">
                  <div className="sessions-header">
                    <h4>
                      {t("settings.usagePanel.sessionList")} ({filteredSessions.length})
                    </h4>
                    <div className="settings-usage-sort-buttons">
                      <button
                        type="button"
                        className={`sort-btn ${sessionSortBy === "cost" ? "active" : ""}`}
                        onClick={() => setSessionSortBy("cost")}
                      >
                        {t("settings.usagePanel.sortByCost")}
                      </button>
                      <button
                        type="button"
                        className={`sort-btn ${sessionSortBy === "time" ? "active" : ""}`}
                        onClick={() => setSessionSortBy("time")}
                      >
                        {t("settings.usagePanel.sortByTime")}
                      </button>
                    </div>
                  </div>

                  <div className="settings-usage-session-list">
                    {paginatedSessions.map((session, index) => (
                      <div key={session.sessionId} className="settings-usage-session-item">
                        <div className="session-rank">
                          {(sessionPage - 1) * SESSIONS_PER_PAGE + index + 1}
                        </div>
                        <div className="session-info">
                          <div className="session-title">{session.summary || session.sessionId}</div>
                          {session.summary ? (
                            <div className="session-id-small">{session.sessionId}</div>
                          ) : null}
                          <div className="session-meta">
                            <span>{formatDate(session.timestamp)}</span>
                            <span className="separator">•</span>
                            <span>{session.model}</span>
                            <span className="separator">•</span>
                            <span>{formatNumber(session.usage.totalTokens)} tokens</span>
                          </div>
                        </div>
                        <div className="session-cost">{formatCost(session.cost)}</div>
                      </div>
                    ))}
                  </div>

                  {totalPages > 1 ? (
                    <div className="settings-usage-pagination">
                      <button
                        type="button"
                        onClick={() => setSessionPage((prev) => Math.max(1, prev - 1))}
                        disabled={sessionPage === 1}
                        className="page-btn"
                      >
                        <span className="codicon codicon-chevron-left" />
                      </button>
                      <span className="page-info">
                        {sessionPage} / {totalPages}
                      </span>
                      <button
                        type="button"
                        onClick={() => setSessionPage((prev) => Math.min(totalPages, prev + 1))}
                        disabled={sessionPage === totalPages}
                        className="page-btn"
                      >
                        <span className="codicon codicon-chevron-right" />
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {activeTab === "timeline" ? (
                <div className="settings-usage-timeline-tab">
                  <h4>{t("settings.usagePanel.dailyTrend")}</h4>
                  <div className="settings-usage-timeline-chart">
                    {filteredDailyUsage.length > 0 ? (
                      <div className="settings-usage-chart-with-axis">
                        <div className="settings-usage-chart-y-axis">
                          {[1, 0.75, 0.5, 0.25, 0].map((ratio) => (
                            <div key={ratio} className="y-axis-label">
                              {formatCost(maxDailyCost * ratio)}
                            </div>
                          ))}
                        </div>
                        <div className="settings-usage-chart-main">
                          <div className="settings-usage-chart-grid">
                            {[0, 1, 2, 3, 4].map((index) => (
                              <div key={index} className="chart-grid-line" style={{ bottom: `${index * 25}%` }} />
                            ))}
                          </div>
                          <div className="settings-usage-chart-scroll-view">
                            <div className="settings-usage-chart-bars">
                              {filteredDailyUsage.map((day) => {
                                const height = maxDailyCost > 0 ? (day.cost / maxDailyCost) * 100 : 0;
                                return (
                                  <div key={day.date} className="chart-bar-wrapper">
                                    <div className="chart-bar-container">
                                      <div
                                        className="chart-bar"
                                        style={{ height: `${height}%` }}
                                        onMouseEnter={(event) => {
                                          const rect = event.currentTarget.getBoundingClientRect();
                                          setTooltip({
                                            visible: true,
                                            x: rect.left + rect.width / 2,
                                            y: rect.top,
                                            content: { date: day.date, cost: day.cost, sessions: day.sessions },
                                          });
                                        }}
                                        onMouseLeave={() => setTooltip((prev) => ({ ...prev, visible: false }))}
                                      />
                                    </div>
                                    <div className="chart-label">{formatShortDate(day.date)}</div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="settings-inline-muted">{t("settings.usagePanel.noDataInRange")}</div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      {tooltip.visible ? (
        <div className="settings-usage-chart-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <div className="tooltip-date">{formatShortDate(tooltip.content.date)}</div>
          <div className="tooltip-cost">{formatCost(tooltip.content.cost)}</div>
          <div className="tooltip-sessions">
            {tooltip.content.sessions} {t("settings.usagePanel.sessionsCount")}
          </div>
        </div>
      ) : null}
    </section>
  );
}
