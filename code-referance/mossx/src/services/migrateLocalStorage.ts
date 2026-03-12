import { writeClientStoreData, getClientStoreFullSync } from "./clientStorage";

const MIGRATION_FLAG = "mossx.clientStorageMigrated";

function readLocalNum(key: string): number | undefined {
  const raw = localStorage.getItem(key);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function readLocalBool(key: string): boolean | undefined {
  const raw = localStorage.getItem(key);
  if (raw === null) return undefined;
  return raw === "true";
}

function readLocalJson<T>(key: string): T | undefined {
  const raw = localStorage.getItem(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function readLocalString(key: string): string | undefined {
  const raw = localStorage.getItem(key);
  return raw ?? undefined;
}

function collectPromptHistories(): Record<string, string[]> {
  const prefix = "mossx.promptHistory.";
  const result: Record<string, string[]> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    const historyKey = key.slice(prefix.length);
    const data = readLocalJson<string[]>(key);
    if (Array.isArray(data)) {
      result[historyKey] = data.filter((v) => typeof v === "string");
    }
  }
  return result;
}

export function migrateLocalStorageToFileStore(): void {
  try {
    if (localStorage.getItem(MIGRATION_FLAG) === "true") {
      return;
    }
  } catch {
    return;
  }

  const existingLayout = getClientStoreFullSync("layout");
  if (existingLayout && Object.keys(existingLayout).length > 0) {
    try {
      localStorage.setItem(MIGRATION_FLAG, "true");
    } catch {
      // best effort
    }
    return;
  }

  // --- layout ---
  const layout: Record<string, unknown> = {};
  const layoutNumKeys: [string, string][] = [
    ["mossx.sidebarWidth", "sidebarWidth"],
    ["mossx.rightPanelWidth", "rightPanelWidth"],
    ["mossx.planPanelHeight", "planPanelHeight"],
    ["mossx.terminalPanelHeight", "terminalPanelHeight"],
    ["mossx.debugPanelHeight", "debugPanelHeight"],
    ["mossx.kanbanConversationWidth", "kanbanConversationWidth"],
  ];
  for (const [localKey, jsonKey] of layoutNumKeys) {
    const v = readLocalNum(localKey);
    if (v !== undefined) layout[jsonKey] = v;
  }
  const layoutBoolKeys: [string, string][] = [
    ["mossx.sidebarCollapsed", "sidebarCollapsed"],
    ["mossx.rightPanelCollapsed", "rightPanelCollapsed"],
    ["reduceTransparency", "reduceTransparency"],
  ];
  for (const [localKey, jsonKey] of layoutBoolKeys) {
    const v = readLocalBool(localKey);
    if (v !== undefined) layout[jsonKey] = v;
  }
  const collapsedGroups = readLocalJson<string[]>("mossx.collapsedGroups");
  if (collapsedGroups) layout.collapsedGroups = collapsedGroups;

  if (Object.keys(layout).length > 0) {
    writeClientStoreData("layout", layout);
  }

  // --- composer ---
  const composer: Record<string, unknown> = {};
  const textareaHeight = readLocalNum("composerTextareaHeight");
  if (textareaHeight !== undefined) composer.textareaHeight = textareaHeight;
  const promptHistories = collectPromptHistories();
  if (Object.keys(promptHistories).length > 0) {
    composer.promptHistory = promptHistories;
  }
  if (Object.keys(composer).length > 0) {
    writeClientStoreData("composer", composer);
  }

  // --- threads ---
  const threads: Record<string, unknown> = {};
  const threadKeys: [string, string][] = [
    ["mossx.threadLastUserActivity", "lastUserActivity"],
    ["mossx.threadCustomNames", "customNames"],
    ["mossx.threadAutoTitlePending", "autoTitlePending"],
    ["mossx.pinnedThreads", "pinnedThreads"],
  ];
  for (const [localKey, jsonKey] of threadKeys) {
    const v = readLocalJson(localKey);
    if (v !== undefined) threads[jsonKey] = v;
  }
  if (Object.keys(threads).length > 0) {
    writeClientStoreData("threads", threads);
  }

  // --- app ---
  const app: Record<string, unknown> = {};
  const language = readLocalString("mossx.language");
  if (language) app.language = language;
  const openApp = readLocalString("open-workspace-app");
  if (openApp) app.openWorkspaceApp = openApp;
  const kanban = readLocalJson("mossx.kanban");
  if (kanban) app.kanban = kanban;
  if (Object.keys(app).length > 0) {
    writeClientStoreData("app", app);
  }

  try {
    localStorage.setItem(MIGRATION_FLAG, "true");
  } catch {
    // best effort
  }
}
