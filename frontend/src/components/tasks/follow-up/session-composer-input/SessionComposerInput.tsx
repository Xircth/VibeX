import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { type ChatComposerInputHandle } from '@astryxdesign/core/Chat';
import { useSlotContributions } from '@dimoai/plugin-sdk';
import { configuredBackendTransport } from '@/lib/backendTransport';
import { toast } from '@/components/ui/toast';
import { materializeMentionedHostFiles } from '@/lib/materializeHostReferences';
import { mentionedHostFileNames } from '@/lib/savedHostSshConfig';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { useBasicGuideHelloSeed } from '@/features/basic-guide/useBasicGuideHelloSeed';
import { useAgentMentions } from '../AgentMention';
import {
  isComposerCaretAtDocumentStart,
  isComposerHistoryNavigationKey,
  mergeComposerMessageHistory,
  shouldNavigateComposerHistory,
  stepComposerHistory,
} from '../sessionComposerHistory';
import { useComposerAtReferencePanel } from '../useComposerAtReferencePanel';
import {
  insertComposerTextWithUndo,
  replaceComposerValueWithUndo,
} from '../replaceComposerValueWithUndo';
import {
  mayContainStructuredComposerToken,
  updateQuoteTokenAnnotation,
} from '../sessionComposerStructuredTokens';
import type { SessionComposerInputProps } from './sessionComposerTypes';
import { handleComposerImagePaste } from './sessionComposerFiles';
import { SessionComposerSurface } from './SessionComposerSurface';
import {
  getEditorCaretOffset,
  getSessionComposerEditable,
  restoreEditorCaretOffset,
  restoreStructuredTokens,
  syncTriggerMenuWidth,
} from './sessionComposerDom';
import { useSessionComposerHover } from './useSessionComposerHover';
import { useSessionComposerCommands } from './useSessionComposerCommands';
import { useSessionComposerInsert } from './useSessionComposerInsert';
import { buildSessionComposerTriggers } from './SessionComposerTriggers';

