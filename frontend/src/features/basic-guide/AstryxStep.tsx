import { Children, isValidElement, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

export type AstryxStepStatus =
  | 'completed'
  | 'current'
  | 'upcoming'
  | 'warning'
  | 'error';

export type AstryxStepItemProps = {
  children: ReactNode;
  status?: AstryxStepStatus;
  description?: ReactNode;
};

export function AstryxStepItem(_props: AstryxStepItemProps) {
  return null;
}

type StepChild = {
  label: ReactNode;
  description?: ReactNode;
  status?: AstryxStepStatus;
};

function collectItems(children: ReactNode): StepChild[] {
  const items: StepChild[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<AstryxStepItemProps>(child)) return;
    items.push({
      label: child.props.children,
      description: child.props.description,
      status: child.props.status,
    });
  });
  return items;
}

export function AstryxStep({
  current = 0,
  orientation = 'vertical',
  'aria-label': ariaLabel,
  children,
}: {
  current?: number;
  orientation?: 'vertical' | 'horizontal';
  'aria-label'?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation('basicGuide');
  const items = collectItems(children);

  return (
    <ol
      aria-label={ariaLabel ?? t('stepsAria')}
      className={cn(
        'astryx-step',
        orientation === 'horizontal'
          ? 'astryx-step--horizontal'
          : 'astryx-step--vertical'
      )}
    >
      {items.map((item, index) => {
        const status: AstryxStepStatus =
          item.status ??
          (index < current
            ? 'completed'
            : index === current
              ? 'current'
              : 'upcoming');
        const number = index + 1;
        return (
          <li
            key={index}
            className="astryx-step__item"
            data-status={status}
            aria-current={status === 'current' ? 'step' : undefined}
          >
            <span className="astryx-step__indicator" aria-hidden="true">
              {status === 'completed' ? (
                <Check className="h-3 w-3" strokeWidth={2.5} />
              ) : (
                number
              )}
            </span>
            <span className="astryx-step__body">
              <span className="astryx-step__label">{item.label}</span>
              {item.description ? (
                <span className="astryx-step__description">
                  {item.description}
                </span>
              ) : null}
            </span>
            {index < items.length - 1 ? (
              <span className="astryx-step__separator" aria-hidden="true" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
