import { useEffect, useState, type CSSProperties } from 'react';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export type BotAvatarShape =
  | 'circle'
  | 'cloud'
  | 'squircle'
  | 'sparkle'
  | 'clover'
  | 'heart'
  | 'pebble'
  | 'droplet'
  | 'capsule'
  | 'triangle'
  | 'pentagon'
  | 'star'
  | 'hexagon';

export type BotAvatarExpression =
  | 'neutral'
  | 'attentive'
  | 'happy'
  | 'laughing'
  | 'excited'
  | 'surprised'
  | 'confused'
  | 'curious'
  | 'suspicious'
  | 'sleepy'
  | 'sad'
  | 'scared'
  | 'angry'
  | 'proud'
  | 'shy'
  | 'unimpressed';

export type BotSessionEmote =
  | 'idle'
  | 'happy'
  | 'curious'
  | 'excited'
  | 'thinking'
  | 'nodding'
  | 'surprised'
  | 'laughing'
  | 'focused'
  | 'wink'
  | 'confused'
  | 'sleepy'
  | 'proud';

export interface MemberBotAvatarConfig {
  color: string;
  shape: BotAvatarShape;
  expression: BotAvatarExpression;
}

export const BOT_AVATAR_COLOR_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  hex: string;
}> = [
  { id: 'ink', label: '炭黑', hex: '#000000' },
  { id: 'brown', label: '暖棕', hex: '#9a6433' },
  { id: 'red', label: '珊瑚红', hex: '#fa2d37' },
  { id: 'orange', label: '活力橙', hex: '#ff6b0a' },
  { id: 'amber', label: '琥珀黄', hex: '#f99408' },
  { id: 'green', label: '薄荷绿', hex: '#09b866' },
  { id: 'turquoise', label: '松石青', hex: '#0db49b' },
  { id: 'blue', label: '电光蓝', hex: '#1584ff' },
  { id: 'purple', label: '紫罗兰', hex: '#8b52ff' },
  { id: 'pink', label: '樱花粉', hex: '#ff2994' },
  { id: 'grey', label: '岩石灰', hex: '#8c8c8c' },
];

export const BOT_AVATAR_SHAPE_PRESETS: ReadonlyArray<{
  id: BotAvatarShape;
  label: string;
}> = [
  { id: 'circle', label: '圆形' },
  { id: 'cloud', label: '云朵' },
  { id: 'squircle', label: '超椭圆' },
  { id: 'sparkle', label: '星芒' },
  { id: 'clover', label: '四叶草' },
  { id: 'heart', label: '心形' },
  { id: 'pebble', label: '花朵' },
  { id: 'droplet', label: '水滴' },
  { id: 'capsule', label: '胶囊' },
  { id: 'triangle', label: '三角形' },
  { id: 'pentagon', label: '五边形' },
  { id: 'star', label: '波浪星' },
  { id: 'hexagon', label: '六边形' },
];

export const BOT_AVATAR_EXPRESSION_PRESETS: ReadonlyArray<{
  id: BotAvatarExpression;
  label: string;
}> = [
  { id: 'neutral', label: '默认' },
  { id: 'attentive', label: '专注' },
  { id: 'happy', label: '开心' },
  { id: 'laughing', label: '大笑' },
  { id: 'excited', label: '兴奋' },
  { id: 'surprised', label: '惊讶' },
  { id: 'confused', label: '困惑' },
  { id: 'curious', label: '好奇' },
  { id: 'suspicious', label: '怀疑' },
  { id: 'sleepy', label: '困倦' },
  { id: 'sad', label: '难过' },
  { id: 'scared', label: '害怕' },
  { id: 'angry', label: '生气' },
  { id: 'proud', label: '得意' },
  { id: 'shy', label: '害羞' },
  { id: 'unimpressed', label: '无语' },
];

function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function deriveMemberBotAvatar(seed: string): MemberBotAvatarConfig {
  const normalized = seed.trim() || 'vibex-bot';
  const h1 = hashSeed(normalized);
  const h2 = hashSeed(`${normalized}:shape`);
  return {
    color: BOT_AVATAR_COLOR_PRESETS[h1 % BOT_AVATAR_COLOR_PRESETS.length].hex,
    shape: BOT_AVATAR_SHAPE_PRESETS[h2 % BOT_AVATAR_SHAPE_PRESETS.length].id,
    expression: 'neutral',
  };
}

