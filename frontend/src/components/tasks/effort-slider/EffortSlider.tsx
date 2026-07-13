/**
 * Effort slider card — the composer's reasoning-effort picker, styled after
 * Claude Code's effort range slider (ported from the claude-range-slider
 * reference): a black squircle card with a Faster↔Smarter track, discrete
 * snap points for the agent-advertised choices, a glowing status label, and
 * a WebGL flame that ignites while the slider sits at the top level.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useWebglFire } from './useWebglFire';
import './effort-slider.css';

const THUMB_WIDTH_PX = 17;
const FLIP_ANIMATION_MS = 460;

/**
 * Canonical effort ranking used to order the track left→right. Agents may
 * advertise their choices in a different order (Claude Code lists "Default"
 * first); on a Faster↔Smarter axis each stop must sit at its actual
 * intensity. "default" ranks with "high" — that is what the default resolves
 * to for Claude Code and Codex — and sits immediately after it.
 */
const EFFORT_RANKS: Record<string, number> = {
  none: 0,
  off: 0,
  minimal: 1,
  min: 1,
  low: 2,
  medium: 3,
  med: 3,
  mid: 3,
  high: 4,
  default: 4.5,
  auto: 4.5,
  xhigh: 5,
  extrahigh: 5,
  veryhigh: 5,
  max: 6,
  maximum: 6,
  ultra: 6,
  ultrathink: 6,
};

function effortRank(choice: EffortSliderChoice): number | null {
  for (const candidate of [choice.value, choice.label]) {
    const token = candidate.toLowerCase().replace(/[^a-z]/g, '');
    const rank = EFFORT_RANKS[token];
    if (rank !== undefined) return rank;
  }
  return null;
}

/**
 * Choices sorted by effort rank. When any choice is outside the known
 * vocabulary the agent-advertised order is kept as-is — a wrong guess would
 * scramble the axis, while trusting the agent is at worst the status quo.
 */
export function orderChoicesByEffort(
  choices: EffortSliderChoice[]
): EffortSliderChoice[] {
  const ranked = choices.map((choice, index) => ({
    choice,
    index,
    rank: effortRank(choice),
  }));
  if (ranked.some((entry) => entry.rank === null)) return choices;
  return ranked
    .sort((a, b) => a.rank! - b.rank! || a.index - b.index)
    .map((entry) => entry.choice);
}

export interface EffortSliderChoice {
  value: string;
  label: string;
  description?: string | null;
}

interface EffortSliderProps {
  /** Header label, e.g. the agent-advertised option label ("Effort"). */
  title: string;
  /** Ordered low → high, as advertised by the agent. */
  choices: EffortSliderChoice[];
  activeValue: string;
  onSelect: (value: string) => void;
  className?: string;
}

