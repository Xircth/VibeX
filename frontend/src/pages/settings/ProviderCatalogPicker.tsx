import { Check, ChevronDown, Search } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { getMenuPosition } from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';
import { usePortalContainer } from '@/contexts/PortalContainerContext';
import { NativeSurfaceOcclusionHold } from '@/contexts/WorkspaceOverlayContext';
import { cn } from '@/lib/utils';

import type { ProviderCatalogTemplateView } from './providerCatalogTypes';

export type ProviderCatalogPickerProps = {
  templates: ProviderCatalogTemplateView[];
  generation: number;
  showCustomTile: boolean;
  disabled?: boolean;
  onSelect: (next: ProviderCatalogTemplateView | 'custom') => void;
};

type MenuPosition = ReturnType<typeof getMenuPosition>;

type Selection = { type: 'custom' } | { type: 'template'; key: string } | null;

function catalogKey(template: ProviderCatalogTemplateView): string {
  return `${template.plugin_id}:${template.id}`;
}

function catalogName(template: ProviderCatalogTemplateView): string {
  return template.name?.trim() || template.display_name?.trim() || template.id;
}

function catalogEndpoint(
  template: ProviderCatalogTemplateView
): string | undefined {
  return template.api_url || template.base_url || undefined;
}

function matchesCatalogQuery(
  template: ProviderCatalogTemplateView,
  query: string
): boolean {
  return [
    catalogName(template),
    template.api_url,
    template.base_url,
    template.website_url,
  ].some((value) => value != null && value.toLowerCase().includes(query));
}

function compareCatalogName(
  left: ProviderCatalogTemplateView,
  right: ProviderCatalogTemplateView
): number {
  return catalogName(left).localeCompare(catalogName(right), 'en');
}

