import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const STANDARD_WEBHOOK_SECRET_PREFIX = 'whsec_';
export const MAX_STANDARD_WEBHOOK_BYTES = 64 * 1024;
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export interface SignStandardWebhookInput {
  secret: string;
  payload: string | Uint8Array | Record<string, unknown>;
  deliveryId?: string;
  timestamp?: number;
}

export interface SignedStandardWebhook {
  deliveryId: string;
  timestamp: number;
  signature: string;
  body: string;
  headers: {
    'webhook-id': string;
    'webhook-timestamp': string;
    'webhook-signature': string;
  };
}

export type StandardWebhookErrorCode =
  | 'invalid_secret'
  | 'payload_too_large'
  | 'missing_headers'
  | 'invalid_timestamp'
  | 'timestamp_out_of_window'
  | 'signature_mismatch'
  | 'invalid_json';

export type VerifyStandardWebhookResult<TPayload = unknown> =
  | {
      ok: true;
      deliveryId: string;
      timestamp: number;
      rawBody: string;
      payload: TPayload;
    }
  | {
      ok: false;
      code: StandardWebhookErrorCode;
      message: string;
    };

export interface VerifyStandardWebhookInput {
  secret: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string | Uint8Array;
  nowSeconds?: number;
  toleranceSeconds?: number;
  maxBodyBytes?: number;
}

/**
 * Decodes a Standard Webhooks signing key (`whsec_<base64>` or raw UTF-8 secret).
 */
export function decodeWebhookSecret(secret: string): Buffer {
  const trimmed = secret.trim();
  if (!trimmed) {
    throw new Error('Webhook signing secret must not be empty.');
  }
  if (trimmed.startsWith(STANDARD_WEBHOOK_SECRET_PREFIX)) {
    const encoded = trimmed.slice(STANDARD_WEBHOOK_SECRET_PREFIX.length);
    if (!encoded || !/^[A-Za-z0-9+/]+=*$/.test(encoded)) {
      throw new Error('Invalid base64 key material after whsec_ prefix.');
    }
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.length === 0) {
      throw new Error('Decoded whsec_ secret must not be empty.');
    }
    return decoded;
  }
  return Buffer.from(trimmed, 'utf8');
}

function normalizeBodyToString(
  payload: string | Uint8Array | Record<string, unknown>
): string {
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload instanceof Uint8Array) {
    return Buffer.from(payload).toString('utf8');
  }
  return JSON.stringify(payload);
}

function getHeaderCaseInsensitive(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      if (Array.isArray(value)) {
        return value[0];
      }
      return value;
    }
  }
  return undefined;
}

/**
 * Signs an outbound Standard Webhooks request using HMAC-SHA256 over
 * `<deliveryId>.<timestamp>.<rawBody>` (and accepts Standard Webhooks header format).
 *
 * Note: Per the Standard Webhooks specification, the canonical signed content is
 * `${msgId}.${timestamp}.${rawBody}` (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`).
 */
export function signStandardWebhook(
  input: SignStandardWebhookInput
): SignedStandardWebhook {
  const key = decodeWebhookSecret(input.secret);
  const body = normalizeBodyToString(input.payload);
  const byteLength = Buffer.byteLength(body, 'utf8');
  if (byteLength > MAX_STANDARD_WEBHOOK_BYTES) {
    throw new Error(
      `Webhook payload (${byteLength} bytes) exceeds 64KiB limit (${MAX_STANDARD_WEBHOOK_BYTES} bytes).`
    );
  }

  const deliveryId = input.deliveryId?.trim() || `msg_${randomUUID()}`;
  const timestamp =
    input.timestamp !== undefined
      ? Math.floor(input.timestamp)
      : Math.floor(Date.now() / 1000);

  const toSign = `${deliveryId}.${timestamp}.${body}`;
  const digestBase64 = createHmac('sha256', key)
    .update(toSign, 'utf8')
    .digest('base64');
  const signature = `v1,${digestBase64}`;

  return {
    deliveryId,
    timestamp,
    signature,
    body,
    headers: {
      'webhook-id': deliveryId,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': signature,
    },
  };
}

