import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import type {
  UserAgentDefinitionRequest,
  UserAgentDefinitionView,
  UserAgentDistributionKind,
} from 'shared/types';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  onSubmit: (request: UserAgentDefinitionRequest) => void;
};

export function UserAgentDefinitionEditor({
  currentPlatform,
  initial,
  loading,
  submitLabel,
  onCancel,
  onSubmit,
}: UserAgentDefinitionEditorProps) {
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

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit({
      agent_id: agentId,
      display_name: displayName,
      description,
      version,
      distribution_kind: distributionKind,
      distribution_json: distributionJson,
    });
  };

  return (
    <form className="settings-surface space-y-4 p-4" onSubmit={submit}>
      <div className="rounded-md border border-border/70 bg-muted/25 px-3 py-2.5 text-xs text-muted-foreground">
        使用 ACP Registry 兼容的 binary、npx 或 uvx 发行定义。VibeX 不执行自定义
        shell 命令；安装前会冻结定义并验证制品完整性。
      </div>

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
        <Field label="显示名称">
          <Input
            aria-label="显示名称"
            required
            value={displayName}
            placeholder="Local Reviewer"
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </Field>
        <Field label="版本">
          <Input
            aria-label="版本"
            required
            value={version}
            placeholder="1.2.3"
            onChange={(event) => setVersion(event.target.value)}
          />
        </Field>
        <Field label="安装方式">
          <select
            aria-label="安装方式"
            className="h-8 w-full rounded-md border border-input bg-[var(--surface-control)] px-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
            value={distributionKind}
            onChange={(event) =>
              setDistributionKind(
                event.target.value as UserAgentDistributionKind
              )
            }
          >
            <option value="npx">npx</option>
            <option value="uvx">uvx</option>
            <option value="binary">binary</option>
          </select>
        </Field>
      </div>

      <Field label="描述（可选）">
        <Input
          aria-label="描述"
          value={description}
          placeholder="这个 Agent 适合完成什么任务"
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>

      <div className="border-t border-border/70 pt-4">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">发行证据</span>
          <span>用户定义</span>
          <span>·</span>
          <span>{distributionKind}</span>
          <span>·</span>
          <span className="font-mono">{currentPlatform}</span>
          <span>·</span>
          <span>
            {distributionKind === 'binary'
              ? sha256.trim()
                ? 'SHA-256'
                : '首次信任后锁定'
              : '生态锁文件'}
          </span>
        </div>

        {distributionKind === 'binary' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="归档地址" className="sm:col-span-2">
              <Input
                aria-label="归档地址"
                required
                type="url"
                value={archiveUrl}
                placeholder="https://example.com/agent.tar.gz"
                onChange={(event) => setArchiveUrl(event.target.value)}
              />
            </Field>
            <Field label="归档内命令">
              <Input
                aria-label="归档内命令"
                required
                value={command}
                placeholder="./agent"
                onChange={(event) => setCommand(event.target.value)}
              />
            </Field>
            <Field label="SHA-256（可选）">
              <Input
                aria-label="SHA-256"
                value={sha256}
                placeholder="留空时首次安装后锁定"
                onChange={(event) => setSha256(event.target.value)}
              />
            </Field>
          </div>
        ) : (
          <Field label="软件包">
            <Input
              aria-label="软件包"
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

      <Field label="启动参数">
        <Textarea
          aria-label="启动参数"
          className="min-h-20 resize-y border-input bg-[var(--surface-control)] font-mono text-xs leading-5"
          value={argsText}
          placeholder="每行一个参数，例如 --acp"
          onChange={(event) => setArgsText(event.target.value)}
        />
        <span className="block font-normal text-muted-foreground">
          每行一个参数；参数会直接传给进程，不经过
          shell，因此可安全保留参数内的空格。
        </span>
      </Field>

      <fieldset className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <legend className="text-xs font-medium text-foreground">
            环境变量（可选）
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
            添加变量
          </Button>
        </div>
        {environment.map((entry, index) => (
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2" key={entry.id}>
            <Input
              aria-label={`环境变量名称 ${index + 1}`}
              autoComplete="off"
              value={entry.name}
              placeholder="变量名"
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
              aria-label={`环境变量值 ${index + 1}`}
              autoComplete="off"
              value={entry.value}
              placeholder="值"
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
              aria-label={`删除环境变量 ${index + 1}`}
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

      <details className="rounded-md border border-border/70 px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-foreground">
          高级：查看生成的 Registry JSON
        </summary>
        <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-5 text-muted-foreground">
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
            取消
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
