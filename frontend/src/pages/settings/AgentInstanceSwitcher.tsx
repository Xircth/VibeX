import { Check, ChevronDown, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { PRODUCT_MENU_CONTENT_CLASS } from '@/components/ui/product-menu-classes';
import {
  LOCAL_PROVIDER_INSTANCE_ID,
  type ProviderInstanceConfig,
} from '@/lib/providerInstancesApi';
import { cn } from '@/lib/utils';

export type AgentInstanceSwitcherProps = {
  agentDisplayName: string;
  instances: ProviderInstanceConfig[];
  selectedInstanceId: string;
  disabled?: boolean;
  mutating?: boolean;
  onSelectInstance: (instanceId: string) => void | Promise<unknown>;
  onCreateInstance: (displayName: string) => Promise<unknown>;
  onRenameInstance: (instanceId: string, displayName: string) => Promise<unknown>;
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [renamingInstance, setRenamingInstance] =
    useState<ProviderInstanceConfig | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        containerRef.current &&
        !containerRef.current.contains(target)
      ) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  const localIsDefault = !instances.some((item) => item.isDefault);
  const selectedCustom = instances.find(
    (item) => item.instanceId === selectedInstanceId
  );
  const localLabel = t('settings:providerInstances.localInstance', {
    defaultValue: '本地实例',
  });
  const activeLabel = selectedCustom ? selectedCustom.displayName : localLabel;

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
    const updated = await onRenameInstance(renamingInstance.instanceId, trimmed);
    if (updated) {
      setRenamingInstance(null);
      setRenameValue('');
    }
  };

  return (
    <div
      ref={containerRef}
      className="relative inline-flex items-center gap-1.5"
      data-testid="agent-instance-switcher"
    >
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 gap-1.5 px-2.5 text-xs font-medium"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        aria-label={t('settings:providerInstances.switcherAria', {
          agent: agentDisplayName,
          defaultValue: '切换 {{agent}} 实例',
        })}
        data-testid="agent-instance-switcher-trigger"
        disabled={disabled}
        onClick={() => setMenuOpen((current) => !current)}
      >
        <span className="max-w-[140px] truncate">{activeLabel}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      </Button>

      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
        data-testid="agent-instance-add-button"
        disabled={disabled || mutating}
        onClick={() => {
          setMenuOpen(false);
          setCreateName('');
          setCreateDialogOpen(true);
        }}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        <span>
          {t('settings:providerInstances.newShort', {
            defaultValue: '新增实例',
          })}
        </span>
      </Button>

      {menuOpen ? (
        <div
          role="menu"
          data-floating-layer="popover"
          data-testid="agent-instance-switcher-menu"
          className={cn(
            PRODUCT_MENU_CONTENT_CLASS,
            'tahoe-popover absolute left-0 top-full z-50 mt-1.5 w-72 p-1.5 shadow-md'
          )}
        >
          <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
            {t('settings:providerInstances.switcherMenuTitle', {
              defaultValue: 'Agent 实例',
            })}
          </div>

          <div className="space-y-0.5">
            <div
              className={cn(
                'flex items-center justify-between gap-1 rounded-md px-2 py-1.5 text-xs transition-colors',
                selectedInstanceId === LOCAL_PROVIDER_INSTANCE_ID
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/60'
              )}
            >
              <button
                type="button"
                role="menuitemradio"
                aria-checked={selectedInstanceId === LOCAL_PROVIDER_INSTANCE_ID}
                data-testid="agent-instance-option-local"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={() => {
                  setMenuOpen(false);
                  void onSelectInstance(LOCAL_PROVIDER_INSTANCE_ID);
                }}
              >
                <Check
                  className={cn(
                    'h-3.5 w-3.5 shrink-0',
                    selectedInstanceId === LOCAL_PROVIDER_INSTANCE_ID
                      ? 'opacity-100'
                      : 'opacity-0'
                  )}
                  aria-hidden="true"
                />
                <span className="truncate font-medium">{localLabel}</span>
                {localIsDefault ? (
                  <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    {t('settings:providerInstances.defaultBadge', {
                      defaultValue: '默认',
                    })}
                  </span>
                ) : null}
              </button>
              {!localIsDefault ? (
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
                  onClick={(event) => {
                    event.stopPropagation();
                    void onSetDefaultInstance(LOCAL_PROVIDER_INSTANCE_ID);
                  }}
                >
                  <Star className="h-3 w-3" aria-hidden="true" />
                </button>
              ) : null}
            </div>

            {instances.map((instance) => {
              const isSelected = selectedInstanceId === instance.instanceId;
              return (
                <div
                  key={instance.instanceId}
                  className={cn(
                    'flex items-center justify-between gap-1 rounded-md px-2 py-1.5 text-xs transition-colors',
                    isSelected
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/60'
                  )}
                >
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={isSelected}
                    data-testid={`agent-instance-option-${instance.instanceId}`}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    onClick={() => {
                      setMenuOpen(false);
                      void onSelectInstance(instance.instanceId);
                    }}
                  >
                    <Check
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        isSelected ? 'opacity-100' : 'opacity-0'
                      )}
                      aria-hidden="true"
                    />
                    <span className="truncate font-medium">
                      {instance.displayName}
                    </span>
                    {instance.isDefault ? (
                      <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        {t('settings:providerInstances.defaultBadge', {
                          defaultValue: '默认',
                        })}
                      </span>
                    ) : null}
                  </button>

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
                        onClick={(event) => {
                          event.stopPropagation();
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
                      onClick={(event) => {
                        event.stopPropagation();
                        setMenuOpen(false);
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
                      onClick={(event) => {
                        event.stopPropagation();
                        void onDeleteInstance(instance.instanceId);
                      }}
                    >
                      <Trash2 className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

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
