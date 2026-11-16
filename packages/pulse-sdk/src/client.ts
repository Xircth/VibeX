import { generateUlid } from './defineEvent.ts';
import { evaluatePulseRuleLocally, validatePulseRuleSpec } from './evaluator.ts';
import {
  PulseValidationError,
  type EventEnvelope,
  type JsonSchemaObject,
  type PulseDeckSnapshot,
  type PulseDryRunReport,
  type PulseEmitCustomEventInput,
  type PulseEvalMode,
  type PulseEventSchemaView,
  type PulseResolveInteractionInput,
  type PulseRuleSaveInput,
  type PulseRuleSpec,
  type PulseRuleView,
  type PulseSourceUpsertInput,
  type PulseSourceView,
  type PulseSubscriberKind,
  type PulseSubscriptionView,
  type PulseUserInteractionView,
} from './types.ts';
import { signStandardWebhook } from './webhook.ts';

export const DEFAULT_PULSE_TIMEOUT_MS = 15_000;

export interface PulseRequestSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export interface PulseTransport {
  send<TResponse = unknown>(request: PulseRequestSpec): Promise<TResponse>;
}

export interface PulseClientOptions {
  baseUrl?: string;
  bearerToken?: string;
  hmacSecret?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  transport?: PulseTransport;
}

export class PulseHttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'PulseHttpError';
    this.status = status;
    this.body = body;
  }
}

/**
 * HTTP REST client speaking `/api/pulse/*` with optional Bearer + Standard Webhooks
 * HMAC-SHA256 authentication, request timeouts, and a pluggable transport seam.
 */
export class PulseClient {
  readonly #baseUrl: string;
  readonly #bearerToken?: string;
  readonly #hmacSecret?: string;
  readonly #defaultHeaders: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #transport: PulseTransport;

