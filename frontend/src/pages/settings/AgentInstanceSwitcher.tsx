import { Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  AstryxSelect,
  type AstryxSelectOption,
} from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  LOCAL_PROVIDER_INSTANCE_ID,
  type ProviderInstanceConfig,
} from '@/lib/providerInstancesApi';

export type AgentInstanceSwitcherProps = {
  agentDisplayName: string;
  instances: ProviderInstanceConfig[];
  selectedInstanceId: string;
  disabled?: boolean;
  mutating?: boolean;
  onSelectInstance: (instanceId: string) => void | Promise<unknown>;
  onCreateInstance: (displayName: string) => Promise<unknown>;
  onRenameInstance: (
    instanceId: string,
    displayName: string
  ) => Promise<unknown>;
  onSetDefaultInstance: (instanceId: string) => Promise<unknown>;
  onDeleteInstance: (instanceId: string) => Promise<unknown>;
};

export function AgentInstanceSwitcher({
  agentDisplayName,
  instances,
  selectedInstanceId,
  disabled = false,
  mutating = false,
  onSelectInstance,
  onCreateInstance,
  onRenameInstance,
  onSetDefaultInstance,
  onDeleteInstance,
}: AgentInstanceSwitcherProps) {
  const { t } = useTranslation(['settings', 'common']);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [renamingInstance, setRenamingInstance] =
    useState<ProviderInstanceConfig | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const localIsDefault = !instances.some((item) => item.isDefault);
  const localLabel = t('settings:providerInstances.localInstance', {
    defaultValue: '本地实例',
  });

  const instanceById = useMemo(
    () => new Map(instances.map((item) => [item.instanceId, item])),
    [instances]
  );

  const selectOptions = useMemo<AstryxSelectOption[]>(
    () => [
      { value: LOCAL_PROVIDER_INSTANCE_ID, label: localLabel },
      ...instances.map((instance) => ({
        value: instance.instanceId,
        label: instance.displayName,
      })),
    ],
    [instances, localLabel]
  );

  const submitCreate = async () => {
    const trimmed = createName.trim();
    if (!trimmed || mutating) return;
    const created = await onCreateInstance(trimmed);
    if (created) {
      setCreateDialogOpen(false);
      setCreateName('');
    }
  };

  const submitRename = async () => {
    if (!renamingInstance || mutating) return;
    const trimmed = renameValue.trim();
    if (!trimmed) return;
    const updated = await onRenameInstance(
      renamingInstance.instanceId,
      trimmed
    );
    if (updated) {
      setRenamingInstance(null);
      setRenameValue('');
    }
  };

  return (
    <div
      className="inline-flex items-center"
      data-testid="agent-instance-switcher"
    >
      <AstryxSelect
        size="compact"
        data-testid="agent-instance-switcher-trigger"
        ariaLabel={t('settings:providerInstances.switcherAria', {
          agent: agentDisplayName,
          defaultValue: '切换 {{agent}} 实例',
        })}
        className="w-auto min-w-[132px] max-w-[220px] shrink-0"
        menuClassName="min-w-[260px]"
        value={selectedInstanceId}
        options={selectOptions}
        disabled={disabled}
        closeMenuOnOptionAction={false}
        onChange={(nextInstanceId) => {
          void onSelectInstance(nextInstanceId);
        }}
        renderPinnedTop={({ closeMenu }) => (
          <button
            type="button"
            data-testid="agent-instance-add-button"
            disabled={disabled || mutating}
            className="flex w-full items-center gap-1.5 rounded-[var(--radius)] px-2.5 py-1.5 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              closeMenu();
              setCreateName('');
              setCreateDialogOpen(true);
            }}
          >
            <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              {t('settings:providerInstances.newShort', {
                defaultValue: '新增实例',
              })}
            </span>
          </button>
        )}
        renderOption={(option) => {
          const instance = instanceById.get(option.value);
          const isDefault = instance ? instance.isDefault : localIsDefault;
          return (
            <span
              className="flex min-w-0 flex-1 items-center gap-1.5"
              data-testid={`agent-instance-option-${option.value}`}
            >
              <span className="truncate font-medium">{option.label}</span>
              {isDefault ? (
                <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  {t('settings:providerInstances.defaultBadge', {
                    defaultValue: '默认',
                  })}
                </span>
              ) : null}
            </span>
          );
        }}
        renderOptionAction={(option, { closeMenu }) => {
          if (option.value === LOCAL_PROVIDER_INSTANCE_ID) {
            if (localIsDefault) return null;
            return (
              <button
                type="button"
                title={t('settings:providerInstances.setDefault', {
                  defaultValue: '设为默认',
                })}
                aria-label={t('settings:providerInstances.setDefault', {
                  defaultValue: '设为默认',
                })}
                data-testid="agent-instance-set-default-local"
                disabled={mutating}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-50"
                onClick={() => {
                  void onSetDefaultInstance(LOCAL_PROVIDER_INSTANCE_ID);
                }}
              >
                <Star className="h-3 w-3" aria-hidden="true" />
              </button>
            );
          }

          const instance = instanceById.get(option.value);
          if (!instance) return null;

          return (
            <div className="flex shrink-0 items-center gap-0.5">
              {!instance.isDefault ? (
                <button
                  type="button"
                  title={t('settings:providerInstances.setDefault', {
                    defaultValue: '设为默认',
                  })}
                  aria-label={t('settings:providerInstances.setDefault', {
                    defaultValue: '设为默认',
                  })}
                  data-testid={`agent-instance-set-default-${instance.instanceId}`}
                  disabled={mutating}
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-50"
                  onClick={() => {
                    void onSetDefaultInstance(instance.instanceId);
                  }}
                >
                  <Star className="h-3 w-3" aria-hidden="true" />
                </button>
              ) : null}
              <button
                type="button"
                title={t('settings:providerInstances.renameAction', {
                  defaultValue: '重命名',
                })}
                aria-label={t('settings:providerInstances.renameAction', {
                  defaultValue: '重命名',
                })}
                data-testid={`agent-instance-rename-${instance.instanceId}`}
                disabled={mutating}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-50"
                onClick={() => {
                  closeMenu();
                  setRenamingInstance(instance);
                  setRenameValue(instance.displayName);
                }}
              >
                <Pencil className="h-3 w-3" aria-hidden="true" />
              </button>
              <button
                type="button"
                title={
                  instance.hasActiveSessions
                    ? t('settings:providerInstances.deleteDisabledActive')
                    : t('settings:providerInstances.delete')
                }
                aria-label={t('settings:providerInstances.delete')}
                data-testid={`agent-instance-delete-${instance.instanceId}`}
                disabled={mutating || instance.hasActiveSessions}
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => {
                  void onDeleteInstance(instance.instanceId);
                }}
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          );
        }}
      />

      <Dialog
        aria-labelledby="create-agent-instance-title"
        className="max-w-sm"
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      >
        <DialogHeader>
          <DialogTitle id="create-agent-instance-title">
            {t('settings:providerInstances.createDialogTitle', {
              agent: agentDisplayName,
              defaultValue: '新增 {{agent}} 实例',
            })}
          </DialogTitle>
          <DialogDescription>
            {t('settings:providerInstances.createDialogDescription', {
              defaultValue:
                '创建独立隔离的纯净配置实例，创建后可单独配置鉴权与供应商。',
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCreate();
          }}
        >
          <Input
            autoFocus
            aria-label={t('settings:providerInstances.displayNameLabel')}
            data-testid="agent-instance-create-name-input"
            disabled={mutating}
            placeholder={t('settings:providerInstances.displayNamePlaceholder')}
            value={createName}
            onChange={(event) => setCreateName(event.target.value)}
          />
          <DialogFooter>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setCreateDialogOpen(false)}
            >
              {t('common:cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              data-testid="agent-instance-create-submit"
              disabled={mutating || !createName.trim()}
            >
              {t('common:confirm')}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      <Dialog
        aria-labelledby="rename-agent-instance-title"
        className="max-w-sm"
        open={renamingInstance !== null}
        onOpenChange={(open) => {
          if (!open) setRenamingInstance(null);
        }}
      >
        <DialogHeader>
          <DialogTitle id="rename-agent-instance-title">
            {t('settings:providerInstances.renameDialogTitle', {
              defaultValue: '重命名实例',
            })}
          </DialogTitle>
        </DialogHeader>
        <form
          className="mt-3 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submitRename();
          }}
        >
          <Input
            autoFocus
            aria-label={t('settings:providerInstances.displayNameLabel')}
            data-testid="agent-instance-rename-input"
            disabled={mutating}
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
          />
          <DialogFooter>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setRenamingInstance(null)}
            >
              {t('common:cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              data-testid="agent-instance-rename-submit"
              disabled={mutating || !renameValue.trim()}
            >
              {t('common:save', { defaultValue: '保存' })}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </div>
  );
}
