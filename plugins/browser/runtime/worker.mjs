import { definePluginWorker } from '@vibex/plugin-sdk';

const KV_SETTINGS_KEY = 'browser_runtime_settings_v1';

const DEFAULT_BROWSER_SETTINGS = {
  defaultTarget: {
    transcript: 'builtin',
    toolCard: 'builtin',
    terminal: 'builtin',
    editor: 'builtin',
    notification: 'builtin',
  },
  hostRules: [],
  toolsEnabled: true,
  defaultGrant: 'control',
  originGrants: {},
  evalEnabled: true,
  evalApproval: 'ask',
  serviceAutoOpen: 'toast',
  terminalClickMenu: true,
  devtools: true,
  surfaceOverride: 'auto',
  suspendBackgroundTabs: true,
  signInUserAgent: true,
  profiles: [{ id: 'default', label: '默认' }],
  newTabProfile: 'default',
};

function pickTarget(val, fallback) {
  return val === 'builtin' || val === 'system' || val === 'ask'
    ? val
    : fallback;
}

function normalizeBrowserSettings(
  raw = {},
  fallback = DEFAULT_BROWSER_SETTINGS
) {
  const base = { ...DEFAULT_BROWSER_SETTINGS, ...fallback };
  const obj =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw.settings &&
        typeof raw.settings === 'object' &&
        !Array.isArray(raw.settings)
        ? raw.settings
        : raw
      : {};

  const rawTargets =
    obj.defaultTarget &&
    typeof obj.defaultTarget === 'object' &&
    !Array.isArray(obj.defaultTarget)
      ? obj.defaultTarget
      : base.defaultTarget;

  const hostRulesSource = Array.isArray(obj.hostRules)
    ? obj.hostRules
    : Array.isArray(obj.rules)
      ? obj.rules
      : base.hostRules;

  const hostRules = hostRulesSource.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const pattern = String(item.pattern ?? item.hostPattern ?? '').trim();
    const rawAction = String(item.action ?? item.mode ?? '').trim();
    const action =
      rawAction === 'block' || rawAction === 'deny'
        ? 'block'
        : rawAction === 'system' || rawAction === 'confirm_writes'
          ? 'system'
          : rawAction === 'builtin' || rawAction === 'allow'
            ? 'builtin'
            : null;
    if (!pattern || !action) return [];
    return [{ pattern, action }];
  });

  const defaultGrant =
    obj.defaultGrant === 'none' ||
    obj.defaultGrant === 'read' ||
    obj.defaultGrant === 'control'
      ? obj.defaultGrant
      : base.defaultGrant;

  const originGrants = {};
  const originSource =
    obj.originGrants &&
    typeof obj.originGrants === 'object' &&
    !Array.isArray(obj.originGrants)
      ? obj.originGrants
      : base.originGrants;
  if (originSource && typeof originSource === 'object') {
    for (const [k, v] of Object.entries(originSource)) {
      if (v === 'none' || v === 'read' || v === 'control') {
        originGrants[k] = v;
      }
    }
  }

  const profilesSource = Array.isArray(obj.profiles)
    ? obj.profiles
    : base.profiles;
  const seenProfiles = new Set();
  const profiles = [];
  for (const item of profilesSource) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id ?? '').trim();
    const rawLabel = String(item.label ?? '').trim();
    const label =
      id === 'default' &&
      (!rawLabel || rawLabel === 'Default' || rawLabel === 'default')
        ? '默认'
        : rawLabel;
    if (!id || !label || id === 'ephemeral' || seenProfiles.has(id)) continue;
    seenProfiles.add(id);
    profiles.push({ id, label });
  }
  if (!seenProfiles.has('default')) {
    profiles.unshift({ id: 'default', label: '默认' });
  }

  const candidateProfile = String(
    obj.newTabProfile ?? base.newTabProfile ?? 'default'
  ).trim();
  const newTabProfile =
    candidateProfile === 'ephemeral' ||
    profiles.some((p) => p.id === candidateProfile)
      ? candidateProfile
      : 'default';

  return {
    defaultTarget: {
      transcript: pickTarget(
        rawTargets?.transcript,
        base.defaultTarget.transcript
      ),
      toolCard: pickTarget(rawTargets?.toolCard, base.defaultTarget.toolCard),
      terminal: pickTarget(rawTargets?.terminal, base.defaultTarget.terminal),
      editor: pickTarget(rawTargets?.editor, base.defaultTarget.editor),
      notification: pickTarget(
        rawTargets?.notification,
        base.defaultTarget.notification
      ),
    },
    hostRules,
    toolsEnabled:
      typeof obj.toolsEnabled === 'boolean'
        ? obj.toolsEnabled
        : base.toolsEnabled,
    defaultGrant,
    originGrants,
    evalEnabled:
      typeof obj.evalEnabled === 'boolean' ? obj.evalEnabled : base.evalEnabled,
    evalApproval:
      obj.evalApproval === 'silent' || obj.evalApproval === 'ask'
        ? obj.evalApproval
        : base.evalApproval,
    serviceAutoOpen:
      obj.serviceAutoOpen === 'off' ||
      obj.serviceAutoOpen === 'toast' ||
      obj.serviceAutoOpen === 'auto'
        ? obj.serviceAutoOpen
        : base.serviceAutoOpen,
    terminalClickMenu:
      typeof obj.terminalClickMenu === 'boolean'
        ? obj.terminalClickMenu
        : base.terminalClickMenu,
    devtools:
      typeof obj.devtools === 'boolean' ? obj.devtools : base.devtools,
    surfaceOverride:
      obj.surfaceOverride === 'window' || obj.surfaceOverride === 'auto'
        ? obj.surfaceOverride
        : base.surfaceOverride,
    suspendBackgroundTabs:
      typeof obj.suspendBackgroundTabs === 'boolean'
        ? obj.suspendBackgroundTabs
        : base.suspendBackgroundTabs,
    signInUserAgent:
      typeof obj.signInUserAgent === 'boolean'
        ? obj.signInUserAgent
        : base.signInUserAgent,
    profiles,
    newTabProfile,
  };
}

