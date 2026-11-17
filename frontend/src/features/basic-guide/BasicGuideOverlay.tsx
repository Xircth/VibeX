import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import { BasicGuideSpotlight } from './BasicGuideSpotlight';
import { useOptionalBasicGuide } from './BasicGuideContext';
import { GuideCopy } from './GuideCopy';
import { cn } from '@/lib/utils';

import { useLayoutStore } from '@/stores/useLayoutStore';

import {
  SUBSTEP_META,
  isGuideVisible,
  isKanbanGuideSurface,
  isSettingsRoute,
  substepSpotlights,
} from './basicGuideState';
import './basicGuide.css';

export function BasicGuideExitButton() {
  const ctx = useOptionalBasicGuide();
  const { t } = useTranslation(['basicGuide']);
  const location = useLocation();

  if (
    !ctx ||
    !isGuideVisible(ctx.state) ||
    ctx.state.endCopy !== 'none' ||
    isSettingsRoute(location.pathname)
  ) {
    return null;
  }

  return (
    <Button
      type="button"
      size="xs"
      variant="primary"
      data-testid="basic-guide-exit-button"
      className="shrink-0"
      onClick={ctx.requestExit}
    >
      {t('exit')}
    </Button>
  );
}

export function BasicGuideOverlay() {
  const ctx = useOptionalBasicGuide();
  const { t } = useTranslation(['basicGuide', 'common']);
  const location = useLocation();
  const activeTab = useLayoutStore((state) => state.activeTab);
  if (!ctx || !isGuideVisible(ctx.state)) return null;

  const { state, exitOpen } = ctx;
  const showingEnd = state.endCopy !== 'none';
  const meta = SUBSTEP_META[state.substep];
  const showCoaching = !showingEnd && state.substep !== 'show-end';
  const spotlightTargets = showCoaching ? substepSpotlights(state.substep) : [];
  const hasFooterAction =
    state.substep === 'show-end' ||
    (meta.continueVisible && meta.targets.length === 0);
  const showStepPanel =
    !isSettingsRoute(location.pathname) && (showingEnd || hasFooterAction);
  const onKanban = isKanbanGuideSurface(location.pathname, activeTab);

  return (
    <>
      {showCoaching ? (
        <BasicGuideSpotlight
          targets={spotlightTargets}
          resolveCopy={(key) => t(`copy.${key}`)}
          panelSelector="[data-basic-guide-panel]"
          continueCopyKey={
            meta.continueVisible && meta.targets.length > 0
              ? state.substep
              : undefined
          }
          continueLabel={t('continue')}
          onContinue={ctx.continueStep}
        />
      ) : null}

      {showStepPanel ? (
        <aside
          className={cn(
            'basic-guide-panel',
            'basic-guide-panel--bottom',
            onKanban && 'basic-guide-panel--kanban'
          )}
          data-basic-guide-panel
          aria-label={t('panelAria')}
        >
          <div
            className={cn(
              'basic-guide-panel__stack',
              !showingEnd && 'basic-guide-panel__stack--framed'
            )}
          >
            {showingEnd ? (
              <div
                className="basic-guide-callout basic-guide-end"
                data-basic-guide-callout="end"
              >
                <button
                  type="button"
                  className="basic-guide-end__close"
                  aria-label={t('common:close')}
                  onClick={ctx.dismissEnd}
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2.25} />
                </button>
                <GuideCopy
                  className="basic-guide-callout__copy"
                  text={t('endCopy')}
                />
              </div>
            ) : (
              <div className="basic-guide-panel__footer">
                {state.substep === 'show-end' ? (
                  <Button
                    type="button"
                    size="sm"
                    data-basic-guide="guide-finish"
                    onClick={ctx.finish}
                  >
                    {t('finish')}
                  </Button>
                ) : null}
                {meta.continueVisible && meta.targets.length === 0 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={ctx.continueStep}
                  >
                    {t('continue')}
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        </aside>
      ) : null}

      <Dialog
        open={exitOpen}
        onOpenChange={(open) => {
          if (!open) ctx.cancelExit();
        }}
      >
        <DialogContent className="!max-w-[360px]">
          <DialogHeader>
            <DialogTitle>{t('exitTitle')}</DialogTitle>
          </DialogHeader>
          <GuideCopy
            className="basic-guide-panel__copy"
            text={t('exitMessage')}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={ctx.cancelExit}>
              {t('common:cancel')}
            </Button>
            <Button type="button" onClick={ctx.confirmExit}>
              {t('exitConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
