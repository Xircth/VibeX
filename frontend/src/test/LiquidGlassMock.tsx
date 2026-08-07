import type { ReactNode } from 'react';

/**
 * liquid-glass-react renders a WebGL shader surface that jsdom cannot run.
 * Render its children inside a marker div (same shape as the per-file mocks
 * used by BranchInfoHeader/ProjectRail tests) so components like
 * SettingsActionBar stay testable. Imported from vitest.setup.ts so every
 * test file gets the mock automatically.
 */
vi.mock('liquid-glass-react', () => ({
  default: ({
    children,
    cornerRadius,
    aberrationIntensity,
    blurAmount,
    saturation,
    elasticity,
    mode,
  }: {
    children: ReactNode;
    cornerRadius?: number;
    aberrationIntensity?: number;
    blurAmount?: number;
    saturation?: number;
    elasticity?: number;
    mode?: string;
  }) => (
    <div
      data-testid="liquid-glass"
      data-corner-radius={cornerRadius}
      data-aberration-intensity={aberrationIntensity}
      data-blur-amount={blurAmount}
      data-saturation={saturation}
      data-elasticity={elasticity}
      data-mode={mode}
    >
      {children}
    </div>
  ),
}));
