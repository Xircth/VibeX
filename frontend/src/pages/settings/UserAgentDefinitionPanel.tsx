import { AlertTriangle, Pencil, RefreshCw } from 'lucide-react';
import { useState } from 'react';
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
};

export function UserAgentDefinitionPanel({
  definition,
  loading,
  operationActive,
  onSave,
  onReinstall,
}: UserAgentDefinitionPanelProps) {
  const [editing, setEditing] = useState(false);

  if (!definition) {
    return (
      <section className="settings-surface px-4 py-5 text-xs text-muted-foreground">
        正在读取手动 Agent 定义…
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
            编辑手动 Agent 定义
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Agent ID 是持久身份，创建后不可修改。发行变更需重新安装后才会生效。
          </p>
        </div>
        <UserAgentDefinitionEditor
          key={definition.definition_sha256}
          currentPlatform={definition.distribution.platform}
          initial={definition}
          loading={loading}
          submitLabel="保存定义"
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
              手动 Agent 定义
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
              {definition.reinstall_required ? '定义待应用' : '定义已同步'}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            注册定义决定 VibeX 安装什么，以及新会话如何启动该 Agent。
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
          编辑定义
        </Button>
      </div>

      {definition.reinstall_required ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-500/25 bg-amber-500/8 px-4 py-3 text-xs">
          <div className="flex min-w-0 items-start gap-2 text-amber-700 dark:text-amber-300">
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
            />
            <span>
              当前安装仍使用旧定义。正在运行的会话不受影响；重新安装后，新会话才使用本页定义。
            </span>
          </div>
          <Button
            className="h-8 shrink-0"
            disabled={operationActive}
            size="sm"
            onClick={onReinstall}
          >
            <RefreshCw aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
            重新安装定义
          </Button>
        </div>
      ) : null}

      <div className="grid divide-y divide-border/70 md:grid-cols-[minmax(0,1.45fr)_minmax(14rem,1fr)] md:divide-x md:divide-y-0">
        <div className="space-y-4 px-4 py-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              发行证据
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <Evidence value="用户定义" />
              <Separator />
              <Evidence value={distribution.kind} mono />
              <Separator />
              <Evidence value={distribution.platform} mono />
              <Separator />
              <Evidence value={integrityLabel(distribution.integrity)} />
            </div>
          </div>

          <dl className="grid gap-x-4 gap-y-3 text-xs sm:grid-cols-2">
            <DefinitionValue
              label="Agent ID"
              value={definition.agent_id}
              mono
            />
            <DefinitionValue label="版本" value={definition.version} mono />
            <DefinitionValue
              className="sm:col-span-2"
              label={distribution.package ? '软件包' : '归档地址'}
              value={distribution.package ?? distribution.archive_url ?? '—'}
              mono
            />
            <DefinitionValue
              label="启动命令"
              value={distribution.command}
              mono
            />
            <DefinitionValue
              label="平台支持"
              value={
                distribution.platform_supported
                  ? '当前平台可用'
                  : '当前平台不支持'
              }
            />
            <DefinitionValue
              className="sm:col-span-2"
              label="启动参数"
              value={
                distribution.args.length ? distribution.args.join(' ') : '无'
              }
              mono
            />
          </dl>
        </div>

        <div className="space-y-4 px-4 py-4">
          <DefinitionValue
            label="定义摘要"
            value={shortDigest(definition.definition_sha256)}
            title={definition.definition_sha256}
            mono
          />
          <DefinitionValue
            label="已安装摘要"
            value={
              definition.installed_definition_sha256
                ? shortDigest(definition.installed_definition_sha256)
                : '尚未安装'
            }
            title={definition.installed_definition_sha256 ?? undefined}
            mono={Boolean(definition.installed_definition_sha256)}
          />
          <DefinitionValue
            label="最后更新"
            value={formatDate(definition.updated_at ?? definition.created_at)}
          />
          <div>
            <dt className="text-[11px] text-muted-foreground">环境变量</dt>
            <dd className="mt-1 space-y-1">
              {distribution.environment.length ? (
                distribution.environment.map((entry) => (
                  <code
                    className="block break-all text-[11px] text-foreground"
                    key={entry.name}
                  >
                    {entry.name}={maskEnvironmentValue(entry.value)}
                  </code>
                ))
              ) : (
                <span className="text-xs text-foreground">无</span>
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
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
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
  integrity: UserAgentDefinitionView['distribution']['integrity']
): string {
  switch (integrity) {
    case 'sha256':
      return 'SHA-256 校验';
    case 'trust_on_first_use':
      return '首次信任后锁定';
    case 'ecosystem_lock':
      return '生态锁文件';
  }
}

function shortDigest(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function maskEnvironmentValue(value: string): string {
  return value ? '••••••' : '(空)';
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}