export function randomMemberBotAvatar(): MemberBotAvatarConfig {
  const randomIndex = (max: number) => Math.floor(Math.random() * max);
  return {
    color:
      BOT_AVATAR_COLOR_PRESETS[randomIndex(BOT_AVATAR_COLOR_PRESETS.length)]
        .hex,
    shape:
      BOT_AVATAR_SHAPE_PRESETS[randomIndex(BOT_AVATAR_SHAPE_PRESETS.length)].id,
    expression: 'neutral',
  };
}

const MEMBER_BOT_AVATARS_STORAGE_KEY = 'vibex-collaboration-member-avatars';

export function readMemberBotAvatars(
  storage: Pick<Storage, 'getItem'> | undefined = typeof window !== 'undefined'
    ? window.localStorage
    : undefined
): Record<string, MemberBotAvatarConfig> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(MEMBER_BOT_AVATARS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, MemberBotAvatarConfig> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        const color = normalizeHexColor(String(record.color ?? ''));
        const shape = String(record.shape ?? '') as BotAvatarShape;
        const rawExpr = String(
          record.expression ?? 'neutral'
        ) as BotAvatarExpression;
        const expression = BOT_AVATAR_EXPRESSION_PRESETS.some(
          (item) => item.id === rawExpr
        )
          ? rawExpr
          : 'neutral';
        if (BOT_AVATAR_SHAPE_PRESETS.some((item) => item.id === shape)) {
          result[key] = { color, shape, expression };
        }
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function writeMemberBotAvatars(
  avatars: Record<string, MemberBotAvatarConfig>,
  storage: Pick<Storage, 'setItem'> | undefined = typeof window !== 'undefined'
    ? window.localStorage
    : undefined
): void {
  if (!storage) return;
  try {
    storage.setItem(MEMBER_BOT_AVATARS_STORAGE_KEY, JSON.stringify(avatars));
  } catch {
    // Ignore storage quota errors.
  }
}

export function normalizeHexColor(value: string, fallback = '#1584ff'): string {
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) {
    return `#${trimmed.toLowerCase()}`;
  }
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const r = trimmed[1];
    const g = trimmed[2];
    const b = trimmed[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return fallback;
}

function parseHexRgb(hex: string): [number, number, number] {
  const normalized = normalizeHexColor(hex);
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
  ];
}

function isLightHexColor(hex: string): boolean {
  const [r, g, b] = parseHexRgb(hex);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.78;
}

