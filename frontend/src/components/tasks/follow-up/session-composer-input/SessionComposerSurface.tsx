import type {
  ClipboardEvent,
  DragEvent,
  FocusEvent,
  KeyboardEvent,
  MutableRefObject,
  PointerEvent,
  RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import {
  ChatComposerInput,
  type ChatComposerInputHandle,
  type ChatComposerTrigger,
} from '@astryxdesign/core/Chat';
import { cn } from '@/lib/utils';
import { prepareImageFileForUpload } from '@/utils/clipboard';
import { isAttachableFile } from '@/utils/mediaAttachments';
import { QuoteTokenPreview } from '../QuoteTokenPreview';
import {
  astryxHandlesComposerSubmit,
  composerEnterAction,
  isComposerImeCommitEnter,
} from '../sessionComposerSubmitHotkey';
import { ComposerAtReferencePanel } from '../ComposerAtReferenceMenu';
import type { SendMessageShortcut } from 'shared/types';
import type { SessionComposerStructuredToken } from '../sessionComposerStructuredTokens';
import { getSessionComposerEditable } from './sessionComposerDom';
import { PreviewElementTokenTooltip } from './PreviewElementTokenTooltip';
import type { useComposerAtReferencePanel } from '../useComposerAtReferencePanel';

export function SessionComposerSurface({
  dropZoneRef,
  handleDragOver,
  handleDragLeave,
  handleDrop,
  dropActive,
  disabled,
  tryAcceptPromptSuggestionOnTab,
  handleTokenPointerOver,
  handleTokenPointerOut,
  handleTokenFocus,
  handleTokenBlur,
  composerRootRef,
  value,
  promptSuggestion,
  onDismissPromptSuggestion,
  onChange,
  atReference,
  className,
  effectivePlaceholder,
  triggers,
  composerHandleRef,
  lastCompositionEndAtRef,
  sendShortcut,
  handleHistoryKeyDown,
  handleSubmit,
  isMaterializingSubmitRef: _isMaterializingSubmitRef,
  onAttachImages,
  handleComposerPaste,
  activeHoverToken,
  elementTokenTooltipId,
  quoteTokenTooltipId,
  cancelHoverHide,
  hideTokenHover,
}: {
  dropZoneRef: RefObject<HTMLDivElement | null>;
  handleDragOver: (event: DragEvent<HTMLDivElement>) => void;
  handleDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  handleDrop: (event: DragEvent<HTMLDivElement>) => void;
  dropActive: boolean;
  disabled: boolean;
  tryAcceptPromptSuggestionOnTab: (
    event: KeyboardEvent<HTMLElement>
  ) => boolean;
  handleTokenPointerOver: (event: PointerEvent<HTMLDivElement>) => void;
  handleTokenPointerOut: (event: PointerEvent<HTMLDivElement>) => void;
  handleTokenFocus: (event: FocusEvent<HTMLDivElement>) => void;
  handleTokenBlur: (event: FocusEvent<HTMLDivElement>) => void;
  composerRootRef: RefObject<HTMLDivElement | null>;
  value: string;
  promptSuggestion: string | null | undefined;
  onDismissPromptSuggestion?: () => void;
  onChange: (value: string) => void;
  atReference: ReturnType<typeof useComposerAtReferencePanel>;
  className?: string;
  effectivePlaceholder: string;
  triggers: ChatComposerTrigger[];
  composerHandleRef: RefObject<ChatComposerInputHandle | null>;
  lastCompositionEndAtRef: MutableRefObject<number>;
  sendShortcut: SendMessageShortcut;
  handleHistoryKeyDown: (event: KeyboardEvent<HTMLDivElement>) => boolean;
  handleSubmit: (text: string) => void;
  isMaterializingSubmitRef: MutableRefObject<boolean>;
  onAttachImages: (files: File[]) => void;
  handleComposerPaste: (
    event: ClipboardEvent<HTMLDivElement>,
    text?: string
  ) => boolean;
  activeHoverToken: {
    anchor: HTMLElement;
    token: SessionComposerStructuredToken;
  } | null;
  elementTokenTooltipId: string;
  quoteTokenTooltipId: string;
  cancelHoverHide: () => void;
  hideTokenHover: (anchor: HTMLElement, delayMs?: number) => void;
}) {
  const { t } = useTranslation('tasks');
  return (
    <div
      ref={dropZoneRef}
      className="session-composer-file-drop-zone min-w-0"
      data-file-reference-drop-zone
      data-testid="session-composer-file-drop-zone"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dropActive ? (
        <div
          className="session-composer-drop-overlay"
          role="status"
          aria-label={t('composer.dropFiles')}
        >
          <FolderOpen aria-hidden="true" />
          <strong>{t('composer.dropFiles')}</strong>
        </div>
      ) : null}
      <div
        className={cn(
          'min-h-[40px] rounded-lg bg-background/35 px-1.5 pb-1 pt-0 transition-colors focus-within:bg-background/50',
          disabled && 'opacity-60'
        )}
        data-testid="session-composer-input-surface"
        onKeyDown={(event) => {
          tryAcceptPromptSuggestionOnTab(event);
        }}
        onPointerOver={handleTokenPointerOver}
        onPointerOut={handleTokenPointerOut}
        onFocusCapture={handleTokenFocus}
        onBlurCapture={handleTokenBlur}
      >
        <ChatComposerInput
          ref={composerRootRef}
          value={value}
          onChange={(next) => {
            if (next && promptSuggestion) {
              onDismissPromptSuggestion?.();
            }
            onChange(next);
            queueMicrotask(() => atReference.detect());
          }}
          isDisabled={disabled}
          className={cn(
            'session-composer-editor min-h-[32px] w-full px-0.5 pb-1 pt-0 font-sans subpixel-antialiased text-[13px] leading-5 tracking-[0.005em]',
            className
          )}
          maxRows={7}
          placeholder={effectivePlaceholder}
          label={t('composer.inputLabel')}
          hasHistory={false}
          pasteAsToken={false}
          triggers={triggers}
          handleRef={composerHandleRef}
          onKeyDown={(event) => {
            if (
              isComposerImeCommitEnter(event, lastCompositionEndAtRef.current)
            ) {
              return;
            }
            if (atReference.handleKeyDown(event)) {
              return;
            }
            if (tryAcceptPromptSuggestionOnTab(event)) {
              return;
            }
            if (event.key === 'Backspace' || event.key === 'Delete') {
              const selection = window.getSelection();
              const editor = getSessionComposerEditable(
                composerRootRef.current
              );
              if (
                editor &&
                selection &&
                selection.isCollapsed &&
                selection.rangeCount > 0
              ) {
                const range = selection.getRangeAt(0);
                const startNode = range.startContainer;
                const insideToken =
                  startNode instanceof HTMLElement
                    ? startNode.closest<HTMLElement>('[data-astryx-token]')
                    : startNode.parentElement?.closest<HTMLElement>(
                        '[data-astryx-token]'
                      );
                if (insideToken && editor.contains(insideToken)) {
                  event.preventDefault();
                  const next = insideToken.nextSibling;
                  if (
                    next?.nodeType === Node.TEXT_NODE &&
                    /^[\u00A0\u200B\uFEFF]+$/.test(next.textContent ?? '')
                  ) {
                    next.remove();
                  }
                  insideToken.remove();
                  editor.dispatchEvent(new Event('input', { bubbles: true }));
                  return;
                }
              }
            }
            if (handleHistoryKeyDown(event)) {
              return;
            }
            const action = composerEnterAction(
              sendShortcut,
              event,
              lastCompositionEndAtRef.current
            );
            if (action === 'defer') {
              if (!event.shiftKey && astryxHandlesComposerSubmit(event)) {
                event.preventDefault();
                const text = composerHandleRef.current?.getValue().trim() ?? '';
                if (text) {
                  handleSubmit(text);
                }
              }
              return;
            }
            event.preventDefault();
            if (action === 'newline') {
              composerHandleRef.current?.insertText('\n');
              onChange(composerHandleRef.current?.getValue() ?? value);
              return;
            }
            const text = composerHandleRef.current?.getValue().trim() ?? '';
            if (!text) return;
            handleSubmit(text);
          }}
          onSubmit={handleSubmit}
          onFiles={(files) => {
            const attached = files
              .filter(isAttachableFile)
              .map(prepareImageFileForUpload);
            if (attached.length > 0) onAttachImages(attached);
          }}
          onPaste={handleComposerPaste}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          data-testid="session-composer-editor"
        />
        {activeHoverToken?.token.kind === 'element' ? (
          <PreviewElementTokenTooltip
            anchor={activeHoverToken.anchor}
            id={elementTokenTooltipId}
            token={activeHoverToken.token}
          />
        ) : null}
        {activeHoverToken?.token.kind === 'quote' ? (
          <QuoteTokenPreview
            anchor={activeHoverToken.anchor}
            id={quoteTokenTooltipId}
            text={activeHoverToken.token.value}
            onPointerEnter={cancelHoverHide}
            onPointerLeave={() => hideTokenHover(activeHoverToken.anchor, 120)}
          />
        ) : null}
      </div>
      {atReference.panel ? (
        <ComposerAtReferencePanel
          groups={atReference.panel.groups}
          activeTab={atReference.panel.activeTab}
          selectedIndex={atReference.panel.selectedIndex}
          loading={atReference.panel.loading}
          anchor={dropZoneRef.current}
          onSelectTab={atReference.selectTab}
          onSelectItem={atReference.selectItem}
        />
      ) : null}
    </div>
  );
}
