import { Loader2, Plus, Trash2 } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import type {
  UserAgentDefinitionRequest,
  UserAgentDefinitionView,
  UserAgentDistributionKind,
} from 'shared/types';

import { AstryxSelect } from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

type EnvironmentRow = {
  id: number;
  name: string;
  value: string;
};

type UserAgentDefinitionEditorProps = {
  currentPlatform: string;
  initial?: UserAgentDefinitionView;
  loading: boolean;
  submitLabel: string;
  onCancel?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSubmit: (request: UserAgentDefinitionRequest) => void;
};

export function UserAgentDefinitionEditor({
  currentPlatform,
  initial,
  loading,
  submitLabel,
  onCancel,
  onDirtyChange,
  onSubmit,
}: UserAgentDefinitionEditorProps) {
  const { t } = useTranslation(['settings', 'common']);
  const initialDistribution = initial?.distribution;
  const [agentId, setAgentId] = useState(initial?.agent_id ?? '');
  const [displayName, setDisplayName] = useState(initial?.display_name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [version, setVersion] = useState(initial?.version ?? '');
  const [distributionKind, setDistributionKind] =
    useState<UserAgentDistributionKind>(initialDistribution?.kind ?? 'npx');
  const [packageName, setPackageName] = useState(
    initialDistribution?.package ?? ''
  );
  const [archiveUrl, setArchiveUrl] = useState(
    initialDistribution?.archive_url ?? ''
  );
  const [command, setCommand] = useState(
    initialDistribution?.kind === 'binary'
      ? initialDistribution.command
      : './agent'
  );
  const [sha256, setSha256] = useState(initialDistribution?.sha256 ?? '');
  const [argsText, setArgsText] = useState(
    initialDistribution?.args.join('\n') ?? '--acp'
  );
  const [environment, setEnvironment] = useState<EnvironmentRow[]>(() => {
    const entries = initialDistribution?.environment ?? [];
    return entries.length > 0
      ? entries.map((entry, index) => ({ id: index, ...entry }))
      : [{ id: 0, name: '', value: '' }];
  });
  const [nextEnvironmentId, setNextEnvironmentId] = useState(
    (initialDistribution?.environment.length ?? 0) + 1
  );
  const [skillsSharedStore, setSkillsSharedStore] = useState(
    initial?.skills_shared_store ?? false
  );
  const [skillsDirectory, setSkillsDirectory] = useState(
    initial?.skills_directory ?? ''
  );

  const args = useMemo(
    () =>
      argsText
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean),
    [argsText]
  );
  const env = useMemo(
    () =>
      Object.fromEntries(
        environment
          .map((entry) => [entry.name.trim(), entry.value] as const)
          .filter(([name]) => name)
      ),
    [environment]
  );
  const distributionJson = useMemo(
    () =>
      buildDistributionJson({
        kind: distributionKind,
        platform: currentPlatform,
        packageName,
        archiveUrl,
        command,
        args,
        env,
        sha256,
      }),
    [
      archiveUrl,
      args,
      command,
      currentPlatform,
      distributionKind,
      env,
      packageName,
      sha256,
    ]
  );
  const request = useMemo<UserAgentDefinitionRequest>(
    () => ({
      agent_id: agentId,
      display_name: displayName,
      description,
      version,
      distribution_kind: distributionKind,
      distribution_json: distributionJson,
      skills_shared_store: skillsSharedStore,
      skills_directory: skillsDirectory.trim() || null,
    }),
    [
      agentId,
      description,
      displayName,
      distributionJson,
      distributionKind,
      skillsDirectory,
      skillsSharedStore,
      version,
    ]
  );
  const fingerprint = JSON.stringify(request);
  const initialFingerprint = useRef(fingerprint).current;
  const dirty = fingerprint !== initialFingerprint;
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(request);
  };

  return (
    <form className="settings-surface space-y-4 p-4" onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Agent ID">
          <Input
            aria-label="Agent ID"
            autoComplete="off"
            disabled={Boolean(initial)}
            pattern="[a-z0-9][a-z0-9_.-]*"
            required
            value={agentId}
            placeholder="local-reviewer"
            onChange={(event) => setAgentId(event.target.value)}
          />
        </Field>
        <Field label={t('settings:agents.displayName')}>
          <Input
            aria-label={t('settings:agents.displayName')}
            required
            value={displayName}
            placeholder="Local Reviewer"
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>
        <Field label={t('settings:agents.version')}>
          <Input
            aria-label={t('settings:agents.version')}
            required
            value={version}
            placeholder="1.2.3"
            onChange={(event) => setVersion(event.target.value)}
          />
        </Field>
        <Field label={t('settings:agents.installMethod')}>
          <AstryxSelect
            ariaLabel={t('settings:agents.installMethod')}
            value={distributionKind}
            options={['npx', 'uvx', 'binary'].map((kind) => ({
              value: kind,
              label: kind,
            }))}
            onChange={(next) =>
              setDistributionKind(next as UserAgentDistributionKind)
            }
          />
        </Field>
      </div>

      <Field label={t('settings:agents.descriptionOptional')}>
        <Input
          aria-label={t('settings:agents.description')}
          value={description}
          placeholder={t('settings:agents.descriptionPlaceholder')}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>

      <div className="border-t border-border/70 pt-4">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {t('settings:agents.distributionEvidence')}
          </span>
          <span>{t('settings:agents.userDefined')}</span>
          <span>·</span>
          <span>{distributionKind}</span>
          <span>·</span>
          <span className="font-mono">{currentPlatform}</span>
          <span>·</span>
          <span>
            {distributionKind === 'binary'
              ? sha256.trim()
                ? 'SHA-256'
                : t('settings:agents.trustOnFirstUse')
              : t('settings:agents.ecosystemLock')}
          </span>
        </div>

        {distributionKind === 'binary' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t('settings:agents.archiveUrl')}
              className="sm:col-span-2"
            >
              <Input
                aria-label={t('settings:agents.archiveUrl')}
                required
                type="url"
                value={archiveUrl}
                placeholder="https://example.com/agent.tar.gz"
                onChange={(event) => setArchiveUrl(event.target.value)}
              />
            </Field>
            <Field label={t('settings:agents.archiveCommand')}>
              <Input
                aria-label={t('settings:agents.archiveCommand')}
                required
                value={command}
                placeholder="./agent"
                onChange={(event) => setCommand(event.target.value)}
              />
            </Field>
            <Field label={t('settings:agents.sha256Optional')}>
              <Input
                aria-label="SHA-256"
                value={sha256}
                placeholder={t('settings:agents.sha256Placeholder')}
                onChange={(event) => setSha256(event.target.value)}
              />
            </Field>
          </div>
        ) : (
          <Field label={t('settings:agents.package')}>
            <Input
              aria-label={t('settings:agents.package')}
              required
              value={packageName}
              placeholder={
                distributionKind === 'npx'
                  ? 'local-reviewer@1.2.3'
                  : 'local-reviewer==1.2.3'
              }
              onChange={(event) => setPackageName(event.target.value)}
            />
          </Field>
        )}
      </div>

      <Field label={t('settings:agents.launchArguments')}>
        <Textarea
          aria-label={t('settings:agents.launchArguments')}
          className="min-h-20 resize-y border-input bg-[var(--surface-control)] font-mono text-xs leading-5"
          value={argsText}
          placeholder={t('settings:agents.launchArgumentsPlaceholder')}
          onChange={(event) => setArgsText(event.target.value)}
        />
      </Field>

      <fieldset className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <legend className="text-xs font-medium text-foreground">
            {t('settings:agents.environmentOptional')}
          </legend>
          <Button
            className="h-7"
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => {
              setEnvironment((rows) => [
                ...rows,
                { id: nextEnvironmentId, name: '', value: '' },
              ]);
              setNextEnvironmentId((value) => value + 1);
            }}
          >
            <Plus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
            {t('settings:agents.addVariable')}
          </Button>
        </div>
        {environment.map((entry, index) => (
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2" key={entry.id}>
            <Input
              aria-label={t('settings:agents.environmentNameAria', {
                number: index + 1,
              })}
              autoComplete="off"
              value={entry.name}
              placeholder={t('settings:agents.variableName')}
              onChange={(event) =>
                setEnvironment((rows) =>
                  rows.map((row) =>
                    row.id === entry.id
                      ? { ...row, name: event.target.value }
                      : row
                  )
                )
              }
            />
            <Input
              aria-label={t('settings:agents.environmentValueAria', {
                number: index + 1,
              })}
              autoComplete="off"
              value={entry.value}
              placeholder={t('settings:agents.value')}
              onChange={(event) =>
                setEnvironment((rows) =>
                  rows.map((row) =>
                    row.id === entry.id
                      ? { ...row, value: event.target.value }
                      : row
                  )
                )
              }
            />
            <Button
              aria-label={t('settings:agents.environmentDeleteAria', {
                number: index + 1,
              })}
              className="h-8 w-8 p-0"
              disabled={environment.length === 1}
              type="button"
              variant="ghost"
              onClick={() =>
                setEnvironment((rows) =>
                  rows.filter((row) => row.id !== entry.id)
                )
              }
            >
              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </fieldset>

      <fieldset className="space-y-3 rounded-md border border-border/70 bg-muted/10 p-3">
        <legend className="px-1 text-xs font-medium text-foreground">
          {t('settings:agents.customSkillsDeclaration')}
        </legend>
        <div className="flex items-start justify-between gap-3">
          <label className="space-y-1" htmlFor="custom-agent-shared-skills">
            <span className="block text-xs font-medium text-foreground">
              {t('settings:agents.customSkillsSharedStore')}
            </span>
          </label>
          <Switch
            id="custom-agent-shared-skills"
            aria-label={t('settings:agents.customSkillsSharedStore')}
            checked={skillsSharedStore}
            onCheckedChange={setSkillsSharedStore}
          />
        </div>
        <Field label={t('settings:agents.customSkillsDirectory')}>
          <Input
            aria-label={t('settings:agents.customSkillsDirectory')}
            autoComplete="off"
            className="font-mono text-xs"
            value={skillsDirectory}
            placeholder="~/.my-agent/skills"
            onChange={(event) => setSkillsDirectory(event.target.value)}
          />
        </Field>
      </fieldset>

      <details className="rounded-md border border-border/70 px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-foreground">
          {t('settings:agents.registryJsonAdvanced')}
        </summary>
        <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all text-xs leading-5 text-muted-foreground">
          {JSON.stringify(JSON.parse(distributionJson), null, 2)}
        </pre>
      </details>

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button
            className="h-8"
            disabled={loading}
            size="sm"
            type="button"
            variant="ghost"
            onClick={onCancel}
          >
            {t('common:cancel')}
          </Button>
        ) : null}
        <Button className="h-8" disabled={loading} size="sm" type="submit">
          {loading ? (
            <Loader2
              aria-hidden="true"
              className="mr-1.5 h-3.5 w-3.5 animate-spin"
            />
          ) : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label
      className={`block space-y-1.5 text-xs font-medium text-foreground ${className ?? ''}`}
    >
      <span>{label}</span>
      {children}
    </label>
  );
}

function buildDistributionJson({
  kind,
  platform,
  packageName,
  archiveUrl,
  command,
  args,
  env,
  sha256,
}: {
  kind: UserAgentDistributionKind;
  platform: string;
  packageName: string;
  archiveUrl: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  sha256: string;
}): string {
  if (kind === 'binary') {
    return JSON.stringify({
      binary: {
        [platform]: {
          archive: archiveUrl.trim(),
          sha256: sha256.trim() || null,
          cmd: command.trim(),
          args,
          env,
        },
      },
    });
  }
  return JSON.stringify({
    [kind]: {
      package: packageName.trim(),
      args,
      env,
    },
  });
}