function renderBotShape(
  shape: BotAvatarShape,
  fill: string,
  stroke?: string,
  strokeWidth = 0
) {
  const commonProps = {
    fill,
    stroke: stroke ?? 'none',
    strokeWidth: stroke ? strokeWidth || 1.5 : 0,
    strokeLinejoin: 'round' as const,
    strokeLinecap: 'round' as const,
  };

  switch (shape) {
    case 'circle':
      return <circle cx="32" cy="32" r="24" {...commonProps} />;
    case 'cloud':
      return (
        <path
          d="M20.5 48.5 C12 48.5 6.8 43.2 6.8 36.2 C6.8 30.8 10.4 26.2 15.6 24.8 C17.1 16 24.2 10.5 32.8 10.5 C41.8 10.5 49.2 16.5 50.8 25 C55 26.8 57.2 30.8 57.2 35.5 C57.2 43.2 51 48.5 43 48.5 Z"
          {...commonProps}
        />
      );
    case 'squircle':
      return (
        <rect
          x="10.5"
          y="10.5"
          width="43"
          height="43"
          rx="10.5"
          {...commonProps}
        />
      );
    case 'sparkle':
      return (
        <path
          d="M32 6 C37.5 6 41.2 17.5 46.2 21.5 C51.2 25.5 58 27 58 32 C58 37 51.2 38.5 46.2 42.5 C41.2 46.5 37.5 58 32 58 C26.5 58 22.8 46.5 17.8 42.5 C12.8 38.5 6 37 6 32 C6 27 12.8 25.5 17.8 21.5 C22.8 17.5 26.5 6 32 6 Z"
          {...commonProps}
        />
      );
    case 'clover':
      return (
        <path
          d="M32 13.5 C24 5.5 11.2 10.8 13.8 21.8 C6.5 25.2 6.5 38.8 13.8 42.2 C11.2 53.2 24 58.5 32 50.5 C40 58.5 52.8 53.2 50.2 42.2 C57.5 38.8 57.5 25.2 50.2 21.8 C52.8 10.8 40 5.5 32 13.5 Z"
          {...commonProps}
        />
      );
    case 'heart':
      return (
        <path
          d="M32 53.5 C27.8 50.6 8.5 37.8 8.5 23.2 C8.5 13.8 15.8 8.5 23.8 8.5 C27.8 8.5 30.5 10.5 32 13 C33.5 10.5 36.2 8.5 40.2 8.5 C48.2 8.5 55.5 13.8 55.5 23.2 C55.5 37.8 36.2 50.6 32 53.5 Z"
          {...commonProps}
        />
      );
    case 'pebble':
      return (
        <path
          d="M32 9 C36 6 42 8.5 42.5 14 C48 13.5 52.5 18 50.5 23.5 C55.5 26 56.5 32.5 52 36.5 C55 41.5 51.5 47.5 46 47.5 C45 53 39 56 34 52.5 C30 56.5 23.5 55 21.5 49.5 C16 50.5 11.5 45.5 13.5 40 C8.5 37.5 7.5 31 12 27 C9 22 12.5 16 18 16 C19 10.5 25 7.5 30 11 Z"
          {...commonProps}
        />
      );
    case 'droplet':
      return (
        <path
          d="M32 7.5 C36.5 7.5 53.5 25.5 53.5 38.5 C53.5 49.8 44.2 55.8 32 55.8 C19.8 55.8 10.5 49.8 10.5 38.5 C10.5 25.5 27.5 7.5 32 7.5 Z"
          {...commonProps}
        />
      );
    case 'capsule':
      return (
        <rect x="7.5" y="15" width="49" height="34" rx="17" {...commonProps} />
      );
    case 'triangle':
      return (
        <path
          d="M26 9.5 Q32 2.5 38 9.5 L55.5 40 Q60.5 48.5 50.5 51.5 Q32 55.5 13.5 51.5 Q3.5 48.5 8.5 40 Z"
          {...commonProps}
        />
      );
    case 'pentagon':
      return (
        <path
          d="M27.5 9.2 Q32 6 36.5 9.2 L52.5 20.8 Q56.5 23.8 54.8 28.8 L48.8 47.5 Q47.2 52.5 41.8 52.5 L22.2 52.5 Q16.8 52.5 15.2 47.5 L9.2 28.8 Q7.5 23.8 11.5 20.8 Z"
          {...commonProps}
        />
      );
    case 'star':
      return (
        <path
          d="M29 7.5 C31.5 4.5 35.5 5.5 36.5 9.5 C37.5 13.5 40.5 14.5 44 12.5 C47.5 10.5 51 13.5 49 17.2 C47 21 48.5 24 52.5 25 C56.5 26 57.2 30.5 53.5 32.5 C49.8 34.5 49.5 37.8 52 41 C54.5 44.2 52 48.2 48 46.8 C44 45.4 41 47.2 40.5 51.2 C40 55.2 35.5 56.5 33 53 C30.5 49.5 27.5 49.5 24.5 52.5 C21.5 55.5 17.2 53.2 18.2 49.2 C19.2 45.2 17.2 42.5 13.2 42 C9.2 41.5 8 37 11.5 34.8 C15 32.6 15.2 29.5 12.2 26.5 C9.2 23.5 11.5 19.2 15.5 20.2 C19.5 21.2 22.5 19.2 23 15.2 C23.5 11.2 26.5 10.5 29 7.5 Z"
          {...commonProps}
        />
      );
    case 'hexagon':
      return (
        <path
          d="M27.5 8 Q32 5.4 36.5 8 L51.5 16.8 Q55.5 19.4 55.5 24.2 L55.5 39.8 Q55.5 44.6 51.5 47.2 L36.5 56 Q32 58.6 27.5 56 L12.5 47.2 Q8.5 44.6 8.5 39.8 L8.5 24.2 Q8.5 19.4 12.5 16.8 Z"
          {...commonProps}
        />
      );
  }
}

