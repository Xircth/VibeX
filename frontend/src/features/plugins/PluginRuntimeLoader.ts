import * as PluginSdk from '@vibex/plugin-sdk';
import {
  createPluginContext,
  type HostCallTransport,
  type PluginComponent,
  serviceContainer,
  setDefaultHostCallTransport,
  setDefaultWorkerInvokeTransport,
} from '@vibex/plugin-sdk';
import * as ReactModule from 'react';
import { createElement } from 'react';
import * as ReactJsxRuntime from 'react/jsx-runtime';

import {
  clearPluginCrashState,
  recordPluginCrash,
  setPluginQuarantineHandler,
} from '@/components/plugins/PluginBoundary';
import {
  PluginSchemaSettingsForm,
  type PluginSettingsJsonSchema,
} from '@/components/plugins/PluginSchemaSettingsForm';
import { toast } from '@/components/ui/toast';
import { createPluginControlApi } from '@/lib/api/plugins';
import { configuredBackendTransport } from '@/lib/backendTransport';
import {
  activatePluginModule,
  deactivatePluginModule,
} from '@/lib/pluginFederation';

const defaultPluginApi = createPluginControlApi(configuredBackendTransport);

const defaultHostTransport: HostCallTransport = async <T>(
  pluginId: string,
  capability: string,
  operation: string,
  input?: unknown
): Promise<T> => {
  return await defaultPluginApi.hostCall<T>(
    pluginId,
    capability,
    operation,
    input
  );
};

setDefaultHostCallTransport(defaultHostTransport);
setDefaultWorkerInvokeTransport(async <T>(
  pluginId: string,
  handler: string,
  input?: unknown
): Promise<T> => {
  return (await defaultPluginApi.invokeContribution(
    pluginId,
    handler,
    input
  )) as T;
});

setPluginQuarantineHandler((pluginId, error) => {
  unloadPluginRuntime(pluginId);
  const reason = error?.message || 'Quarantined after repeated crashes';
  try {
    toast.error(`Plugin "${pluginId}" quarantined: ${reason}`);
  } catch {
    // Ignore toast errors in headless test environments.
  }
  void defaultPluginApi.quarantine(pluginId, reason).catch(() => undefined);
});

const SHARED_HOST_MODULES: Record<string, unknown> = {
  react: ReactModule,
  'react/jsx-runtime': ReactJsxRuntime,
  'react/jsx-dev-runtime': ReactJsxRuntime,
  '@vibex/plugin-sdk': PluginSdk,
  '@vibex/plugin-sdk/app': PluginSdk,
  '@vibex/plugin-sdk/context': PluginSdk,
  '@vibex/plugin-sdk/registry': PluginSdk,
  '@vibex/plugin-sdk/services': PluginSdk,
  '@vibex/plugin-sdk/hooks': PluginSdk,
  '@vibex/plugin-sdk/testing': PluginSdk,
};

if (typeof globalThis !== 'undefined') {
  const g = globalThis as Record<string, unknown>;
  g.__VIBEX_HOST_MODULES__ = SHARED_HOST_MODULES;
  if (!g.React) {
    g.React = ReactModule;
  }
}

function stripInlineTypeSpecifiers(braceClause: string): string {
  const inner = braceClause.slice(1, -1);
  const kept = inner
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !/^type\s+[A-Za-z0-9_$]/.test(part))
    .map((part) => part.replace(/\s+as\s+/g, ': '));
  return kept.length > 0 ? `{ ${kept.join(', ')} }` : '';
}

