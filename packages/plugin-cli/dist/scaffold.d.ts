export type PluginTemplate = "full" | "app" | "agent";
export declare function scaffoldPlugin(target: string, publisher?: string, template?: PluginTemplate): Promise<string>;
