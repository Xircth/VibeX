export const PERMISSION_CAPABILITIES = [
    'runtime.execute',
    'runtime.lock',
    'artifact.preview',
    'net.fetch',
    'net.websocket',
    'fs.read',
    'fs.write',
    'env.read',
    'secret.keep',
    'storage.kv',
];
/**
 * Icon names the Host is willing to render for plugin chrome. Plugins name an
 * icon instead of shipping markup, so no plugin asset reaches Host DOM.
 * Mirrored by `@vibex/plugin-contract/catalog/icons` and the Rust
 * `CONTRIBUTION_ICONS`; all three are asserted equal by tests.
 */
export const CONTRIBUTION_ICONS = [
    'activity',
    'alert-triangle',
    'bell',
    'bookmark',
    'bot',
    'calendar',
    'chart-bar',
    'check-circle',
    'clock',
    'cloud',
    'code',
    'database',
    'file-text',
    'filter',
    'flag',
    'folder',
    'gauge',
    'git-branch',
    'globe',
    'info',
    'key',
    'layers',
    'link',
    'list',
    'message-square',
    'monitor',
    'package',
    'play',
    'plug',
    'puzzle',
    'refresh-cw',
    'search',
    'settings',
    'shield',
    'sparkles',
    'star',
    'tag',
    'terminal',
    'timer',
    'user',
    'zap',
];
const relativePath = {
    type: 'string',
    minLength: 1,
    pattern: '^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$',
};
const id = {
    type: 'string',
    pattern: '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$',
};
export const pluginManifestSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://schemas.vibex.dev/plugin/v4/plugin.schema.json',
    type: 'object',
    additionalProperties: false,
    required: [
        'manifestVersion',
        'apiVersion',
        'id',
        'publisher',
        'version',
        'name',
    ],
    properties: {
        $schema: { type: 'string' },
        manifestVersion: { const: 4 },
        apiVersion: { enum: ['1.0', '2.0'] },
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{1,62}$' },
        publisher: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,62}$' },
        version: {
            type: 'string',
            pattern: '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:[-+][0-9A-Za-z.-]+)?$',
        },
        name: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        readme: { const: 'README.md' },
        engines: {
            type: 'object',
            additionalProperties: false,
            properties: {
                vibex: { type: 'string', minLength: 1 },
                pluginSdk: { type: 'string', minLength: 1 },
            },
        },
        content: {
            type: 'object',
            additionalProperties: false,
            required: ['root', 'index'],
            properties: {
                root: { const: 'contents' },
                index: { const: '.vibex-plugin/content.index.json' },
            },
        },
        config: {
            type: 'object',
            additionalProperties: false,
            required: ['schema'],
            properties: { schema: { type: 'object' } },
        },
        dependencies: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    kind: { enum: ['runtime', 'plugin'] },
                    descriptor: relativePath,
                    optional: { type: 'boolean' },
                    id: { type: 'string', minLength: 1 },
                    publisher: { type: 'string' },
                    versionRange: { type: 'string' },
                    required: { type: 'boolean' },
                },
            },
        },
        entrypoints: {
            type: 'object',
            additionalProperties: false,
            properties: {
                worker: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['path', 'runtime', 'protocol'],
                    properties: {
                        path: relativePath,
                        runtime: { enum: ['node', 'python', 'native'] },
                        protocol: { const: '1.1' },
                        maxFrameMiB: { type: 'integer', minimum: 1, maximum: 128 },
                        sharedWorker: { type: 'boolean' },
                        isolation: { enum: ['shared', 'process'] },
                    },
                },
                app: {
                    oneOf: [
                        {
                            type: 'object',
                            additionalProperties: false,
                            required: ['root', 'document'],
                            properties: {
                                root: relativePath,
                                document: { type: 'string', minLength: 1 },
                                protocol: { const: '1.0' },
                            },
                        },
                        {
                            type: 'object',
                            additionalProperties: false,
                            required: ['entry', 'protocol'],
                            properties: {
                                entry: relativePath,
                                styles: relativePath,
                                protocol: { const: '2.0' },
                            },
                        },
                    ],
                },
            },
        },
        permissions: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'capability', 'scope', 'reason'],
                properties: {
                    id,
                    capability: {
                        enum: [
                            'runtime.execute',
                            'runtime.lock',
                            'artifact.preview',
                            'net.fetch',
                            'net.websocket',
                            'fs.read',
                            'fs.write',
                            'env.read',
                            'secret.keep',
                            'storage.kv',
                        ],
                    },
                    scope: { type: 'object' },
                    reason: { type: 'string', minLength: 1 },
                    optional: { type: 'boolean' },
                    trustTier: { enum: ['sandboxed_worker', 'trusted_native'] },
                },
            },
        },
        integrations: {
            type: 'array',
            items: {
                type: 'object',
                required: ['id', 'kind'],
                properties: {
                    id,
                    kind: {
                        enum: [
                            'content.skill',
                            'content.mcp',
                            'content.hook',
                            'workflow.binding',
                            'file.opener',
                            'artifact.preview',
                            'app.surface',
                            'app.command',
                            'app.toolbar',
                            'app.status',
                            'app.composer.slash',
                            'app.timeline.card',
                            'app.settings.section',
                            'host.service',
                            'provider.model.importSource',
                            'provider.model.catalog',
                            'app.panel',
                            'app.tab',
                            'app.kanban.view',
                            'app.settings.page',
                            'app.composer.action',
                            'app.rail.section',
                            'provider.remote.provisioner',
                        ],
                    },
                    resource: relativePath,
                    required: { type: 'boolean' },
                },
            },
        },
        interface: { type: 'object' },
    },
};
function splitNormalizedPathComponents(rawPath) {
    if (typeof rawPath !== 'string')
        return null;
    const trimmed = rawPath.trim();
    if (!trimmed || trimmed.includes('\0'))
        return null;
    const segments = trimmed.replace(/\\/g, '/').split('/');
    const components = [];
    for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i];
        if (seg === '..') {
            return null;
        }
        if (seg === '.' || seg === '') {
            if (i === 0 && trimmed.startsWith('/')) {
                components.push('/');
            }
            continue;
        }
        if (i === 0 && /^[A-Za-z]:$/.test(seg)) {
            components.push(seg.toLowerCase());
            continue;
        }
        components.push(seg);
    }
    return components.length > 0 ? components : null;
}
/**
 * Checks whether `candidatePath` is inside `rootPath` using component-level
 * prefix matching (`Path::components` parity) while rejecting any `..` parent
 * directory traversal segment.
 *
 * Prevents naive string-prefix bypasses such as `/home/user2` matching `/home/user`.
 */
