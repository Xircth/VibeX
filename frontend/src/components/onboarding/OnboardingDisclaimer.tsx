import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { APP_NAME } from '@/lib/branding';

const DISCLAIMER_SECTIONS = [
  'nature',
  'agents',
  'thirdPartyAgents',
  'plugins',
  'git',
  'automation',
  'delegation',
  'remote',
  'channels',
  'data',
  'runtime',
  'costs',
  'liability',
] as const;

export function OnboardingDisclaimerNotice({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation('dialogs');

  return (
    <p className="onboarding-disclaimer-copy">
      {t('onboarding.disclaimerAcceptHint')}
      <button
        type="button"
        className="onboarding-disclaimer-link"
        onClick={onOpen}
      >
        {t('onboarding.disclaimerLink')}
      </button>
    </p>
  );
}

export function OnboardingDisclaimerDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('dialogs');
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    titleRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="onboarding-disclaimer-overlay">
      <div
        className="onboarding-disclaimer-backdrop"
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        className="onboarding-disclaimer-panel dialog-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2
          ref={titleRef}
          id={titleId}
          className="onboarding-disclaimer-title"
          tabIndex={-1}
        >
          {t('onboarding.disclaimerTitle')}
        </h2>
        <div className="onboarding-disclaimer-body">
          <p>{t('onboarding.disclaimerPreamble', { appName: APP_NAME })}</p>
          {DISCLAIMER_SECTIONS.map((id) => (
            <section key={id} className="onboarding-disclaimer-section">
              <h3>{t(`onboarding.disclaimerSections.${id}.title`)}</h3>
              <p>
                {t(`onboarding.disclaimerSections.${id}.body`, {
                  appName: APP_NAME,
                })}
              </p>
            </section>
          ))}
        </div>
        <div className="onboarding-disclaimer-actions">
          <button
            type="button"
            className="onboarding-primary-button"
            onClick={onClose}
          >
            {t('onboarding.disclaimerClose')}
          </button>
        </div>
      </div>
    </div>
  );
}