function slugifyProfileId(raw) {
  const text = String(raw ?? '').trim();
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (ascii && /^[a-z0-9]/.test(ascii)) {
    return ascii.slice(0, 36);
  }
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `profile-${(hash >>> 0).toString(16)}`;
}

function extractOrigin(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin;
    }
  } catch {
    // Ignore invalid URLs
  }
  return null;
}

function rethrowNavigationPolicy(error, url) {
  const msg = String(error?.message ?? error?.code ?? error ?? '');
  if (msg.includes('browser_use_system_browser')) {
    throw new Error(
      `browser_use_system_browser: 站点规则要求用系统浏览器打开 (${url})`
    );
  }
  if (
    msg.includes('browser_blocked_by_policy') ||
    msg.includes('browser_navigation_blocked')
  ) {
    throw new Error(
      `browser_navigation_blocked: 该站点已被站点规则禁止访问 (${url})`
    );
  }
  throw error;
}

function isUnimplementedError(error) {
  const text = String(error?.message ?? error?.code ?? error ?? '');
  return (
    text.includes('capability_unimplemented') ||
    text.includes('is not implemented') ||
    text.includes('browser_unsupported_operation')
  );
}

export default definePluginWorker((registrar, environment) => {
  let cachedSettings = normalizeBrowserSettings(DEFAULT_BROWSER_SETTINGS);
  const tabGrants = new Map();
  const tabOrigins = new Map();
  const tabVisibility = new Map();
  const suspendedTabs = new Set();

  const overlayTabRecord = (tab, settings = cachedSettings) => {
    if (!tab || typeof tab !== 'object' || !tab.tabId) return tab;
    const tabId = String(tab.tabId);
    const origin =
      tab.origin || extractOrigin(tab.url) || tabOrigins.get(tabId) || null;
    if (origin) {
      tabOrigins.set(tabId, origin);
    }
    if (!settings.toolsEnabled) {
      return {
        ...tab,
        origin,
        grant: null,
      };
    }
    if (tabGrants.has(tabId)) {
      const stored = tabGrants.get(tabId);
      if (!stored || stored.level === 'none') {
        return {
          ...tab,
          origin,
          grant: null,
        };
      }
      return {
        ...tab,
        origin,
        grant: {
          level: stored.level,
          origin: stored.origin || origin || tab.url || 'about:blank',
          grantedAt: stored.grantedAt || Date.now(),
        },
      };
    }
    if (tab.grant && typeof tab.grant === 'object' && tab.grant.level) {
      tabGrants.set(tabId, {
        level: tab.grant.level,
        origin: tab.grant.origin || origin || tab.url || 'about:blank',
        grantedAt: tab.grant.grantedAt || Date.now(),
      });
    }
    return {
      ...tab,
      origin,
    };
  };

  const loadSettings = async () => {
    let fileConfig = {};
    let kvConfig = {};
    let hostConfig = {};

    try {
      const cfg = await environment.host.call('storage', 'settings.get', {});
      if (cfg && typeof cfg === 'object') {
        fileConfig = cfg;
      }
    } catch {
      // Ignore in test harnesses without storage.
    }

    try {
      const kv = await environment.host.call('storage', 'kv.get', {
        key: KV_SETTINGS_KEY,
      });
      if (kv && typeof kv === 'object') {
        kvConfig = kv;
      }
    } catch {
      // Ignore in test harnesses without kv.
    }

    try {
      const nativeSettings = await environment.host.call(
        'browser',
        'settings.get',
        {}
      );
      if (nativeSettings && typeof nativeSettings === 'object') {
        hostConfig = nativeSettings;
      }
    } catch {
      // Pre-0.2.9 host binaries may not implement browser.settings.get.
    }

    const merged = normalizeBrowserSettings(
      {
        ...fileConfig,
        ...hostConfig,
        ...kvConfig,
      },
      cachedSettings
    );
    cachedSettings = merged;
    return merged;
  };

  const persistSettings = async (nextRaw) => {
    const prevSignInUa = cachedSettings.signInUserAgent;
    const normalized = normalizeBrowserSettings(nextRaw, cachedSettings);
    cachedSettings = normalized;

    try {
      await environment.host.call('storage', 'kv.put', {
        key: KV_SETTINGS_KEY,
        value: normalized,
      });
    } catch {
      // Ignore kv errors in read-only test harnesses.
    }

    try {
      await environment.host.call('storage', 'settings.put', normalized);
    } catch {
      // Ignore config.json write errors in read-only bundles.
    }

    try {
      const hostSaved = await environment.host.call(
        'browser',
        'settings.set',
        normalized
      );
      if (hostSaved && typeof hostSaved === 'object') {
        cachedSettings = normalizeBrowserSettings(hostSaved, normalized);
      }
    } catch {
      // Pre-0.2.9 host binaries may not implement browser.settings.set.
    }

    if (prevSignInUa !== cachedSettings.signInUserAgent) {
      try {
        const listed = await environment.host.call('browser', 'tab.list', {});
        const tabs = Array.isArray(listed?.tabs) ? listed.tabs : [];
        for (const tab of tabs) {
          if (tab?.tabId) {
            await environment.host
              .call('browser', 'tab.device', {
                tabId: tab.tabId,
                device: 'desktop',
              })
              .catch(() => {});
          }
        }
      } catch {
        // Ignore
      }
    }

    return cachedSettings;
  };

  const syncHostSettings = async () => {
    try {
      const loaded = await loadSettings();
      await environment.host.call('browser', 'settings.set', loaded);
    } catch {
      // Host browser or storage may not be ready in unit-test harnesses.
    }
  };

  void syncHostSettings();

  const handleBrowserDispatch = async (input) => {
    const body = input && typeof input === 'object' ? input : {};
    const operation =
      typeof body.operation === 'string' ? body.operation : '';
    const payload =
      body.input && typeof body.input === 'object' ? body.input : {};

    if (operation === 'bootstrap') {
      const settings = await loadSettings();
      let capabilities = null;
      let tabs = [];
      try {
        capabilities = await environment.host.call(
          'browser',
          'capabilities',
          {}
        );
      } catch {
        // Ignore
      }
      try {
        const listed = await environment.host.call('browser', 'tab.list', {});
        if (Array.isArray(listed?.tabs)) {
          tabs = listed.tabs.map((tab) => overlayTabRecord(tab, settings));
        }
      } catch {
        // Ignore
      }
      return {
        settings,
        capabilities,
        tabs,
      };
    }

    if (operation === 'tab.list') {
      const settings = await loadSettings();
      const listed = await environment.host.call('browser', 'tab.list', payload);
      if (listed && Array.isArray(listed.tabs)) {
        return {
          ...listed,
          tabs: listed.tabs.map((tab) => overlayTabRecord(tab, settings)),
        };
      }
      return listed;
    }

    if (operation === 'settings.get') {
      return await loadSettings();
    }

    if (operation === 'settings.set') {
      const current = await loadSettings();
      const patch =
        payload.settings && typeof payload.settings === 'object'
          ? payload.settings
          : payload;
      return await persistSettings({
        ...current,
        ...patch,
        defaultTarget: patch.defaultTarget
          ? { ...current.defaultTarget, ...patch.defaultTarget }
          : current.defaultTarget,
      });
    }

    if (operation === 'policy.setRules') {
      const current = await loadSettings();
      const updated = await persistSettings({
        ...current,
        hostRules: Array.isArray(payload.rules)
          ? payload.rules
          : current.hostRules,
      });
      try {
        return await environment.host.call('browser', 'policy.setRules', {
          rules: updated.hostRules,
        });
      } catch {
        return {
          source: 'user',
          enabled: true,
          path: null,
          managedRules: [],
          rulesCount: updated.hostRules.length,
        };
      }
    }

    if (operation === 'profile.list') {
      const current = await loadSettings();
      return {
        profiles: current.profiles,
        newTabProfile: current.newTabProfile,
      };
    }

    if (operation === 'profile.create') {
      const label = String(payload.label ?? '').trim();
      if (!label) {
        throw new Error('browser_invalid: 请输入配置文件名称');
      }
      const reserved =
        label === '无痕' ||
        label.toLowerCase() === 'ephemeral' ||
        label.toLowerCase() === 'incognito';
      const baseSlug = slugifyProfileId(payload.id ?? label);
      if (reserved || baseSlug === 'ephemeral') {
        throw new Error(
          'browser_invalid: 「无痕」是内置配置文件，可在「新标签页使用」中直接选择'
        );
      }
      const current = await loadSettings();
      let candidate = baseSlug;
      let seq = 2;
      while (current.profiles.some((p) => p.id === candidate)) {
        candidate = `${baseSlug}-${seq}`;
        seq += 1;
      }
      const record = { id: candidate, label };
      try {
        const created = await environment.host.call(
          'browser',
          'profile.create',
          record
        );
        const finalRecord =
          created && typeof created === 'object' && created.id
            ? { id: String(created.id), label }
            : record;
        const nextProfiles = [
          ...current.profiles.filter((p) => p.id !== finalRecord.id),
          finalRecord,
        ];
        await persistSettings({
          ...current,
          profiles: nextProfiles,
        });
        return finalRecord;
      } catch (error) {
        if (
          !isUnimplementedError(error) &&
          !String(error?.message ?? error).includes('browser_invalid')
        ) {
          throw error;
        }
        await persistSettings({
          ...current,
          profiles: [...current.profiles, record],
        });
        return record;
      }
    }

    if (operation === 'profile.clear') {
      const profileId = String(payload.profileId ?? '').trim();
      if (!profileId) {
        throw new Error('browser_invalid: profileId is required');
      }
      try {
        return await environment.host.call('browser', 'profile.clear', {
          profileId,
        });
      } catch (error) {
        if (!isUnimplementedError(error)) throw error;
        try {
          const listed = await environment.host.call('browser', 'tab.list', {});
          const tabs = Array.isArray(listed?.tabs) ? listed.tabs : [];
          for (const tab of tabs) {
            if (tab?.profileId === profileId && tab?.tabId) {
              await environment.host
                .call('browser', 'tab.close', { tabId: tab.tabId })
                .catch(() => {});
            }
          }
        } catch {
          // Ignore tab cleanup failure
        }
        return { cleared: true, profileId };
      }
    }

    if (operation === 'profile.remove') {
      const profileId = String(payload.profileId ?? '').trim();
      if (!profileId || profileId === 'default') {
        throw new Error(
          'browser_invalid: the default profile cannot be removed'
        );
      }
      try {
        const removed = await environment.host.call(
          'browser',
          'profile.remove',
          { profileId }
        );
        const nextProfiles = cachedSettings.profiles.filter(
          (p) => p.id !== profileId
        );
        const nextNewTabProfile =
          cachedSettings.newTabProfile === profileId
            ? 'default'
            : cachedSettings.newTabProfile;
        await persistSettings({
          ...cachedSettings,
          profiles: nextProfiles,
          newTabProfile: nextNewTabProfile,
        });
        return removed;
      } catch (error) {
        if (!isUnimplementedError(error)) throw error;
        try {
          const listed = await environment.host.call('browser', 'tab.list', {});
          const tabs = Array.isArray(listed?.tabs) ? listed.tabs : [];
          for (const tab of tabs) {
            if (tab?.profileId === profileId && tab?.tabId) {
              await environment.host
                .call('browser', 'tab.close', { tabId: tab.tabId })
                .catch(() => {});
            }
          }
        } catch {
          // Ignore
        }
        const current = await loadSettings();
        const nextProfiles = current.profiles.filter((p) => p.id !== profileId);
        const nextNewTabProfile =
          current.newTabProfile === profileId
            ? 'default'
            : current.newTabProfile;
        const saved = await persistSettings({
          ...current,
          profiles: nextProfiles,
          newTabProfile: nextNewTabProfile,
        });
        return {
          removed: true,
          profileId,
          profiles: saved.profiles,
          newTabProfile: saved.newTabProfile,
        };
      }
    }

    if (operation === 'tab.create') {
      const current = await loadSettings();
      const targetUrl = String(payload.url ?? 'about:blank').trim();

      const origin = extractOrigin(targetUrl);
      const isUiPanelCreate = Boolean(payload.bounds);
      let effectiveLevel = current.defaultGrant || 'control';
      if (!current.toolsEnabled) {
        effectiveLevel = 'none';
      } else if (origin && current.originGrants[origin]) {
        effectiveLevel = current.originGrants[origin];
      } else if (
        !isUiPanelCreate &&
        (payload.grant === 'none' ||
          payload.grant === 'read' ||
          payload.grant === 'control')
      ) {
        effectiveLevel = payload.grant;
      }

      const nextPayload = {
        ...payload,
        profileId: payload.profileId || current.newTabProfile || 'default',
        grant: effectiveLevel,
      };
      let created;
      try {
        created = await environment.host.call(
          'browser',
          'tab.create',
          nextPayload
        );
      } catch (error) {
        rethrowNavigationPolicy(error, targetUrl);
      }
      if (created && typeof created === 'object' && created.tabId) {
        const tabId = String(created.tabId);
        const resolvedOrigin = created.origin || origin || null;
        if (resolvedOrigin) {
          tabOrigins.set(tabId, resolvedOrigin);
        }
        if (effectiveLevel === 'none') {
          tabGrants.set(tabId, null);
        } else {
          tabGrants.set(tabId, {
            level: effectiveLevel,
            origin: resolvedOrigin || targetUrl || 'about:blank',
            grantedAt: Date.now(),
          });
        }
        if (effectiveLevel !== 'control') {
          await environment.host
            .call('browser', 'grant.set', {
              tabId,
              level: effectiveLevel,
            })
            .catch(() => {});
        }
        return overlayTabRecord(created, current);
      }
      return created;
    }

    if (operation === 'tab.navigate') {
      const current = await loadSettings();
      const targetUrl = String(payload.url ?? '').trim();
      let navigated;
      try {
        navigated = await environment.host.call(
          'browser',
          'tab.navigate',
          payload
        );
      } catch (error) {
        rethrowNavigationPolicy(error, targetUrl);
      }
      if (navigated && typeof navigated === 'object' && navigated.tabId) {
        const tabId = String(navigated.tabId);
        const newOrigin =
          navigated.origin || extractOrigin(targetUrl) || tabOrigins.get(tabId);
        if (newOrigin) {
          tabOrigins.set(tabId, newOrigin);
        }
        if (newOrigin && current.originGrants[newOrigin]) {
          const rememberedLevel = current.originGrants[newOrigin];
          tabGrants.set(
            tabId,
            rememberedLevel === 'none'
              ? null
              : {
                  level: rememberedLevel,
                  origin: newOrigin,
                  grantedAt: Date.now(),
                }
          );
          await environment.host
            .call('browser', 'grant.set', {
              tabId,
              level: rememberedLevel,
            })
            .catch(() => {});
        } else if (tabGrants.has(tabId)) {
          const existing = tabGrants.get(tabId);
          if (existing && newOrigin) {
            tabGrants.set(tabId, { ...existing, origin: newOrigin });
          }
        }
        return overlayTabRecord(navigated, current);
      }
      return navigated;
    }

    if (operation === 'tab.close') {
      const tabId = String(payload.tabId ?? '');
      if (tabId) {
        tabGrants.delete(tabId);
        tabOrigins.delete(tabId);
        tabVisibility.delete(tabId);
        suspendedTabs.delete(tabId);
      }
      return await environment.host.call('browser', 'tab.close', payload);
    }

    if (operation === 'grant.set') {
      const tabId = String(payload.tabId ?? '').trim();
      const level = String(payload.level ?? '').trim();
      if (!tabId || !['none', 'read', 'control'].includes(level)) {
        throw new Error('browser_invalid: tabId and valid level are required');
      }
      const current = await loadSettings();
      let hostTab = null;
      try {
        hostTab = await environment.host.call('browser', 'grant.set', {
          tabId,
          level,
        });
      } catch (error) {
        const msg = String(error?.message ?? error?.code ?? error ?? '');
        if (!msg.includes('browser_not_grantable')) {
          throw error;
        }
      }

      let origin =
        hostTab?.origin ||
        extractOrigin(hostTab?.url) ||
        tabOrigins.get(tabId) ||
        null;
      if (!origin) {
        try {
          const listed = await environment.host.call('browser', 'tab.list', {});
          const found = Array.isArray(listed?.tabs)
            ? listed.tabs.find((item) => item?.tabId === tabId)
            : null;
          if (found) {
            hostTab = hostTab || found;
            origin = found.origin || extractOrigin(found.url) || null;
          }
        } catch {
          // Ignore
        }
      }
      if (origin) {
        tabOrigins.set(tabId, origin);
      }

      const grantedAt = Date.now();
      if (level === 'none') {
        tabGrants.set(tabId, null);
      } else {
        tabGrants.set(tabId, {
          level,
          origin: origin || hostTab?.url || 'about:blank',
          grantedAt,
        });
      }

      if (origin) {
        const nextOriginGrants = { ...current.originGrants };
        if (level === 'none') {
          delete nextOriginGrants[origin];
        } else {
          nextOriginGrants[origin] = level;
        }
        await persistSettings({
          ...current,
          originGrants: nextOriginGrants,
        });
      }

      const baseTab =
        hostTab && typeof hostTab === 'object'
          ? hostTab
          : {
              tabId,
              url: origin || 'about:blank',
              title: 'Browser',
              origin,
            };
      return overlayTabRecord(baseTab, cachedSettings);
    }

    if (operation === 'tab.devtools') {
      const current = await loadSettings();
      if (!current.devtools) {
        throw new Error(
          'browser_devtools_disabled: 已在浏览器设置中关闭「显示开发者工具 (DevTools) 按钮」'
        );
      }
      await environment.host.call('browser', 'tab.devtools', payload);
      return { ok: true, devtools: true };
    }

    if (operation === 'surface.set') {
      const tabId = String(payload.tabId ?? '');
      const visible = Boolean(payload?.bounds?.visible);
      if (tabId) {
        tabVisibility.set(tabId, visible);
        if (!visible && cachedSettings.suspendBackgroundTabs) {
          suspendedTabs.add(tabId);
        } else if (visible) {
          suspendedTabs.delete(tabId);
        }
      }
      return await environment.host.call('browser', 'surface.set', payload);
    }

    if (
      operation === 'snapshot' ||
      operation === 'act' ||
      operation === 'console.read' ||
      operation === 'screenshot' ||
      operation === 'tab.capture' ||
      operation === 'eval.request' ||
      operation === 'eval.run'
    ) {
      const current = await loadSettings();
      if (!current.toolsEnabled) {
        throw new Error(
          'browser_tools_disabled: 已在浏览器设置中关闭 Agent 浏览器 MCP 工具'
        );
      }
      if (
        (operation === 'eval.request' || operation === 'eval.run') &&
        !current.evalEnabled
      ) {
        throw new Error(
          'browser_eval_disabled: 已在浏览器设置中关闭「允许执行页面 JavaScript」'
        );
      }
      const forwarded =
        operation === 'eval.request' || operation === 'eval.run'
          ? { ...payload, evalApproval: current.evalApproval }
          : payload;
      return await environment.host.call('browser', operation, forwarded);
    }

    return await environment.host.call('browser', operation, payload);
  };

  registrar.handle('surface.createSession', async (input) => {
    if (
      input &&
      typeof input === 'object' &&
      typeof input.operation === 'string' &&
      input.operation.length > 0
    ) {
      return await handleBrowserDispatch(input);
    }
    await syncHostSettings();
    return { ready: true };
  });

  registrar.handle('browser.dispatch', handleBrowserDispatch);
});
