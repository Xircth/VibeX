import { CheckCircle2, ChevronDown, CircleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentPreflightItemView,
  AgentPreflightSource,
} from 'shared/types';

import { cn } from '@/lib/utils';

type AgentPreflightCheckItemProps = {
  item: AgentPreflightItemView;
  label: string;
  detail: string;
  busy?: boolean;
  onUpdate?: () => void;
};

type CheckStatus = AgentPreflightItemView['status'];

export function AgentPreflightCheckItem({
  item,
  label,
  detail,
  busy = false,
  onUpdate,
}: AgentPreflightCheckItemProps) {
  const { t } = useTranslation('settings');
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();

  return (
    <li
      aria-label={t('agents.preflightResultAria', { label })}
      className="agent-preflight-check"
      data-expanded={expanded}
      data-status={item.status}
    >
      <div className="agent-preflight-layout">
        <PreflightCheckIdentity label={label} status={item.status} />
        <PreflightInformationStack
          detail={detail}
          expanded={expanded}
          id={panelId}
          label={label}
          path={item.path}
          source={item.source}
          version={item.version}
        />
        <div className="agent-preflight-trigger">
          <PreflightCheckStatus
            busy={busy}
            onUpdate={onUpdate}
            status={item.status}
            updateAvailable={item.update_available}
          />
          <button
            aria-controls={panelId}
            aria-expanded={expanded}
            aria-label={t(
              expanded
                ? 'agents.preflightCollapseDetails'
                : 'agents.preflightExpandDetails',
              { label }
            )}
            className="agent-preflight-chevron-button"
            onClick={() => setExpanded((current) => !current)}
            type="button"
          >
            <ChevronDown
              aria-hidden="true"
              className="agent-preflight-chevron"
            />
          </button>
        </div>
      </div>
    </li>
  );
}

function PreflightCheckIdentity({
  label,
  status,
}: {
  label: string;
  status: CheckStatus;
}) {
  const Icon = status === 'pass' ? CheckCircle2 : CircleAlert;
  return (
    <span className="agent-preflight-identity">
      <span
        aria-hidden="true"
        className={cn('agent-preflight-status-icon', `is-${status}`)}
      >
        <Icon />
      </span>
      <strong>{label}</strong>
    </span>
  );
}

function PreflightCheckStatus({
  busy,
  onUpdate,
  status,
  updateAvailable,
}: {
  busy: boolean;
  onUpdate?: () => void;
  status: CheckStatus;
  updateAvailable?: boolean;
}) {
  const { t } = useTranslation('settings');
  return (
    <span className="agent-preflight-status-stack">
      <span className={cn('agent-preflight-status', `is-${status}`)}>
        {status === 'pass'
          ? t('agents.available')
          : status === 'warning'
            ? t('agents.optionalWarning')
            : t('agents.needsAction')}
      </span>
      {updateAvailable && onUpdate ? (
        <button
          className="agent-preflight-status is-update"
          disabled={busy}
          onClick={onUpdate}
          type="button"
        >
          {t('agents.updateAvailableBadge')}
        </button>
      ) : updateAvailable ? (
        <span className="agent-preflight-status is-update">
          {t('agents.updateAvailableBadge')}
        </span>
      ) : null}
    </span>
  );
}

function PreflightInformationStack({
  detail,
  expanded,
  id,
  label,
  path,
  source,
  version,
}: {
  detail: string;
  expanded: boolean;
  id: string;
  label: string;
  path: string | null;
  source: AgentPreflightSource | null;
  version: string | null;
}) {
  const { t } = useTranslation('settings');
  return (
    <dl
      aria-label={t('agents.preflightInformationAria', { label })}
      className="agent-preflight-information-list"
      id={id}
      role="group"
    >
      <PreflightInformation
        label={t('agents.version')}
        value={version || t('agents.versionUnknown')}
      />
      {expanded && source ? (
        <PreflightInformation
          isDisclosureDetail
          label={t('agents.source')}
          value={t('agents.sourceSystem')}
          monospace={false}
        />
      ) : null}
      {expanded && path ? (
        <PreflightInformation
          isDisclosureDetail
          isPath
          label={t('agents.location')}
          value={path}
        />
      ) : null}
      {expanded && detail ? (
        <PreflightInformation
          isDetail
          isDisclosureDetail
          label={t('agents.preflightDetailLabel')}
          monospace={false}
          value={detail}
        />
      ) : null}
    </dl>
  );
}

function PreflightInformation({
  isDetail = false,
  isDisclosureDetail = false,
  isPath = false,
  label,
  monospace = true,
  value,
}: {
  isDetail?: boolean;
  isDisclosureDetail?: boolean;
  isPath?: boolean;
  label: string;
  monospace?: boolean;
  value: string;
}) {
  return (
    <div
      className={cn(
        'agent-preflight-information',
        isPath && 'is-path',
        isDetail && 'is-detail',
        isDisclosureDetail && 'is-disclosure-detail'
      )}
    >
      <dt className="agent-preflight-information-label">{label}</dt>
      <dd>
        {monospace ? (
          <code className="agent-preflight-evidence-value" title={value}>
            {value}
          </code>
        ) : (
          <span className="agent-preflight-evidence-value">{value}</span>
        )}
      </dd>
    </div>
  );
}
