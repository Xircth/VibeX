export type SearchResultKind =
  | "file"
  | "kanban"
  | "thread"
  | "message"
  | "history"
  | "skill"
  | "command";

export type SearchScope = "active-workspace" | "global";
export type SearchContentFilter =
  | "all"
  | "files"
  | "kanban"
  | "threads"
  | "messages"
  | "history"
  | "skills"
  | "commands";

export type SearchResult = {
  id: string;
  kind: SearchResultKind;
  title: string;
  subtitle?: string;
  score: number;
  workspaceId?: string;
  workspaceName?: string;
  threadId?: string;
  messageId?: string;
  panelId?: string;
  taskId?: string;
  filePath?: string;
  historyText?: string;
  skillName?: string;
  commandName?: string;
  sourceKind?:
    | "files"
    | "kanban"
    | "threads"
    | "messages"
    | "history"
    | "skills"
    | "commands";
  locationLabel?: string;
  updatedAt?: number;
};