/**
 * Verifies an inbound Standard Webhooks payload in strict security order:
 * 1. Body size check (<= 64KiB) BEFORE JSON parsing
 * 2. Header presence & 5-minute replay window check
 * 3. Constant-time `timingSafeEqual` HMAC-SHA256 signature verification
 * 4. UTF-8 JSON parsing
 */
export function verifyStandardWebhook<TPayload = unknown>(
  input: VerifyStandardWebhookInput
): VerifyStandardWebhookResult<TPayload> {
  const maxBytes = input.maxBodyBytes ?? MAX_STANDARD_WEBHOOK_BYTES;
  const rawBuffer =
    typeof input.rawBody === 'string'
      ? Buffer.from(input.rawBody, 'utf8')
      : Buffer.from(input.rawBody);

  if (rawBuffer.byteLength > maxBytes) {
    return {
      ok: false,
      code: 'payload_too_large',
      message: `Webhook body (${rawBuffer.byteLength} bytes) exceeds maximum ${maxBytes} bytes.`,
    };
  }

  let key: Buffer;
  try {
    key = decodeWebhookSecret(input.secret);
  } catch (err) {
    return {
      ok: false,
      code: 'invalid_secret',
      message: err instanceof Error ? err.message : 'Invalid signing secret.',
    };
  }

  const deliveryId = getHeaderCaseInsensitive(input.headers, 'webhook-id')?.trim();
  const timestampRaw = getHeaderCaseInsensitive(
    input.headers,
    'webhook-timestamp'
  )?.trim();
  const signatureHeader = getHeaderCaseInsensitive(
    input.headers,
    'webhook-signature'
  )?.trim();

  if (!deliveryId || !timestampRaw || !signatureHeader) {
    return {
      ok: false,
      code: 'missing_headers',
      message:
        'Missing required Standard Webhooks headers (webhook-id, webhook-timestamp, webhook-signature).',
    };
  }

  if (!/^\d+$/.test(timestampRaw)) {
    return {
      ok: false,
      code: 'invalid_timestamp',
      message: 'webhook-timestamp must be an integer Unix epoch timestamp in seconds.',
    };
  }

  const timestamp = Number(timestampRaw);
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;

  if (Math.abs(nowSeconds - timestamp) > tolerance) {
    return {
      ok: false,
      code: 'timestamp_out_of_window',
      message: `Webhook timestamp ${timestamp} is outside the ${tolerance}s replay window (now=${nowSeconds}).`,
    };
  }

  const rawBody = rawBuffer.toString('utf8');
  const expectedPrimary = createHmac('sha256', key)
    .update(`${deliveryId}.${timestamp}.${rawBody}`, 'utf8')
    .digest();

  const candidateSignatures = signatureHeader
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  let matched = false;
  for (const candidate of candidateSignatures) {
    const commaIndex = candidate.indexOf(',');
    if (commaIndex <= 0) {
      continue;
    }
    const version = candidate.slice(0, commaIndex);
    const encodedSig = candidate.slice(commaIndex + 1);
    if (version !== 'v1' || !encodedSig || !/^[A-Za-z0-9+/]+=*$/.test(encodedSig)) {
      continue;
    }
    const actualBytes = Buffer.from(encodedSig, 'base64');
    if (
      actualBytes.byteLength === expectedPrimary.byteLength &&
      timingSafeEqual(actualBytes, expectedPrimary)
    ) {
      matched = true;
    }
  }

  if (!matched) {
    return {
      ok: false,
      code: 'signature_mismatch',
      message: 'Webhook HMAC-SHA256 signature verification failed.',
    };
  }

  try {
    const payload = JSON.parse(rawBody) as TPayload;
    return {
      ok: true,
      deliveryId,
      timestamp,
      rawBody,
      payload,
    };
  } catch (err) {
    return {
      ok: false,
      code: 'invalid_json',
      message: err instanceof Error ? err.message : 'Invalid UTF-8 JSON body.',
    };
  }
}
