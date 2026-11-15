import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@astryxdesign/core/Badge';
import { Button as AstryxButton } from '@astryxdesign/core/Button';
import { Icon } from '@astryxdesign/core/Icon';
import { HStack, VStack } from '@astryxdesign/core/Layout';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import {
  proportional,
  resolveColumnWidths,
  Table,
  TableBody,
  TableCell,
  TableRow,
  type TableColumn,
} from '@astryxdesign/core/Table';
import { Text } from '@astryxdesign/core/Text';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Play,
  Plus,
  Radio,
  Save,
  Trash2,
  XCircle,
} from 'lucide-react';
import type { WorkflowDefinitionSummary } from 'shared/types';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useManagedAgentOptions } from '@/features/agent-management';
import type {
  EventSourceKind,
  PulseSourceTestResult,
  PulseSourceUpsertInput,
  PulseSourceView,
  PulseSubscriberKind,
  PulseSubscriptionView,
} from '@/lib/api/pulse';
import { cn } from '@/lib/utils';
import {
  AutomationSplitFrame,
  groupHeaderCell,
  interactiveRowStyle,
  selectedTableRowStyle,
} from './AutomationSplitFrame';
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

export interface AutomationSourcesTabProps {
  renderHeader?: (
    toolbarRow?: ReactNode,
    contextualAction?: ReactNode
  ) => ReactNode;
  sources: readonly PulseSourceView[];
  subscriptions: readonly PulseSubscriptionView[];
  workflows: readonly WorkflowDefinitionSummary[];
  initialAddingNew?: boolean;
  onUpsertSource: (
    input: PulseSourceUpsertInput
  ) => Promise<PulseSourceView | null>;
  onDeleteSource: (id: string) => Promise<void>;
  onTestSource: (
    id: string,
    ingest: boolean
  ) => Promise<PulseSourceTestResult | null>;
  onSubscribeThread: (
    threadKey: string,
    kind: 'session' | 'bot' | 'group' | 'workflow',
    subscriberId: string
  ) => Promise<void>;
  onUnsubscribeThread: (subscriptionId: string) => Promise<void>;
}

