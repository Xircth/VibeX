import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

export interface ProfileOption {
  id: string;
  label: string;
}

export interface ProfileUserDataSummary {
  profileId: string;
  bookmarksCount: number;
  historyCount: number;
  credentialsCount: number;
}

interface DetectedBrowserProfile {
  id: string;
  browserId: string;
  browserName: string;
  profileName: string;
  profilePath: string;
  engine: 'chromium' | 'firefox';
  hasBookmarks: boolean;
  hasHistory: boolean;
}

interface RedactedCredentialItem {
  id: string;
  name: string;
  url: string;
  origin: string;
  host: string;
  username: string;
  source: string;
  updatedAt: number;
}

interface ImportRunResult {
  profileId: string;
  bookmarksAdded: number;
  historyAdded: number;
  credentialsAdded: number;
  credentialsUpdated: number;
  credentialsSkipped: number;
  warnings?: string[];
  summary?: ProfileUserDataSummary;
}

function notifyUserDataChanged(profileId: string) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('dimo:browser-userdata-changed', {
        detail: { profileId },
      })
    );
  }
}

export function BrowserUserDataImport({
  profiles,
  defaultTargetProfileId,
  summaries,
  dispatch,
  onSummariesRefresh,
  onStatus,
}: {
  profiles: ProfileOption[];
  defaultTargetProfileId: string;
  summaries: Record<string, ProfileUserDataSummary>;
  dispatch: <T = unknown>(
    operation: string,
    input?: Record<string, unknown>
  ) => Promise<T>;
  onSummariesRefresh: () => Promise<void>;
  onStatus: (tone: 'success' | 'danger' | 'neutral', text: string) => void;
}) {
  const usableProfiles = useMemo(
    () => profiles.filter((p) => p.id !== 'ephemeral'),
    [profiles]
  );

  const resolvedDefaultTarget = useMemo(() => {
    if (
      defaultTargetProfileId &&
      defaultTargetProfileId !== 'ephemeral' &&
      usableProfiles.some((p) => p.id === defaultTargetProfileId)
    ) {
      return defaultTargetProfileId;
    }
    return usableProfiles[0]?.id ?? 'default';
  }, [defaultTargetProfileId, usableProfiles]);

  const [targetProfileId, setTargetProfileId] = useState<string>(
    resolvedDefaultTarget
  );

  useEffect(() => {
    if (!usableProfiles.some((p) => p.id === targetProfileId)) {
      setTargetProfileId(resolvedDefaultTarget);
    }
  }, [resolvedDefaultTarget, targetProfileId, usableProfiles]);

  const [detected, setDetected] = useState<DetectedBrowserProfile[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [includeBookmarks, setIncludeBookmarks] = useState(true);
  const [includeHistory, setIncludeHistory] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [showCredentials, setShowCredentials] = useState(false);
  const [credentials, setCredentials] = useState<RedactedCredentialItem[]>([]);
  const [loadingCredentials, setLoadingCredentials] = useState(false);
  const [showExportHint, setShowExportHint] = useState(false);

  const csvInputRef = useRef<HTMLInputElement | null>(null);
  const htmlInputRef = useRef<HTMLInputElement | null>(null);
  const targetSelectId = useId();

  const activeSummary: ProfileUserDataSummary = summaries[targetProfileId] ?? {
    profileId: targetProfileId,
    bookmarksCount: 0,
    historyCount: 0,
    credentialsCount: 0,
  };

  const detectBrowsers = useCallback(async () => {
    setDetecting(true);
    setDetectError(null);
    try {
      const res = await dispatch<{ browsers?: DetectedBrowserProfile[] }>(
        'userdata.import.detect',
        {}
      );
      setDetected(Array.isArray(res?.browsers) ? res.browsers : []);
    } catch (err) {
      setDetectError(
        err instanceof Error ? err.message : '未能扫描本机已安装的浏览器'
      );
    } finally {
      setDetecting(false);
    }
  }, [dispatch]);

  useEffect(() => {
    void detectBrowsers();
  }, [detectBrowsers]);

  const loadCredentials = useCallback(
    async (profileId: string) => {
      setLoadingCredentials(true);
      try {
        const res = await dispatch<{ credentials?: RedactedCredentialItem[] }>(
          'userdata.credentials.list',
          { profileId }
        );
        setCredentials(Array.isArray(res?.credentials) ? res.credentials : []);
      } catch {
        setCredentials([]);
      } finally {
        setLoadingCredentials(false);
      }
    },
    [dispatch]
  );

  useEffect(() => {
    if (showCredentials) {
      void loadCredentials(targetProfileId);
    }
  }, [loadCredentials, showCredentials, targetProfileId]);

  const handleImportProfile = async (item: DetectedBrowserProfile) => {
    if (!includeBookmarks && !includeHistory) {
      onStatus('neutral', '请至少勾选「书签」或「常用历史」');
      return;
    }
    setBusyKey(`browser:${item.id}`);
    try {
      const res = await dispatch<ImportRunResult>('userdata.import.run', {
        targetProfileId,
        sourceProfilePath: item.profilePath,
        sourceEngine: item.engine,
        includeBookmarks,
        includeHistory,
      });
      await onSummariesRefresh();
      notifyUserDataChanged(targetProfileId);
      const parts: string[] = [];
      if (includeBookmarks) parts.push(`新增 ${res.bookmarksAdded ?? 0} 条书签`);
      if (includeHistory) parts.push(`同步 ${res.historyAdded ?? 0} 条常用历史`);
      const warnSuffix =
        res.warnings && res.warnings.length > 0
          ? `（${res.warnings[0]}）`
          : '';
      onStatus(
        'success',
        `已从 ${item.browserName}（${item.profileName}）导入：${parts.join('，')}${warnSuffix}`
      );
    } catch (err) {
      onStatus(
        'danger',
        err instanceof Error ? err.message : '导入浏览器数据失败'
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleImportBookmarkHtml = async (file: File) => {
    setBusyKey('html');
    try {
      const bookmarkHtml = await file.text();
      const res = await dispatch<ImportRunResult>('userdata.import.run', {
        targetProfileId,
        bookmarkHtml,
      });
      await onSummariesRefresh();
      notifyUserDataChanged(targetProfileId);
      onStatus('success', `已从书签文件导入 ${res.bookmarksAdded ?? 0} 条书签`);
    } catch (err) {
      onStatus(
        'danger',
        err instanceof Error ? err.message : '解析书签 HTML 失败'
      );
    } finally {
      setBusyKey(null);
      if (htmlInputRef.current) htmlInputRef.current.value = '';
    }
  };

  const handleImportPasswordCsv = async (file: File) => {
    setBusyKey('csv');
    try {
      const passwordCsv = await file.text();
      const res = await dispatch<ImportRunResult>('userdata.import.run', {
        targetProfileId,
        passwordCsv,
        passwordSource: file.name || 'csv',
      });
      await onSummariesRefresh();
      if (showCredentials) {
        await loadCredentials(targetProfileId);
      }
      notifyUserDataChanged(targetProfileId);
      const added = res.credentialsAdded ?? 0;
      const updated = res.credentialsUpdated ?? 0;
      onStatus(
        'success',
        `已加密保存本地密码：新增 ${added} 条，更新 ${updated} 条`
      );
    } catch (err) {
      onStatus(
        'danger',
        err instanceof Error ? err.message : '导入密码 CSV 失败'
      );
    } finally {
      setBusyKey(null);
      if (csvInputRef.current) csvInputRef.current.value = '';
    }
  };

  const handleRemoveCredential = async (credentialId: string) => {
    setBusyKey(`del:${credentialId}`);
    try {
      await dispatch('userdata.credentials.remove', {
        profileId: targetProfileId,
        credentialId,
      });
      await Promise.all([
        onSummariesRefresh(),
        loadCredentials(targetProfileId),
      ]);
      notifyUserDataChanged(targetProfileId);
    } catch (err) {
      onStatus(
        'danger',
        err instanceof Error ? err.message : '删除本地凭据失败'
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleClearKind = async (
    kind: 'bookmarks' | 'history' | 'credentials'
  ) => {
    setBusyKey(`clear:${kind}`);
    try {
      await dispatch(`userdata.${kind}.clear`, { profileId: targetProfileId });
      await onSummariesRefresh();
      if (kind === 'credentials' && showCredentials) {
        setCredentials([]);
      }
      notifyUserDataChanged(targetProfileId);
      const label =
        kind === 'bookmarks'
          ? '书签'
          : kind === 'history'
            ? '常用历史'
            : '本地加密密码';
      onStatus('success', `已清空该配置的${label}`);
    } catch (err) {
      onStatus('danger', err instanceof Error ? err.message : '清空失败');
    } finally {
      setBusyKey(null);
    }
  };

  const btnStyle: React.CSSProperties = {
    height: '28px',
    minHeight: '28px',
    paddingInline: '10px',
    fontSize: '12px',
    lineHeight: '16px',
    border: '0',
    borderRadius:
      'var(--_button-radius, var(--radius-element, var(--radius, 8px)))',
    background: 'var(--surface-control-solid, var(--color-neutral, #e5e5e5))',
    color: 'var(--text-strong, var(--color-text-primary, inherit))',
  };

  return (
    <div
      className="mt-1 w-full space-y-3 border-t border-[var(--border-subtle,hsl(var(--border)))] pt-3"
      data-testid="browser-userdata-import"
    >
      {/* Header + Target Profile Selector */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <span>从其他浏览器导入</span>
            <span className="settings-status-pill-success px-2 py-0.5 text-[11px] font-medium">
              仅本地加密保存 · 不上云
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            一键迁移书签与常用历史（地址栏输入自动匹配），并支持通过密码 CSV 在本地加密保管登录账号。
          </p>
        </div>

        <div className="flex items-center gap-2">
          <label
            htmlFor={targetSelectId}
            className="text-xs text-muted-foreground"
          >
            导入到
          </label>
          <select
            id={targetSelectId}
            aria-label="导入目标配置文件"
            value={targetProfileId}
            onChange={(e) => setTargetProfileId(e.target.value)}
            className="h-7 rounded-lg border px-2 text-xs font-medium text-foreground outline-none"
            style={{
              border: '1px solid var(--border-subtle, hsl(var(--border)))',
              background:
                'var(--surface-raised-control, var(--surface-control))',
            }}
          >
            {usableProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Current profile user-data stats & quick clear */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border-subtle,hsl(var(--border)))] bg-[var(--surface-control,hsl(var(--muted)/0.25))] px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <span className="tabular-nums text-muted-foreground">
            书签{' '}
            <strong className="font-semibold text-foreground">
              {activeSummary.bookmarksCount}
            </strong>
          </span>
          <span className="tabular-nums text-muted-foreground">
            常用历史{' '}
            <strong className="font-semibold text-foreground">
              {activeSummary.historyCount}
            </strong>
          </span>
          <span className="tabular-nums text-muted-foreground">
            本地密码{' '}
            <strong className="font-semibold text-foreground">
              {activeSummary.credentialsCount}
            </strong>
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {activeSummary.bookmarksCount > 0 ? (
            <button
              type="button"
              disabled={busyKey !== null}
              onClick={() => void handleClearKind('bookmarks')}
              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            >
              清空书签
            </button>
          ) : null}
          {activeSummary.historyCount > 0 ? (
            <button
              type="button"
              disabled={busyKey !== null}
              onClick={() => void handleClearKind('history')}
              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            >
              清空历史
            </button>
          ) : null}
          {activeSummary.credentialsCount > 0 ? (
            <>
              <button
                type="button"
                onClick={() => setShowCredentials((prev) => !prev)}
                className="rounded px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10"
              >
                {showCredentials ? '收起账号列表' : '管理本地账号'}
              </button>
              <button
                type="button"
                disabled={busyKey !== null}
                onClick={() => void handleClearKind('credentials')}
                className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
              >
                清空密码
              </button>
            </>
          ) : null}
        </div>
      </div>

      {/* Step 1: One-click import from detected local browsers */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="font-medium text-foreground">
              1. 书签与常用历史（一键导入）
            </span>
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-muted-foreground">
              <input
                type="checkbox"
                checked={includeBookmarks}
                onChange={(e) => setIncludeBookmarks(e.target.checked)}
                className="h-3.5 w-3.5 rounded border"
              />
              <span>书签</span>
            </label>
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-muted-foreground">
              <input
                type="checkbox"
                checked={includeHistory}
                onChange={(e) => setIncludeHistory(e.target.checked)}
                className="h-3.5 w-3.5 rounded border"
              />
              <span>常用历史</span>
            </label>
          </div>

          <div className="flex items-center gap-1.5">
            <input
              ref={htmlInputRef}
              type="file"
              accept=".html,.htm,text/html"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleImportBookmarkHtml(file);
              }}
            />
            <button
              type="button"
              disabled={busyKey !== null}
              onClick={() => htmlInputRef.current?.click()}
              className="astryx-button inline-flex shrink-0 cursor-pointer items-center justify-center font-medium disabled:opacity-50"
              style={btnStyle}
            >
              导入书签 HTML
            </button>
            <button
              type="button"
              disabled={detecting || busyKey !== null}
              onClick={() => void detectBrowsers()}
              className="astryx-button inline-flex shrink-0 cursor-pointer items-center justify-center font-medium disabled:opacity-50"
              style={btnStyle}
            >
              {detecting ? '扫描中…' : '重新检测'}
            </button>
          </div>
        </div>

        {detectError ? (
          <p className="text-xs text-destructive">{detectError}</p>
        ) : detected.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--border-subtle,hsl(var(--border)))] px-3 py-2.5 text-xs text-muted-foreground">
            {detecting
              ? '正在扫描本机 Chrome / Edge / Arc / Brave / Firefox 配置…'
              : '未在本机默认路径检测到外部浏览器配置，可通过右侧「导入书签 HTML」导入 Safari 或任意浏览器导出的书签。'}
          </div>
        ) : (
          <div
            role="list"
            aria-label="检测到的本机浏览器配置"
            className="w-full overflow-hidden rounded-lg border"
            style={{
              borderRadius: '8px',
              border: '1px solid var(--border-subtle, hsl(var(--border)))',
              background: 'var(--surface-control, hsl(var(--muted) / 0.25))',
            }}
          >
            {detected.map((item, idx) => {
              const isBusy = busyKey === `browser:${item.id}`;
              const availableParts = [
                item.hasBookmarks ? '书签' : null,
                item.hasHistory ? '历史' : null,
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <div
                  key={item.id}
                  role="listitem"
                  className={`flex items-center justify-between gap-2.5 px-3 py-1.5 ${
                    idx > 0
                      ? 'border-t border-[var(--border-subtle,hsl(var(--border)))]'
                      : ''
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                      <span className="truncate">{item.browserName}</span>
                      <span className="settings-meta-chip px-1.5 py-0.5 text-[11px]">
                        {item.profileName}
                      </span>
                      {availableParts ? (
                        <span className="text-[11px] font-normal text-muted-foreground">
                          {availableParts}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={busyKey !== null}
                    onClick={() => void handleImportProfile(item)}
                    className="astryx-button inline-flex shrink-0 cursor-pointer items-center justify-center font-medium disabled:cursor-not-allowed disabled:opacity-50"
                    style={btnStyle}
                  >
                    {isBusy ? '导入中…' : '一键导入'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Step 2: Encrypted local password CSV import */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground">
            2. 账号密码（CSV 导入 · 本地 AES-256-GCM 加密）
          </span>
          <button
            type="button"
            onClick={() => setShowExportHint((prev) => !prev)}
            className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {showExportHint ? '收起导出指引' : '如何导出密码 CSV？'}
          </button>
        </div>

        {showExportHint ? (
          <div className="rounded-lg border border-[var(--border-subtle,hsl(var(--border)))] bg-[var(--surface-control,hsl(var(--muted)/0.25))] px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            <div>
              • Chrome / Edge / Arc：打开浏览器密码管理页 → 点击右上角 ⋮ →
              「导出密码」保存为 <code>.csv</code> 文件
            </div>
            <div>
              • Safari（macOS）：系统设置 /「密码」App → 文件 →
              「将所有密码导出到文件」
            </div>
          </div>
        ) : null}

        <input
          ref={csvInputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleImportPasswordCsv(file);
          }}
        />
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void handleImportPasswordCsv(file);
          }}
          className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed px-3 py-2.5 text-xs transition-colors ${
            dragActive
              ? 'border-primary bg-primary/5'
              : 'border-[var(--border-subtle,hsl(var(--border)))] bg-[var(--surface-control,hsl(var(--muted)/0.18))]'
          }`}
        >
          <span className="text-muted-foreground">
            将导出的密码 <code>.csv</code> 拖入此处，密钥由本机系统钥匙串 / Windows DPAPI 保护，绝不上传云端。
          </span>
          <button
            type="button"
            disabled={busyKey !== null}
            onClick={() => csvInputRef.current?.click()}
            className="astryx-button inline-flex shrink-0 cursor-pointer items-center justify-center font-medium disabled:opacity-50"
            style={btnStyle}
          >
            {busyKey === 'csv' ? '加密导入中…' : '选择 CSV 文件'}
          </button>
        </div>
      </div>

      {/* Step 3: Collapsible Redacted Credential Drawer */}
      {showCredentials ? (
        <div
          role="list"
          aria-label="已加密保存的本地账号列表"
          className="max-h-56 overflow-y-auto rounded-lg border"
          style={{
            border: '1px solid var(--border-subtle, hsl(var(--border)))',
            background: 'var(--surface-control, hsl(var(--muted) / 0.25))',
          }}
        >
          {loadingCredentials ? (
            <div className="px-3 py-3 text-center text-xs text-muted-foreground">
              加载本地账号列表…
            </div>
          ) : credentials.length === 0 ? (
            <div className="px-3 py-3 text-center text-xs text-muted-foreground">
              当前配置尚未保存本地账号密码
            </div>
          ) : (
            credentials.map((cred, idx) => (
              <div
                key={cred.id}
                role="listitem"
                className={`flex items-center justify-between gap-2 px-3 py-1.5 text-xs ${
                  idx > 0
                    ? 'border-t border-[var(--border-subtle,hsl(var(--border)))]'
                    : ''
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-foreground">
                    {cred.name || cred.origin}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {cred.username || '(无用户名)'} · {cred.origin}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busyKey !== null}
                  onClick={() => void handleRemoveCredential(cred.id)}
                  className="shrink-0 rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                >
                  移除
                </button>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