export function isPathWithinRoot(candidatePath, rootPath) {
    const candidate = splitNormalizedPathComponents(candidatePath);
    const root = splitNormalizedPathComponents(rootPath);
    if (!candidate || !root || candidate.length < root.length) {
        return false;
    }
    for (let i = 0; i < root.length; i += 1) {
        if (candidate[i] !== root[i]) {
            return false;
        }
    }
    return true;
}
function isCloudMetadataHost(hostname) {
    const normalized = hostname
        .trim()
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/\.$/, '');
    if (!normalized)
        return false;
    if (normalized === '169.254.169.254' ||
        normalized === 'metadata.google.internal' ||
        normalized === 'metadata.goog' ||
        normalized === '100.100.100.200' ||
        normalized === 'fd00:ec2::254') {
        return true;
    }
    if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(normalized)) {
        return true;
    }
    if (normalized.startsWith('::ffff:169.254.') || normalized.startsWith('::ffff:a9fe:')) {
        return true;
    }
    if (/^fe[89ab][0-9a-f]:/i.test(normalized)) {
        return true;
    }
    return false;
}
function matchesAllowedHostPattern(hostname, origin, pattern) {
    const raw = pattern.trim().toLowerCase();
    if (!raw)
        return false;
    if (raw === '*')
        return true;
    if (raw.includes('://')) {
        try {
            const parsedPattern = new URL(raw);
            return origin.toLowerCase() === parsedPattern.origin.toLowerCase();
        }
        catch {
            return false;
        }
    }
    if (raw.startsWith('*.')) {
        const suffix = raw.slice(2);
        return Boolean(suffix) && (hostname === suffix || hostname.endsWith(`.${suffix}`));
    }
    return hostname === raw;
}
/**
 * Validates a network fetch URL against VibeX declarative grant security rules:
 * - Only `http:` and `https:` protocols are permitted
 * - Rejects deceptive URLs containing `@` (`username` / `password` userinfo, e.g. `https://api.example.com@evil.com`)
 * - Blocks link-local / cloud metadata endpoints (`169.254.169.254`, `169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`, `metadata.google.internal`)
 * - Optionally enforces an allowlist of host/origin patterns (`net.fetch` scope)
 */
export function validateSafeFetchUrl(rawUrl, allowedHosts) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
        return { ok: false, reason: 'invalid_url' };
    }
    let parsed;
    try {
        parsed = new URL(rawUrl);
    }
    catch {
        return { ok: false, reason: 'invalid_url' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, reason: 'unsupported_protocol' };
    }
    const authorityMatch = rawUrl.trim().match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/);
    const rawAuthority = authorityMatch?.[1] ?? '';
    if (parsed.username !== '' || parsed.password !== '' || rawAuthority.includes('@')) {
        return { ok: false, reason: 'userinfo_forbidden' };
    }
    const hostname = parsed.hostname
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/\.$/, '');
    if (!hostname) {
        return { ok: false, reason: 'invalid_url' };
    }
    if (isCloudMetadataHost(hostname)) {
        return { ok: false, reason: 'metadata_endpoint_blocked', hostname };
    }
    if (Array.isArray(allowedHosts)) {
        const allowed = allowedHosts.some((pattern) => matchesAllowedHostPattern(hostname, parsed.origin, pattern));
        if (!allowed) {
            return { ok: false, reason: 'host_not_allowed', hostname };
        }
    }
    return {
        ok: true,
        url: parsed.toString(),
        hostname,
    };
}
/**
 * Builds an isolated, frozen environment snapshot containing only explicitly
 * allowlisted keys (`env.read` scope `keys`), preventing full `process.env`
 * leakage into plugin workers.
 */
export function createEnvSnapshot(sourceEnv, allowedKeys) {
    const snapshot = Object.create(null);
    if (!sourceEnv || typeof sourceEnv !== 'object') {
        return Object.freeze(snapshot);
    }
    for (const rawKey of allowedKeys) {
        if (typeof rawKey !== 'string')
            continue;
        const key = rawKey.trim();
        if (!key)
            continue;
        if (Object.prototype.hasOwnProperty.call(sourceEnv, key)) {
            const value = sourceEnv[key];
            if (typeof value === 'string') {
                snapshot[key] = value;
            }
        }
    }
    return Object.freeze(snapshot);
}