export function EffortSlider({
  title,
  choices: rawChoices,
  activeValue,
  onSelect,
  className,
}: EffortSliderProps) {
  const { t } = useTranslation(['tasks', 'common']);
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, '');
  const clipCardId = `vx-effort-card-${uid}`;
  const clipTrackId = `vx-effort-track-${uid}`;

  const choices = useMemo(() => orderChoicesByEffort(rawChoices), [rawChoices]);

  const snapPercents = useMemo(
    () =>
      choices.map((_, index) =>
        choices.length <= 1 ? 100 : (index / (choices.length - 1)) * 100
      ),
    [choices]
  );

  const nearestIndex = useCallback(
    (percent: number) => {
      let best = 0;
      for (let i = 1; i < snapPercents.length; i++) {
        if (
          Math.abs(snapPercents[i] - percent) <
          Math.abs(snapPercents[best] - percent)
        ) {
          best = i;
        }
      }
      return best;
    },
    [snapPercents]
  );

  const activeIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.value === activeValue)
  );

  const [percent, setPercent] = useState(() => snapPercents[activeIndex] ?? 0);
  const [isAnimating, setIsAnimating] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const draggingRef = useRef(false);
  const flipTimerRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const syncFire = useWebglFire(canvasRef);

  // Follow external selection changes while not dragging.
  useEffect(() => {
    if (draggingRef.current) return;
    setPercent(snapPercents[activeIndex] ?? 0);
  }, [activeIndex, snapPercents]);

  const currentIndex = nearestIndex(percent);
  const currentChoice = choices[currentIndex];
  const topIndex = choices.length - 1;
  // The flame burns only when the slider actually sits at the top of the
  // track, mirroring the reference behavior (fire at 100 only).
  const isActive = percent >= 99.5;
  const isFull = percent >= 100;

  // Play the flip-up reveal when the label first reaches the top level.
  const prevIndexRef = useRef(currentIndex);
  useEffect(() => {
    const prev = prevIndexRef.current;
    prevIndexRef.current = currentIndex;
    if (currentIndex === topIndex && prev !== topIndex) {
      setIsAnimating(true);
      if (flipTimerRef.current !== null) {
        window.clearTimeout(flipTimerRef.current);
      }
      flipTimerRef.current = window.setTimeout(() => {
        setIsAnimating(false);
        flipTimerRef.current = null;
      }, FLIP_ANIMATION_MS);
    } else if (currentIndex !== topIndex && prev === topIndex) {
      if (flipTimerRef.current !== null) {
        window.clearTimeout(flipTimerRef.current);
        flipTimerRef.current = null;
      }
      setIsAnimating(false);
    }
  }, [currentIndex, topIndex]);

  useEffect(
    () => () => {
      if (flipTimerRef.current !== null) {
        window.clearTimeout(flipTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    syncFire(percent / 100, isActive);
  }, [isActive, percent, syncFire]);

  const commitSelection = useCallback(
    (index: number) => {
      setPercent(snapPercents[index] ?? 0);
      const choice = choices[index];
      if (choice && choice.value !== activeValue) {
        onSelect(choice.value);
      }
    },
    [activeValue, choices, onSelect, snapPercents]
  );

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    draggingRef.current = true;
    setIsDragging(true);
    setPercent(Number.parseInt(event.target.value, 10));
  };

  const handleRelease = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setIsDragging(false);
    commitSelection(nearestIndex(percent));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowUp'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = Math.min(Math.max(currentIndex + step, 0), topIndex);
    commitSelection(next);
  };

  const maskPercent = Math.min(percent + 2, 100);
  const canvasMask = `linear-gradient(to right, black 0%, black ${maskPercent}%, transparent ${maskPercent}%)`;

  return (
    <div className={cn('vx-effort-shadow', className)}>
      <svg
        className="vx-effort-clip"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <defs>
          <clipPath id={clipCardId} clipPathUnits="objectBoundingBox">
            <path
              d="M 0.053,0
                 C 0.029,0 0.012,0.008 0.005,0.02
                 C 0.002,0.028 0,0.038 0,0.053
                 L 0,0.947
                 C 0,0.962 0.002,0.972 0.005,0.98
                 C 0.012,0.992 0.029,1 0.053,1
                 L 0.947,1
                 C 0.971,1 0.988,0.992 0.995,0.98
                 C 0.998,0.972 1,0.962 1,0.947
                 L 1,0.053
                 C 1,0.038 0.998,0.028 0.995,0.02
                 C 0.988,0.008 0.971,0 0.947,0
                 Z"
            />
          </clipPath>
          <clipPath id={clipTrackId} clipPathUnits="objectBoundingBox">
            <path
              d="M 0.033,0
                 C 0.018,0 0.007,0.012 0.003,0.035
                 C 0.001,0.055 0,0.1 0,0.15
                 L 0,0.85
                 C 0,0.9 0.001,0.945 0.003,0.965
                 C 0.007,0.988 0.018,1 0.033,1
                 L 0.967,1
                 C 0.982,1 0.993,0.988 0.997,0.965
                 C 0.999,0.945 1,0.9 1,0.85
                 L 1,0.15
                 C 1,0.1 0.999,0.055 0.997,0.035
                 C 0.993,0.012 0.982,0 0.967,0
                 Z"
            />
          </clipPath>
        </defs>
      </svg>

      <div
        className="vx-effort-card"
        style={{ clipPath: `url(#${clipCardId})` }}
      >
        <div className="vx-effort-header">
          <div className="vx-effort-header-left">
            <span className="vx-effort-label">{title}</span>
            <span
              className={cn(
                'vx-effort-status',
                isActive && 'vx-glowing',
                isAnimating && 'vx-animate-up'
              )}
            >
              {currentChoice?.label ?? ''}
            </span>
          </div>
          {currentChoice?.description ? (
            <div className="vx-effort-help" title={currentChoice.description}>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth="1.5"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z"
                />
              </svg>
            </div>
          ) : null}
        </div>

        <div className="vx-effort-scale">
          <span>{t('effortSlider.faster')}</span>
          <span>{t('effortSlider.smarter')}</span>
        </div>

        <div
          className={cn(
            'vx-effort-track',
            isActive && 'vx-active',
            isFull && 'vx-full',
            isDragging && 'vx-dragging'
          )}
          style={{ clipPath: `url(#${clipTrackId})` }}
        >
          <div className="vx-effort-track-bg" />
          <div
            className="vx-effort-fill"
            style={{
              // Fill up to the thumb center while dragging.
              width: `calc(${percent / 100} * (100% - ${THUMB_WIDTH_PX}px) + ${THUMB_WIDTH_PX / 2 + 2}px)`,
            }}
          />
          <div className="vx-effort-dots">
            {snapPercents.map((snap, index) => (
              <span
                key={index}
                className="vx-effort-dot"
                style={{
                  // Align each snap dot with the thumb center at that stop.
                  left: `calc(${snap / 100} * (100% - ${THUMB_WIDTH_PX}px) + ${THUMB_WIDTH_PX / 2}px)`,
                }}
              />
            ))}
          </div>
          <canvas
            ref={canvasRef}
            style={{
              maskImage: canvasMask,
              WebkitMaskImage: canvasMask,
            }}
          />
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(percent)}
            className={cn(isActive && 'vx-glowing')}
            aria-label={title}
            aria-valuetext={currentChoice?.label}
            onChange={handleInput}
            onPointerUp={handleRelease}
            onBlur={handleRelease}
            onKeyDown={handleKeyDown}
          />
        </div>
      </div>
    </div>
  );
}
