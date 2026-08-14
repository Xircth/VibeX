import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validatePlugin } from './validation.js';

describe('validatePlugin product package', () => {
  it('accepts README summary, root config, indexed contents and integrations', async () => {
    const root = await fixture();
    const result = await validatePlugin(root);

    expect(result).toMatchObject({ valid: true, diagnostics: [] });
    expect(result.manifest?.readme).toBe('README.md');
  });

  it('rejects a README without an independent one-line summary tag', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'README.md'),
      '# Test\n\nNo frontmatter summary.\n'
    );

    const result = await validatePlugin(root);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'readme_summary_invalid' }),
      ])
    );
  });

  it('rejects a missing or invalid root config.json', async () => {
    const root = await fixture();
    await writeFile(join(root, 'config.json'), '[]');

    const result = await validatePlugin(root);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'config_invalid' }),
      ])
    );
  });

  it('validates root config.json against the declared form schema', async () => {
    const root = await fixture();
    await writeFile(join(root, 'config.json'), '{"enabled":"yes"}');

    const result = await validatePlugin(root);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'config_invalid' }),
      ])
    );
  });

  it('rejects unknown product integration kinds', async () => {
    const root = await fixture({
      integrations: [{ id: 'unknown', kind: 'agent.skill' }],
    });

    const result = await validatePlugin(root);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'integration_unknown' }),
      ])
    );
  });

  it('rejects content index entries outside contents', async () => {
    const root = await fixture();
    await writeFile(
      join(root, '.vibex-plugin/content.index.json'),
      JSON.stringify({
        schemaVersion: 1,
        items: [{ path: 'README.md', kind: 'skill', title: 'Escape' }],
      })
    );

    const result = await validatePlugin(root);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'content_path_invalid' }),
      ])
    );
  });

  it('accepts a file opener backed by a generic artifact editor surface', async () => {
    const root = await fixture({
      entrypoints: {
        worker: {
          path: 'runtime/main.mjs',
          format: 'javascript-esm',
          protocol: '1.0',
        },
        app: { root: 'dist/app', document: 'index.html', protocol: '1.0' },
      },
      integrations: [
        {
          id: 'diagram-files',
          kind: 'file.opener',
          extensions: ['drawio'],
          editorSurface: 'diagram-editor',
        },
        {
          id: 'diagram-editor',
          kind: 'app.surface',
          slot: 'artifact.editor',
          appEntrypoint: 'app',
          handler: 'surface.createSession',
        },
      ],
    });
    await mkdir(join(root, 'runtime'), { recursive: true });
    await mkdir(join(root, 'dist/app'), { recursive: true });
    await writeFile(join(root, 'runtime/main.mjs'), 'export default {};');
    await writeFile(join(root, 'dist/app/index.html'), '<main>Editor</main>');

    const result = await validatePlugin(root);

    expect(result).toMatchObject({ valid: true, diagnostics: [] });
  });

  it('rejects ambiguous and orphaned file editor declarations', async () => {
    const root = await fixture({
      integrations: [
        {
          id: 'diagram-files',
          kind: 'file.opener',
          extensions: ['drawio'],
          previewProvider: 'preview',
          editorSurface: 'missing-editor',
        },
      ],
    });

    const result = await validatePlugin(root);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'file_opener_target_invalid' }),
      ])
    );
  });
});

async function fixture(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vibex-plugin-'));
  await mkdir(join(root, '.vibex-plugin'), { recursive: true });
  await mkdir(join(root, 'contents/skills/test'), { recursive: true });
  await writeFile(
    join(root, '.vibex-plugin/plugin.json'),
    JSON.stringify({
      manifestVersion: 4,
      apiVersion: '1.0',
      id: 'test.app',
      publisher: 'tests',
      version: '1.0.0',
      name: 'Test',
      readme: 'README.md',
      engines: { vibex: '>=0.1.3', pluginSdk: '^1.0.0' },
      content: {
        root: 'contents',
        index: '.vibex-plugin/content.index.json',
      },
      config: {
        schema: {
          type: 'object',
          properties: { enabled: { type: 'boolean' } },
          additionalProperties: false,
        },
      },
      permissions: [],
      integrations: [
        {
          id: 'test',
          kind: 'content.skill',
          resource: 'contents/skills/test',
        },
      ],
      ...extra,
    })
  );
  await writeFile(
    join(root, 'README.md'),
    '---\nsummary: Test one complete VibeX plugin.\n---\n# Test\n'
  );
  await writeFile(join(root, 'config.json'), '{"enabled":true}\n');
  await writeFile(
    join(root, '.vibex-plugin/content.index.json'),
    JSON.stringify({
      schemaVersion: 1,
      items: [
        {
          path: 'contents/skills/test/SKILL.md',
          kind: 'skill',
          title: 'Test skill',
        },
      ],
    })
  );
  await writeFile(
    join(root, 'contents/skills/test/SKILL.md'),
    '---\nname: test\ndescription: Test skill.\n---\n'
  );
  return root;
}
