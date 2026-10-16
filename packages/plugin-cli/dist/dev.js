import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
const ignoredDirectories = new Set(['.git', 'dist', 'node_modules']);
const ignoredFiles = new Set([
    '.vibex-plugin/developer-link.json',
    '.vibex-plugin/package.lock.json',
    '.vibex-plugin/dev-remote.json',
]);
function shouldIgnoreSource(path, ignoreRemoteSources) {
    if (ignoredFiles.has(path))
        return true;
    if (path.endsWith('.vxp'))
        return true;
    if (!ignoreRemoteSources)
        return false;
    return (path.startsWith('src/') ||
        path === 'vite.config.ts' ||
        path === 'vite.config.js' ||
        path.startsWith('dist/remote') ||
        path.startsWith('dist/assets/'));
}
export async function watchPluginSources(root, options) {
    const debounceMs = options.debounceMs ?? 150;
    const ignoreRemoteSources = options.ignoreRemoteSources === true;
    let baseline = await sourceDigest(root, ignoreRemoteSources);
    let timer;
    let reloading = false;
    let queued = false;
    const runReload = async () => {
        if (reloading) {
            queued = true;
            return;
        }
        reloading = true;
        try {
            do {
                queued = false;
                if (options.signal.aborted)
                    return;
                let observed;
                try {
                    observed = await sourceDigest(root, ignoreRemoteSources);
                }
                catch (error) {
                    options.onError?.(error);
                    return;
                }
                if (observed === baseline && !queued)
                    return;
                try {
                    await options.reload();
                }
                catch (error) {
                    options.onError?.(error);
                }
                baseline = observed;
                let after;
                try {
                    after = await sourceDigest(root, ignoreRemoteSources);
                }
                catch (error) {
                    options.onError?.(error);
                    return;
                }
                if (after !== observed)
                    queued = true;
            } while (queued && !options.signal.aborted);
        }
        finally {
            reloading = false;
        }
    };
    const trigger = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            void runReload();
        }, debounceMs);
    };
    const createWatcher = options.createWatcher ??
        ((directory, listener) => watch(directory, { recursive: true }, () => listener()));
    const watcher = createWatcher(root, trigger);
    options.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        watcher.close();
    }, { once: true });
    await new Promise((resolve) => {
        options.signal.addEventListener('abort', () => resolve(), { once: true });
    });
}
function isEnoent(error) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT');
}
async function sourceDigest(root, ignoreRemoteSources = false) {
    const hash = createHash('sha256');
    const files = [];
    async function visit(directory) {
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        }
        catch (error) {
            if (isEnoent(error) && directory !== root)
                return;
            throw error;
        }
        for (const entry of entries) {
            if (entry.isDirectory() && ignoredDirectories.has(entry.name))
                continue;
            const absolute = join(directory, entry.name);
            const path = relative(root, absolute).replaceAll('\\', '/');
            if (shouldIgnoreSource(path, ignoreRemoteSources))
                continue;
            if (entry.isDirectory())
                await visit(absolute);
            else if (entry.isFile())
                files.push(path);
        }
    }
    await visit(root);
    for (const path of files.sort()) {
        let content;
        try {
            content = await readFile(join(root, path));
        }
        catch (error) {
            if (isEnoent(error))
                continue;
            throw error;
        }
        hash.update(path).update('\0').update(content);
    }
    return hash.digest('hex');
}
