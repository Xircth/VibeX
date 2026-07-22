import { useState } from 'react';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { ChevronRight, FileCode2, RotateCcw, Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ConversationFileChange } from 'shared/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { defineModal } from '@/lib/modals';
import { cn } from '@/lib/utils';

export type ResendCheckpointResult = 'restore' | 'resend' | 'dismissed';

export interface ResendCheckpointDialogProps {
  title: string;
  files: ConversationFileChange[];
  previewUnavailable?: boolean;
}

const ResendCheckpointDialogImpl =
  NiceModal.create<ResendCheckpointDialogProps>((props) => {
    const modal = useModal();
    const { t } = useTranslation(['panels', 'common']);
    const [filesExpanded, setFilesExpanded] = useState(false);

    const resolve = (result: ResendCheckpointResult) => {
      modal.resolve(result);
      modal.hide();
    };

    return (
      <Dialog
        open={modal.visible}
        onOpenChange={(open) => {
          if (!open) resolve('dismissed');
        }}
        className="!max-w-[520px] overflow-x-hidden p-0 sm:!max-w-[520px]"
      >
        <DialogContent className="gap-0">
          <div className="resend-checkpoint-surface">
            <DialogHeader className="pr-8">
              <DialogTitle>{props.title}</DialogTitle>
            </DialogHeader>

            <div className="mt-4 space-y-2">
              <div className="resend-checkpoint-option">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-foreground">
                    {t('timeline.restoreAndResend')}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t('timeline.restoreAndResendDescription')}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0 gap-1.5"
                  onClick={() => resolve('restore')}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t('timeline.restoreAndResend')}
                </Button>
              </div>

              <div className="resend-checkpoint-option">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-foreground">
                    {t('timeline.resendOnly')}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t('timeline.resendOnlyDescription')}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 gap-1.5"
                  onClick={() => resolve('resend')}
                >
                  <Send className="h-3.5 w-3.5" />
                  {t('timeline.resendOnly')}
                </Button>
              </div>
            </div>

            <div className="mt-3 overflow-hidden rounded-[10px] bg-background/55">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted/50"
                onClick={() => setFilesExpanded((expanded) => !expanded)}
                aria-expanded={filesExpanded}
              >
                <ChevronRight
                  className={cn(
                    'h-3.5 w-3.5 text-muted-foreground transition-transform duration-150',
                    filesExpanded && 'rotate-90'
                  )}
                />
                <FileCode2 className="h-3.5 w-3.5 text-muted-foreground" />
                <span>
                  {props.previewUnavailable
                    ? t('timeline.rollbackFilesUnavailable')
                    : t('timeline.rollbackFiles', {
                        count: props.files.length,
                      })}
                </span>
              </button>
              {filesExpanded ? (
                <div className="max-h-52 overflow-y-auto px-2 pb-2">
                  {props.files.length > 0 ? (
                    props.files.map((file) => (
                      <div
                        key={`${file.change_kind}:${file.path}`}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 font-mono text-[11px] text-foreground"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {file.old_path
                            ? `${file.old_path} → ${file.path}`
                            : file.path}
                        </span>
                        {file.additions != null ? (
                          <span className="text-[hsl(var(--success))]">
                            +{Number(file.additions)}
                          </span>
                        ) : null}
                        {file.deletions != null ? (
                          <span className="text-destructive">
                            -{Number(file.deletions)}
                          </span>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <div className="px-2 py-2 text-xs text-muted-foreground">
                      {t('timeline.noRollbackFiles')}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  });

export const ResendCheckpointDialog = defineModal<
  ResendCheckpointDialogProps,
  ResendCheckpointResult
>(ResendCheckpointDialogImpl);