export function rewriteSharedBareImports(code: string): string {
  const sharedKeys = new Set(Object.keys(SHARED_HOST_MODULES));
  return code
    .replace(/^\s*import\s+type\s+[\s\S]*?\s+from\s+['"][^'"]+['"]\s*;?/gm, '')
    .replace(
      /^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm,
      (fullMatch, rawClause: string, specifier: string) => {
        const trimmedSpec = specifier.trim();
        if (!sharedKeys.has(trimmedSpec)) {
          return fullMatch;
        }
        const clause = rawClause.trim();
        const modExpr = `globalThis.__VIBEX_HOST_MODULES__[${JSON.stringify(trimmedSpec)}]`;
        if (clause.startsWith('* as ')) {
          const nsName = clause.slice('* as '.length).trim();
          return `const ${nsName} = ${modExpr};`;
        }
        if (clause.startsWith('{') && clause.endsWith('}')) {
          const destructured = stripInlineTypeSpecifiers(clause);
          return destructured ? `const ${destructured} = ${modExpr};` : '';
        }
        const braceIdx = clause.indexOf('{');
        if (braceIdx > 0) {
          const defaultName = clause
            .slice(0, braceIdx)
            .replace(/,\s*$/, '')
            .trim();
          const namedPart = stripInlineTypeSpecifiers(clause.slice(braceIdx));
          return namedPart
            ? `const ${defaultName} = ${modExpr}.default ?? ${modExpr}; const ${namedPart} = ${modExpr};`
            : `const ${defaultName} = ${modExpr}.default ?? ${modExpr};`;
        }
        return `const ${clause} = ${modExpr}.default ?? ${modExpr};`;
      }
    );
}

function hasPluginModuleExports(mod: unknown): boolean {
  if (!mod || typeof mod !== 'object') return false;
  const record = mod as Record<string, unknown>;
  return (
    typeof record.default === 'function' ||
    typeof record.activate === 'function' ||
    Boolean(
      record.default &&
        typeof record.default === 'object' &&
        typeof (record.default as Record<string, unknown>).activate ===
          'function'
    )
  );
}

