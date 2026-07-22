import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  getProjectRailMonogram,
  ProjectRailProjectBadge,
} from './ProjectRailProjectBadge';

describe('ProjectRailProjectBadge', () => {
  it('uses word initials for a multi-word project name', () => {
    expect(getProjectRailMonogram('My Course')).toBe('MC');
  });

  it('keeps two glyphs for a compact CJK project name', () => {
    expect(getProjectRailMonogram('课程项目')).toBe('课程');
  });

  it('renders the project identity as its own component', () => {
    render(<ProjectRailProjectBadge name="VibeX" active />);

    expect(screen.getByText('VI')).toBeInTheDocument();
    expect(screen.getByText('VI').parentElement).toHaveClass(
      'project-rail-project-badge--active'
    );
  });
});