function renderBotExpression(
  expression: BotAvatarExpression,
  eyeColor: string
) {
  switch (expression) {
    case 'happy':
      return (
        <g>
          <path
            d="M21.8 33.2 C23.4 26.8 28.8 26.8 30.4 33.2"
            stroke={eyeColor}
            strokeWidth="4.6"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M33.6 33.2 C35.2 26.8 40.6 26.8 42.2 33.2"
            stroke={eyeColor}
            strokeWidth="4.6"
            strokeLinecap="round"
            fill="none"
          />
        </g>
      );
    case 'laughing':
      return (
        <g>
          <path
            d="M21.8 27.6 L28.4 31.5 L21.8 35.4"
            stroke={eyeColor}
            strokeWidth="4.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <path
            d="M42.2 27.6 L35.6 31.5 L42.2 35.4"
            stroke={eyeColor}
            strokeWidth="4.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </g>
      );
    case 'proud':
      return (
        <g>
          <path
            d="M22 32.2 C23.8 26.2 28.6 26.2 30.2 32.2"
            stroke={eyeColor}
            strokeWidth="4.8"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M33.8 32.2 C35.4 26.2 40.2 26.2 42 32.2"
            stroke={eyeColor}
            strokeWidth="4.8"
            strokeLinecap="round"
            fill="none"
          />
        </g>
      );
    case 'curious':
      return (
        <g>
          <rect
            x="23.8"
            y="27"
            width="5.2"
            height="9.6"
            rx="2.6"
            fill={eyeColor}
          />
          <rect
            x="34.8"
            y="23.5"
            width="5.6"
            height="14.5"
            rx="2.8"
            fill={eyeColor}
          />
        </g>
      );
    case 'confused':
      return (
        <g transform="rotate(-7 32 31.5)">
          <rect
            x="23.8"
            y="25.5"
            width="5.2"
            height="12.6"
            rx="2.6"
            fill={eyeColor}
          />
          <rect
            x="34.8"
            y="24.5"
            width="5.4"
            height="8.4"
            rx="2.7"
            fill={eyeColor}
          />
        </g>
      );
    case 'excited':
      return (
        <g>
          <rect
            x="23.4"
            y="23.5"
            width="5.8"
            height="15.5"
            rx="2.9"
            fill={eyeColor}
          />
          <rect
            x="34.8"
            y="23.5"
            width="5.8"
            height="15.5"
            rx="2.9"
            fill={eyeColor}
          />
        </g>
      );
    case 'surprised':
      return (
        <g>
          <rect
            x="22.8"
            y="23.8"
            width="6.6"
            height="15"
            rx="3.3"
            fill={eyeColor}
          />
          <rect
            x="34.6"
            y="23.8"
            width="6.6"
            height="15"
            rx="3.3"
            fill={eyeColor}
          />
        </g>
      );
    case 'attentive':
      return (
        <g>
          <rect
            x="24"
            y="26"
            width="5.2"
            height="10.8"
            rx="2.6"
            fill={eyeColor}
          />
          <rect
            x="34.8"
            y="26"
            width="5.2"
            height="10.8"
            rx="2.6"
            fill={eyeColor}
          />
        </g>
      );
    case 'suspicious':
      return (
        <g>
          <rect
            x="22.8"
            y="28.2"
            width="7.2"
            height="5.8"
            rx="2.9"
            fill={eyeColor}
          />
          <rect
            x="34"
            y="28.2"
            width="7.2"
            height="5.8"
            rx="2.9"
            fill={eyeColor}
          />
        </g>
      );
    case 'shy':
      return (
        <g>
          <path
            d="M21.8 32.5 C23.4 27.2 28.6 27.2 30.2 32.5"
            stroke={eyeColor}
            strokeWidth="4.5"
            strokeLinecap="round"
            fill="none"
          />
          <rect
            x="34.6"
            y="24.8"
            width="5.4"
            height="13.4"
            rx="2.7"
            fill={eyeColor}
          />
        </g>
      );
    case 'sleepy':
    case 'unimpressed':
      return (
        <g>
          <rect
            x="22.8"
            y="29.6"
            width="7.4"
            height="4.4"
            rx="2.2"
            fill={eyeColor}
          />
          <rect
            x="33.8"
            y="29.6"
            width="7.4"
            height="4.4"
            rx="2.2"
            fill={eyeColor}
          />
        </g>
      );
    default:
      // Front-facing upright pill eyes without eyeball dots
      return (
        <g>
          <rect
            x="23.8"
            y="25"
            width="5.4"
            height="13"
            rx="2.7"
            fill={eyeColor}
          />
          <rect
            x="34.8"
            y="25"
            width="5.4"
            height="13"
            rx="2.7"
            fill={eyeColor}
          />
        </g>
      );
  }
}

export const SESSION_EMOTE_SEQUENCE: ReadonlyArray<{
  emote: BotSessionEmote;
  expression: BotAvatarExpression;
}> = [
  { emote: 'happy', expression: 'happy' },
  { emote: 'curious', expression: 'curious' },
  { emote: 'excited', expression: 'excited' },
  { emote: 'thinking', expression: 'attentive' },
  { emote: 'nodding', expression: 'proud' },
  { emote: 'surprised', expression: 'surprised' },
  { emote: 'laughing', expression: 'laughing' },
  { emote: 'focused', expression: 'suspicious' },
  { emote: 'wink', expression: 'shy' },
  { emote: 'confused', expression: 'confused' },
  { emote: 'sleepy', expression: 'sleepy' },
  { emote: 'proud', expression: 'proud' },
];

