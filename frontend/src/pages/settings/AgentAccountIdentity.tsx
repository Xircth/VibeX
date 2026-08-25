import { CircleAlert, User } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function AgentAccountIdentity({
  signedIn,
  accountLabel,
}: {
  signedIn: boolean;
  accountLabel?: string | null;
}) {
  const { t } = useTranslation('settings');
  const identifiedLabel = signedIn ? accountLabel?.trim() || null : null;
  const state = identifiedLabel
    ? 'identified'
    : signedIn
      ? 'unknown'
      : 'signed-out';
  const label = identifiedLabel
    ? identifiedLabel
    : signedIn
      ? t('agents.authSessionNoUserInfo')
      : t('agents.authSessionSignedOut');
  const accessibleName = identifiedLabel
    ? t('agents.authSessionAccount', { account: identifiedLabel })
    : label;

  return (
    <div
      className="agent-account-identity"
      data-state={state}
      data-testid="agent-account-identity"
      role="status"
      aria-label={accessibleName}
    >
      <span className="agent-account-identity-mark" aria-hidden="true">
        {identifiedLabel ? (
          accountInitial(identifiedLabel)
        ) : signedIn ? (
          <CircleAlert />
        ) : (
          <User />
        )}
      </span>
      <span className="agent-account-identity-copy">
        <strong>{label}</strong>
      </span>
    </div>
  );
}

export function accountInitial(label: string): string {
  const source = label.split('@')[0]?.trim() || label.trim();
  const first = [...source][0];
  return first ? first.toLocaleUpperCase() : '?';
}
