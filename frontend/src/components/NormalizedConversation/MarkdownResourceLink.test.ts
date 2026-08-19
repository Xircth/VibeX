import { describe, expect, it } from 'vitest';
import {
  githubRepoUrlFromShorthand,
  resolveMarkdownInlineResource,
  resolveMarkdownWorkspacePathTarget,
} from './MarkdownResourceLink';

describe('resolveMarkdownWorkspacePathTarget', () => {
  it('does not treat GitHub repo markdown links as workspace folders', () => {
    expect(
      resolveMarkdownWorkspacePathTarget(
        'https://github.com/firecrawl/open-agent-builder',
        'firecrawl/open-agent-builder',
        'C:/workspace/project'
      )
    ).toBeNull();
  });

  it('still opens same-origin file-looking labels in the workspace', () => {
    expect(
      resolveMarkdownWorkspacePathTarget(
        'http://127.0.0.1:3002/local-projects/project-1/sessions',
        'frontend/src/App.tsx',
        'C:/workspace/project'
      )
    ).toEqual({
      path: 'C:/workspace/project/frontend/src/App.tsx',
      displayPath: 'frontend/src/App.tsx',
      nodeType: 'file',
    });
  });

  it('still reveals local directory labels without a web href', () => {
    expect(
      resolveMarkdownWorkspacePathTarget(
        undefined,
        'frontend/src/components',
        'C:/workspace/project'
      )
    ).toEqual({
      path: 'C:/workspace/project/frontend/src/components',
      displayPath: 'frontend/src/components',
      nodeType: 'folder',
    });
  });
});

describe('githubRepoUrlFromShorthand', () => {
  it('recognizes owner/repo slugs as GitHub repositories', () => {
    expect(githubRepoUrlFromShorthand('firecrawl/open-agent-builder')).toBe(
      'https://github.com/firecrawl/open-agent-builder'
    );
    expect(githubRepoUrlFromShorthand('escapeboy/agent-fleet-o')).toBe(
      'https://github.com/escapeboy/agent-fleet-o'
    );
    expect(githubRepoUrlFromShorthand('microsoft/autogen')).toBe(
      'https://github.com/microsoft/autogen'
    );
  });

  it('does not treat workspace path fragments as GitHub repositories', () => {
    expect(githubRepoUrlFromShorthand('frontend/src')).toBeNull();
    expect(githubRepoUrlFromShorthand('src/lib')).toBeNull();
    expect(githubRepoUrlFromShorthand('crates/agents')).toBeNull();
    expect(githubRepoUrlFromShorthand('frontend/src/components')).toBeNull();
    expect(githubRepoUrlFromShorthand('my-app/src')).toBeNull();
  });
});

describe('resolveMarkdownInlineResource', () => {
  it('turns GitHub owner/repo inline code into a repository link', () => {
    expect(
      resolveMarkdownInlineResource(
        'firecrawl/open-agent-builder',
        'C:/workspace/project'
      )
    ).toEqual({ href: 'https://github.com/firecrawl/open-agent-builder' });
  });

  it('keeps workspace files and folders clickable', () => {
    expect(
      resolveMarkdownInlineResource(
        'frontend/src/App.tsx',
        'C:/workspace/project'
      )
    ).toEqual({
      pathTarget: {
        path: 'C:/workspace/project/frontend/src/App.tsx',
        displayPath: 'frontend/src/App.tsx',
        nodeType: 'file',
      },
    });
    expect(
      resolveMarkdownInlineResource(
        'frontend/src/components',
        'C:/workspace/project'
      )
    ).toEqual({
      pathTarget: {
        path: 'C:/workspace/project/frontend/src/components',
        displayPath: 'frontend/src/components',
        nodeType: 'folder',
      },
    });
  });
});
