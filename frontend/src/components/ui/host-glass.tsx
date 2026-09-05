import type { CSSProperties, ReactNode, RefObject } from 'react';
import LiquidGlass from 'liquid-glass-react';
import { usesSolidHostChrome } from '@/utils/platform';

/** liquid-glass-react centers with left/top 50% and its own translate.
 *  The Windows fallback is a plain div and must fill the stage instead. */
export function solidHostChromeStyle(
  style?: CSSProperties
): CSSProperties | undefined {
  if (!style) {
    return style;
  }
  if (
    style.position !== 'absolute' ||
    style.left !== '50%' ||
    style.top !== '50%'
  ) {
    return style;
  }
  return {
    ...style,
    inset: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    width: style.width ?? '100%',
    height: style.height ?? '100%',
    transform: 'none',
  };
}

type HostGlassProps = {
  className?: string;
  children: ReactNode;
  padding?: string;
  cornerRadius?: number;
  displacementScale?: number;
  blurAmount?: number;
  saturation?: number;
  aberrationIntensity?: number;
  elasticity?: number;
  mouseContainer?: RefObject<HTMLElement | null>;
  globalMousePos?: { x: number; y: number };
  mouseOffset?: { x: number; y: number };
  mode?: 'standard' | 'polar' | 'prominent' | 'shader';
  style?: CSSProperties;
};

export function HostGlass({
  className,
  children,
  style,
  ...glassProps
}: HostGlassProps) {
  if (usesSolidHostChrome()) {
    return (
      <div className={className} style={solidHostChromeStyle(style)}>
        {children}
      </div>
    );
  }

  return (
    <LiquidGlass className={className} style={style} {...glassProps}>
      {children}
    </LiquidGlass>
  );
}