const EMOTE_TO_EXPRESSION: Record<BotSessionEmote, BotAvatarExpression> = {
  idle: 'neutral',
  happy: 'happy',
  curious: 'curious',
  excited: 'excited',
  thinking: 'attentive',
  nodding: 'proud',
  surprised: 'surprised',
  laughing: 'laughing',
  focused: 'suspicious',
  wink: 'shy',
  confused: 'confused',
  sleepy: 'sleepy',
  proud: 'proud',
};

export function MemberBotAvatar({
  config,
  className,
  reactionKey,
  animated = true,
  sessionActive = false,
  selectedOutline = false,
  'data-testid': dataTestId,
}: {
  config: MemberBotAvatarConfig;
  className?: string;
  reactionKey?: number;
  animated?: boolean;
  sessionActive?: boolean;
  selectedOutline?: boolean;
  'data-testid'?: string;
}) {
  const normalizedColor = normalizeHexColor(config.color);
  const isLight = isLightHexColor(normalizedColor);
  const eyeColor = isLight ? '#111827' : '#ffffff';
  const strokeColor = isLight ? 'rgba(15, 23, 42, 0.14)' : undefined;

  const [sessionEmote, setSessionEmote] = useState<BotSessionEmote>('idle');
  const [completedReactionKey, setCompletedReactionKey] = useState(0);

  useEffect(() => {
    if (!reactionKey || reactionKey <= 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setCompletedReactionKey(reactionKey);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [reactionKey]);

  useEffect(() => {
    if (!animated || !sessionActive) {
      setSessionEmote('idle');
      return;
    }
    const seed = hashSeed(`${config.color}:${config.shape}`);
    let step = seed % SESSION_EMOTE_SEQUENCE.length;
    let clearTimer: number | null = null;

    const triggerNextEmote = () => {
      const next = SESSION_EMOTE_SEQUENCE[step % SESSION_EMOTE_SEQUENCE.length];
      step += 1;
      setSessionEmote(next.emote);
      if (clearTimer !== null) window.clearTimeout(clearTimer);
      clearTimer = window.setTimeout(() => {
        setSessionEmote('idle');
      }, 1250);
    };

    triggerNextEmote();
    const intervalMs = 2600 + (seed % 900);
    const timer = window.setInterval(triggerNextEmote, intervalMs);

    return () => {
      window.clearInterval(timer);
      if (clearTimer !== null) window.clearTimeout(clearTimer);
    };
  }, [animated, sessionActive, config.color, config.shape]);

  const isReactingNow = Boolean(
    reactionKey && reactionKey > 0 && completedReactionKey < reactionKey
  );

  const activeReactionEmote: BotSessionEmote =
    isReactingNow && reactionKey
      ? SESSION_EMOTE_SEQUENCE[
          (reactionKey - 1) % SESSION_EMOTE_SEQUENCE.length
        ].emote
      : sessionEmote;

  const effectiveExpression: BotAvatarExpression =
    activeReactionEmote !== 'idle'
      ? EMOTE_TO_EXPRESSION[activeReactionEmote]
      : config.expression || 'neutral';

  const seed = hashSeed(`${config.color}:${config.shape}`);
  const blinkDurationSec = (4.6 + (seed % 24) * 0.1).toFixed(2);
  const blinkDelaySec = ((seed % 35) * 0.1).toFixed(2);

  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn(
        'collaboration-bot-avatar inline-block shrink-0 select-none overflow-visible',
        animated && 'collaboration-bot-avatar--animated',
        animated &&
          activeReactionEmote === 'idle' &&
          'collaboration-bot-avatar--idle-blink',
        sessionActive && 'collaboration-bot-avatar--session-active',
        className
      )}
      style={
        animated
          ? ({
              '--bot-blink-duration': `${blinkDurationSec}s`,
              '--bot-blink-delay': `${blinkDelaySec}s`,
            } as CSSProperties)
          : undefined
      }
      data-testid={dataTestId}
      data-bot-color={normalizedColor}
      data-bot-shape={config.shape}
      data-bot-expression={effectiveExpression}
      data-bot-emote={activeReactionEmote}
      data-bot-session-active={sessionActive ? 'true' : 'false'}
      aria-hidden="true"
    >
      <g
        key={reactionKey ?? 0}
        className={cn(
          'collaboration-bot-avatar-stage',
          activeReactionEmote !== 'idle' &&
            `collaboration-bot-emote--${activeReactionEmote}`,
          isReactingNow && 'is-reacting'
        )}
      >
        <g className="collaboration-bot-3d-head">
          {selectedOutline ? (
            <>
              {renderBotShape(config.shape, 'none', '#d1d5db', 8)}
              {renderBotShape(config.shape, 'none', '#ffffff', 4.5)}
            </>
          ) : null}
          {renderBotShape(config.shape, normalizedColor, strokeColor)}
          <g className="collaboration-bot-avatar-face">
            {renderBotExpression(effectiveExpression, eyeColor)}
          </g>
        </g>
      </g>
    </svg>
  );
}

