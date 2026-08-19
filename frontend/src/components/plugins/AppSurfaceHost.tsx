import { AlertTriangle, Loader2, RotateCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useTheme } from '@/components/ThemeProvider';
import { Button } from '@/components/ui/button';

const APP_SURFACE_PROTOCOL = 'vibex.app-surface/1';
const LOCAL_METHODS = new Set(['surface.ready', 'surface.escape']);
const ARTIFACT_METHODS = new Set(['artifact.readText', 'artifact.writeText']);

type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface AppSurfaceDescriptor {
  pluginId: string;
  surfaceId: string;
  label: string;
  generation: number;
  allowedMethods: string[];
  minHeight?: number;
  initialRoute?: string;
  slot?: 'plugin.detail.panel' | 'artifact.editor' | 'conversation.timeline.card';
  artifactPath?: string;
}

export interface AppSurfaceSessionIdentity {
  pluginId: string;
  surfaceId: string;
  generation: number;
  token: string;
}

export interface AppSurfaceHostTransport {
  load(
    request: AppSurfaceSessionIdentity & { artifactPath?: string }
  ): Promise<{
    html: string;
    token: string;
    context?: Record<string, JsonValue>;
  }>;
  invoke(
    request: AppSurfaceSessionIdentity & {
      requestId: string;
      method: string;
      params: JsonValue;
      sequence: number;
    }
  ): Promise<JsonValue>;
  revoke(
    request: AppSurfaceSessionIdentity & { reason: string }
  ): Promise<void>;
}

interface SurfaceContext {
  theme: 'light' | 'dark';
  locale: string;
  direction: 'ltr' | 'rtl';
  reducedMotion: boolean;
  label: string;
  route?: string;
  [key: string]: JsonValue | undefined;
}

interface MountedSurface {
  document: string;
  token: string;
  hostContext: Record<string, JsonValue>;
}

