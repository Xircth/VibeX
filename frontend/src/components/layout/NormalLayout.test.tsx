import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('NormalLayout chrome', () => {
  it('keeps the project rail toggle in the bottom status bar instead of the header', () => {
    const layout = readFileSync(
      resolve(__dirname, './NormalLayout.tsx'),
      'utf8'
    );
    const navbar = readFileSync(resolve(__dirname, './Navbar.tsx'), 'utf8');
    const welcome = readFileSync(
      resolve(__dirname, '../welcome/WelcomePage.tsx'),
      'utf8'
    );

    expect(layout).toContain('<StatusBar />');
    expect(navbar).not.toMatch(/<ProjectRailToggleButton/);
    expect(welcome).not.toMatch(/<ProjectRailToggleButton/);
  });
});
