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

  it('accepts workerHttp managed MCP without an entrypoint', async () => {
    const root = await fixture({
      integrations: [
        {
          id: 'test',
          kind: 'content.skill',
          resource: 'contents/skills/test',
        },
        {
          id: 'sidecar',
          kind: 'content.mcp',
          resource: 'contents/mcps/sidecar.json',
        },
      ],
    });
    await mkdir(join(root, 'contents/mcps'), { recursive: true });
    await writeFile(
      join(root, 'contents/mcps/sidecar.json'),
      JSON.stringify({
        managedRuntime: {
          kind: 'workerHttp',
          handler: 'mcp.endpoint',
          protocolRevision: '2026-07-28',
          defaultBinding: 'all-compatible-agents',
        },
      })
    );
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
          {
            path: 'contents/mcps/sidecar.json',
            kind: 'mcp',
            title: 'Sidecar',
          },
        ],
      })
    );

    const result = await validatePlugin(root);
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'mcp_tools_missing', severity: 'warning' }),
      ])
    );
  });

  it('accepts packaged MCP that declares tools', async () => {
    const root = await fixture({
      integrations: [
        {
          id: 'test',
          kind: 'content.skill',
          resource: 'contents/skills/test',
        },
        {
          id: 'hello',
          kind: 'content.mcp',
          resource: 'contents/mcps/hello.json',
        },
      ],
    });
    await mkdir(join(root, 'contents/mcps'), { recursive: true });
    await mkdir(join(root, 'dist/mcp'), { recursive: true });
    await writeFile(join(root, 'dist/mcp/hello.mjs'), 'export {}\n');
    await writeFile(
      join(root, 'contents/mcps/hello.json'),
      JSON.stringify({
        managedRuntime: {
          entrypoint: 'dist/mcp/hello.mjs',
          protocolRevision: '2026-07-28',
          defaultBinding: 'all-compatible-agents',
        },
        tools: [{ name: 'hello', group: 'mcp' }],
      })
    );
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
          {
            path: 'contents/mcps/hello.json',
            kind: 'mcp',
            title: 'Hello',
          },
        ],
      })
    );

    const result = await validatePlugin(root);
    expect(result.valid).toBe(true);
    expect(result.diagnostics.filter((item) => item.code.startsWith('mcp_'))).toEqual(
      []
    );
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
          runtime: 'node',
          protocol: '1.1',
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

describe('validatePlugin provider.model.catalog', () => {
  it('accepts a legal catalog package', async () => {
    const root = await catalogFixture();
    const result = await validatePlugin(root);

    expect(result).toMatchObject({ valid: true, diagnostics: [] });
  });

  it('rejects a catalog contribution without resource', async () => {
    const root = await catalogFixture({
      integration: { resource: undefined },
      writeCatalog: false,
    });

    const result = await validatePlugin(root);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'integration_resource_invalid' }),
      ])
    );
  });

  it('rejects a catalog contribution that declares handler', async () => {
    const root = await catalogFixture({
      integration: { handler: 'catalog.load' },
    });

    const result = await validatePlugin(root);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'provider_catalog_handler_unsupported',
        }),
      ])
    );
  });

  it('rejects a template that includes apiKey', async () => {
    const root = await catalogFixture({
      catalog: legalCatalog({
        templates: [{ ...legalReusableTemplate(), apiKey: 'sk-secret' }],
      }),
    });

    const result = await validatePlugin(root);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'provider_catalog_secret_forbidden' }),
      ])
    );
  });

  it('rejects a javascript: websiteUrl', async () => {
    const root = await catalogFixture({
      catalog: legalCatalog({
        templates: [
          {
            ...legalReusableTemplate(),
            websiteUrl: 'javascript:alert(1)',
          },
        ],
      }),
    });

    const result = await validatePlugin(root);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'provider_catalog_url_invalid' }),
      ])
    );
  });

  it('rejects a websiteUrl that includes userinfo', async () => {
    const root = await catalogFixture({
      catalog: legalCatalog({
        templates: [
          {
            ...legalReusableTemplate(),
            websiteUrl: 'https://user:pass@example.com/providers',
          },
        ],
      }),
    });

    const result = await validatePlugin(root);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'provider_catalog_url_invalid' }),
      ])
    );
  });

  it('rejects an apiKeyUrl whose query includes aff=', async () => {
    const root = await catalogFixture({
      catalog: legalCatalog({
        templates: [
          {
            ...legalReusableTemplate(),
            apiKeyUrl: 'https://example.com/keys?aff=partner',
          },
        ],
      }),
    });

    const result = await validatePlugin(root);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'provider_catalog_url_invalid' }),
      ])
    );
  });

  it('accepts a websiteUrl whose query contains aff only as a substring', async () => {
    const root = await catalogFixture({
      catalog: legalCatalog({
        templates: [
          {
            ...legalReusableTemplate(),
            websiteUrl: 'https://example.com/staff?role=staff',
          },
        ],
      }),
    });

    const result = await validatePlugin(root);

    expect(result).toMatchObject({ valid: true, diagnostics: [] });
  });

  it('rejects a surface that does not match the file agentId', async () => {
    const root = await catalogFixture({
      catalog: {
        schemaVersion: 1,
        agentId: 'claude_code',
        templates: [
          {
            id: 'openai',
            name: 'OpenAI',
            surface: 'opencode',
            providerId: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            models: [{ id: 'gpt-4o' }],
          },
        ],
      },
    });

    const result = await validatePlugin(root);

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'provider_catalog_surface_mismatch',
        }),
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

const CATALOG_RESOURCE = 'catalogs/claude_code.json';

function legalReusableTemplate() {
  return {
    id: 'openrouter',
    name: 'OpenRouter',
    surface: 'reusable',
    apiUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4',
    websiteUrl: 'https://openrouter.ai',
    apiKeyUrl: 'https://openrouter.ai/keys',
    endpointCandidates: ['https://openrouter.ai/api/v1'],
    category: 'community',
  };
}

function legalCatalog(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    agentId: 'claude_code',
    templates: [legalReusableTemplate()],
    ...overrides,
  };
}

async function catalogFixture({
  integration,
  catalog,
  writeCatalog = true,
}: {
  integration?: Record<string, unknown>;
  catalog?: unknown;
  writeCatalog?: boolean;
} = {}) {
  const resolved = {
    id: 'claude-code',
    kind: 'provider.model.catalog',
    label: 'Claude templates',
    resource: CATALOG_RESOURCE,
    ...integration,
  };
  const root = await fixture({ integrations: [resolved] });
  if (writeCatalog && typeof resolved.resource === 'string') {
    await mkdir(join(root, 'catalogs'), { recursive: true });
    await writeFile(
      join(root, resolved.resource),
      JSON.stringify(catalog ?? legalCatalog())
    );
  }
  return root;
}
