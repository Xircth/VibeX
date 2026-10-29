import { useTranslation } from 'react-i18next';
import type {
  AgentModelProviderImportCandidateView,
  AgentModelProviderImportPreviewView,
} from 'shared/types';

import { Button } from '@/components/ui/button';

export function ImportPreview({
  preview,
  selected,
  saving,
  onToggle,
  onCancel,
  onApply,
}: {
  // Plugin-contributed sources produce the same candidate list without going
  // through the built-in import command, so this only needs the parts it renders.
  preview: Pick<AgentModelProviderImportPreviewView, 'candidates' | 'error'>;
  selected: string[];
  saving: boolean;
  onToggle: (sourceId: string, checked: boolean) => void;
  onCancel: () => void;
  onApply: () => void;
}) {
  const { t } = useTranslation('settings');
  const selectable = preview.candidates.filter(
    (candidate) => !candidate.skip_reason
  );
  return (
    <div className="agent-model-provider-import-preview">
      {preview.candidates.length === 0 ? (
        <p>{preview.error ?? t('agents.providerImportEmpty')}</p>
      ) : (
        <ul>
          {preview.candidates.map((candidate) => (
            <ImportCandidateRow
              key={candidate.source_id}
              candidate={candidate}
              checked={selected.includes(candidate.source_id)}
              disabled={saving}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
      <div className="agent-model-provider-import-actions">
        <Button size="sm" variant="outline" className="h-8" onClick={onCancel}>
          {t('agents.providerImportCancel')}
        </Button>
        <Button
          size="sm"
          className="h-8"
          disabled={saving || selectable.length === 0 || selected.length === 0}
          onClick={onApply}
        >
          {t('agents.providerImportApply')}
        </Button>
      </div>
    </div>
  );
}

function ImportCandidateRow({
  candidate,
  checked,
  disabled,
  onToggle,
}: {
  candidate: AgentModelProviderImportCandidateView;
  checked: boolean;
  disabled: boolean;
  onToggle: (sourceId: string, checked: boolean) => void;
}) {
  const blocked = Boolean(candidate.skip_reason);
  return (
    <li>
      <label>
        <input
          type="checkbox"
          checked={checked && !blocked}
          disabled={disabled || blocked}
          onChange={(event) =>
            onToggle(candidate.source_id, event.target.checked)
          }
        />
        <span>
          <strong>{candidate.name}</strong>
          <small>{candidate.api_url}</small>
          {candidate.skip_reason ? <em>{candidate.skip_reason}</em> : null}
        </span>
      </label>
    </li>
  );
}
