import type { CSSProperties, ReactNode, RefObject } from 'react';
import LiquidGlass from 'liquid-glass-react';
import { usesSolidHostChrome } from '@/utils/platform';

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
      <div className={className} style={style}>
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
