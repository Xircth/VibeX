import { describe, expect, it, vi } from "vitest";
import {
  activatePluginWorker,
  clearPluginVolatileConfig,
  createPluginContext,
  createVolatile,
  definePluginWorker,
  getPluginVolatileConfig,
  normalizePluginContext,
  notifyPluginConfigUpdated,
} from "./index.js";

describe("Volatile<T> and reactive plugin configuration", () => {
  it("provides reactive current/value/get, onChange/subscribe, and map/select semantics with structural deduplication", () => {
    const config = createVolatile({ retries: 3, endpoint: "https://api.example.com" });
    expect(config.current).toEqual({ retries: 3, endpoint: "https://api.example.com" });
    expect(config.value).toEqual({ retries: 3, endpoint: "https://api.example.com" });
    expect(config.get()).toEqual({ retries: 3, endpoint: "https://api.example.com" });

    const retries = config.map((value) => value.retries);
    expect(retries.current).toBe(3);

    const onConfigChange = vi.fn();
    const onRetriesChange = vi.fn();
    const unsubConfig = config.onChange(onConfigChange);
    const unsubRetries = retries.onChange(onRetriesChange);

    // Identical structural update does not fire listeners
    expect(config.set({ retries: 3, endpoint: "https://api.example.com" })).toBe(false);
    expect(onConfigChange).not.toHaveBeenCalled();
    expect(onRetriesChange).not.toHaveBeenCalled();

    // Updating endpoint fires parent listener but not retries mapped listener
    expect(config.set({ retries: 3, endpoint: "https://staging.example.com" })).toBe(true);
    expect(onConfigChange).toHaveBeenCalledTimes(1);
    expect(onRetriesChange).not.toHaveBeenCalled();

    // Updating retries fires both
    expect(config.set({ retries: 5, endpoint: "https://staging.example.com" })).toBe(true);
    expect(retries.current).toBe(5);
    expect(onConfigChange).toHaveBeenCalledTimes(2);
    expect(onRetriesChange).toHaveBeenCalledWith(5, 3);

    unsubConfig();
    unsubRetries();
    config.set({ retries: 1, endpoint: "https://prod.example.com" });
    expect(onConfigChange).toHaveBeenCalledTimes(2);
    expect(onRetriesChange).toHaveBeenCalledTimes(1);
  });

  it("updates worker env.config and triggers registrar.onConfigUpdate without re-activating", async () => {
    const activateSpy = vi.fn();
    const configUpdateSpy = vi.fn();
    const envConfigChangeSpy = vi.fn();

    const definition = definePluginWorker((registrar, env) => {
      activateSpy(env.config.current);
      env.config.onChange(envConfigChangeSpy);
      registrar.onConfigUpdate(configUpdateSpy);
      registrar.handle("ping", () => ({
        currentTimeout: env.config.current.timeoutMs ?? null,
      }));
    });

    const activated = await activatePluginWorker(definition, {
      context: normalizePluginContext({
        pluginId: "demo-worker",
        pluginVersion: "1.0.0",
        generation: 1,
        config: { timeoutMs: 1000 },
      }),
      host: {
        call: async () => null,
      },
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    expect(activateSpy).toHaveBeenCalledTimes(1);
    expect(activateSpy).toHaveBeenCalledWith({ timeoutMs: 1000 });
    expect(await activated.invoke("ping", {})).toEqual({ currentTimeout: 1000 });

    const changed = activated.updateConfig({ timeoutMs: 2500 });
    expect(changed).toBe(true);
    expect(activateSpy).toHaveBeenCalledTimes(1);
    expect(envConfigChangeSpy).toHaveBeenCalledWith(
      { timeoutMs: 2500 },
      { timeoutMs: 1000 },
    );
    expect(configUpdateSpy).toHaveBeenCalledWith(
      { timeoutMs: 2500 },
      { timeoutMs: 1000 },
    );
    expect(await activated.invoke("ping", {})).toEqual({ currentTimeout: 2500 });
    await activated.dispose();
  });

  it("propagates host config updates to VibeXPluginContext.config and settings.volatile()", async () => {
    const pluginId = "demo-ui-plugin";
    clearPluginVolatileConfig(pluginId);

    let storedSettings: Record<string, unknown> = { theme: "dark", maxItems: 10 };
    const ctx = createPluginContext({
      pluginId,
      hostCall: async <T = unknown>(
        _p: string,
        capability: string,
        operation: string,
        input?: unknown,
      ): Promise<T> => {
        if (capability === "storage" && operation === "settings.get") {
          return storedSettings as T;
        }
        if (capability === "storage" && operation === "settings.put") {
          storedSettings = (input as Record<string, unknown>) ?? {};
          return storedSettings as T;
        }
        return {} as T;
      },
    });

    const settingsVolatile = ctx.host.storage.settings.volatile<{
      theme: string;
      maxItems: number;
    }>({ theme: "light", maxItems: 5 });

    const listener = vi.fn();
    ctx.host.storage.settings.onChange(listener);

    // Initial load via settings.get populates volatile store
    await ctx.host.storage.settings.get();
    expect(ctx.config.current).toEqual({ theme: "dark", maxItems: 10 });
    expect(settingsVolatile.current).toEqual({ theme: "dark", maxItems: 10 });

    // Simulated external save (e.g. from Settings tab) updates volatile config in-place
    notifyPluginConfigUpdated(pluginId, { theme: "solarized", maxItems: 25 });
    expect(ctx.config.current).toEqual({ theme: "solarized", maxItems: 25 });
    expect(settingsVolatile.current).toEqual({ theme: "solarized", maxItems: 25 });
    expect(listener).toHaveBeenLastCalledWith(
      { theme: "solarized", maxItems: 25 },
      { theme: "dark", maxItems: 10 },
    );
    expect(getPluginVolatileConfig(pluginId).current).toEqual({
      theme: "solarized",
      maxItems: 25,
    });

    ctx.dispose();
    clearPluginVolatileConfig(pluginId);
  });
});