  constructor(options: PulseClientOptions = {}) {
    const rawBaseUrl =
      options.baseUrl ??
      process.env.VIBEX_PULSE_URL ??
      process.env.VIBEX_SERVER_URL ??
      (process.env.VIBEX_WEB_PORT
        ? 'http://127.0.0.1:' + process.env.VIBEX_WEB_PORT
        : 'http://127.0.0.1:17891');
    this.#baseUrl = rawBaseUrl.replace(/\/+$/, '');
    this.#bearerToken =
      options.bearerToken ??
      process.env.VIBEX_PULSE_TOKEN ??
      process.env.VIBEX_SERVER_TOKEN;
    this.#hmacSecret =
      options.hmacSecret ?? process.env.VIBEX_PULSE_WEBHOOK_SECRET;
    this.#defaultHeaders = { ...(options.headers ?? {}) };
    this.#timeoutMs =
      options.timeoutMs !== undefined && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_PULSE_TIMEOUT_MS;

    if (options.transport) {
      this.#transport = options.transport;
    } else {
      const fetchFn = options.fetchImpl ?? globalThis.fetch;
      this.#transport = {
        send: async <TResponse>(req: PulseRequestSpec): Promise<TResponse> => {
          const response = await fetchFn(`${this.#baseUrl}${req.path}`, {
            method: req.method,
            headers: req.headers,
            body: req.body,
            signal: AbortSignal.timeout(this.#timeoutMs),
          });
          const text = await response.text();
          let parsed: unknown = null;
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = text;
            }
          }
          if (!response.ok) {
            const record =
              typeof parsed === 'object' && parsed !== null
                ? (parsed as Record<string, unknown>)
                : null;
            const nestedError =
              record &&
              typeof record.error === 'object' &&
              record.error !== null
                ? (record.error as Record<string, unknown>)
                : null;
            const msg =
              typeof record?.message === 'string'
                ? record.message
                : typeof nestedError?.message === 'string'
                  ? nestedError.message
                  : `Pulse HTTP ${response.status} on ${req.method} ${req.path}`;
            throw new PulseHttpError(response.status, msg, parsed);
          }
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            'data' in parsed &&
            ('success' in parsed || 'ok' in parsed)
          ) {
            return (parsed as { data: TResponse }).data;
          }
          return parsed as TResponse;
        },
      };
    }
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async #request<TResponse>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    payload?: unknown,
    deliveryId?: string,
    extraHeaders?: Record<string, string>
  ): Promise<TResponse> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.#defaultHeaders,
      ...(extraHeaders ?? {}),
    };

    if (this.#bearerToken) {
      headers.authorization = `Bearer ${this.#bearerToken}`;
    }

    let body: string | undefined;
    if (payload !== undefined) {
      body = JSON.stringify(payload);
      headers['content-type'] = 'application/json';
      if (this.#hmacSecret) {
        const signed = signStandardWebhook({
          secret: this.#hmacSecret,
          payload: body,
          deliveryId,
        });
        Object.assign(headers, signed.headers);
      }
    }

    return this.#transport.send<TResponse>({
      method,
      path,
      headers,
      body,
    });
  }

  async deckSnapshot(projectId?: string | null): Promise<PulseDeckSnapshot> {
    const trimmed = projectId?.trim();
    const query = trimmed ? `?projectId=${encodeURIComponent(trimmed)}` : '';
    return this.#request<PulseDeckSnapshot>('GET', `/api/pulse/deck${query}`);
  }

  async emit<TPayload = unknown>(
    input: PulseEmitCustomEventInput<TPayload>
  ): Promise<EventEnvelope<TPayload>> {
    const eventId = generateUlid();
    const deliveryId = input.deliveryId ?? `dlv_${eventId}`;
    const envelope: EventEnvelope<TPayload> = {
      eventId,
      deliveryId,
      source: {
        kind: 'sdk_custom',
        instanceId: input.sourceInstanceId ?? 'pulse-sdk',
        trustLevel: input.trustLevel ?? 'trusted_internal',
      },
      eventType: input.eventType,
      occurredAt: new Date().toISOString(),
      actor: {
        id: input.actor?.id ?? 'pulse-sdk',
        displayName: input.actor?.displayName ?? null,
        roles: input.actor?.roles ?? [],
        isBot: input.actor?.isBot ?? false,
        isSelf: input.actor?.isSelf ?? false,
      },
      threadKey: input.threadKey ?? null,
      correlations: input.correlations ?? [],
      replyChannels: input.replyChannels ?? [],
      trace: {
        rootEventId: input.trace?.rootEventId ?? eventId,
        parentRunId: input.trace?.parentRunId ?? null,
        hopCount: input.trace?.hopCount ?? 0,
      },
      payload: input.payload,
    };

    const extraHeaders = this.#hmacSecret
      ? { 'x-pulse-source-id': envelope.source.instanceId }
      : undefined;

    return this.#request<EventEnvelope<TPayload>>(
      'POST',
      '/api/pulse/events/emit',
      envelope,
      deliveryId,
      extraHeaders
    );
  }

  async listCapturedEvents(limit = 25): Promise<EventEnvelope[]> {
    return this.#request<EventEnvelope[]>(
      'GET',
      `/api/pulse/events?limit=${encodeURIComponent(String(limit))}`
    );
  }

  async listSchemas(): Promise<PulseEventSchemaView[]> {
    return this.#request<PulseEventSchemaView[]>('GET', '/api/pulse/schemas');
  }

  async defineSchema(input: {
    eventType: string;
    summary: string;
    jsonSchema: JsonSchemaObject | Record<string, unknown>;
  }): Promise<PulseEventSchemaView> {
    return this.#request<PulseEventSchemaView>(
      'POST',
      '/api/pulse/schemas',
      input
    );
  }

  async listSources(): Promise<PulseSourceView[]> {
    return this.#request<PulseSourceView[]>('GET', '/api/pulse/sources');
  }

  async upsertSource(input: PulseSourceUpsertInput): Promise<PulseSourceView> {
    return this.#request<PulseSourceView>('POST', '/api/pulse/sources', {
      input,
    });
  }

  async deleteSource(id: string): Promise<void> {
    await this.#request<unknown>(
      'DELETE',
      `/api/pulse/sources/${encodeURIComponent(id)}`
    );
  }

  async listRules(projectId?: string | null): Promise<PulseRuleView[]> {
    const trimmed = projectId?.trim();
    const query = trimmed ? `?projectId=${encodeURIComponent(trimmed)}` : '';
    return this.#request<PulseRuleView[]>('GET', `/api/pulse/rules${query}`);
  }

  async saveRule(input: PulseRuleSaveInput): Promise<PulseRuleView> {
    const violations = validatePulseRuleSpec(input.spec);
    if (violations.length > 0) {
      throw new PulseValidationError(
        `Invalid PulseRuleSpec '${input.spec.name}'`,
        violations
      );
    }
    return this.#request<PulseRuleView>('POST', '/api/pulse/rules', input);
  }

  async setRuleMode(
    id: string,
    evalMode: PulseEvalMode
  ): Promise<PulseRuleView> {
    return this.#request<PulseRuleView>(
      'POST',
      `/api/pulse/rules/${encodeURIComponent(id)}/mode`,
      { id, evalMode }
    );
  }

  async setRuleEnabled(id: string, enabled: boolean): Promise<PulseRuleView> {
    return this.#request<PulseRuleView>(
      'POST',
      `/api/pulse/rules/${encodeURIComponent(id)}/enabled`,
      { id, enabled }
    );
  }

  async deleteRule(id: string): Promise<void> {
    await this.#request<unknown>(
      'DELETE',
      `/api/pulse/rules/${encodeURIComponent(id)}`
    );
  }

  async dryRunRule(
    spec: PulseRuleSpec,
    sampleEvent: EventEnvelope,
    options?: { offline?: boolean }
  ): Promise<PulseDryRunReport> {
    if (options?.offline) {
      return evaluatePulseRuleLocally(spec, sampleEvent);
    }
    return this.#request<PulseDryRunReport>('POST', '/api/pulse/rules/dry-run', {
      spec,
      sampleEvent,
    });
  }

  async subscribeThread(input: {
    threadKey: string;
    subscriberKind: PulseSubscriberKind;
    subscriberId: string;
    active?: boolean;
  }): Promise<PulseSubscriptionView> {
    return this.#request<PulseSubscriptionView>(
      'POST',
      '/api/pulse/subscriptions',
      {
        threadKey: input.threadKey,
        subscriberKind: input.subscriberKind,
        subscriberId: input.subscriberId,
        active: input.active ?? true,
      }
    );
  }

  async unsubscribeThread(subscriptionId: string): Promise<void> {
    await this.#request<unknown>(
      'DELETE',
      `/api/pulse/subscriptions/${encodeURIComponent(subscriptionId)}`
    );
  }

  async promoteCandidate(
    candidateId: string
  ): Promise<{ promoted: boolean; candidateId: string }> {
    return this.#request<{ promoted: boolean; candidateId: string }>(
      'POST',
      `/api/pulse/candidates/${encodeURIComponent(candidateId)}/promote`,
      {}
    );
  }

  async resolveInteraction(
    input: PulseResolveInteractionInput
  ): Promise<PulseUserInteractionView> {
    return this.#request<PulseUserInteractionView>(
      'POST',
      `/api/pulse/interactions/${encodeURIComponent(input.interactionId)}/resolve`,
      { input }
    );
  }
}