export function evaluateSingleFileEsmModule(
  code: string
): Record<string, unknown> {
  const transformed = rewriteSharedBareImports(code)
    .replace(
      /^\s*export\s+default\s+async\s+function(?:\s+([A-Za-z0-9_$]+))?\s*\(/gm,
      (_m, name: string | undefined) =>
        `__exports.default = async function ${name ?? 'activate'}(`
    )
    .replace(
      /^\s*export\s+default\s+function(?:\s+([A-Za-z0-9_$]+))?\s*\(/gm,
      (_m, name: string | undefined) =>
        `__exports.default = function ${name ?? 'activate'}(`
    )
    .replace(/^\s*export\s+default\s+/gm, '__exports.default = ')
    .replace(
      /^\s*export\s+async\s+function\s+([A-Za-z0-9_$]+)\s*\(/gm,
      (_m, name: string) => `__exports.${name} = async function ${name}(`
    )
    .replace(
      /^\s*export\s+function\s+([A-Za-z0-9_$]+)\s*\(/gm,
      (_m, name: string) => `__exports.${name} = function ${name}(`
    )
    .replace(
      /^\s*export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/gm,
      (_m, name: string) => `const ${name} = __exports.${name} =`
    );

  const exportsObj: Record<string, unknown> = {};
  const runner = new Function('__exports', transformed) as (
    exp: Record<string, unknown>
  ) => void;
  runner(exportsObj);
  return exportsObj;
}

export interface DeclarativePluginSpec {
  id?: string;
  name?: string;
  version?: string;
  dependencies?: Array<{
    kind?: 'plugin' | 'runtime';
    id: string;
    publisher?: string;
    versionRange?: string;
    required?: boolean;
  }>;
  providers?: Array<{
    id: string;
    label: string;
    category?: string;
    baseUrl?: string;
    models?: string[];
    metadata?: Record<string, unknown>;
  }>;
  commands?: Array<{
    id: string;
    title: string;
    category?: string;
    icon?: string;
    shortcut?: string;
    handler?: () => void | Promise<void>;
  }>;
  toolbarItems?: Array<{
    id: string;
    label?: string;
    tooltip?: string;
    icon?: string;
    order?: number;
    component?: PluginComponent;
    onActivate?: () => void | Promise<void>;
  }>;
  statusBarItems?: Array<{
    id: string;
    label?: string;
    tooltip?: string;
    icon?: string;
    slot?: 'statusbar.items' | 'status.after-mcp' | string;
    order?: number;
    component?: PluginComponent;
    onActivate?: () => void | Promise<void>;
  }>;
  railSections?: Array<{
    id: string;
    label?: string;
    tooltip?: string;
    icon?: string;
    order?: number;
    panelId?: string;
    onActivate?: () => void | Promise<void>;
  }>;
  panels?: Array<{
    id: string;
    title: string;
    icon?: string;
    zone?: 'left' | 'editor' | 'bottom' | 'session';
    multiInstance?: boolean;
    order?: number;
    component?: PluginComponent;
  }>;
  tabs?: Array<{
    id: string;
    title: string;
    icon?: string;
    order?: number;
    component?: PluginComponent;
  }>;
  kanbanViews?: Array<{
    id: string;
    title: string;
    titleKey?: string;
    icon?: string;
    hidesBottomDock?: boolean;
    order?: number;
    component?: PluginComponent;
  }>;
  settingsPages?: Array<{
    id: string;
    title: string;
    description?: string;
    group?: string;
    icon?: string;
    order?: number;
    schema?: PluginSettingsJsonSchema | Record<string, unknown>;
    component?: PluginComponent;
  }>;
  settingsSections?: Array<{
    id: string;
    title: string;
    description?: string;
    category?: string;
    icon?: string;
    order?: number;
    schema?: PluginSettingsJsonSchema | Record<string, unknown>;
    component?: PluginComponent;
  }>;
  settingsSchema?: PluginSettingsJsonSchema | Record<string, unknown>;
  composerActions?: Array<{
    id: string;
    label?: string;
    title?: string;
    tooltip?: string;
    prompt?: string;
    icon?: string;
    order?: number;
    onActivate?: () => void | Promise<void>;
  }>;
  slashCommands?: Array<{
    id: string;
    name: string;
    title?: string;
    description: string;
    prompt?: string;
    argumentHint?: string;
    execute?: (args: string) => void | string | Promise<void | string>;
  }>;
  themes?: Array<{
    id: string;
    label: string;
    scheme: 'light' | 'dark';
    cssVariables: Record<string, string>;
  }>;
  css?: string;
}

const activeStyleNodes = new Map<string, HTMLStyleElement>();
const activeBlobUrls = new Map<string, string>();
const activeDeclarativeDisposers = new Map<string, () => void>();
const activeDependencyWatchers = new Map<string, () => void>();
const activeMarkerDisposers = new Map<string, () => void>();
const activePluginIds = new Set<string>();

function providePluginActiveMarker(pluginId: string): () => void {
  activeMarkerDisposers.get(pluginId)?.();
  const dispose = serviceContainer.provide(
    `plugin.active:${pluginId}`,
    { pluginId, active: true },
    pluginId
  );
  const cleanup = () => {
    dispose();
    if (activeMarkerDisposers.get(pluginId) === cleanup) {
      activeMarkerDisposers.delete(pluginId);
    }
  };
  activeMarkerDisposers.set(pluginId, cleanup);
  return cleanup;
}

function requiredPluginDependencyIds(
  spec?: DeclarativePluginSpec
): string[] {
  if (!spec?.dependencies?.length) return [];
  return spec.dependencies
    .filter((dep) => (dep.kind ?? 'plugin') === 'plugin' && dep.required !== false && dep.id.trim().length > 0)
    .map((dep) => dep.id.trim());
}

export function injectPluginCss(pluginId: string, cssText: string): () => void {
  removePluginCss(pluginId);
  if (typeof document === 'undefined' || !cssText.trim()) {
    return () => undefined;
  }
  const style = document.createElement('style');
  style.setAttribute('data-vibex-plugin', pluginId);
  style.textContent = `@layer vibex-plugins {\n${cssText}\n}`;
  document.head.appendChild(style);
  activeStyleNodes.set(pluginId, style);
  return () => removePluginCss(pluginId);
}

export function removePluginCss(pluginId: string): void {
  const existing = activeStyleNodes.get(pluginId);
  if (existing) {
    existing.remove();
    activeStyleNodes.delete(pluginId);
  }
}

function createSchemaSettingsComponent(
  pluginId: string,
  schema: PluginSettingsJsonSchema | Record<string, unknown>,
  title?: string,
  description?: string,
  callHost?: HostCallTransport
): PluginComponent {
  return function DeclarativeSchemaSettingsView() {
    return createElement(PluginSchemaSettingsForm, {
      pluginId,
      schema,
      title,
      description,
      callHost,
    });
  };
}

export function applyDeclarativePlugin(
  pluginId: string,
  spec: DeclarativePluginSpec,
  options?: { callHost?: HostCallTransport }
): () => void {
  activeDeclarativeDisposers.get(pluginId)?.();
  const callHost = options?.callHost ?? defaultHostTransport;
  const ctx = createPluginContext({
    pluginId,
    callHost,
  });

  if (spec.css) {
    injectPluginCss(pluginId, spec.css);
  }

  for (const provider of spec.providers ?? []) {
    ctx.registerProvider({
      id: provider.id,
      label: provider.label,
      category: provider.category,
      baseUrl: provider.baseUrl,
      models: provider.models,
      metadata: provider.metadata,
    });
  }

  for (const command of spec.commands ?? []) {
    ctx.ui.registerCommand({
      id: command.id,
      title: command.title,
      category: command.category,
      icon: command.icon,
      shortcut: command.shortcut,
      handler:
        command.handler ??
        (async () => {
          await defaultPluginApi.invokeContribution(pluginId, command.id);
        }),
    });
  }

  for (const item of spec.toolbarItems ?? []) {
    ctx.ui.registerToolbarItem({
      id: item.id,
      label: item.label,
      tooltip: item.tooltip,
      icon: item.icon,
      order: item.order,
      component: item.component,
      onActivate:
        item.onActivate ??
        (async () => {
          await defaultPluginApi.invokeContribution(pluginId, item.id);
        }),
    });
  }

  for (const item of spec.statusBarItems ?? []) {
    ctx.ui.registerStatusBarItem({
      id: item.id,
      label: item.label,
      tooltip: item.tooltip,
      icon: item.icon,
      slot: item.slot,
      order: item.order,
      component: item.component,
      onActivate:
        item.onActivate ??
        (async () => {
          await defaultPluginApi.invokeContribution(pluginId, item.id);
        }),
    });
  }

  for (const rail of spec.railSections ?? []) {
    ctx.ui.registerRailSection({
      id: rail.id,
      label: rail.label,
      tooltip: rail.tooltip,
      icon: rail.icon,
      order: rail.order,
      metadata: rail.panelId
        ? { opens: { kind: 'panel', id: rail.panelId } }
        : undefined,
      onActivate: rail.onActivate,
    });
  }

  for (const panel of spec.panels ?? []) {
    ctx.ui.registerPanel({
      id: panel.id,
      title: panel.title,
      icon: panel.icon,
      zone: panel.zone,
      multiInstance: panel.multiInstance,
      order: panel.order,
      component: panel.component,
    });
  }

  for (const tab of spec.tabs ?? []) {
    ctx.ui.registerTab({
      id: tab.id,
      title: tab.title,
      icon: tab.icon,
      order: tab.order,
      component: tab.component,
    });
  }

  for (const view of spec.kanbanViews ?? []) {
    ctx.ui.registerKanbanView({
      id: view.id,
      title: view.title,
      titleKey: view.titleKey,
      icon: view.icon,
      hidesBottomDock: view.hidesBottomDock,
      order: view.order,
      component: view.component,
    });
  }

  for (const page of spec.settingsPages ?? []) {
    const component =
      page.component ??
      (page.schema
        ? createSchemaSettingsComponent(
            pluginId,
            page.schema,
            page.title,
            page.description,
            callHost
          )
        : undefined);
    ctx.ui.registerSettingsPage({
      id: page.id,
      title: page.title,
      description: page.description,
      group: page.group,
      icon: page.icon,
      order: page.order,
      schema: page.schema,
      component,
    });
  }

  for (const section of spec.settingsSections ?? []) {
    const component =
      section.component ??
      (section.schema
        ? createSchemaSettingsComponent(
            pluginId,
            section.schema,
            section.title,
            section.description,
            callHost
          )
        : undefined);
    ctx.ui.registerSettingsSection({
      id: section.id,
      title: section.title,
      description: section.description,
      category: section.category,
      icon: section.icon,
      order: section.order,
      component,
    });
  }

  if (
    spec.settingsSchema &&
    (spec.settingsPages?.length ?? 0) === 0 &&
    (spec.settingsSections?.length ?? 0) === 0
  ) {
    const schemaTitle =
      typeof (spec.settingsSchema as PluginSettingsJsonSchema).title ===
      'string'
        ? (spec.settingsSchema as PluginSettingsJsonSchema).title!
        : pluginId;
    const schemaDescription =
      typeof (spec.settingsSchema as PluginSettingsJsonSchema).description ===
      'string'
        ? (spec.settingsSchema as PluginSettingsJsonSchema).description
        : undefined;
    const component = createSchemaSettingsComponent(
      pluginId,
      spec.settingsSchema,
      schemaTitle,
      schemaDescription,
      callHost
    );
    ctx.ui.registerSettingsSection({
      id: 'settings',
      title: schemaTitle,
      description: schemaDescription,
      component,
    });
    ctx.ui.registerSettingsPage({
      id: 'settings',
      title: schemaTitle,
      description: schemaDescription,
      schema: spec.settingsSchema,
      component,
    });
  }

  for (const action of spec.composerActions ?? []) {
    ctx.ui.registerComposerAction({
      id: action.id,
      label: action.label ?? action.title ?? action.id,
      tooltip: action.tooltip,
      icon: action.icon,
      order: action.order,
      metadata: {
        ...(action.title ? { title: action.title } : {}),
        ...(action.prompt ? { prompt: action.prompt } : {}),
      },
      onActivate: action.onActivate,
    });
  }

  for (const slash of spec.slashCommands ?? []) {
    ctx.ui.registerComposerSlash({
      id: slash.id,
      name: slash.name,
      title: slash.title,
      description: slash.description,
      prompt: slash.prompt,
      argumentHint: slash.argumentHint,
      execute:
        slash.execute ??
        (slash.prompt
          ? () => slash.prompt!
          : async (args: string) => {
              await defaultPluginApi.invokeContribution(pluginId, slash.id, {
                args,
              });
            }),
    });
  }

  for (const theme of spec.themes ?? []) {
    ctx.registerTheme({
      id: theme.id,
      label: theme.label,
      scheme: theme.scheme,
      cssVariables: theme.cssVariables,
    });
  }

  const dispose = () => {
    activeDeclarativeDisposers.delete(pluginId);
    removePluginCss(pluginId);
    ctx.dispose();
  };
  activeDeclarativeDisposers.set(pluginId, dispose);
  return dispose;
}

export type PluginRuntimeSource =
  | {
      kind: 'module';
      module: unknown;
      css?: string;
      spec?: DeclarativePluginSpec;
    }
  | {
      kind: 'esm-url';
      entryUrl: string;
      css?: string;
      spec?: DeclarativePluginSpec;
    }
  | {
      kind: 'esm-code';
      code: string;
      css?: string;
      spec?: DeclarativePluginSpec;
    }
  | { kind: 'declarative'; spec: DeclarativePluginSpec; css?: string };

export async function loadPluginRuntime(
  pluginId: string,
  source: PluginRuntimeSource,
  options?: { callHost?: HostCallTransport; generation?: number }
): Promise<() => void> {
  activePluginIds.add(pluginId);
  activeDependencyWatchers.get(pluginId)?.();
  activeDependencyWatchers.delete(pluginId);

  const requiredDeps = requiredPluginDependencyIds(source.spec);
  if (requiredDeps.length > 0) {
    const depServiceKeys = requiredDeps.map((id) => `plugin.active:${id}`);
    let currentInstanceDispose: (() => void) | undefined;
    let initialActivationPromise: Promise<void> | undefined;
    let cancelled = false;
    const stopWatch = serviceContainer.inject(depServiceKeys, () => {
      let active = true;
      const p = loadPluginRuntimeImmediate(pluginId, source, options)
        .then((dispose) => {
          if (!active || cancelled) {
            dispose();
          } else {
            currentInstanceDispose = dispose;
          }
        })
        .catch(() => undefined);
      if (!initialActivationPromise) {
        initialActivationPromise = p;
      }
      return () => {
        active = false;
        if (currentInstanceDispose) {
          const prev = currentInstanceDispose;
          currentInstanceDispose = undefined;
          prev();
        } else {
          unloadPluginRuntimeImmediate(pluginId);
        }
      };
    });
    if (initialActivationPromise) {
      await initialActivationPromise;
    }
    const fullDispose = () => {
      cancelled = true;
      activeDependencyWatchers.delete(pluginId);
      activePluginIds.delete(pluginId);
      stopWatch();
    };
    activeDependencyWatchers.set(pluginId, fullDispose);
    return fullDispose;
  }

  return await loadPluginRuntimeImmediate(pluginId, source, options);
}

async function loadPluginRuntimeImmediate(
  pluginId: string,
  source: PluginRuntimeSource,
  options?: { callHost?: HostCallTransport; generation?: number }
): Promise<() => void> {
  if (source.kind === 'declarative') {
    const mergedSpec =
      source.css && !source.spec.css
        ? { ...source.spec, css: source.css }
        : source.spec;
    const disposeDecl = applyDeclarativePlugin(pluginId, mergedSpec, options);
    clearPluginCrashState(pluginId);
    const disposeMarker = providePluginActiveMarker(pluginId);
    return () => {
      disposeMarker();
      disposeDecl();
    };
  }

  let disposeDeclarative: (() => void) | undefined;
  try {
    if (source.spec) {
      disposeDeclarative = applyDeclarativePlugin(
        pluginId,
        source.spec,
        options
      );
    }
    if (source.css) {
      injectPluginCss(pluginId, source.css);
    }

    let mod: unknown;
    if (source.kind === 'module') {
      mod = source.module;
    } else if (source.kind === 'esm-code') {
      const prevBlob = activeBlobUrls.get(pluginId);
      if (prevBlob && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(prevBlob);
      }
      const rewrittenCode = rewriteSharedBareImports(source.code);
      if (
        typeof URL !== 'undefined' &&
        typeof URL.createObjectURL === 'function'
      ) {
        const blob = new Blob([rewrittenCode], { type: 'text/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        activeBlobUrls.set(pluginId, blobUrl);
        try {
          mod = await import(/* @vite-ignore */ blobUrl);
        } catch {
          mod = undefined;
        }
      }
      if (!hasPluginModuleExports(mod)) {
        mod = evaluateSingleFileEsmModule(source.code);
      }
    } else {
      mod = await import(/* @vite-ignore */ source.entryUrl);
    }

    const disposeModule = await activatePluginModule(pluginId, mod, {
      callHost: options?.callHost ?? defaultHostTransport,
    });
    clearPluginCrashState(pluginId);
    const disposeMarker = providePluginActiveMarker(pluginId);
    return () => {
      disposeMarker();
      disposeDeclarative?.();
      disposeModule();
      removePluginCss(pluginId);
      const blobUrl = activeBlobUrls.get(pluginId);
      if (blobUrl && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(blobUrl);
        activeBlobUrls.delete(pluginId);
      }
    };
  } catch (error) {
    disposeDeclarative?.();
    removePluginCss(pluginId);
    const normalized =
      error instanceof Error ? error : new Error(String(error ?? 'Load error'));
    recordPluginCrash(pluginId, normalized);
    throw normalized;
  }
}

function unloadPluginRuntimeImmediate(pluginId: string): void {
  activeMarkerDisposers.get(pluginId)?.();
  activeDeclarativeDisposers.get(pluginId)?.();
  deactivatePluginModule(pluginId);
  removePluginCss(pluginId);
  const blobUrl = activeBlobUrls.get(pluginId);
  if (blobUrl && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(blobUrl);
    activeBlobUrls.delete(pluginId);
  }
}

export function unloadPluginRuntime(pluginId: string): void {
  activePluginIds.delete(pluginId);
  activeDependencyWatchers.get(pluginId)?.();
  activeDependencyWatchers.delete(pluginId);
  unloadPluginRuntimeImmediate(pluginId);
}

export function unloadAllPluginRuntimes(): void {
  const allIds = new Set<string>([
    ...activePluginIds,
    ...activeDependencyWatchers.keys(),
    ...activeDeclarativeDisposers.keys(),
    ...activeMarkerDisposers.keys(),
  ]);
  for (const pluginId of allIds) {
    unloadPluginRuntime(pluginId);
  }
}

export const pluginRuntimeLoader = {
  async activateModule(
    pluginId: string,
    module: unknown,
    options?: {
      spec?: DeclarativePluginSpec;
      css?: string;
      callHost?: HostCallTransport;
      generation?: number;
    }
  ): Promise<() => void> {
    return await loadPluginRuntime(
      pluginId,
      {
        kind: 'module',
        module,
        spec: options?.spec,
        css: options?.css,
      },
      options
    );
  },
  deactivate(pluginId: string): void {
    unloadPluginRuntime(pluginId);
  },
  deactivateAll(): void {
    unloadAllPluginRuntimes();
  },
};
