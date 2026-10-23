import { Children, isValidElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

export type AstryxStepperStatus = 'completed' | 'current' | 'upcoming';

export function AstryxStepperItem(_props: { children: ReactNode }) {
  return null;
}

export function AstryxStepper({
  current = 0,
  onStepClick,
  'aria-label': ariaLabel,
  children,
}: {
  current?: number;
  onStepClick?: (index: number) => void;
  'aria-label'?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation(['basicGuide', 'statusbar']);
  const labels: ReactNode[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<{ children: ReactNode }>(child)) return;
    labels.push(child.props.children);
  });

  return (
    <ol
      aria-label={
        ariaLabel ?? t('agentStatus.acpStepsAria', { ns: 'statusbar' })
      }
      className="astryx-stepper"
    >
      {labels.map((label, index) => {
        const status: AstryxStepperStatus =
          index < current
            ? 'completed'
            : index === current
              ? 'current'
              : 'upcoming';
        const stepNumber = index + 1;
        const name =
          status === 'completed'
            ? t('agentStatus.goToStepWithStatus', {
                ns: 'statusbar',
                stepNumber,
                label,
                status: t('agentStatus.stepCompleted', { ns: 'statusbar' }),
              })
            : t('agentStatus.goToStep', {
                ns: 'statusbar',
                stepNumber,
                label,
              });
        const clickable = Boolean(onStepClick);
        const Tag = clickable ? 'button' : 'span';
        return (
          <li
            key={index}
            className="astryx-stepper__item"
            data-status={status}
            aria-current={status === 'current' ? 'step' : undefined}
          >
            <Tag
              {...(clickable
                ? {
                    type: 'button' as const,
                    onClick: () => onStepClick?.(index),
                    'aria-label': name,
                  }
                : { 'aria-hidden': true })}
              className={cn(
                'astryx-stepper__trigger',
                clickable && 'astryx-stepper__trigger--button'
              )}
            >
              <span className="astryx-stepper__dot" />
              <span className="astryx-stepper__label">{label}</span>
            </Tag>
            {index < labels.length - 1 ? (
              <span className="astryx-stepper__separator" aria-hidden="true" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