export function ProviderCatalogPicker({
  templates,
  generation,
  showCustomTile,
  disabled = false,
  onSelect,
}: ProviderCatalogPickerProps) {
  const { t } = useTranslation('settings');
  const container = usePortalContainer();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const listId = `${menuId}-list`;
  const [query, setQuery] = useState('');
  const [sortByName, setSortByName] = useState(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [selection, setSelection] = useState<Selection>(null);

  useEffect(() => {
    setQuery('');
    setSortByName(false);
    setSelection(null);
    setOpen(false);
  }, [generation]);

  const visibleTemplates = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? templates.filter((template) => matchesCatalogQuery(template, needle))
      : templates;
    if (!sortByName) return filtered;
    return [...filtered].sort(compareCatalogName);
  }, [query, sortByName, templates]);

  const showToolbar = templates.length > 0;
  const showEmpty =
    showToolbar && visibleTemplates.length === 0 && query.trim().length > 0;
  const selectedTemplate =
    selection?.type === 'template'
      ? templates.find((template) => catalogKey(template) === selection.key)
      : undefined;
  const triggerLabel =
    selection?.type === 'custom'
      ? t('agents.providerCatalogCustom')
      : selectedTemplate
        ? catalogName(selectedTemplate)
        : t('agents.providerCatalogSearch');

  const optionCount = (showCustomTile ? 1 : 0) + visibleTemplates.length;
  const customIndex = showCustomTile ? 0 : -1;
  const firstTemplateIndex = showCustomTile ? 1 : 0;

  const closeMenu = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    setPosition(null);
  }, []);

  const openMenu = useCallback(() => {
    setOpen(true);
    setActiveIndex(customIndex >= 0 ? customIndex : firstTemplateIndex);
  }, [customIndex, firstTemplateIndex]);

  const reposition = useCallback(() => {
    if (!triggerRef.current) return;
    setPosition(getMenuPosition(triggerRef.current.getBoundingClientRect()));
  }, []);

  useEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener('scroll', reposition, {
      capture: true,
      passive: true,
    });
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        rootRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      closeMenu();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [closeMenu, open]);

  useEffect(() => {
    if (!open || !position) return;
    if (showToolbar) {
      searchRef.current?.focus();
      return;
    }
    triggerRef.current?.focus();
  }, [open, position, showToolbar]);

  useEffect(() => {
    if (!open) return;
    const active = listRef.current?.querySelector<HTMLElement>(
      '[data-active="true"]'
    );
    active?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, open, visibleTemplates]);

  const selectAt = useCallback(
    (index: number) => {
      if (index < 0) return;
      if (showCustomTile && index === 0) {
        setSelection({ type: 'custom' });
        onSelect('custom');
        closeMenu();
        return;
      }
      const template = visibleTemplates[index - (showCustomTile ? 1 : 0)];
      if (!template) return;
      setSelection({ type: 'template', key: catalogKey(template) });
      onSelect(template);
      closeMenu();
    },
    [closeMenu, onSelect, showCustomTile, visibleTemplates]
  );

  const moveActive = useCallback(
    (delta: number) => {
      if (optionCount === 0) return;
      setActiveIndex((current) => {
        if (current < 0) return delta > 0 ? 0 : optionCount - 1;
        return (current + delta + optionCount) % optionCount;
      });
    },
    [optionCount]
  );

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (open) {
          if (event.key === 'Enter' || event.key === ' ') selectAt(activeIndex);
          else moveActive(event.key === 'ArrowDown' ? 1 : -1);
        } else {
          openMenu();
        }
        break;
      case 'Escape':
        if (open) {
          event.preventDefault();
          closeMenu();
        }
        break;
      default:
        break;
    }
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        break;
      case 'Enter':
        event.preventDefault();
        selectAt(activeIndex);
        break;
      case 'Escape':
        event.preventDefault();
        closeMenu();
        triggerRef.current?.focus();
        break;
      case 'Home':
        event.preventDefault();
        if (optionCount > 0) setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        if (optionCount > 0) setActiveIndex(optionCount - 1);
        break;
      default:
        break;
    }
  };

  if (!showCustomTile && templates.length === 0) return null;

  return (
    <div ref={rootRef} className="agent-model-provider-catalog">
      <div
        ref={triggerRef}
        role="combobox"
        tabIndex={disabled ? -1 : 0}
        aria-label={t('agents.providerCatalogSearch')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-disabled={disabled || undefined}
        className={cn('astryx-select-trigger', open && 'is-open')}
        onClick={() => {
          if (disabled) return;
          if (open) closeMenu();
          else openMenu();
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          handleTriggerKeyDown(event);
        }}
      >
        <span
          className={cn(
            'astryx-select-trigger-label',
            !selection && 'is-placeholder'
          )}
        >
          {triggerLabel}
        </span>
        <ChevronDown aria-hidden="true" className="astryx-select-chevron" />
      </div>
      {open && position
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              className="agent-model-provider-catalog-menu tahoe-popover"
              style={{
                top: position.top,
                left: position.left,
                width: position.width,
                maxHeight: position.maxHeight,
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <NativeSurfaceOcclusionHold />
              {showToolbar ? (
                <div className="agent-model-provider-catalog-search">
                  <div className="agent-model-provider-catalog-search-field">
                    <Search aria-hidden="true" className="h-3.5 w-3.5" />
                    <input
                      ref={searchRef}
                      aria-label={t('agents.providerCatalogSearch')}
                      autoComplete="off"
                      disabled={disabled}
                      placeholder={t('agents.providerCatalogSearch')}
                      type="search"
                      value={query}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        setActiveIndex(0);
                      }}
                      onKeyDown={handleSearchKeyDown}
                    />
                  </div>
                  <Button
                    aria-pressed={sortByName}
                    className="agent-model-provider-catalog-sort h-8"
                    disabled={disabled}
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => setSortByName((current) => !current)}
                  >
                    {t('agents.providerCatalogSortName')}
                  </Button>
                </div>
              ) : null}
              <div
                ref={listRef}
                id={listId}
                role="listbox"
                aria-label={t('agents.providerCatalogSearch')}
                className="agent-model-provider-catalog-list"
              >
                {showCustomTile ? (
                  <CatalogOption
                    active={activeIndex === 0}
                    disabled={disabled}
                    label={t('agents.providerCatalogCustom')}
                    selected={selection?.type === 'custom'}
                    onHover={() => setActiveIndex(0)}
                    onSelect={() => selectAt(0)}
                  />
                ) : null}
                {visibleTemplates.map((template, index) => {
                  const optionIndex = firstTemplateIndex + index;
                  const name = catalogName(template);
                  const endpoint = catalogEndpoint(template);
                  const source = template.plugin_label
                    ? `${t('agents.providerCatalogSourcePlugin')} · ${template.plugin_label}`
                    : t('agents.providerCatalogSourcePlugin');
                  return (
                    <CatalogOption
                      key={catalogKey(template)}
                      active={activeIndex === optionIndex}
                      disabled={disabled}
                      endpoint={endpoint}
                      label={name}
                      selected={
                        selection?.type === 'template' &&
                        selection.key === catalogKey(template)
                      }
                      source={source}
                      websiteUrl={template.website_url}
                      apiKeyUrl={template.api_key_url}
                      onHover={() => setActiveIndex(optionIndex)}
                      onSelect={() => selectAt(optionIndex)}
                    />
                  );
                })}
                {showEmpty ? (
                  <p
                    aria-live="polite"
                    className="agent-model-provider-catalog-empty"
                  >
                    {t('agents.providerCatalogEmpty')}
                  </p>
                ) : null}
              </div>
            </div>,
            container ?? document.body
          )
        : null}
    </div>
  );
}

function CatalogOption({
  label,
  endpoint,
  source,
  websiteUrl,
  apiKeyUrl,
  selected,
  active,
  disabled,
  onSelect,
  onHover,
}: {
  label: string;
  endpoint?: string;
  source?: string;
  websiteUrl?: string | null;
  apiKeyUrl?: string | null;
  selected: boolean;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <div
      role="option"
      aria-label={label}
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      data-active={active ? 'true' : undefined}
      className="agent-model-provider-catalog-option"
      onClick={() => {
        if (!disabled) onSelect();
      }}
      onMouseEnter={() => {
        if (!disabled) onHover();
      }}
    >
      <div className="agent-model-provider-catalog-option-main">
        <strong>{label}</strong>
        {endpoint ? (
          <span className="agent-model-provider-catalog-endpoint">
            {endpoint}
          </span>
        ) : null}
        {source ? (
          <span className="agent-model-provider-catalog-source">{source}</span>
        ) : null}
        {websiteUrl || apiKeyUrl ? (
          <div className="agent-model-provider-catalog-links">
            {websiteUrl ? (
              <a
                href={websiteUrl}
                rel="noopener noreferrer"
                target="_blank"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                {t('agents.providerCatalogWebsite')}
              </a>
            ) : null}
            {apiKeyUrl ? (
              <a
                href={apiKeyUrl}
                rel="noopener noreferrer"
                target="_blank"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                {t('agents.providerCatalogGetKey')}
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
      {selected ? (
        <Check aria-hidden="true" className="astryx-select-option-check" />
      ) : null}
    </div>
  );
}