export function SessionComposerInput({
  value: rawValue,
  disabled = false,
  className,
  placeholder,
  promptSuggestion = null,
  onAcceptPromptSuggestion,
  onDismissPromptSuggestion,
  context,
  messageHistory,
  acceptExternalInserts = true,
  replaceValueRef,
  onChange,
  onSubmit,
  onAttachImages,
}: SessionComposerInputProps) {
  const value = rawValue ?? '';
  const { t } = useTranslation('tasks');
  useBasicGuideHelloSeed(value, onChange);
  const sendShortcut =
    useOptionalUserSystem()?.config?.send_message_shortcut ?? 'Enter';
  const {
    sessionId,
    workspaceId,
    workspacePath,
    repoId,
    repoIds,
    projectId,
    executorProfile,
    availableCommands = null,
    commandsLoading = false,
    transport = configuredBackendTransport,
    spaceMembers,
  } = context ?? {};
  const composerHandleRef = useRef<ChatComposerInputHandle | null>(null);
  const composerRootRef = useRef<HTMLDivElement | null>(null);
  const lastCompositionEndAtRef = useRef(Number.NEGATIVE_INFINITY);
  const lastSelfEmittedValueRef = useRef<string | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const historyIndexRef = useRef(-1);
  const historyDraftRef = useRef('');
  const localSubmitsRef = useRef<string[]>([]);
  const dropZoneRef = useRef<HTMLDivElement | null>(null);
  const dropActiveRef = useRef(false);
  const [dropActive, setDropActive] = useState(false);
  const setComposerDropActive = useCallback((active: boolean) => {
    dropActiveRef.current = active;
    setDropActive(active);
  }, []);

  const {
    elementTokenTooltipId,
    quoteTokenTooltipId,
    activeHoverToken,
    cancelHoverHide,
    hideTokenHover,
    setQuoteEditing,
    handleTokenPointerOver,
    handleTokenPointerOut,
    handleTokenFocus,
    handleTokenBlur,
  } = useSessionComposerHover();
  const agentMentions = useAgentMentions();
  const executor = executorProfile?.executor ?? null;

  const composerActions = usePluginHostContributions('composer_action');
  const sdkComposerActions = useSlotContributions('composer.actions');
  const mergedComposerActions = useMemo(() => {
    const seen = new Set<string>();
    const fromSdk = sdkComposerActions.map((item) => {
      const pluginId = item.pluginId ?? 'builtin';
      const id = `${pluginId}/${item.id}`;
      seen.add(id);
      const meta = item.metadata ?? {};
      const title = item.label ?? String(meta.title ?? item.id);
      const prompt =
        typeof meta.prompt === 'string'
          ? meta.prompt
          : item.onActivate
            ? ''
            : title;
      return {
        id,
        title,
        detail:
          item.tooltip ??
          (typeof meta.title === 'string' ? meta.title : undefined),
        insertText: prompt,
        onActivate: item.onActivate ? () => item.onActivate?.() : undefined,
      };
    });
    const fromHost = composerActions
      .filter((item) => !seen.has(`${item.pluginId}/${item.id}`))
      .map((item) => {
        const metadata = contributionMetadata(item);
        const prompt =
          typeof metadata.prompt === 'string' ? metadata.prompt : item.label;
        return {
          id: `${item.pluginId}/${item.id}`,
          title: item.label,
          detail:
            typeof metadata.title === 'string' ? metadata.title : undefined,
          insertText: prompt,
        };
      });
    return [...fromSdk, ...fromHost];
  }, [composerActions, sdkComposerActions]);

  const atReferenceContext = useMemo(
    () => ({
      sessionId,
      workspaceId,
      repoId,
      repoIds,
      projectId,
      transport,
      spaceMembers,
      actions: mergedComposerActions,
    }),
    [
      mergedComposerActions,
      projectId,
      repoId,
      repoIds,
      sessionId,
      spaceMembers,
      transport,
      workspaceId,
    ]
  );

  const atReference = useComposerAtReferencePanel({
    composerRootRef,
    composerHandleRef,
    context: atReferenceContext,
    disabled,
    onChange,
  });

  const bareAgentMentions =
    agentMentions.capability === 'supported'
      ? agentMentions.candidates
      : undefined;
  const hasPotentialTokens = mayContainStructuredComposerToken(value, {
    bareAgentMentions,
    spaceMembers,
  });

  const preSyncCaretOffsetRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (
      isComposing ||
      !hasPotentialTokens ||
      lastSelfEmittedValueRef.current === value
    ) {
      preSyncCaretOffsetRef.current = null;
      return;
    }
    const editor = getSessionComposerEditable(composerRootRef.current);
    preSyncCaretOffsetRef.current =
      editor && document.activeElement === editor
        ? getEditorCaretOffset(editor)
        : null;
  }, [bareAgentMentions, hasPotentialTokens, isComposing, spaceMembers, value]);

  useEffect(() => {
    if (isComposing) return;
    const savedCaretOffset = preSyncCaretOffsetRef.current;
    preSyncCaretOffsetRef.current = null;
    lastSelfEmittedValueRef.current = null;
    if (!hasPotentialTokens || !composerRootRef.current) return;
    restoreStructuredTokens(
      composerRootRef.current,
      value,
      bareAgentMentions,
      savedCaretOffset,
      spaceMembers
    );
  }, [bareAgentMentions, hasPotentialTokens, isComposing, spaceMembers, value]);

  const handleSelfEmittedChange = useCallback(
    (next: string) => {
      lastSelfEmittedValueRef.current = next;
      onChange(next);
    },
    [onChange]
  );

  if (replaceValueRef) {
    replaceValueRef.current = (next: string) => {
      const editor = getSessionComposerEditable(composerRootRef.current);
      if (editor && replaceComposerValueWithUndo(editor, next)) return;
      onChange(next);
    };
  }

  useLayoutEffect(() => {
    const composerRoot = composerRootRef.current;
    if (!composerRoot) return;

    const sync = () => syncTriggerMenuWidth(composerRoot);
    sync();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', sync);
      return () => window.removeEventListener('resize', sync);
    }

    const observer = new ResizeObserver(sync);
    observer.observe(composerRoot);
    return () => observer.disconnect();
  }, []);

  const {
    slashSource,
    dollarSource,
    agentMentionSource,
    pluginSource,
    makeToken,
    pluginOnSelect,
  } = useSessionComposerCommands({
    transport,
    executor,
    workspacePath,
    availableCommands: availableCommands ?? null,
    commandsLoading: commandsLoading ?? false,
    agentMentions,
  });
  const triggers = useMemo(
    () =>
      buildSessionComposerTriggers({
        slashSource,
        dollarSource,
        agentMentionSource,
        pluginSource,
        makeToken,
        pluginOnSelect,
        agentMentionsSupported: agentMentions.capability === 'supported',
        t,
      }),
    [
      agentMentionSource,
      agentMentions.capability,
      dollarSource,
      makeToken,
      pluginOnSelect,
      pluginSource,
      slashSource,
      t,
    ]
  );

  const { handleDrop, handleDragOver, handleDragLeave } =
    useSessionComposerInsert({
      composerHandleRef,
      composerRootRef,
      dropZoneRef,
      dropActiveRef,
      value,
      onChange,
      onAttachImages,
      sessionId,
      acceptExternalInserts,
      spaceMembers,
      disabled,
      workspacePath,
      setComposerDropActive,
      lastCompositionEndAtRef,
    });

  const handleComposerPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>, text?: string) => {
      if (handleComposerImagePaste(event, onAttachImages, disabled)) {
        if (promptSuggestion) {
          onDismissPromptSuggestion?.();
        }
        return true;
      }
      if (disabled) {
        return false;
      }
      const pasted = text ?? event.clipboardData?.getData('text/plain') ?? '';
      if (pasted && promptSuggestion) {
        onDismissPromptSuggestion?.();
      }
      const editor = getSessionComposerEditable(composerRootRef.current);
      if (!editor) {
        return false;
      }
      return insertComposerTextWithUndo(editor, pasted);
    },
    [disabled, onAttachImages, onDismissPromptSuggestion, promptSuggestion]
  );

  const historySessionIdRef = useRef(sessionId);
  if (historySessionIdRef.current !== sessionId) {
    historySessionIdRef.current = sessionId;
    historyIndexRef.current = -1;
    historyDraftRef.current = '';
    localSubmitsRef.current = [];
  }

  const isMaterializingSubmitRef = useRef(false);
  const clearSubmittedEditor = useCallback(() => {
    const editable = composerRootRef.current?.querySelector<HTMLElement>(
      '[contenteditable="true"]'
    );
    if (editable) {
      editable.replaceChildren();
      editable.dispatchEvent(new Event('input', { bubbles: true }));
    }
    onChange('');
  }, [onChange]);

  const commitSubmission = useCallback(
    (rawText: string, submittedText: string) => {
      if (onSubmit(submittedText) === false) {
        if (composerRootRef.current) {
          restoreStructuredTokens(
            composerRootRef.current,
            rawText,
            agentMentions.capability === 'supported'
              ? agentMentions.candidates
              : undefined,
            rawText.length,
            spaceMembers
          );
        }
        return;
      }
      if (rawText.trim()) {
        localSubmitsRef.current = [...localSubmitsRef.current, rawText];
      }
      historyIndexRef.current = -1;
      historyDraftRef.current = '';
      clearSubmittedEditor();
    },
    [
      agentMentions.candidates,
      agentMentions.capability,
      clearSubmittedEditor,
      onSubmit,
      spaceMembers,
    ]
  );

  const handleSubmit = useCallback(
    (text: string) => {
      if (isMaterializingSubmitRef.current) return;
      if (mentionedHostFileNames(text).length === 0) {
        commitSubmission(text, text);
        return;
      }
      isMaterializingSubmitRef.current = true;
      void (async () => {
        try {
          const submitted = await materializeMentionedHostFiles({ text });
          commitSubmission(text, submitted);
        } catch (error) {
          toast.error(t('composer.atReference.materializeFailed'), {
            description: error instanceof Error ? error.message : String(error),
          });
        } finally {
          isMaterializingSubmitRef.current = false;
        }
      })();
    },
    [commitSubmission, t]
  );

  const handleHistoryKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return false;
      if (!isComposerHistoryNavigationKey(event)) return false;

      const history = mergeComposerMessageHistory(
        messageHistory ?? [],
        localSubmitsRef.current
      );
      const editor = composerRootRef.current?.querySelector<HTMLElement>(
        '[contenteditable="true"], [contenteditable="false"][role="combobox"]'
      );
      if (
        !shouldNavigateComposerHistory({
          key: event.key,
          isBrowsing: historyIndexRef.current !== -1,
          isCaretAtStart: isComposerCaretAtDocumentStart(editor ?? null),
          historyLength: history.length,
        })
      ) {
        return false;
      }

      const next = stepComposerHistory({
        history,
        index: historyIndexRef.current,
        draft: historyDraftRef.current,
        currentValue: composerHandleRef.current?.getValue() ?? value,
        direction: event.key === 'ArrowUp' ? 'older' : 'newer',
      });
      if (!next.applied) return false;

      event.preventDefault();
      historyIndexRef.current = next.index;
      historyDraftRef.current = next.draft;
      onChange(next.value);
      queueMicrotask(() => atReference.detect());
      return true;
    },
    [atReference, disabled, messageHistory, onChange, value]
  );

  const activePromptSuggestion =
    !value && !disabled && !atReference.panel && promptSuggestion?.trim()
      ? promptSuggestion.trim()
      : null;
  const resolvedPlaceholder =
    placeholder ??
    t('composer.placeholder', 'Ask anything. @ files, $ skills, / commands');
  const effectivePlaceholder = activePromptSuggestion
    ? t('conversation:composer.promptSuggestion', {
        suggestion: activePromptSuggestion,
        defaultValue: `${activePromptSuggestion}\u3000Tab 采纳`,
      })
    : resolvedPlaceholder;
  const tryAcceptPromptSuggestionOnTab = useCallback(
    (event: KeyboardEvent<HTMLElement>): boolean => {
      if (
        event.defaultPrevented ||
        event.key !== 'Tab' ||
        event.shiftKey ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        !activePromptSuggestion
      ) {
        return false;
      }
      event.preventDefault();
      const editor = getSessionComposerEditable(composerRootRef.current);
      const replacedWithUndo =
        editor != null &&
        replaceComposerValueWithUndo(editor, activePromptSuggestion);
      if (
        !replacedWithUndo ||
        (composerHandleRef.current?.getValue() ?? '') !== activePromptSuggestion
      ) {
        onChange(activePromptSuggestion);
      }
      if (editor) {
        restoreEditorCaretOffset(editor, activePromptSuggestion.length);
      }
      onAcceptPromptSuggestion?.(activePromptSuggestion);
      onDismissPromptSuggestion?.();
      return true;
    },
    [
      activePromptSuggestion,
      onAcceptPromptSuggestion,
      onChange,
      onDismissPromptSuggestion,
    ]
  );

  const handleUpdateQuoteAnnotation = useCallback(
    (anchor: HTMLElement, targetRaw: string, annotation: string) => {
      const editor = getSessionComposerEditable(composerRootRef.current);
      let occurrenceIndex = 0;
      if (editor) {
        const matchingChips = Array.from(
          editor.querySelectorAll<HTMLElement>('[data-astryx-token]')
        ).filter((chip) => chip.dataset.astryxTokenValue === targetRaw);
        const foundIndex = matchingChips.indexOf(anchor);
        if (foundIndex >= 0) {
          occurrenceIndex = foundIndex;
        }
      }
      const currentValue = composerHandleRef.current?.getValue() ?? value;
      const nextValue = updateQuoteTokenAnnotation(
        currentValue,
        targetRaw,
        annotation,
        occurrenceIndex
      );
      if (nextValue === currentValue) return;
      onChange(nextValue);
    },
    [onChange, value]
  );

  return (
    <SessionComposerSurface
      dropZoneRef={dropZoneRef}
      handleDragOver={handleDragOver}
      handleDragLeave={handleDragLeave}
      handleDrop={handleDrop}
      dropActive={dropActive}
      disabled={disabled}
      tryAcceptPromptSuggestionOnTab={tryAcceptPromptSuggestionOnTab}
      handleTokenPointerOver={handleTokenPointerOver}
      handleTokenPointerOut={handleTokenPointerOut}
      handleTokenFocus={handleTokenFocus}
      handleTokenBlur={handleTokenBlur}
      composerRootRef={composerRootRef}
      value={value}
      sessionId={sessionId}
      promptSuggestion={promptSuggestion}
      hasActivePromptSuggestion={Boolean(activePromptSuggestion)}
      isComposing={isComposing}
      onCompositionStateChange={setIsComposing}
      onDismissPromptSuggestion={onDismissPromptSuggestion}
      onChange={handleSelfEmittedChange}
      onUpdateQuoteAnnotation={handleUpdateQuoteAnnotation}
      atReference={atReference}
      className={className}
      effectivePlaceholder={effectivePlaceholder}
      triggers={triggers}
      composerHandleRef={composerHandleRef}
      lastCompositionEndAtRef={lastCompositionEndAtRef}
      sendShortcut={sendShortcut}
      handleHistoryKeyDown={handleHistoryKeyDown}
      handleSubmit={handleSubmit}
      isMaterializingSubmitRef={isMaterializingSubmitRef}
      onAttachImages={onAttachImages}
      handleComposerPaste={handleComposerPaste}
      activeHoverToken={activeHoverToken}
      elementTokenTooltipId={elementTokenTooltipId}
      quoteTokenTooltipId={quoteTokenTooltipId}
      cancelHoverHide={cancelHoverHide}
      hideTokenHover={hideTokenHover}
      setQuoteEditing={setQuoteEditing}
    />
  );
}
