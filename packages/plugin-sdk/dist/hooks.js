import { commandRegistry, conversationModeRegistry, kanbanViewRegistry, markdownRegistry, overlayRegistry, panelRegistry, promptContextRegistry, providerRegistry, settingRegistry, settingsPageRegistry, slashCommandRegistry, slotRegistry, themeRegistry, viewRegistry, } from './registry.js';
import { serviceContainer } from './services.js';
let boundUseSyncExternalStore = null;
/**
 * Binds React's `useSyncExternalStore` from the Host singleton so plugin SDK
 * hooks work without bundling a duplicate copy of React in `@vibex/plugin-sdk`.
 */
export function bindExternalStoreHook(hook) {
    boundUseSyncExternalStore = hook;
}
function resolveExternalStoreHook() {
    if (boundUseSyncExternalStore) {
        return boundUseSyncExternalStore;
    }
    const globalReact = globalThis.__VIBEX_REACT__;
    if (typeof globalReact?.useSyncExternalStore === 'function') {
        return globalReact.useSyncExternalStore;
    }
    return null;
}
function readExternalStore(subscribe, getSnapshot) {
    const hook = resolveExternalStoreHook();
    if (hook) {
        return hook(subscribe, getSnapshot, getSnapshot);
    }
    return getSnapshot();
}
export function useRegistry(registry) {
    return readExternalStore(registry.subscribe, registry.getAll);
}
export function useSlotContributions(slot) {
    return readExternalStore(slotRegistry.subscribe, () => slotRegistry.getBySlot(slot));
}
export function useCommands() {
    return useRegistry(commandRegistry);
}
export function useViews(slot) {
    return readExternalStore(viewRegistry.subscribe, () => slot ? viewRegistry.getBySlot(slot) : viewRegistry.getAll());
}
export function useSettingSections() {
    return useRegistry(settingRegistry);
}
export function useSlashCommands() {
    return useRegistry(slashCommandRegistry);
}
export function usePromptContexts() {
    return useRegistry(promptContextRegistry);
}
export function useProviders() {
    return useRegistry(providerRegistry);
}
export function useThemes() {
    return useRegistry(themeRegistry);
}
export function useConversationModes() {
    return useRegistry(conversationModeRegistry);
}
export function useMarkdownRenderers() {
    return useRegistry(markdownRegistry);
}
export function useOverlays() {
    return useRegistry(overlayRegistry);
}
export function usePanels() {
    return useRegistry(panelRegistry);
}
export function useKanbanViewContributions() {
    return useRegistry(kanbanViewRegistry);
}
export function useSettingsPages() {
    return useRegistry(settingsPageRegistry);
}
export function usePluginService(key) {
    return readExternalStore((onChange) => serviceContainer.onServiceChange(key, onChange), () => serviceContainer.inject(key));
}
