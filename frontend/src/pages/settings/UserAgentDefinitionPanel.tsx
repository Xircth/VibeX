import { AlertTriangle, Pencil, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type {
  UserAgentDefinitionRequest,
  UserAgentDefinitionView,
} from 'shared/types';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { UserAgentDefinitionEditor } from './UserAgentDefinitionEditor';

type UserAgentDefinitionPanelProps = {
  definition: UserAgentDefinitionView | null;
  loading: boolean;
  operationActive: boolean;
  onSave: (request: UserAgentDefinitionRequest) => Promise<boolean>;
  onReinstall: () => void;
  onDirtyChange?: (dirty: boolean) => void;
};

export function UserAgentDefinitionPanel({
  definition,
  loading,
  operationActive,
  onSave,
  onReinstall,
  onDirtyChange,
}: UserAgentDefinitionPanelProps) {
  const { i18n, t } = useTranslation('settings');
  const [editing, setEditing] = useState(false);

  if (!definition) {
    return (
      <section className="settings-surface px-4 py-5 text-xs text-muted-foreground">
        {t('agents.userDefinitionLoading')}
      </section>
    );
  }

  if (editing) {
    return (
      <section aria-labelledby="user-agent-definition-title">
        <div className="mb-3">
          <h2
            className="text-[15px] font-semibold text-foreground"
            id="user-agent-definition-title"
          >
            {t('agents.userDefinitionEditTitle')}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('agents.userDefinitionEditDescription')}
          </p>
        </div>
        <UserAgentDefinitionEditor
          key={definition.definition_sha256}
          currentPlatform={definition.distribution.platform}
          initial={definition}
          loading={loading}
          submitLabel={t('agents.userDefinitionSave')}
          onDirtyChange={onDirtyChange}
          onCancel={() => setEditing(false)}
          onSubmit={(request) => {
            void onSave(request).then((saved) => {
              if (saved) setEditing(false);
            });
          }}
        />
      </section>
    );
  }

  const distribution = definition.distribution;
  return (
    <section
      aria-labelledby="user-agent-definition-title"
      className="settings-surface overflow-hidden"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 px-4 py-3.5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2
              className="text-[15px] font-semibold text-foreground"
              id="user-agent-definition-title"
            >
              {t('agents.userDefinitionTitle')}
            </h2>
            <span
              className={cn(
                'agent-registry-status',
                definition.reinstall_required
                  ? 'settings-status-pill-warning'
                  : 'settings-status-pill-success'
              )}
              role="status"
            >
              {definition.reinstall_required
                ? t('agents.userDefinitionPending')
                : t('agents.userDefinitionSynced')}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('agents.userDefinitionDescription')}
          </p>
        </div>
        <Button
          className="h-8"
          disabled={loading || operationActive}
          size="sm"
          variant="outline"
          onClick={() => setEditing(true)}
        >
          <Pencil aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          {t('agents.userDefinitionEdit')}
        </Button>
      </div>

      {definition.reinstall_required ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-500/25 bg-amber-500/8 px-4 py-3 text-xs">
          <div className="flex min-w-0 items-start gap-2 text-amber-700 dark:text-amber-300">
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
            />
            <span>{t('agents.userDefinitionReinstallWarning')}</span>
          </div>
          <Button
            className="h-8 shrink-0"
            disabled={operationActive}
            size="sm"
            onClick={onReinstall}
          >
            <RefreshCw aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
            {t('agents.userDefinitionReinstall')}
          </Button>
        </div>
      ) : null}

      <div className="grid divide-y divide-border/70 md:grid-cols-[minmax(0,1.45fr)_minmax(14rem,1fr)] md:divide-x md:divide-y-0">
        <div className="space-y-4 px-4 py-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('agents.distributionEvidence')}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <Evidence value={t('agents.userDefined')} />
              <Separator />
              <Evidence value={distribution.kind} mono />
              <Separator />
              <Evidence value={distribution.platform} mono />
              <Separator />
              <Evidence value={integrityLabel(t, distribution.integrity)} />
            </div>
          </div>

          <dl className="grid gap-x-4 gap-y-3 text-xs sm:grid-cols-2">
            <DefinitionValue
              label="Agent ID"
              value={definition.agent_id}
              mono
            />
            <DefinitionValue
              label={t('agents.version')}
              value={definition.version}
              mono
            />
            <DefinitionValue
              className="sm:col-span-2"
              label={
                distribution.package
                  ? t('agents.package')
                  : t('agents.archiveUrl')
              }
              value={distribution.package ?? distribution.archive_url ?? '—'}
              mono
            />
            <DefinitionValue
              label={t('agents.launchCommand')}
              value={distribution.command}
              mono
            />
            <DefinitionValue
              label={t('agents.platformSupport')}
              value={
                distribution.platform_supported
                  ? t('agents.platformAvailable')
                  : t('agents.platformUnsupported')
              }
            />
            <DefinitionValue
              className="sm:col-span-2"
              label={t('agents.launchArguments')}
              value={
                distribution.args.length
                  ? distribution.args.join(' ')
                  : t('agents.none')
              }
              mono
            />
          </dl>
        </div>

        <div className="space-y-4 px-4 py-4">
          <DefinitionValue
            label={t('agents.definitionDigest')}
            value={shortDigest(definition.definition_sha256)}
            title={definition.definition_sha256}
            mono
          />
          <DefinitionValue
            label={t('agents.installedDigest')}
            value={
              definition.installed_definition_sha256
                ? shortDigest(definition.installed_definition_sha256)
                : t('agents.notInstalledYet')
            }
            title={definition.installed_definition_sha256 ?? undefined}
            mono={Boolean(definition.installed_definition_sha256)}
          />
          <DefinitionValue
            label={t('agents.lastUpdated')}
            value={formatDate(
              definition.updated_at ?? definition.created_at,
              i18n.language
            )}
          />
          <div>
            <dt className="text-xs text-muted-foreground">
              {t('agents.environmentVariables')}
            </dt>
            <dd className="mt-1 space-y-1">
              {distribution.environment.length ? (
                distribution.environment.map((entry) => (
                  <code
                    className="block break-all text-xs text-foreground"
                    key={entry.name}
                  >
                    {entry.name}={maskEnvironmentValue(t, entry.value)}
                  </code>
                ))
              ) : (
                <span className="text-xs text-foreground">
                  {t('agents.none')}
                </span>
              )}
            </dd>
          </div>
        </div>
      </div>
    </section>
  );
}

function Evidence({ value, mono = false }: { value: string; mono?: boolean }) {
  return (
    <span className={cn('text-foreground', mono && 'font-mono')}>{value}</span>
  );
}

function Separator() {
  return <span className="text-border">/</span>;
}

function DefinitionValue({
  label,
  value,
  mono = false,
  className,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'mt-1 break-all text-xs text-foreground',
          mono && 'font-mono'
        )}
        title={title}
      >
        {value}
      </dd>
    </div>
  );
}

function integrityLabel(
  t: TFunction<'settings'>,
  integrity: UserAgentDefinitionView['distribution']['integrity']
): string {
  switch (integrity) {
    case 'sha256':
      return t('agents.sha256Verification');
    case 'trust_on_first_use':
      return t('agents.trustOnFirstUse');
    case 'ecosystem_lock':
      return t('agents.ecosystemLock');
  }
}

function shortDigest(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function maskEnvironmentValue(t: TFunction<'settings'>, value: string): string {
  return value ? '••••••' : t('agents.emptyValue');
}

function formatDate(value: string | null, language: string): string {
  return value ? new Date(value).toLocaleString(language) : '—';
}
