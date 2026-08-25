import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TextInput } from '@astryxdesign/core/TextInput';

const textInputSurfaceStyle = {
  backgroundColor: 'var(--surface-control)',
  borderRadius: 'var(--radius)',
};

export function VersionControlSetup({
  userName,
  userEmail,
  installing,
  error,
  disabled,
  onUserNameChange,
  onUserEmailChange,
}: {
  userName: string;
  userEmail: string;
  installing: boolean;
  error: string | null;
  disabled?: boolean;
  onUserNameChange: (value: string) => void;
  onUserEmailChange: (value: string) => void;
}) {
  const { t } = useTranslation('dialogs');
  const fieldsDisabled = disabled || installing;

  return (
    <div className="onboarding-config-panel onboarding-version-control-panel">
      <label className="onboarding-version-control-field">
        <span>{t('onboarding.gitUserNameLabel')}</span>
        <TextInput
          label={t('onboarding.gitUserNameLabel')}
          isLabelHidden
          value={userName}
          onChange={onUserNameChange}
          placeholder={t('onboarding.gitUserNamePlaceholder')}
          isDisabled={fieldsDisabled}
          width="100%"
          className="[&_input]:text-sm"
          style={textInputSurfaceStyle}
        />
      </label>
      <label className="onboarding-version-control-field">
        <span>{t('onboarding.gitUserEmailLabel')}</span>
        <TextInput
          label={t('onboarding.gitUserEmailLabel')}
          isLabelHidden
          value={userEmail}
          onChange={onUserEmailChange}
          placeholder={t('onboarding.gitUserEmailPlaceholder')}
          isDisabled={fieldsDisabled}
          width="100%"
          className="[&_input]:text-sm"
          style={textInputSurfaceStyle}
        />
      </label>
      {installing ? (
        <p className="onboarding-version-control-progress" role="status">
          <Loader2 className="animate-spin" aria-hidden="true" />
          {t('onboarding.installingVersionControl')}
        </p>
      ) : null}
      {error ? (
        <p className="onboarding-inline-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
