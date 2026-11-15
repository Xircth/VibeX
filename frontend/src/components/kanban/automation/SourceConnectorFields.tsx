import { useTranslation } from 'react-i18next';
import { Check, Copy, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { EventSourceKind } from '@/lib/api/pulse';
import { cn } from '@/lib/utils';
import { generateWebhookSecret } from './automationModels';

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
      <div className="space-y-3" data-testid="connector-github">
        <div className="grid gap-1.5 sm:grid-cols-2">
          <button
            type="button"
            data-testid="github-mode-poll"
            aria-pressed={githubMode === 'poll'}
            onClick={() => onGithubModeChange('poll')}
            className={cn(
              'rounded-md border px-3 py-2 text-left text-xs font-medium transition-colors',
              githubMode === 'poll'
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border bg-[var(--surface-control)] text-muted-foreground hover:text-foreground'
            )}
          >
            {t('pulseDeck.workbench.sources.githubModePoll')}
          </button>
          <button
            type="button"
            data-testid="github-mode-webhook"
            aria-pressed={githubMode === 'webhook'}
            onClick={() => onGithubModeChange('webhook')}
            className={cn(
              'rounded-md border px-3 py-2 text-left text-xs font-medium transition-colors',
              githubMode === 'webhook'
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border bg-[var(--surface-control)] text-muted-foreground hover:text-foreground'
            )}
          >
            {t('pulseDeck.workbench.sources.githubModeWebhook')}
          </button>
        </div>

        {githubMode === 'poll' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="github-repo-input" className="text-xs">
                {t('pulseDeck.workbench.sources.githubRepoLabel')}
              </Label>
              <Input
                id="github-repo-input"
                data-testid="github-repo-input"
                placeholder={t(
                  'pulseDeck.workbench.sources.githubRepoPlaceholder'
                )}
                value={githubRepo}
                onChange={(e) => onGithubRepoChange(e.target.value)}
                className="h-8 font-mono text-xs"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="github-poll-interval" className="text-xs">
                {t('pulseDeck.workbench.sources.githubPollIntervalLabel')}
              </Label>
              <select
                id="github-poll-interval"
                data-testid="github-poll-interval"
                value={githubPollSeconds}
                onChange={(e) =>
                  onGithubPollSecondsChange(Number(e.target.value) || 60)
                }
                className="h-8 w-full rounded-md border border-border bg-[var(--surface-control)] px-2.5 text-xs tabular-nums text-foreground"
              >
                <option value={30}>30s</option>
                <option value={60}>60s</option>
                <option value={120}>120s</option>
              </select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="github-token-input" className="text-xs">
                {t('pulseDeck.workbench.sources.githubTokenLabel')}
              </Label>
              <Input
                id="github-token-input"
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
    );
  }

  if (kind === 'feishu') {
    return (
      <div className="space-y-3" data-testid="connector-feishu">
        <div className="grid gap-1.5 sm:grid-cols-2">
          <button
            type="button"
            data-testid="feishu-mode-long-connection"
            aria-pressed={feishuMode === 'long_connection'}
            onClick={() => onFeishuModeChange('long_connection')}
            className={cn(
              'rounded-md border px-3 py-2 text-left text-xs font-medium transition-colors',
              feishuMode === 'long_connection'
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border bg-[var(--surface-control)] text-muted-foreground hover:text-foreground'
            )}
          >
            {t('pulseDeck.workbench.sources.feishuModeLongConn')}
          </button>
          <button
            type="button"
            data-testid="feishu-mode-webhook"
            aria-pressed={feishuMode === 'webhook'}
            onClick={() => onFeishuModeChange('webhook')}
            className={cn(
              'rounded-md border px-3 py-2 text-left text-xs font-medium transition-colors',
              feishuMode === 'webhook'
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border bg-[var(--surface-control)] text-muted-foreground hover:text-foreground'
            )}
          >
            {t('pulseDeck.workbench.sources.feishuModeWebhook')}
          </button>
        </div>

        {feishuMode === 'long_connection' ? (
          <div className="space-y-2.5">
            <p className="rounded-md border border-border bg-[var(--surface-panel)] p-2.5 text-xs text-muted-foreground">
              {t('pulseDeck.workbench.sources.feishuBridgeHint')}
            </p>
            <div className="space-y-1">
              <Label htmlFor="feishu-bot-openid" className="text-xs">
                {t('pulseDeck.workbench.sources.feishuBotOpenIdLabel')}
              </Label>
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
            />
          </div>
        )}
      </div>
    );
  }

  return (
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
            {t('pulseDeck.workbench.editor.event.intervalSecondsLabel')}
          </Label>
          <Input
            id="source-interval-sec"
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
}: {
  webhookUrl: string;
  signingSecret: string;
  onSigningSecretChange: (val: string) => void;
  allowUnsigned: boolean;
  onAllowUnsignedChange: (val: boolean) => void;
  copiedKey: string | null;
  onCopy: (key: string, text: string) => Promise<void>;
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
          >
            {copiedKey === 'url' ? (
              <Check className="mr-1 h-3.5 w-3.5" />
            ) : (
              <Copy className="mr-1 h-3.5 w-3.5" />
            )}
            {copiedKey === 'url'
              ? t('pulseDeck.workbench.sources.copiedBtn')
              : t('pulseDeck.workbench.sources.copyUrlBtn')}
          </Button>
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="source-signing-secret" className="text-xs">
          {t('pulseDeck.signingSecretLabel')}
        </Label>
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
          >
            <KeyRound className="mr-1 h-3.5 w-3.5" />
            {t('pulseDeck.workbench.sources.generateSecretBtn')}
          </Button>
          {signingSecret ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="source-copy-secret-btn"
              onClick={() => void onCopy('secret', signingSecret)}
            >
              <Copy className="mr-1 h-3.5 w-3.5" />
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
