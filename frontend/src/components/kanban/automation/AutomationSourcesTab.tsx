import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import {
  CheckCircle2,
  Loader2,
  Play,
  Plus,
  Save,
  Trash2,
  XCircle,
} from 'lucide-react';

import {
  AstryxSelect,
  type AstryxSelectOption,
} from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type {
  EventSourceKind,
  PulseSourceTestResult,
  PulseSourceUpsertInput,
  PulseSourceView,
} from '@/lib/api/pulse';
import { cn } from '@/lib/utils';

import { AutomationSplitFrame } from './AutomationSplitFrame';
import {
  FilterStatusPill,
  FilterTable,
  type FilterChipItem,
  type FilterTableRow,
} from './FilterTable';
import { buildWebhookCurlSnippet } from './automationModels';
import { SourceConnectorFields } from './SourceConnectorFields';

const SOURCE_KIND_OPTIONS: ReadonlyArray<{
  kind: EventSourceKind;
  labelKey: string;
}> = [
  { kind: 'github', labelKey: 'pulseDeck.workbench.sources.kindGithub' },
  { kind: 'feishu', labelKey: 'pulseDeck.workbench.sources.kindFeishu' },
  {
    kind: 'webhook_standard',
    labelKey: 'pulseDeck.workbench.sources.kindWebhookStandard',
  },
  {
    kind: 'webhook_custom',
    labelKey: 'pulseDeck.workbench.sources.kindWebhookCustom',
  },
  { kind: 'time_cron', labelKey: 'pulseDeck.workbench.sources.kindTimeCron' },
  {
    kind: 'time_interval',
    labelKey: 'pulseDeck.workbench.sources.kindTimeInterval',
  },
  { kind: 'jira', labelKey: 'pulseDeck.workbench.sources.kindJira' },
];

const SOURCE_TEMPLATE_KINDS: ReadonlyArray<{
  kind: EventSourceKind;
  labelKey: string;
}> = [
  { kind: 'github', labelKey: 'pulseDeck.workbench.sources.kindGithub' },
  { kind: 'feishu', labelKey: 'pulseDeck.workbench.sources.kindFeishu' },
  {
    kind: 'webhook_standard',
    labelKey: 'pulseDeck.workbench.sources.kindWebhookStandard',
  },
  { kind: 'time_cron', labelKey: 'pulseDeck.workbench.sources.kindTimeCron' },
  { kind: 'jira', labelKey: 'pulseDeck.workbench.sources.kindJira' },
];

function readStringConfig(
  cfg: Record<string, unknown> | undefined,
  key: string,
  fallback = ''
): string {
  const val = cfg?.[key];
  return typeof val === 'string' ? val : fallback;
}

function readNumberConfig(
  cfg: Record<string, unknown> | undefined,
  key: string,
  fallback: number
): number {
  const val = cfg?.[key];
  return typeof val === 'number' && Number.isFinite(val) ? val : fallback;
}

export function toFullGithubRepoUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('git@') ||
    trimmed.startsWith('ssh://')
  ) {
    return trimmed;
  }
  const clean = trimmed.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (/^[^/\s]+\/[^/\s]+$/.test(clean)) {
    return `https://github.com/${clean}`;
  }
  return trimmed;
}

export type SourceFilterKey = 'connected' | 'template';

export interface AutomationSourcesTabProps {
  renderShell: (options: {
    headerSearch?: ReactNode;
    contextualAction?: ReactNode;
    children: ReactNode;
  }) => ReactNode;
  sources: readonly PulseSourceView[];
  initialAddingNew?: boolean;
  onUpsertSource: (
    input: PulseSourceUpsertInput
  ) => Promise<PulseSourceView | null>;
  onDeleteSource: (id: string) => Promise<void>;
  onTestSource: (
    id: string,
    ingest: boolean
  ) => Promise<PulseSourceTestResult | null>;
}

