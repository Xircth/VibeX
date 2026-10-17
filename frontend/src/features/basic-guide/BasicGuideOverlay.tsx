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
  const showStepPanel = !isSettingsRoute(location.pathname);

  return (
    <>
      {showCoaching ? (
        <BasicGuideSpotlight
          targets={spotlightTargets}
          resolveCopy={(key) => t(`copy.${key}`)}
          panelSelector="[data-basic-guide-panel]"
        />
      ) : null}

      {showStepPanel ? (
        <aside
          className={cn(
            'basic-guide-panel',
            'basic-guide-panel--bottom',
            isProjectRoute(location.pathname) && 'basic-guide-panel--workspace'
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
              <>
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
                    variant="outline"
                    onClick={ctx.requestExit}
                  >
                    {t('exit')}
                  </Button>
                </div>
                <AstryxStep current={current} aria-label={t('stepsAria')}>
                  <AstryxStepItem
                    description={t('steps.createProjectDescription')}
                  >
                    {t('steps.createProject')}
                  </AstryxStepItem>
                  <AstryxStepItem
                    description={t('steps.createSessionDescription')}
                  >
                    {t('steps.createSession')}
                  </AstryxStepItem>
                  <AstryxStepItem
                    description={t('steps.learnLayoutDescription')}
                  >
                    {t('steps.learnLayout')}
                  </AstryxStepItem>
                </AstryxStep>
              </>
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
