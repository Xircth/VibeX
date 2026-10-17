import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import { AstryxStep, AstryxStepItem } from './AstryxStep';
import { BasicGuideSpotlight } from './BasicGuideSpotlight';
import { useOptionalBasicGuide } from './BasicGuideContext';
import { GuideCopy } from './GuideCopy';
import { cn } from '@/lib/utils';

import {
  SUBSTEP_META,
  isGuideVisible,
  isProjectRoute,
  isSettingsRoute,
  mainStepIndex,
  substepSpotlights,
} from './basicGuideState';
import './basicGuide.css';

export function BasicGuideOverlay() {
  const ctx = useOptionalBasicGuide();
  const { t } = useTranslation(['basicGuide', 'common']);
  const location = useLocation();
  if (!ctx || !isGuideVisible(ctx.state)) return null;

  const { state, exitOpen } = ctx;
  const showingEnd = state.endCopy !== 'none';
  const meta = SUBSTEP_META[state.substep];
  const current = showingEnd ? 3 : mainStepIndex(state.substep);
  const showCoaching = !showingEnd && state.substep !== 'show-end';
  const spotlightTargets = showCoaching ? substepSpotlights(state.substep) : [];

  return (
    <>
      {showCoaching ? (
        <BasicGuideSpotlight
          targets={spotlightTargets}
          resolveCopy={(key) => t(`copy.${key}`)}
          panelSelector="[data-basic-guide-panel]"
        />
      ) : null}

      <aside
        className={cn(
          'basic-guide-panel',
          isSettingsRoute(location.pathname) && 'basic-guide-panel--settings',
          isProjectRoute(location.pathname) && 'basic-guide-panel--workspace'
        )}
        data-basic-guide-panel
        aria-label={t('panelAria')}
      >
        <div className="basic-guide-panel__stack">
          {showingEnd ? (
            <button
              type="button"
              className="basic-guide-end"
              onClick={ctx.dismissEnd}
            >
              {t('endCopy')}
            </button>
          ) : (
            <>
              <AstryxStep current={current} aria-label={t('stepsAria')}>
                <AstryxStepItem>{t('steps.createProject')}</AstryxStepItem>
                <AstryxStepItem>{t('steps.createSession')}</AstryxStepItem>
                <AstryxStepItem>{t('steps.learnLayout')}</AstryxStepItem>
              </AstryxStep>
              <div className="basic-guide-panel__actions">
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
                {meta.continueVisible ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={ctx.continueStep}
                  >
                    {t('continue')}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-1.5 text-muted-foreground"
                  onClick={ctx.requestExit}
                >
                  {t('exit')}
                </Button>
              </div>
            </>
          )}
        </div>
      </aside>

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