export function AutomationSourcesTab({
  renderShell,
  sources,
  initialAddingNew = false,
  onUpsertSource,
  onDeleteSource,
  onTestSource,
}: AutomationSourcesTabProps) {
  const { t } = useTranslation('panels');

  const connectedSources = useMemo(
    () => sources.filter((src) => !src.id.startsWith('placeholder-')),
    [sources]
  );

  const templateItems = useMemo(() => {
    const connectedKinds = new Set(connectedSources.map((src) => src.kind));
    return SOURCE_TEMPLATE_KINDS.filter((tpl) => !connectedKinds.has(tpl.kind));
  }, [connectedSources]);

  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(() =>
    initialAddingNew ? null : (connectedSources[0]?.id ?? null)
  );
  const [selectedTemplateKind, setSelectedTemplateKind] =
    useState<EventSourceKind | null>(() =>
      !initialAddingNew && connectedSources.length === 0 ? 'github' : null
    );
  const [creatingNew, setCreatingNew] = useState(
    initialAddingNew || connectedSources.length === 0
  );
  const [sourceFilter, setSourceFilter] = useState<SourceFilterKey | 'all'>(
    'all'
  );
  const hydratedSourceIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (connectedSources.length === 0 && sourceFilter === 'connected') {
      setSourceFilter('all');
    }
  }, [connectedSources.length, sourceFilter]);

  // Connector form states
  const [kind, setKind] = useState<EventSourceKind>('github');
  const [title, setTitle] = useState(() =>
    t('pulseDeck.workbench.sources.kindGithub')
  );
  const [enabled, setEnabled] = useState(true);
  const [signingSecret, setSigningSecret] = useState('');
  const [allowUnsigned, setAllowUnsigned] = useState(false);

  // GitHub mode & fields
  const [githubMode, setGithubMode] = useState<'poll' | 'webhook'>('poll');
  const [githubRepo, setGithubRepo] = useState('');
  const [githubPollSeconds, setGithubPollSeconds] = useState<number>(60);
  const [githubToken, setGithubToken] = useState('');
  const [githubBranch, setGithubBranch] = useState('');

  // Feishu mode & fields
  const [feishuMode, setFeishuMode] = useState<'long_connection' | 'webhook'>(
    'long_connection'
  );
  const [feishuBotOpenId, setFeishuBotOpenId] = useState('');

  // Schedule fields for time_cron / time_interval
  const [cronExpression, setCronExpression] = useState('0 9 * * *');
  const [intervalSeconds, setIntervalSeconds] = useState(300);

  // Copy & self-test UI states
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [savingAndTesting, setSavingAndTesting] = useState(false);
  const [testResult, setTestResult] = useState<PulseSourceTestResult | null>(
    null
  );

  const sourceKindSelectOptions = useMemo<AstryxSelectOption[]>(
    () =>
      SOURCE_KIND_OPTIONS.map((opt) => ({
        value: opt.kind,
        label: t(opt.labelKey),
      })),
    [t]
  );

  const hydrateFromSource = (src: PulseSourceView) => {
    const cfg = src.configJson;
    hydratedSourceIdRef.current = src.id;
    setKind(src.kind);
    setTitle(src.title);
    setEnabled(src.enabled);
    setSigningSecret('');
    setAllowUnsigned(Boolean(cfg?.allowUnsigned));
    if (src.kind === 'github') {
      setGithubMode(cfg?.mode === 'webhook' ? 'webhook' : 'poll');
      setGithubRepo(toFullGithubRepoUrl(readStringConfig(cfg, 'repo')));
      setGithubPollSeconds(readNumberConfig(cfg, 'pollIntervalSeconds', 60));
      setGithubToken(readStringConfig(cfg, 'githubToken'));
      setGithubBranch(readStringConfig(cfg, 'branch'));
    } else if (src.kind === 'feishu') {
      setFeishuMode(cfg?.mode === 'webhook' ? 'webhook' : 'long_connection');
      setFeishuBotOpenId(readStringConfig(cfg, 'botOpenId'));
    } else if (src.kind === 'time_cron') {
      setCronExpression(readStringConfig(cfg, 'expression', '0 9 * * *'));
    } else if (src.kind === 'time_interval') {
      setIntervalSeconds(readNumberConfig(cfg, 'everySeconds', 300));
    }
    setTestResult(null);
  };

  const applyTemplateDefaults = useCallback(
    (tplKind: EventSourceKind) => {
      hydratedSourceIdRef.current = null;
      setCreatingNew(true);
      setSelectedSourceId(null);
      setSelectedTemplateKind(tplKind);
      setKind(tplKind);
      const matched = SOURCE_KIND_OPTIONS.find((opt) => opt.kind === tplKind);
      setTitle(matched ? t(matched.labelKey) : tplKind);
      setEnabled(true);
      setSigningSecret('');
      setAllowUnsigned(false);
      if (tplKind === 'github') {
        setGithubMode('poll');
        setGithubRepo('');
        setGithubPollSeconds(60);
        setGithubToken('');
        setGithubBranch('');
      } else if (tplKind === 'feishu') {
        setFeishuMode('long_connection');
        setFeishuBotOpenId('');
      } else if (tplKind === 'time_cron') {
        setCronExpression('0 9 * * *');
      } else if (tplKind === 'time_interval') {
        setIntervalSeconds(300);
      }
      setTestResult(null);
    },
    [t]
  );

  useEffect(() => {
    if (initialAddingNew) {
      hydratedSourceIdRef.current = null;
      setCreatingNew(true);
      setSelectedSourceId(null);
      setSelectedTemplateKind(null);
      return;
    }
    if (creatingNew && connectedSources.length === 0) {
      return;
    }
    if (creatingNew && selectedTemplateKind !== null) {
      return;
    }
    if (creatingNew && selectedSourceId === null) {
      return;
    }
    const match =
      connectedSources.find((item) => item.id === selectedSourceId) ??
      connectedSources[0];
    if (match) {
      if (selectedSourceId !== match.id) {
        setSelectedSourceId(match.id);
      }
      if (hydratedSourceIdRef.current !== match.id) {
        hydrateFromSource(match);
      }
    } else if (connectedSources.length === 0) {
      setCreatingNew(true);
      setSelectedSourceId(null);
      setSelectedTemplateKind((prev) => prev ?? 'github');
    }
  }, [
    connectedSources,
    creatingNew,
    initialAddingNew,
    selectedSourceId,
    selectedTemplateKind,
  ]);

  const selectedSource = creatingNew
    ? null
    : (connectedSources.find((item) => item.id === selectedSourceId) ?? null);

  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://127.0.0.1:3000';
  const resolvedSourceSlug = selectedSource?.id ?? `src-${kind}`;
  const webhookUrl = `${origin}${
    selectedSource?.publicWebhookPath ??
    `/api/pulse/webhooks/${resolvedSourceSlug}`
  }`;

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      // Clipboard API may be restricted in headless test environments
    }
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1500);
  };

  const buildConfigJson = (): Record<string, unknown> => {
    if (kind === 'github') {
      return githubMode === 'poll'
        ? {
            mode: 'poll',
            repo: toFullGithubRepoUrl(githubRepo),
            pollIntervalSeconds: githubPollSeconds,
            githubToken: githubToken.trim() || null,
            branch: githubBranch.trim() || null,
          }
        : {
            mode: 'webhook',
            allowUnsigned,
          };
    }
    if (kind === 'feishu') {
      return feishuMode === 'long_connection'
        ? {
            mode: 'long_connection',
            bridgeChatChannel: true,
            botOpenId: feishuBotOpenId.trim() || null,
          }
        : {
            mode: 'webhook',
            autoChallengeHandshake: true,
            allowUnsigned,
          };
    }
    if (kind === 'time_cron') {
      return { expression: cronExpression.trim() || '0 9 * * *' };
    }
    if (kind === 'time_interval') {
      return { everySeconds: intervalSeconds };
    }
    return { allowUnsigned };
  };

  const handleSaveAndTest = async (ingest: boolean) => {
    const trimmedTitle = title.trim() || kind;
    setSavingAndTesting(true);
    try {
      const saved = await onUpsertSource({
        id: selectedSource ? selectedSource.id : null,
        kind,
        title: trimmedTitle,
        enabled,
        configJson: buildConfigJson(),
        signingSecret: signingSecret.trim() || null,
      });
      const targetId = saved?.id ?? selectedSource?.id;
      if (saved) {
        hydratedSourceIdRef.current = saved.id;
        setCreatingNew(false);
        setSelectedTemplateKind(null);
        setSelectedSourceId(saved.id);
      }
      if (targetId) {
        const probe = await onTestSource(targetId, ingest);
        if (probe) {
          setTestResult(probe);
        }
      }
    } finally {
      setSavingAndTesting(false);
    }
  };

  const filterChips = useMemo<FilterChipItem<SourceFilterKey | 'all'>[]>(() => {
    const chips: FilterChipItem<SourceFilterKey | 'all'>[] = [
      {
        key: 'all',
        label: t('pulseDeck.workbench.sources.filterAll'),
        count: connectedSources.length + templateItems.length,
        testId: 'sources-filter-chip-all',
      },
    ];
    if (connectedSources.length > 0) {
      chips.push({
        key: 'connected',
        label: t('pulseDeck.workbench.sources.sourcesHeader'),
        dot: 'hsl(var(--success))',
        count: connectedSources.length,
        testId: 'sources-connected-group-header',
      });
    }
    if (templateItems.length > 0) {
      chips.push({
        key: 'template',
        label: t('pulseDeck.workbench.sources.templatesHeader'),
        dot: 'hsl(var(--info))',
        count: templateItems.length,
        testId: 'sources-templates-group-header',
      });
    }
    return chips;
  }, [connectedSources.length, templateItems.length, t]);

  const columns = useMemo(
    () => [
      { key: 'source', label: t('pulseDeck.workbench.sources.colSource') },
      { key: 'health', label: t('pulseDeck.workbench.sources.colHealth') },
      { key: 'volume', label: t('pulseDeck.workbench.sources.colVolume') },
    ],
    [t]
  );

  const tableRows = useMemo<FilterTableRow<SourceFilterKey>[]>(() => {
    const rows: FilterTableRow<SourceFilterKey>[] = [];

    for (const src of connectedSources) {
      const active = !creatingNew && selectedSourceId === src.id;
      const statusLabel = !src.enabled
        ? t('pulseDeck.sourceDisabled')
        : src.healthy
          ? t('pulseDeck.sourceHealthy')
          : t('pulseDeck.sourceUnhealthy');
      const tone = !src.enabled ? 'paused' : src.healthy ? 'done' : 'error';
      const cursorText =
        src.enabled && src.cursorWatermark && src.cursorWatermark !== '0'
          ? t('pulseDeck.sourceCursor', { cursor: src.cursorWatermark })
          : null;

      rows.push({
        key: src.id,
        statusKey: 'connected',
        selected: active,
        testId: `source-row-${src.id}`,
        onClick: () => {
          setCreatingNew(false);
          setSelectedTemplateKind(null);
          setSelectedSourceId(src.id);
          hydrateFromSource(src);
        },
        cells: [
          <span key="source" className="truncate font-medium text-foreground">
            {src.title}
          </span>,
          <div
            key="health"
            data-testid={`pulse-source-watermark-${src.id}`}
            className="flex min-w-0 items-center gap-1.5"
          >
            <FilterStatusPill tone={tone} label={statusLabel} />
            {cursorText ? (
              <span className="truncate text-[11.5px] tabular-nums text-muted-foreground">
                {` · ${cursorText}`}
              </span>
            ) : null}
          </div>,
          <span
            key="volume"
            data-testid={`pulse-source-counts-${src.id}`}
            className="truncate text-xs tabular-nums text-muted-foreground"
          >
            {t('pulseDeck.sourceReceived24h', {
              count: src.receivedCount24h,
            })}
            {src.rejectedCount24h > 0
              ? ` · ${t('pulseDeck.sourceRejected24h', {
                  count: src.rejectedCount24h,
                })}`
              : ''}
          </span>,
        ],
      });
    }

    for (const tpl of templateItems) {
      const active = creatingNew && selectedTemplateKind === tpl.kind;
      const tplTitle = t(tpl.labelKey);
      const hintLabel = t('pulseDeck.workbench.sources.templateStatusHint');

      rows.push({
        key: `tpl-${tpl.kind}`,
        statusKey: 'template',
        selected: active,
        testId: `source-template-row-${tpl.kind}`,
        onClick: () => applyTemplateDefaults(tpl.kind),
        cells: [
          <span
            key="source"
            className="truncate font-medium text-muted-foreground"
          >
            {tplTitle}
          </span>,
          <FilterStatusPill key="health" tone="progress" label={hintLabel} />,
          <span
            key="volume"
            className="text-xs tabular-nums text-muted-foreground/60"
          >
            —
          </span>,
        ],
      });
    }

    return rows;
  }, [
    applyTemplateDefaults,
    connectedSources,
    creatingNew,
    selectedSourceId,
    selectedTemplateKind,
    templateItems,
    t,
  ]);

  const addSourceAction = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid="sources-add-btn"
      onClick={() => {
        applyTemplateDefaults('github');
        setSelectedTemplateKind(null);
      }}
      className="h-7 shrink-0 gap-1 px-2.5 text-xs"
    >
      <Plus className="h-3.5 w-3.5" />
      {t('pulseDeck.workbench.sources.addSourceBtn')}
    </Button>
  );

  const masterPane = (
    <div
      data-testid="pulse-deck-sources-strip"
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
    >
      <FilterTable
        filters={filterChips}
        columns={columns}
        rows={tableRows}
        activeFilter={sourceFilter}
        onFilterChange={setSourceFilter}
        gridTemplateColumns="minmax(120px,1.15fr) minmax(150px,1.35fr) minmax(90px,0.8fr)"
        minTableWidthClass="min-w-[380px]"
        ariaLabel={t('pulseDeck.workbench.sources.panelAria')}
      />
    </div>
  );

  const curlSnippet = buildWebhookCurlSnippet(webhookUrl, signingSecret, kind);

  const detailPane = (
    <div data-testid="automation-source-editor">
      <VStack gap={4}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="source-kind-select" className="text-xs">
              {t('pulseDeck.workbench.sources.kindSelectLabel')}
            </Label>
            <AstryxSelect
              id="source-kind-select"
              value={kind}
              options={sourceKindSelectOptions}
              ariaLabel={t('pulseDeck.workbench.sources.kindSelectLabel')}
              onChange={(nextValue) => {
                const nextKind = nextValue as EventSourceKind;
                setKind(nextKind);
                if (creatingNew) {
                  setSelectedTemplateKind(nextKind);
                  const matched = SOURCE_KIND_OPTIONS.find(
                    (opt) => opt.kind === nextKind
                  );
                  if (matched) {
                    setTitle(t(matched.labelKey));
                  }
                }
                setTestResult(null);
              }}
              size="compact"
              className="w-full"
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="source-title-input" className="text-xs">
                {t('pulseDeck.sourceTitleLabel')}
              </Label>
              {selectedSource ? (
                <button
                  type="button"
                  data-testid="source-delete-btn"
                  onClick={() => void onDeleteSource(selectedSource.id)}
                  className="inline-flex items-center gap-1 text-2xs text-muted-foreground transition-colors hover:text-destructive"
                >
                  <Trash2 className="h-3 w-3" />
                  {t('pulseDeck.workbench.sources.deleteSourceBtn')}
                </button>
              ) : null}
            </div>
            <Input
              id="source-title-input"
              data-testid="source-title-input"
              placeholder={t('pulseDeck.sourceTitlePlaceholder')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
        </div>

        <SourceConnectorFields
          kind={kind}
          webhookUrl={webhookUrl}
          curlSnippet={curlSnippet}
          signingSecret={signingSecret}
          onSigningSecretChange={setSigningSecret}
          allowUnsigned={allowUnsigned}
          onAllowUnsignedChange={setAllowUnsigned}
          copiedKey={copiedKey}
          onCopy={copyText}
          githubMode={githubMode}
          onGithubModeChange={setGithubMode}
          githubRepo={githubRepo}
          onGithubRepoChange={setGithubRepo}
          githubPollSeconds={githubPollSeconds}
          onGithubPollSecondsChange={setGithubPollSeconds}
          githubToken={githubToken}
          onGithubTokenChange={setGithubToken}
          githubBranch={githubBranch}
          onGithubBranchChange={setGithubBranch}
          feishuMode={feishuMode}
          onFeishuModeChange={setFeishuMode}
          feishuBotOpenId={feishuBotOpenId}
          onFeishuBotOpenIdChange={setFeishuBotOpenId}
          cronExpression={cronExpression}
          onCronExpressionChange={setCronExpression}
          intervalSeconds={intervalSeconds}
          onIntervalSecondsChange={setIntervalSeconds}
        />

        <HStack gap={2} vAlign="center" wrap="wrap">
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={savingAndTesting}
            data-testid="source-save-and-test-btn"
            onClick={() => void handleSaveAndTest(false)}
            className="h-7 gap-1.5 px-2.5 text-xs"
          >
            {savingAndTesting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            <span>
              {savingAndTesting
                ? t('pulseDeck.workbench.sources.testingBtn')
                : t('pulseDeck.workbench.sources.saveAndTestBtn')}
            </span>
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={savingAndTesting}
            data-testid="source-emit-live-test-btn"
            onClick={() => void handleSaveAndTest(true)}
            className="h-7 gap-1.5 px-2.5 text-xs"
          >
            <Play className="h-3.5 w-3.5" />
            <span>
              {kind === 'feishu'
                ? t('pulseDeck.workbench.sources.feishuSelfTestBtn')
                : kind === 'webhook_standard' || kind === 'webhook_custom'
                  ? t('pulseDeck.workbench.sources.sendTestRequestBtn')
                  : t('pulseDeck.workbench.sources.emitLiveTestBtn')}
            </span>
          </Button>
        </HStack>

        {testResult ? (
          <div
            data-testid="source-test-result"
            className={cn(
              'rounded-md p-3 text-xs',
              testResult.ok
                ? 'bg-success/10 text-foreground'
                : 'bg-destructive/10 text-destructive'
            )}
          >
            <div className="flex items-center gap-1.5 font-medium">
              {testResult.ok ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-destructive" />
              )}
              <span>
                {testResult.ok
                  ? t('pulseDeck.workbench.sources.testResultOk')
                  : t('pulseDeck.workbench.sources.testResultFail')}
                {' · '}
                {testResult.message}
              </span>
            </div>
            {testResult.sampleEnvelope ? (
              <pre className="mt-2 max-h-48 overflow-auto rounded bg-background p-2 font-mono text-2xs text-muted-foreground">
                {JSON.stringify(testResult.sampleEnvelope, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : null}
      </VStack>
    </div>
  );

  return (
    <>
      {renderShell({
        contextualAction: addSourceAction,
        children: (
          <AutomationSplitFrame
            testId="automation-tab-sources-split"
            panelLabel={t('pulseDeck.workbench.sources.panelAria')}
            master={masterPane}
            detail={detailPane}
          />
        ),
      })}
    </>
  );
}
