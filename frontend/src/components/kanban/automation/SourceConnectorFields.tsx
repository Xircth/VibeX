import { forwardRef, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import { Check, Copy, ExternalLink, KeyRound } from 'lucide-react';

import {
  AstryxSelect,
  type AstryxSelectOption,
} from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { openExternal } from '@/features/model-router/openExternal';
import type { EventSourceKind } from '@/lib/api/pulse';

import { generateWebhookSecret } from './automationModels';

type SegmentedControlItemProps = ComponentProps<typeof SegmentedControlItem>;

const ForwardedSegmentedControlItem = forwardRef<
  HTMLButtonElement,
  SegmentedControlItemProps
>((props, ref) => <SegmentedControlItem {...props} ref={ref} />);
ForwardedSegmentedControlItem.displayName = 'ForwardedSegmentedControlItem';

const GITHUB_POLL_INTERVAL_OPTIONS: AstryxSelectOption[] = [
  { value: '30', label: '30s' },
  { value: '60', label: '60s' },
  { value: '120', label: '120s' },
  { value: '300', label: '300s' },
];

const GITHUB_TOKEN_CREATE_URL =
  'https://github.com/settings/tokens/new?scopes=repo,workflow&description=VibeX';
const FEISHU_OPEN_CONSOLE_URL = 'https://open.feishu.cn/app';
const JIRA_API_TOKENS_URL =
  'https://id.atlassian.com/manage-profile/security/api-tokens';

function CredentialExternalLinkButton({
  url,
  tooltip,
  testId,
}: {
  url: string;
  tooltip: string;
  testId: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={tooltip}
          data-testid={testId}
          onClick={() => void openExternal(url)}
          className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export interface SourceConnectorFieldsProps {
  kind: EventSourceKind;
  webhookUrl: string;
  curlSnippet: string;
  signingSecret: string;
  onSigningSecretChange: (val: string) => void;
  allowUnsigned: boolean;
  onAllowUnsignedChange: (val: boolean) => void;
  copiedKey: string | null;
  onCopy: (key: string, text: string) => Promise<void>;
  githubMode: 'poll' | 'webhook';
  onGithubModeChange: (mode: 'poll' | 'webhook') => void;
  githubRepo: string;
  onGithubRepoChange: (val: string) => void;
  githubPollSeconds: number;
  onGithubPollSecondsChange: (val: number) => void;
  githubToken: string;
  onGithubTokenChange: (val: string) => void;
  githubBranch: string;
  onGithubBranchChange: (val: string) => void;
  feishuMode: 'long_connection' | 'webhook';
  onFeishuModeChange: (mode: 'long_connection' | 'webhook') => void;
  feishuBotOpenId: string;
  onFeishuBotOpenIdChange: (val: string) => void;
  cronExpression: string;
  onCronExpressionChange: (val: string) => void;
  intervalSeconds: number;
  onIntervalSecondsChange: (val: number) => void;
}

export function SourceConnectorFields({
  kind,
  webhookUrl,
  curlSnippet,
  signingSecret,
  onSigningSecretChange,
  allowUnsigned,
  onAllowUnsignedChange,
  copiedKey,
  onCopy,
  githubMode,
  onGithubModeChange,
  githubRepo,
  onGithubRepoChange,
  githubPollSeconds,
  onGithubPollSecondsChange,
  githubToken,
  onGithubTokenChange,
  githubBranch,
  onGithubBranchChange,
  feishuMode,
  onFeishuModeChange,
  feishuBotOpenId,
  onFeishuBotOpenIdChange,
  cronExpression,
  onCronExpressionChange,
  intervalSeconds,
  onIntervalSecondsChange,
}: SourceConnectorFieldsProps) {
  const { t } = useTranslation('panels');

  if (kind === 'github') {
    return (
      <TooltipProvider delayDuration={200}>
        <div className="space-y-3" data-testid="connector-github">
          <div className="space-y-1">
            <Label className="text-xs">
              {t('pulseDeck.workbench.sources.connectionModeLabel')}
            </Label>
            <SegmentedControl
              value={githubMode}
              onChange={(val) => onGithubModeChange(val as 'poll' | 'webhook')}
              label={t('pulseDeck.workbench.sources.connectionModeLabel')}
              size="sm"
              layout="fill"
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <ForwardedSegmentedControlItem
                    value="poll"
                    label={t('pulseDeck.workbench.sources.githubModePoll')}
                    data-testid="github-mode-poll"
                  />
                </TooltipTrigger>
                <TooltipContent side="top">
                  {t('pulseDeck.workbench.sources.githubModePollTooltip')}
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <ForwardedSegmentedControlItem
                    value="webhook"
                    label={t('pulseDeck.workbench.sources.githubModeWebhook')}
                    data-testid="github-mode-webhook"
                  />
                </TooltipTrigger>
                <TooltipContent side="top">
                  {t('pulseDeck.workbench.sources.githubModeWebhookTooltip')}
                </TooltipContent>
              </Tooltip>
            </SegmentedControl>
          </div>

          {githubMode === 'poll' ? (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="github-repo-input" className="text-xs">
                  {t('pulseDeck.workbench.sources.githubRepoLabel')}
                </Label>
                <Input
                  id="github-repo-input"
                  data-testid="github-repo-input"
                  type="url"
                  placeholder={t(
                    'pulseDeck.workbench.sources.githubRepoPlaceholder'
                  )}
                  value={githubRepo}
                  onChange={(e) => onGithubRepoChange(e.target.value)}
                  className="h-8 font-mono text-xs"
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="github-poll-interval" className="text-xs">
                    {t('pulseDeck.workbench.sources.githubPollIntervalLabel')}
                  </Label>
                  <AstryxSelect
                    id="github-poll-interval"
                    value={String(githubPollSeconds)}
                    options={GITHUB_POLL_INTERVAL_OPTIONS}
                    ariaLabel={t(
                      'pulseDeck.workbench.sources.githubPollIntervalLabel'
                    )}
                    onChange={(val) =>
                      onGithubPollSecondsChange(Number(val) || 60)
                    }
                    size="compact"
                    className="w-full tabular-nums"
                  />
                </div>

                <div className="space-y-1">
                  <Label htmlFor="github-branch-input" className="text-xs">
                    {t('pulseDeck.workbench.sources.githubBranchLabel')}
                  </Label>
                  <Input
                    id="github-branch-input"
                    placeholder={t(
                      'pulseDeck.workbench.sources.githubBranchPlaceholder'
                    )}
                    value={githubBranch}
                    onChange={(e) => onGithubBranchChange(e.target.value)}
                    className="h-8 font-mono text-xs"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="github-token-input" className="text-xs">
                    {t('pulseDeck.workbench.sources.githubTokenLabel')}
                  </Label>
                  <CredentialExternalLinkButton
                    url={GITHUB_TOKEN_CREATE_URL}
                    tooltip={t(
                      'pulseDeck.workbench.sources.githubTokenLinkTooltip'
                    )}
                    testId="github-token-link-btn"
                  />
                </div>
                <Input
                  id="github-token-input"
                  data-testid="github-token-input"
                  type="password"
                  placeholder="ghp_..."
                  value={githubToken}
                  onChange={(e) => onGithubTokenChange(e.target.value)}
                  className="h-8 font-mono text-xs"
                />
                <p className="text-2xs text-muted-foreground">
                  {t('pulseDeck.workbench.sources.githubTokenHelper')}
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <WebhookEndpointControls
                webhookUrl={webhookUrl}
                signingSecret={signingSecret}
                onSigningSecretChange={onSigningSecretChange}
                allowUnsigned={allowUnsigned}
                onAllowUnsignedChange={onAllowUnsignedChange}
                copiedKey={copiedKey}
                onCopy={onCopy}
              />
              <ol className="space-y-0.5 rounded-md border border-border bg-[var(--surface-panel)] p-2.5 text-2xs text-muted-foreground">
                <li>{t('pulseDeck.workbench.sources.githubWebhookGuide1')}</li>
                <li>{t('pulseDeck.workbench.sources.githubWebhookGuide2')}</li>
                <li>{t('pulseDeck.workbench.sources.githubWebhookGuide3')}</li>
              </ol>
            </div>
          )}
        </div>
      </TooltipProvider>
    );
  }

  if (kind === 'feishu') {
    return (
      <TooltipProvider delayDuration={200}>
        <div className="space-y-3" data-testid="connector-feishu">
          <div className="space-y-1">
            <Label className="text-xs">
              {t('pulseDeck.workbench.sources.connectionModeLabel')}
            </Label>
            <SegmentedControl
              value={feishuMode}
              onChange={(val) =>
                onFeishuModeChange(val as 'long_connection' | 'webhook')
              }
              label={t('pulseDeck.workbench.sources.connectionModeLabel')}
              size="sm"
              layout="fill"
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <ForwardedSegmentedControlItem
                    value="long_connection"
                    label={t('pulseDeck.workbench.sources.feishuModeLongConn')}
                    data-testid="feishu-mode-long-connection"
                  />
                </TooltipTrigger>
                <TooltipContent side="top">
                  {t('pulseDeck.workbench.sources.feishuModeLongConnTooltip')}
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <ForwardedSegmentedControlItem
                    value="webhook"
                    label={t('pulseDeck.workbench.sources.feishuModeWebhook')}
                    data-testid="feishu-mode-webhook"
                  />
                </TooltipTrigger>
                <TooltipContent side="top">
                  {t('pulseDeck.workbench.sources.feishuModeWebhookTooltip')}
                </TooltipContent>
              </Tooltip>
            </SegmentedControl>
          </div>

          {feishuMode === 'long_connection' ? (
            <div className="space-y-2.5">
              <p className="rounded-md border border-border bg-[var(--surface-panel)] p-2.5 text-xs text-muted-foreground">
                {t('pulseDeck.workbench.sources.feishuBridgeHint')}
              </p>
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="feishu-bot-openid" className="text-xs">
                    {t('pulseDeck.workbench.sources.feishuBotOpenIdLabel')}
                  </Label>
                  <CredentialExternalLinkButton
                    url={FEISHU_OPEN_CONSOLE_URL}
                    tooltip={t(
                      'pulseDeck.workbench.sources.feishuConsoleLinkTooltip'
                    )}
                    testId="feishu-console-link-btn"
                  />
                </div>
                <Input
                  id="feishu-bot-openid"
                  data-testid="feishu-bot-openid"
                  placeholder="ou_..."
                  value={feishuBotOpenId}
                  onChange={(e) => onFeishuBotOpenIdChange(e.target.value)}
                  className="h-8 font-mono text-xs"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-2xs text-muted-foreground">
                {t('pulseDeck.workbench.sources.feishuWebhookHint')}
              </p>
              <WebhookEndpointControls
                webhookUrl={webhookUrl}
                signingSecret={signingSecret}
                onSigningSecretChange={onSigningSecretChange}
                allowUnsigned={allowUnsigned}
                onAllowUnsignedChange={onAllowUnsignedChange}
                copiedKey={copiedKey}
                onCopy={onCopy}
                credentialLinkUrl={FEISHU_OPEN_CONSOLE_URL}
                credentialLinkTooltip={t(
                  'pulseDeck.workbench.sources.feishuConsoleLinkTooltip'
                )}
                credentialLinkTestId="feishu-console-link-btn"
              />
            </div>
          )}
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-3" data-testid={`connector-${kind}`}>
        {kind === 'time_cron' ? (
          <div className="space-y-1">
            <Label htmlFor="source-cron-expr" className="text-xs">
              {t('pulseDeck.composerCronExpr')}
            </Label>
            <Input
              id="source-cron-expr"
              value={cronExpression}
              onChange={(e) => onCronExpressionChange(e.target.value)}
              className="h-8 font-mono text-xs"
            />
          </div>
        ) : kind === 'time_interval' ? (
          <div className="space-y-1">
            <Label htmlFor="source-interval-sec" className="text-xs">
              {t('pulseDeck.workbench.sources.intervalSecondsLabel')}
            </Label>
            <Input
              id="source-interval-sec"
              data-testid="source-interval-sec"
              type="number"
              min={10}
              value={intervalSeconds}
              onChange={(e) =>
                onIntervalSecondsChange(
                  Math.max(10, Number(e.target.value) || 60)
                )
              }
              className="h-8 w-40 tabular-nums text-xs"
            />
          </div>
        ) : (
          <>
            <WebhookEndpointControls
              webhookUrl={webhookUrl}
              signingSecret={signingSecret}
              onSigningSecretChange={onSigningSecretChange}
              allowUnsigned={allowUnsigned}
              onAllowUnsignedChange={onAllowUnsignedChange}
              copiedKey={copiedKey}
              onCopy={onCopy}
              credentialLinkUrl={
                kind === 'jira' ? JIRA_API_TOKENS_URL : undefined
              }
              credentialLinkTooltip={
                kind === 'jira'
                  ? t('pulseDeck.workbench.sources.jiraConsoleLinkTooltip')
                  : undefined
              }
              credentialLinkTestId={
                kind === 'jira' ? 'jira-console-link-btn' : undefined
              }
            />
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs">
                  {t('pulseDeck.workbench.sources.webhookCurlLabel')}
                </Label>
                <button
                  type="button"
                  data-testid="source-copy-curl-btn"
                  onClick={() => void onCopy('curl', curlSnippet)}
                  className="inline-flex items-center gap-1 text-2xs text-primary hover:underline"
                >
                  {copiedKey === 'curl' ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  {copiedKey === 'curl'
                    ? t('pulseDeck.workbench.sources.copiedBtn')
                    : t('pulseDeck.workbench.sources.copyCurlBtn')}
                </button>
              </div>
              <pre
                data-testid="source-curl-snippet"
                className="overflow-x-auto rounded-md border border-border bg-[var(--surface-panel)] p-2.5 font-mono text-2xs text-muted-foreground"
              >
                {curlSnippet}
              </pre>
            </div>
          </>
        )}
      </div>
    </TooltipProvider>
  );
}

function WebhookEndpointControls({
  webhookUrl,
  signingSecret,
  onSigningSecretChange,
  allowUnsigned,
  onAllowUnsignedChange,
  copiedKey,
  onCopy,
  credentialLinkUrl,
  credentialLinkTooltip,
  credentialLinkTestId,
}: {
  webhookUrl: string;
  signingSecret: string;
  onSigningSecretChange: (val: string) => void;
  allowUnsigned: boolean;
  onAllowUnsignedChange: (val: boolean) => void;
  copiedKey: string | null;
  onCopy: (key: string, text: string) => Promise<void>;
  credentialLinkUrl?: string;
  credentialLinkTooltip?: string;
  credentialLinkTestId?: string;
}) {
  const { t } = useTranslation('panels');
  return (
    <div className="space-y-2.5">
      <div className="space-y-1">
        <Label htmlFor="source-webhook-url" className="text-xs">
          {t('pulseDeck.workbench.sources.webhookUrlLabel')}
        </Label>
        <div className="flex items-center gap-1.5">
          <Input
            id="source-webhook-url"
            data-testid="source-webhook-url"
            readOnly
            value={webhookUrl}
            className="h-8 flex-1 font-mono text-xs"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="source-copy-url-btn"
            onClick={() => void onCopy('url', webhookUrl)}
            className="h-7 gap-1 px-2 text-xs"
          >
            {copiedKey === 'url' ? (
              <Check className="h-3 w-3" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
            {copiedKey === 'url'
              ? t('pulseDeck.workbench.sources.copiedBtn')
              : t('pulseDeck.workbench.sources.copyUrlBtn')}
          </Button>
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="source-signing-secret" className="text-xs">
            {t('pulseDeck.signingSecretLabel')}
          </Label>
          {credentialLinkUrl &&
          credentialLinkTooltip &&
          credentialLinkTestId ? (
            <CredentialExternalLinkButton
              url={credentialLinkUrl}
              tooltip={credentialLinkTooltip}
              testId={credentialLinkTestId}
            />
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            id="source-signing-secret"
            data-testid="source-signing-secret"
            aria-label={t('pulseDeck.signingSecretAria')}
            placeholder={t('pulseDeck.signingSecretPlaceholder')}
            value={signingSecret}
            onChange={(e) => onSigningSecretChange(e.target.value)}
            className="h-8 min-w-[180px] flex-1 font-mono text-xs"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="source-generate-secret-btn"
            onClick={() => onSigningSecretChange(generateWebhookSecret())}
            className="h-7 gap-1 px-2 text-xs"
          >
            <KeyRound className="h-3 w-3" />
            {t('pulseDeck.workbench.sources.generateSecretBtn')}
          </Button>
          {signingSecret ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="source-copy-secret-btn"
              onClick={() => void onCopy('secret', signingSecret)}
              className="h-7 gap-1 px-2 text-xs"
            >
              <Copy className="h-3 w-3" />
              {copiedKey === 'secret'
                ? t('pulseDeck.workbench.sources.copiedBtn')
                : t('pulseDeck.workbench.sources.copySecretBtn')}
            </Button>
          ) : null}
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={allowUnsigned}
          onCheckedChange={(checked) => onAllowUnsignedChange(checked === true)}
        />
        <span>{t('pulseDeck.workbench.sources.allowUnsignedLabel')}</span>
      </label>
    </div>
  );
}