/** Adds the lifecycle bridge without rewriting trusted plugin markup. */
export function buildAppSurfaceDocument({
  pluginHtml,
  nonce: _nonce,
}: {
  pluginHtml: string;
  nonce: string;
}) {
  const content = new DOMParser().parseFromString(pluginHtml, 'text/html');
  const boot = `(() => {
    'use strict';
    let port = null;
    let token = null;
    let sequence = 0;
    let hostSequence = 0;
    let requestId = 0;
    let resolveReady;
    const pending = new Map();
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const request = (method, params = null) => ready.then(() => new Promise((resolve, reject) => {
      const id = String(++requestId);
      pending.set(id, { resolve, reject });
      port.postMessage({
        protocol: '${APP_SURFACE_PROTOCOL}',
        type: 'request',
        token,
        sequence: ++sequence,
        requestId: id,
        method,
        params
      });
    }));
    Object.defineProperty(globalThis, 'vibexSurface', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: Object.freeze({ ready, request })
    });
    const applyContext = (context) => {
      if (!context || typeof context !== 'object') return;
      document.documentElement.lang = context.locale || '';
      document.documentElement.dir = context.direction === 'rtl' ? 'rtl' : 'ltr';
      document.documentElement.dataset.theme = context.theme || 'light';
      document.documentElement.style.colorScheme = context.theme === 'dark' ? 'dark' : 'light';
      dispatchEvent(new CustomEvent('vibexsurfacecontext', { detail: context }));
    };
    addEventListener('message', (event) => {
      if (event.source !== parent || port) return;
      const message = event.data;
      if (!message || message.protocol !== '${APP_SURFACE_PROTOCOL}' || message.type !== 'bootstrap') return;
      const nextPort = event.ports && event.ports[0];
      if (!nextPort || typeof message.token !== 'string') return;
      token = message.token;
      port = nextPort;
      port.onmessage = ({ data }) => {
        if (!data || data.protocol !== '${APP_SURFACE_PROTOCOL}' || data.token !== token) return;
        if (!Number.isSafeInteger(data.sequence) || data.sequence !== hostSequence + 1) return;
        hostSequence = data.sequence;
        if (data.type === 'context') {
          applyContext(data.context);
          return;
        }
        if (data.type !== 'response') return;
        const waiter = pending.get(data.requestId);
        if (!waiter) return;
        pending.delete(data.requestId);
        if (data.ok) waiter.resolve(data.result);
        else waiter.reject(Object.assign(new Error(data.error && data.error.message || 'Surface request failed'), { code: data.error && data.error.code }));
      };
      port.start && port.start();
      applyContext(message.context);
      resolveReady(Object.freeze({
        ...message.context,
        pluginId: message.pluginId,
        surfaceId: message.surfaceId,
        generation: message.generation
      }));
    }, { capture: true });
    addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      void request('surface.escape', null).catch(() => undefined);
    }, { capture: true });
  })();`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><script>${boot}</script>${content.head.innerHTML}</head><body>${content.body.innerHTML}</body></html>`;
}

function createOpaqueToken() {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 24) return false;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return (
      value.length <= 1_000 &&
      value.every((item) => isJsonValue(item, depth + 1))
    );
  }
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 1_000 &&
    entries.every(
      ([key, item]) => key.length <= 256 && isJsonValue(item, depth + 1)
    )
  );
}

function surfaceIdentity(
  descriptor: AppSurfaceDescriptor,
  token: string
): AppSurfaceSessionIdentity {
  return {
    pluginId: descriptor.pluginId,
    surfaceId: descriptor.surfaceId,
    generation: descriptor.generation,
    token,
  };
}

function useReducedMotionPreference() {
  const readPreference = () =>
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false);
  const [reducedMotion, setReducedMotion] = useState(readPreference);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const update = () => setReducedMotion(query.matches);
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  return reducedMotion;
}

export function AppSurfaceHost({
  descriptor,
  enabled,
  transport,
  tokenFactory = createOpaqueToken,
  channelFactory = () => new MessageChannel(),
  bootstrapMessenger = (frame, message, port) =>
    frame.contentWindow?.postMessage(message, '*', [port]),
  variant = 'panel',
}: {
  descriptor: AppSurfaceDescriptor;
  enabled: boolean;
  transport: AppSurfaceHostTransport;
  tokenFactory?: () => string;
  channelFactory?: () => MessageChannel;
  bootstrapMessenger?: (
    frame: HTMLIFrameElement,
    message: Record<string, unknown>,
    port: MessagePort
  ) => void;
  variant?: 'panel' | 'editor';
}) {
  const { resolvedTheme } = useTheme();
  const { i18n, t } = useTranslation('settings');
  const regionRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const tokenRef = useRef<string | null>(null);
  const revokedTokensRef = useRef(new Set<string>());
  const incomingSequenceRef = useRef(0);
  const hostSequenceRef = useRef(0);
  const outgoingSequenceRef = useRef(0);
  const loadCountRef = useRef(0);
  const pendingRequestIdsRef = useRef(new Set<string>());
  const [mounted, setMounted] = useState<MountedSurface | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const direction = i18n.dir(i18n.language) === 'rtl' ? 'rtl' : 'ltr';
  const reducedMotion = useReducedMotionPreference();
  const context = useMemo<SurfaceContext>(
    () => ({
      ...(mounted?.hostContext ?? {}),
      theme: resolvedTheme,
      locale: i18n.language,
      direction,
      reducedMotion,
      label: descriptor.label,
      route: descriptor.initialRoute,
    }),
    [
      descriptor.initialRoute,
      descriptor.label,
      direction,
      i18n.language,
      reducedMotion,
      resolvedTheme,
      mounted?.hostContext,
    ]
  );
  const { pluginId, surfaceId, generation } = descriptor;

  const revoke = useCallback(
    (token: string, reason: string) => {
      if (revokedTokensRef.current.has(token)) return;
      revokedTokensRef.current.add(token);
      portRef.current?.close();
      portRef.current = null;
      if (tokenRef.current === token) tokenRef.current = null;
      void Promise.resolve(
        transport.revoke({ pluginId, surfaceId, generation, token, reason })
      ).catch(() => undefined);
    },
    [generation, pluginId, surfaceId, transport]
  );

  const failClosed = useCallback(
    (message: string) => {
      const token = tokenRef.current;
      if (token) revoke(token, 'protocol_violation');
      setMounted(null);
      setFailure(message);
      setReady(false);
    },
    [revoke]
  );

  useEffect(() => {
    setMounted(null);
    setFailure(null);
    setReady(false);
    incomingSequenceRef.current = 0;
    hostSequenceRef.current = 0;
    outgoingSequenceRef.current = 0;
    loadCountRef.current = 0;
    pendingRequestIdsRef.current.clear();
    if (!enabled) {
      setLoading(false);
      return;
    }

    let active = true;
    const mountNonce = tokenFactory();
    let sessionToken: string | null = null;
    setLoading(true);
    void transport
      .load({
        pluginId,
        surfaceId,
        generation,
        token: mountNonce,
        artifactPath: descriptor.artifactPath,
      })
      .then(({ html, token, context: hostContext = {} }) => {
        sessionToken = token;
        if (!active) {
          revoke(token, 'unmounted_before_load_completed');
          return;
        }
        tokenRef.current = token;
        setMounted({
          document: buildAppSurfaceDocument({
            pluginHtml: html,
            nonce: tokenFactory(),
          }),
          token,
          hostContext,
        });
      })
      .catch(() => {
        if (!active) return;
        if (sessionToken) {
          revoke(sessionToken, 'invalid_surface_document');
        }
        setFailure(t('plugins.surfaceLoadFailed'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      if (sessionToken) {
        revoke(sessionToken, 'unmounted_or_generation_changed');
      }
    };
  }, [
    enabled,
    descriptor.artifactPath,
    generation,
    pluginId,
    reloadKey,
    revoke,
    surfaceId,
    t,
    tokenFactory,
    transport,
  ]);

  useEffect(() => {
    const port = portRef.current;
    const token = tokenRef.current;
    if (!port || !token || !ready) return;
    port.postMessage({
      protocol: APP_SURFACE_PROTOCOL,
      type: 'context',
      token,
      sequence: ++outgoingSequenceRef.current,
      context,
    });
  }, [context, ready]);

  const respond = useCallback(
    (
      port: MessagePort,
      token: string,
      requestId: string,
      response:
        | { ok: true; result: JsonValue }
        | { ok: false; error: { code: string; message: string } }
    ) => {
      port.postMessage({
        protocol: APP_SURFACE_PROTOCOL,
        type: 'response',
        token,
        sequence: ++outgoingSequenceRef.current,
        requestId,
        ...response,
      });
    },
    []
  );

  const handleFrameLoad = useCallback(() => {
    if (!mounted || !frameRef.current?.contentWindow) return;
    loadCountRef.current += 1;
    if (loadCountRef.current > 1 || portRef.current) {
      failClosed(t('plugins.surfaceProtocolViolation'));
      return;
    }
    const channel = channelFactory();
    const port = channel.port1;
    portRef.current = port;
    incomingSequenceRef.current = 0;
    const message = async (event: MessageEvent) => {
      const payload = event.data;
      if (!payload || typeof payload !== 'object') {
        failClosed(t('plugins.surfaceProtocolViolation'));
        return;
      }
      const record = payload as Record<string, unknown>;
      if (
        record.protocol !== APP_SURFACE_PROTOCOL ||
        record.type !== 'request' ||
        record.token !== mounted.token ||
        record.sequence !== incomingSequenceRef.current + 1 ||
        typeof record.requestId !== 'string' ||
        record.requestId.length === 0 ||
        record.requestId.length > 128 ||
        pendingRequestIdsRef.current.has(record.requestId) ||
        typeof record.method !== 'string' ||
        record.method.length === 0 ||
        record.method.length > 256 ||
        !isJsonValue(record.params)
      ) {
        failClosed(t('plugins.surfaceProtocolViolation'));
        return;
      }
      incomingSequenceRef.current += 1;
      const method = record.method;
      const requestId = record.requestId;
      pendingRequestIdsRef.current.add(requestId);
      if (method === 'surface.ready') {
        setReady(true);
        respond(port, mounted.token, requestId, { ok: true, result: null });
        pendingRequestIdsRef.current.delete(requestId);
        return;
      }
      if (method === 'surface.escape') {
        regionRef.current?.focus();
        respond(port, mounted.token, requestId, { ok: true, result: null });
        pendingRequestIdsRef.current.delete(requestId);
        return;
      }
      const artifactMethod =
        descriptor.slot === 'artifact.editor' && ARTIFACT_METHODS.has(method);
      if (
        !LOCAL_METHODS.has(method) &&
        !artifactMethod &&
        !descriptor.allowedMethods.includes(method)
      ) {
        pendingRequestIdsRef.current.delete(requestId);
        failClosed(t('plugins.surfaceProtocolViolation'));
        return;
      }
      try {
        const result = await transport.invoke({
          ...surfaceIdentity(descriptor, mounted.token),
          requestId,
          method,
          params: record.params,
          sequence: ++hostSequenceRef.current,
        });
        if (tokenRef.current !== mounted.token) return;
        if (!isJsonValue(result)) {
          failClosed(t('plugins.surfaceProtocolViolation'));
          return;
        }
        respond(port, mounted.token, requestId, { ok: true, result });
      } catch (cause) {
        if (tokenRef.current !== mounted.token) return;
        const causeMessage =
          cause instanceof Error ? cause.message : String(cause);
        const revisionConflict = /changed outside|revision|conflict/iu.test(
          causeMessage
        );
        respond(port, mounted.token, requestId, {
          ok: false,
          error: {
            code: revisionConflict
              ? 'artifact_revision_conflict'
              : 'host_request_failed',
            message: revisionConflict
              ? 'Artifact changed outside this editor; reload before saving'
              : 'The VibeX Host could not complete this request',
          },
        });
      } finally {
        pendingRequestIdsRef.current.delete(requestId);
      }
    };
    port.addEventListener('message', message);
    port.start();
    bootstrapMessenger(
      frameRef.current,
      {
        protocol: APP_SURFACE_PROTOCOL,
        type: 'bootstrap',
        token: mounted.token,
        pluginId: descriptor.pluginId,
        surfaceId: descriptor.surfaceId,
        generation: descriptor.generation,
        context,
      },
      channel.port2
    );
  }, [
    bootstrapMessenger,
    channelFactory,
    context,
    descriptor,
    failClosed,
    mounted,
    respond,
    t,
    transport,
  ]);

  return (
    <section
      ref={regionRef}
      className={`plugin-app-surface-host plugin-app-surface-host--${variant}`}
      role="region"
      aria-label={descriptor.label}
      tabIndex={-1}
    >
      {variant === 'panel' ? (
        <header>
          <strong>{descriptor.label}</strong>
          <span>
            {t('plugins.surfaceGeneration', {
              generation: descriptor.generation,
            })}
          </span>
        </header>
      ) : null}
      {!enabled ? (
        <p className="plugin-app-surface-state">
          {t('plugins.surfaceDisabled')}
        </p>
      ) : loading ? (
        <p className="plugin-app-surface-state" role="status">
          <Loader2 className="animate-spin" aria-hidden="true" />
          {t('plugins.surfaceLoading')}
        </p>
      ) : failure ? (
        <div className="plugin-app-surface-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>{failure}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setReloadKey((current) => current + 1)}
          >
            <RotateCw aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
            {t('common:retry')}
          </Button>
        </div>
      ) : mounted ? (
        <iframe
          key={`${descriptor.pluginId}:${descriptor.surfaceId}:${descriptor.generation}:${reloadKey}`}
          ref={frameRef}
          className="plugin-app-surface-frame"
          style={{
            minHeight:
              variant === 'editor' ? '100%' : (descriptor.minHeight ?? 320),
          }}
          referrerPolicy="no-referrer"
          srcDoc={mounted.document}
          title={descriptor.label}
          onLoad={handleFrameLoad}
        />
      ) : null}
    </section>
  );
}