export function AutomationSourcesTab({
  renderHeader,
  sources,
  subscriptions,
  workflows,
  initialAddingNew = false,
  onUpsertSource,
  onDeleteSource,
  onTestSource,
  onSubscribeThread,
  onUnsubscribeThread,
}: AutomationSourcesTabProps) {
  const { t, i18n } = useTranslation('panels');
  const managedAgents = useManagedAgentOptions(undefined, true);

  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(
    () => (initialAddingNew ? null : (sources[0]?.id ?? null))
  );
  const [creatingNew, setCreatingNew] = useState(
    initialAddingNew || sources.length === 0
  );
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(['sources', 'subscriptions'])
  );
  const hydratedSourceIdRef = useRef<string | null>(null);

  // Connector form states
  const [kind, setKind] = useState<EventSourceKind>('github');
  const [title, setTitle] = useState('GitHub CI/CD');
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

  // Thread Subscription states
  const [subThreadKey, setSubThreadKey] = useState('');
  const [subKind, setSubKind] = useState<PulseSubscriberKind>('session');
  const [subTargetId, setSubTargetId] = useState('');

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
      setGithubRepo(readStringConfig(cfg, 'repo'));
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

  useEffect(() => {
    if (initialAddingNew) {
      hydratedSourceIdRef.current = null;
      setCreatingNew(true);
      setSelectedSourceId(null);
      return;
    }
    if (creatingNew) return;
    const match =
      sources.find((item) => item.id === selectedSourceId) ?? sources[0];
    if (match) {
      if (selectedSourceId !== match.id) {
        setSelectedSourceId(match.id);
      }
      if (hydratedSourceIdRef.current !== match.id) {
        hydrateFromSource(match);
      }
    }
  }, [creatingNew, initialAddingNew, selectedSourceId, sources]);

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedSource = creatingNew
    ? null
    : (sources.find((item) => item.id === selectedSourceId) ?? null);

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
            repo: githubRepo.trim(),
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
        id:
          selectedSource && !selectedSource.id.startsWith('placeholder-')
            ? selectedSource.id
            : null,
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

  const subTargetSuggestions = useMemo(() => {
    if (subKind === 'workflow') {
      return workflows.map((wf) => ({
        id: wf.id,
        label: `${wf.name} (${wf.id})`,
      }));
    }
    if (subKind === 'bot') {
      return [
        { id: 'triage-bot', label: 'triage-bot' },
        { id: 'release-bot', label: 'release-bot' },
        { id: 'oncall-bot', label: 'oncall-bot' },
      ];
    }
    if (subKind === 'group') {
      return [{ id: 'eng-council', label: 'eng-council' }];
    }
    return managedAgents.length > 0
      ? managedAgents.map((a) => ({ id: a.value, label: a.label }))
      : [
          { id: 'sess-main', label: 'sess-main' },
          { id: 'claude-code', label: 'Claude Code' },
        ];
  }, [managedAgents, subKind, workflows]);

  const columns = useMemo<TableColumn<Record<string, unknown>>[]>(
    () => [
      {
        key: 'source',
        header: t('pulseDeck.workbench.sources.colSource'),
        width: proportional(1.1),
      },
      {
        key: 'health',
        header: t('pulseDeck.workbench.sources.colHealth'),
        width: proportional(1),
      },
      {
        key: 'volume',
        header: t('pulseDeck.workbench.sources.colVolume'),
        width: proportional(0.8),
      },
    ],
    [t, i18n.language]
  );

  const resolvedWidths = useMemo(
    () => resolveColumnWidths(columns),
    [columns]
  );

  const addSourceAction = (
    <AstryxButton
      label={t('pulseDeck.workbench.sources.addSourceBtn')}
      variant="secondary"
      size="md"
      icon={<Icon icon={Plus} size="sm" />}
      data-testid="sources-add-btn"
      onClick={() => {
        hydratedSourceIdRef.current = null;
        setCreatingNew(true);
        setSelectedSourceId(null);
        setKind('github');
        setTitle('GitHub CI/CD');
        setGithubMode('poll');
        setSigningSecret('');
        setTestResult(null);
      }}
    />
  );

  const masterPane = (
    <div data-testid="pulse-deck-sources-strip" className="min-h-0 flex-1">
      <Table
        columns={columns}
        density="balanced"
        dividers="rows"
        textOverflow="truncate"
        hasHover
      >
        <colgroup>
          {columns.map((col) => (
            <col
              key={col.key}
              style={resolvedWidths.columns.get(col.key)?.style}
            />
          ))}
        </colgroup>
        <TableBody>
          {/* Group 1: Connected Event Sources */}
          <TableRow
            role="button"
            tabIndex={0}
            onClick={() => toggleGroup('sources')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleGroup('sources');
              }
            }}
          >
            <TableCell colSpan={columns.length} style={groupHeaderCell}>
              <HStack gap={2} vAlign="center">
                <Icon
                  icon={
                    expandedGroups.has('sources') ? ChevronDown : ChevronRight
                  }
                  size="sm"
                  color="secondary"
                />
                <Text type="body" weight="bold">
                  {t('pulseDeck.workbench.sources.groupConnected')}
                </Text>
                <Badge
                  variant="neutral"
                  label={String(sources.length)}
                  className="tabular-nums"
                />
              </HStack>
            </TableCell>
          </TableRow>

          {expandedGroups.has('sources') &&
            sources.map((src) => {
              const active = !creatingNew && selectedSourceId === src.id;
              const statusLabel = !src.enabled
                ? t('pulseDeck.sourceDisabled')
                : src.healthy
                  ? t('pulseDeck.sourceHealthy')
                  : t('pulseDeck.sourceUnhealthy');
              const watermarkText = src.cursorWatermark
                ? `${statusLabel} · ${t('pulseDeck.sourceCursor', {
                    cursor: src.cursorWatermark,
                  })}`
                : statusLabel;
              const rowStyle = active
                ? { ...interactiveRowStyle, ...selectedTableRowStyle }
                : interactiveRowStyle;

              return (
                <TableRow
                  key={src.id}
                  data-testid={`source-row-${src.id}`}
                  style={rowStyle}
                  onClick={() => {
                    setCreatingNew(false);
                    setSelectedSourceId(src.id);
                    hydrateFromSource(src);
                  }}
                >
                  <TableCell>
                    <HStack gap={2} vAlign="center">
                      <StatusDot
                        variant={
                          !src.enabled
                            ? 'neutral'
                            : src.healthy
                              ? 'success'
                              : 'error'
                        }
                        label={statusLabel}
                      />
                      <Text type="body" weight="medium" maxLines={1}>
                        {src.title}
                      </Text>
                    </HStack>
                  </TableCell>
                  <TableCell>
                    <span
                      data-testid={`pulse-source-watermark-${src.id}`}
                      className="text-xs tabular-nums text-muted-foreground"
                    >
                      {watermarkText}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span
                      data-testid={`pulse-source-counts-${src.id}`}
                      className="text-xs tabular-nums text-muted-foreground"
                    >
                      {t('pulseDeck.sourceReceived24h', {
                        count: src.receivedCount24h,
                      })}
                      {src.rejectedCount24h > 0
                        ? ` · ${t('pulseDeck.sourceRejected24h', {
                            count: src.rejectedCount24h,
                          })}`
                        : ''}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}

          {/* Group 2: Thread Subscriptions */}
          <TableRow
            role="button"
            tabIndex={0}
            onClick={() => toggleGroup('subscriptions')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleGroup('subscriptions');
              }
            }}
          >
            <TableCell colSpan={columns.length} style={groupHeaderCell}>
              <HStack gap={2} vAlign="center">
                <Icon
                  icon={
                    expandedGroups.has('subscriptions')
                      ? ChevronDown
                      : ChevronRight
                  }
                  size="sm"
                  color="secondary"
                />
                <Icon icon={Radio} size="sm" color="secondary" />
                <Text type="body" weight="bold">
                  {t('pulseDeck.workbench.sources.groupSubscriptions')}
                </Text>
                <Badge
                  variant="neutral"
                  label={String(subscriptions.length)}
                  className="tabular-nums"
                />
              </HStack>
            </TableCell>
          </TableRow>

          {expandedGroups.has('subscriptions') &&
            (subscriptions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length}>
                  <Text type="supporting" color="secondary">
                    {t('pulseDeck.subscriptionsEmpty')}
                  </Text>
                </TableCell>
              </TableRow>
            ) : (
              subscriptions.map((sub) => (
                <TableRow key={sub.id}>
                  <TableCell>
                    <span className="font-mono text-xs text-foreground">
                      {sub.threadKey}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Text type="supporting" color="secondary" maxLines={1}>
                      {sub.subscriberKind} · {sub.subscriberId}
                    </Text>
                  </TableCell>
                  <TableCell>
                    <AstryxButton
                      label={t('pulseDeck.unsubscribeAria', {
                        threadKey: sub.threadKey,
                      })}
                      variant="ghost"
                      size="sm"
                      isIconOnly
                      icon={<Icon icon={Trash2} size="sm" />}
                      data-testid={`pulse-deck-unsubscribe-${sub.id}`}
                      onClick={() => void onUnsubscribeThread(sub.id)}
                    />
                  </TableCell>
                </TableRow>
              ))
            ))}
        </TableBody>
      </Table>
    </div>
  );

  const curlSnippet = buildWebhookCurlSnippet(webhookUrl, signingSecret, kind);

  const detailPane = (
    <div data-testid="automation-source-editor">
      <VStack gap={4}>
        {/* Connector Kind Picker + Title */}
        <VStack gap={3}>
          <div className="flex flex-wrap gap-1.5">
            {SOURCE_KIND_OPTIONS.map((opt) => {
              const active = kind === opt.kind;
              return (
                <button
                  key={opt.kind}
                  type="button"
                  data-testid={`source-kind-${opt.kind}`}
                  aria-pressed={active}
                  onClick={() => {
                    setKind(opt.kind);
                    if (creatingNew) {
                      setTitle(t(opt.labelKey));
                    }
                    setTestResult(null);
                  }}
                  className={cn(
                    'rounded-full px-2.5 py-1 text-2xs font-medium transition-colors',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-[var(--color-background-muted)] text-muted-foreground hover:text-foreground'
                  )}
                >
                  {t(opt.labelKey)}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="min-w-[200px] flex-1 space-y-1">
              <Label htmlFor="source-title-input" className="text-xs">
                {t('pulseDeck.sourceTitleLabel')}
              </Label>
              <Input
                id="source-title-input"
                data-testid="source-title-input"
                placeholder={t('pulseDeck.sourceTitlePlaceholder')}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="h-8 text-xs"
              />
            </div>

            {selectedSource &&
            !selectedSource.id.startsWith('placeholder-') ? (
              <AstryxButton
                label={t('pulseDeck.workbench.sources.deleteSourceBtn')}
                variant="ghost"
                size="sm"
                icon={<Icon icon={Trash2} size="sm" />}
                data-testid="source-delete-btn"
                onClick={() => void onDeleteSource(selectedSource.id)}
              />
            ) : null}
          </div>
        </VStack>

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

        {/* Save & Live Self-Test Bar */}
        <HStack gap={2} vAlign="center" wrap="wrap">
          <AstryxButton
            label={
              savingAndTesting
                ? t('pulseDeck.workbench.sources.testingBtn')
                : t('pulseDeck.workbench.sources.saveAndTestBtn')
            }
            variant="primary"
            size="sm"
            isDisabled={savingAndTesting}
            icon={<Icon icon={Save} size="sm" />}
            data-testid="source-save-and-test-btn"
            onClick={() => void handleSaveAndTest(false)}
          />

          <AstryxButton
            label={
              kind === 'feishu'
                ? t('pulseDeck.workbench.sources.feishuSelfTestBtn')
                : kind === 'webhook_standard' || kind === 'webhook_custom'
                  ? t('pulseDeck.workbench.sources.sendTestRequestBtn')
                  : t('pulseDeck.workbench.sources.emitLiveTestBtn')
            }
            variant="secondary"
            size="sm"
            isDisabled={savingAndTesting}
            icon={<Icon icon={Play} size="sm" />}
            data-testid="source-emit-live-test-btn"
            onClick={() => void handleSaveAndTest(true)}
          />
        </HStack>

        {/* Live Test Result Output */}
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

        {/* Thread Subscriptions Sub-Form */}
        <div className="space-y-2.5 rounded-lg bg-[var(--color-background-muted)] p-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Radio className="h-3.5 w-3.5 text-primary" />
            {t('pulseDeck.subscriptionsTitle')}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              aria-label={t('pulseDeck.subscriptionThreadKeyAria')}
              placeholder="github:org/repo#12"
              value={subThreadKey}
              onChange={(e) => setSubThreadKey(e.target.value)}
              className="h-8 min-w-[160px] flex-1 bg-background font-mono text-xs"
            />

            <div className="inline-flex items-center rounded-md bg-background p-0.5">
              {(['session', 'bot', 'group', 'workflow'] as const).map((k) => {
                const active = subKind === k;
                return (
                  <button
                    key={k}
                    type="button"
                    data-testid={`deck-sub-kind-${k}`}
                    aria-pressed={active}
                    onClick={() => setSubKind(k)}
                    className={cn(
                      'rounded px-2 py-0.5 text-2xs font-medium transition-colors',
                      active
                        ? 'bg-[var(--color-background-muted)] text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {t(`pulseDeck.subscriberKinds.${k}`)}
                  </button>
                );
              })}
            </div>

            <Input
              aria-label={t('pulseDeck.subscriberIdAria')}
              list="pulse-sub-target-suggestions"
              placeholder={t(
                'pulseDeck.workbench.sources.subTargetPlaceholder'
              )}
              value={subTargetId}
              onChange={(e) => setSubTargetId(e.target.value)}
              className="h-8 w-44 bg-background font-mono text-xs"
            />
            <datalist id="pulse-sub-target-suggestions">
              {subTargetSuggestions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </datalist>

            <AstryxButton
              label={t('pulseDeck.bindBtn')}
              variant="secondary"
              size="sm"
              data-testid="pulse-deck-subscribe-btn"
              onClick={() => {
                if (!subThreadKey.trim() || !subTargetId.trim()) return;
                void onSubscribeThread(
                  subThreadKey.trim(),
                  subKind as 'session' | 'bot' | 'group' | 'workflow',
                  subTargetId.trim()
                ).then(() => {
                  setSubThreadKey('');
                  setSubTargetId('');
                });
              }}
            />
          </div>
        </div>
      </VStack>
    </div>
  );

  return (
    <AutomationSplitFrame
      testId="automation-tab-sources-split"
      header={renderHeader?.(undefined, addSourceAction)}
      master={masterPane}
      detail={detailPane}
    />
  );
}
