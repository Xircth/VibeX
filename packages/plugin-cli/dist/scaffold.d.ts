export declare const PLUGIN_TEMPLATES: readonly ["skill", "mcp", "file-tab", "editor-tab", "full", "ts-worker", "node-worker", "python-worker", "rust-worker", "host-service", "host-chrome", "provider-import", "hooks", "panel", "kanban-view"];
export type PluginTemplate = (typeof PLUGIN_TEMPLATES)[number];
export declare function isPluginTemplate(value: string): value is PluginTemplate;
export declare function scaffoldPlugin(target: string, publisher?: string, template?: string): Promise<string>;
