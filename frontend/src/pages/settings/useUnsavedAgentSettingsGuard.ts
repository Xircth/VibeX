import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { AgentId } from 'shared/types';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';

export function useUnsavedAgentSettingsGuard(
  selectedAgentId: AgentId | null,
  t: TFunction<['settings', 'common']>
) {
  const [configDirty, setConfigDirty] = useState(false);
  const dirtySourcesRef = useRef<Set<string>>(new Set());
  const configDirtyRef = useRef(false);

  const setDirtySource = useCallback((source: string, dirty: boolean) => {
    const sources = dirtySourcesRef.current;
    if (sources.has(source) === dirty) return;
    if (dirty) {
      sources.add(source);
    } else {
      sources.delete(source);
    }
    const nextConfigDirty = sources.size > 0;
    if (configDirtyRef.current !== nextConfigDirty) {
      configDirtyRef.current = nextConfigDirty;
      setConfigDirty(nextConfigDirty);
    }
  }, []);

  useEffect(() => {
    dirtySourcesRef.current.clear();
    configDirtyRef.current = false;
    setConfigDirty(false);
  }, [selectedAgentId]);

  const confirmDiscardConfig = useCallback(async () => {
    if (!configDirtyRef.current) return true;
    const result = await ConfirmDialog.show({
      title: t('settings:agents.unsavedConfigTitle'),
      message: t('settings:agents.unsavedConfigMessage'),
      confirmText: t('settings:agents.discardConfig'),
      cancelText: t('common:cancel'),
      variant: 'destructive',
    });
    if (result !== 'confirmed') return false;
    dirtySourcesRef.current.clear();
    configDirtyRef.current = false;
    setConfigDirty(false);
    return true;
  }, [t]);

  useEffect(() => {
    if (!configDirty) return;
    const currentHref = window.location.href;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    const handleSidebarClick = (event: MouseEvent) => {
      if (!configDirtyRef.current) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const navTarget = target.closest<HTMLElement>(
        '.settings-sidebar a[href], .settings-sidebar .settings-nav-button, .settings-sidebar .settings-search-result'
      );
      if (!navTarget) return;
      if (
        navTarget.getAttribute('aria-current') === 'page' ||
        navTarget.classList.contains('is-active')
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        if (!(await confirmDiscardConfig())) return;
        const fallbackAnchorNav = (e: MouseEvent) => {
          if (navTarget instanceof HTMLAnchorElement && !e.defaultPrevented) {
            e.preventDefault();
            const href = navTarget.getAttribute('href');
            if (href) window.history.pushState(null, '', href);
          }
        };
        window.addEventListener('click', fallbackAnchorNav, { once: true });
        navTarget.click();
        window.removeEventListener('click', fallbackAnchorNav);
      })();
    };
    const handlePopState = () => {
      if (!configDirtyRef.current) return;
      const nextHref = window.location.href;
      window.history.pushState(null, '', currentHref);
      void (async () => {
        if (await confirmDiscardConfig()) {
          window.history.replaceState(null, '', nextHref);
        }
      })();
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', handleSidebarClick, true);
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('click', handleSidebarClick, true);
      window.removeEventListener('popstate', handlePopState);
    };
  }, [configDirty, confirmDiscardConfig]);

  return { setDirtySource, confirmDiscardConfig };
}
