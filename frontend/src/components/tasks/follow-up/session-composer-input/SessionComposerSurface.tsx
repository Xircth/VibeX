import {
  useEffect,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
  type UIEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import {
  ChatComposerInput,
  type ChatComposerInputHandle,
  type ChatComposerTrigger,
} from '@astryxdesign/core/Chat';
import { requestConversationScrollToQuote } from '@/lib/conversationScroll';
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
import {
  hasQuoteSourceAnchor,
  type SessionComposerStructuredToken,
} from '../sessionComposerStructuredTokens';
import {
  getHoverableTokenFromEventTarget,
  getStructuredHoverToken,
} from './composerSearch';
import { getSessionComposerEditable } from './sessionComposerDom';
import { PreviewElementTokenTooltip } from './PreviewElementTokenTooltip';
import type { useComposerAtReferencePanel } from '../useComposerAtReferencePanel';

type ScrollFadeState = 'none' | 'top' | 'bottom' | 'both';

function computeScrollFade(element: HTMLElement): ScrollFadeState {
  if (element.scrollHeight <= element.clientHeight + 2) {
    return 'none';
  }
  const canScrollUp = element.scrollTop > 2;
  const canScrollDown =
    element.scrollTop + element.clientHeight < element.scrollHeight - 2;
  if (canScrollUp && canScrollDown) return 'both';
  if (canScrollUp) return 'top';
  if (canScrollDown) return 'bottom';
  return 'none';
}

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
  sessionId,
  promptSuggestion,
  hasActivePromptSuggestion = false,
  isComposing,
  onCompositionStateChange,
  onDismissPromptSuggestion,
  onChange,
  onUpdateQuoteAnnotation,
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
  setQuoteEditing,
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
  sessionId?: string | null;
  promptSuggestion: string | null | undefined;
  hasActivePromptSuggestion?: boolean;
  isComposing: boolean;
  onCompositionStateChange: (composing: boolean) => void;
  onDismissPromptSuggestion?: () => void;
  onChange: (value: string) => void;
  onUpdateQuoteAnnotation?: (
    anchor: HTMLElement,
    targetRaw: string,
    annotation: string
  ) => void;
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
  setQuoteEditing?: (editing: boolean) => void;
}) {
  const { t } = useTranslation('tasks');
  const [scrollFade, setScrollFade] = useState<ScrollFadeState>('none');

  useEffect(() => {
    if (!value) {
      setScrollFade((prev) => (prev === 'none' ? prev : 'none'));
      return;
    }
    const editable = getSessionComposerEditable(composerRootRef.current);
    if (!editable) return;
    const next = computeScrollFade(editable);
    setScrollFade((prev) => (prev === next ? prev : next));
  }, [composerRootRef, value]);

  const handleEditorScrollCapture = (event: UIEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.hasAttribute('contenteditable')) return;
    const next = computeScrollFade(target);
    setScrollFade((prev) => (prev === next ? prev : next));
  };

  const jumpToQuoteToken = (token: SessionComposerStructuredToken) => {
    if (token.kind !== 'quote' || !hasQuoteSourceAnchor(token.quote)) return;
    requestConversationScrollToQuote({
      ...token.quote,
      conversationId:
        token.quote?.conversationId ?? (sessionId || undefined),
      snippet: token.value,
    });
  };

  const handleSurfaceClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = getHoverableTokenFromEventTarget(event.target);
    if (!anchor) return;
    const token = getStructuredHoverToken(anchor);
    if (token?.kind === 'quote' && hasQuoteSourceAnchor(token.quote)) {
      jumpToQuoteToken(token);
    }
  };

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
          'session-composer-input-surface min-h-[3.25rem] px-1 pb-1 pt-0',
          disabled && 'opacity-60'
        )}
        data-testid="session-composer-input-surface"
        data-prompt-suggestion={
          hasActivePromptSuggestion && !isComposing ? 'true' : undefined
        }
        data-scroll-fade={scrollFade !== 'none' ? scrollFade : undefined}
        onKeyDown={(event) => {
          tryAcceptPromptSuggestionOnTab(event);
        }}
        onClick={handleSurfaceClick}
        onScrollCapture={handleEditorScrollCapture}
        onPointerOver={handleTokenPointerOver}
        onPointerOut={handleTokenPointerOut}
        onFocusCapture={handleTokenFocus}
        onBlurCapture={(event) => {
          onCompositionStateChange(false);
          handleTokenBlur(event);
        }}
        onCompositionStartCapture={() => onCompositionStateChange(true)}
        onCompositionEndCapture={() => onCompositionStateChange(false)}
      >
        <ChatComposerInput
          ref={composerRootRef}
          value={value}
          onChange={(next) => {
            if (next && promptSuggestion) {
              onDismissPromptSuggestion?.();
            }
            onChange(next);
            if (atReference.isOpen || next.includes('@')) {
              queueMicrotask(() => atReference.detect());
            }
          }}
          isDisabled={disabled}
          className={cn(
            'session-composer-editor min-h-[3.25rem] w-full px-0.5 pb-1 pt-0 font-sans subpixel-antialiased text-[13px] leading-5 tracking-[0.005em]',
            className
          )}
          maxRows={7}
          placeholder={isComposing ? '' : effectivePlaceholder}
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
            quoteMeta={activeHoverToken.token.quote}
            onJumpToSource={
              hasQuoteSourceAnchor(activeHoverToken.token.quote)
                ? () => jumpToQuoteToken(activeHoverToken.token)
                : undefined
            }
            onUpdateAnnotation={
              !disabled && onUpdateQuoteAnnotation
                ? (nextNote) =>
                    onUpdateQuoteAnnotation(
                      activeHoverToken.anchor,
                      activeHoverToken.token.raw,
                      nextNote
                    )
                : undefined
            }
            onEditingChange={setQuoteEditing}
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
