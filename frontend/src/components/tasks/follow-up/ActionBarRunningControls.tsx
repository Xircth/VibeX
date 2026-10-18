import { ComposerPrimaryActionButton } from './ComposerPrimaryActionButton';

type ActionBarRunningControlsProps = {
  isStopping: boolean;
  onStopExecution: () => void;
};

export function ActionBarRunningControls({
  isStopping,
  onStopExecution,
}: ActionBarRunningControlsProps) {
  return (
    <div className="flex items-center gap-1">
      <ComposerPrimaryActionButton
        action="stop"
        label={'\u505c\u6b62'}
        onClick={onStopExecution}
        disabled={isStopping}
        pending={isStopping}
      />
    </div>
  );
}