type AvatarConfigSection = 'color' | 'shape';

export function MemberBotAvatarPicker({
  value,
  onChange,
  compact = false,
  label = '头像',
}: {
  value: MemberBotAvatarConfig;
  onChange: (next: MemberBotAvatarConfig) => void;
  compact?: boolean;
  label?: string;
}) {
  const [activeSection, setActiveSection] =
    useState<AvatarConfigSection>('color');
  const [reactionKey, setReactionKey] = useState(0);

  const applyColor = (rawColor: string) => {
    const normalized = normalizeHexColor(rawColor, value.color);
    onChange({
      ...value,
      color: normalized,
      expression: 'neutral',
    });
    setReactionKey((prev) => prev + 1);
  };

  return (
    <div
      className={cn(
        'collaboration-avatar-picker',
        compact && 'collaboration-avatar-picker--compact'
      )}
      data-testid="member-bot-avatar-picker"
    >
      <div className="collaboration-avatar-picker-header">
        <Label className="shrink-0">{label}</Label>
        <SegmentedControl
          value={activeSection}
          onChange={(next) =>
            setActiveSection(next === 'shape' ? 'shape' : 'color')
          }
          label="头像属性"
          size="sm"
          layout="hug"
          className="collaboration-compact-segmented"
        >
          <SegmentedControlItem value="color" label="颜色" />
          <SegmentedControlItem value="shape" label="形状" />
        </SegmentedControl>
      </div>

      <div className="collaboration-avatar-picker-layout">
        <div className="collaboration-avatar-left-col">
          <button
            type="button"
            className="collaboration-avatar-preview-box"
            data-testid="member-bot-avatar-preview"
            title="点击预览头像动态效果"
            onClick={() => setReactionKey((prev) => prev + 1)}
          >
            <MemberBotAvatar
              config={value}
              reactionKey={reactionKey}
              className={compact ? 'h-14 w-14' : 'h-20 w-20'}
            />
          </button>
        </div>

        <div className="collaboration-avatar-right-col">
          {activeSection === 'color' ? (
            <div
              className="collaboration-avatar-config-panel"
              data-testid="member-avatar-panel-color"
            >
              <div className="collaboration-avatar-color-grid">
                {BOT_AVATAR_COLOR_PRESETS.map((preset) => {
                  const selected =
                    normalizeHexColor(value.color) ===
                    normalizeHexColor(preset.hex);
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      aria-label={preset.label}
                      title={preset.label}
                      className={cn(
                        'collaboration-avatar-color-dot',
                        selected && 'is-selected'
                      )}
                      style={{ backgroundColor: preset.hex }}
                      onClick={() => applyColor(preset.hex)}
                    />
                  );
                })}
              </div>
            </div>
          ) : null}

          {activeSection === 'shape' ? (
            <div
              className="collaboration-avatar-config-panel"
              data-testid="member-avatar-panel-shape"
            >
              <div className="collaboration-avatar-shape-grid">
                {BOT_AVATAR_SHAPE_PRESETS.map((preset) => {
                  const selected = value.shape === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      aria-label={preset.label}
                      title={preset.label}
                      className={cn(
                        'collaboration-avatar-shape-btn',
                        selected && 'is-selected'
                      )}
                      onClick={() => {
                        onChange({
                          ...value,
                          shape: preset.id,
                          expression: 'neutral',
                        });
                        setReactionKey((prev) => prev + 1);
                      }}
                    >
                      <MemberBotAvatar
                        config={{
                          ...value,
                          shape: preset.id,
                          expression: 'neutral',
                        }}
                        animated={false}
                        selectedOutline={selected}
                        className="h-8 w-8"
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
