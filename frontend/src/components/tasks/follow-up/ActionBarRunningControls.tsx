import { useTranslation } from 'react-i18next';
import { ComposerPrimaryActionButton } from './ComposerPrimaryActionButton';

type ActionBarRunningControlsProps = {
  isStopping: boolean;
  onStopExecution: () => void;
};

export function ActionBarRunningControls({
  isStopping,
  onStopExecution,
}: ActionBarRunningControlsProps) {
  const { t } = useTranslation('tasks');
  return (
    <div className="flex items-center gap-1">
      <ComposerPrimaryActionButton
        action="stop"
        label={t('composer.stop', '停止')}
        onClick={onStopExecution}
        disabled={isStopping}
        pending={isStopping}
      />
    </div>
  );
}
