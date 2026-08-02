export enum Scope {
  GLOBAL = 'global',
  DIALOG = 'dialog',
  CONFIRMATION = 'confirmation',
  KANBAN = 'kanban',
  PROJECTS = 'projects',
  SETTINGS = 'settings',
  EDIT_COMMENT = 'edit-comment',
  APPROVALS = 'approvals',
  FOLLOW_UP = 'follow-up',
  FOLLOW_UP_READY = 'follow-up-ready',
  WORKSPACE = 'workspace',
}

export enum Action {
  EXIT = 'exit',
  CREATE = 'create',
  SUBMIT = 'submit',
  FOCUS_SEARCH = 'focus_search',
  NAV_UP = 'nav_up',
  NAV_DOWN = 'nav_down',
  NAV_LEFT = 'nav_left',
  NAV_RIGHT = 'nav_right',
  OPEN_DETAILS = 'open_details',
  SHOW_HELP = 'show_help',
  DELETE_TASK = 'delete_task',
  APPROVE_REQUEST = 'approve_request',
  DENY_APPROVAL = 'deny_approval',
  SUBMIT_FOLLOW_UP = 'submit_follow_up',
  SUBMIT_TASK = 'submit_task',
  SUBMIT_TASK_ALT = 'submit_task_alt',
  SUBMIT_COMMENT = 'submit_comment',
  CYCLE_VIEW_BACKWARD = 'cycle_view_backward',
}

export interface KeyBinding {
  action: Action;
  keys: string | string[];
  scopes?: Scope[];
  description: string;
  group?: string;
}

/**
 * Sequential keyboard shortcut binding (e.g., "g s" for Go to Settings)
 */
export interface SequentialBinding {
  id: string;
  keys: string[];
  scopes?: Scope[];
  description: string;
  group: string;
  actionId: string;
}

/**
 * Valid first keys for sequential shortcuts.
 * These keys will be intercepted to start a sequence.
 */
export const SEQUENCE_FIRST_KEYS = new Set([
  'g', // Go/Navigate
  'v', // View
]);

/**
 * All sequential keyboard shortcuts organized by namespace
 */
export const sequentialBindings: SequentialBinding[] = [
  // Navigation (G = Go)
  {
    id: 'seq-go-settings',
    keys: ['g', 's'],
    description: 'Go to Settings',
    group: 'Navigation',
    actionId: 'settings',
  },
  // View (V)
  {
    id: 'seq-view-changes',
    keys: ['v', 'c'],
    description: 'Toggle Changes panel',
    group: 'View',
    actionId: 'toggle-changes-mode',
  },
  {
    id: 'seq-view-logs',
    keys: ['v', 'l'],
    description: 'Toggle Logs panel',
    group: 'View',
    actionId: 'toggle-logs-mode',
  },
  {
    id: 'seq-view-preview',
    keys: ['v', 'p'],
    description: 'Toggle Preview panel',
    group: 'View',
    actionId: 'toggle-preview-mode',
  },
  {
    id: 'seq-view-sidebar',
    keys: ['v', 's'],
    description: 'Toggle Left Sidebar',
    group: 'View',
    actionId: 'toggle-left-sidebar',
  },
  {
    id: 'seq-view-chat',
    keys: ['v', 'h'],
    description: 'Toggle Chat panel',
    group: 'View',
    actionId: 'toggle-left-main-panel',
  },
];

export const keyBindings: KeyBinding[] = [
  // Exit/Close actions
  {
    action: Action.EXIT,
    keys: 'esc',
    scopes: [Scope.CONFIRMATION],
    description: 'Close confirmation dialog',
    group: 'Dialog',
  },
  {
    action: Action.EXIT,
    keys: 'esc',
    scopes: [Scope.DIALOG],
    description: 'Close dialog or blur input',
    group: 'Dialog',
  },
  {
    action: Action.EXIT,
    keys: 'esc',
    scopes: [Scope.KANBAN],
    description: 'Close panel or navigate to projects',
    group: 'Navigation',
  },
  {
    action: Action.EXIT,
    keys: 'esc',
    scopes: [Scope.EDIT_COMMENT],
    description: 'Cancel comment',
    group: 'Comments',
  },
  {
    action: Action.EXIT,
    keys: 'esc',
    scopes: [Scope.SETTINGS],
    description: 'Close settings',
    group: 'Navigation',
  },

  // Creation actions
  {
    action: Action.CREATE,
    keys: 'c',
    scopes: [Scope.KANBAN],
    description: 'Create new task',
    group: 'Kanban',
  },
  {
    action: Action.CREATE,
    keys: 'c',
    scopes: [Scope.PROJECTS],
    description: 'Create new project',
    group: 'Projects',
  },

  // Submit actions
  {
    action: Action.SUBMIT,
    keys: 'enter',
    scopes: [Scope.DIALOG],
    description: 'Submit form or confirm action',
    group: 'Dialog',
  },

  // Navigation actions
  {
    action: Action.FOCUS_SEARCH,
    keys: 'slash',
    scopes: [Scope.KANBAN],
    description: 'Focus search',
    group: 'Navigation',
  },
  {
    action: Action.NAV_UP,
    keys: 'k',
    scopes: [Scope.KANBAN],
    description: 'Move up within column',
    group: 'Navigation',
  },
  {
    action: Action.NAV_DOWN,
    keys: 'j',
    scopes: [Scope.KANBAN],
    description: 'Move down within column',
    group: 'Navigation',
  },
  {
    action: Action.NAV_LEFT,
    keys: 'h',
    scopes: [Scope.KANBAN],
    description: 'Move to previous column',
    group: 'Navigation',
  },
  {
    action: Action.NAV_RIGHT,
    keys: 'l',
    scopes: [Scope.KANBAN],
    description: 'Move to next column',
    group: 'Navigation',
  },
  {
    action: Action.OPEN_DETAILS,
    keys: ['meta+enter', 'ctrl+enter'],
    scopes: [Scope.KANBAN],
    description:
      'Open details; when open, cycle views forward (attempt → preview → diffs)',
    group: 'Navigation',
  },
  {
    action: Action.CYCLE_VIEW_BACKWARD,
    keys: ['meta+shift+enter', 'ctrl+shift+enter'],
    scopes: [Scope.KANBAN],
    description: 'Cycle views backward (diffs → preview → attempt)',
    group: 'Navigation',
  },

  // Global actions
  {
    action: Action.SHOW_HELP,
    keys: 'shift+slash',
    scopes: [Scope.GLOBAL],
    description: 'Show keyboard shortcuts help',
    group: 'Global',
  },

  // Task actions
  {
    action: Action.DELETE_TASK,
    keys: 'd',
    scopes: [Scope.KANBAN],
    description: 'Delete selected task',
    group: 'Task Details',
  },

  // Approval actions
  {
    action: Action.APPROVE_REQUEST,
    keys: 'enter',
    scopes: [Scope.APPROVALS],
    description: 'Approve pending approval request',
    group: 'Approvals',
  },
  {
    action: Action.DENY_APPROVAL,
    keys: ['meta+enter', 'ctrl+enter'],
    scopes: [Scope.APPROVALS],
    description: 'Deny pending approval request',
    group: 'Approvals',
  },

  // Follow-up actions
  {
    action: Action.SUBMIT_FOLLOW_UP,
    keys: 'meta+enter',
    scopes: [Scope.FOLLOW_UP_READY],
    description: 'Send or queue follow-up (depending on state)',
    group: 'Follow-up',
  },
  {
    action: Action.SUBMIT_TASK,
    keys: ['meta+enter', 'ctrl+enter'],
    scopes: [Scope.DIALOG],
    description: 'Submit task form (Create & Start or Update)',
    group: 'Dialog',
  },
  {
    action: Action.SUBMIT_TASK_ALT,
    keys: ['meta+shift+enter', 'ctrl+shift+enter'],
    scopes: [Scope.DIALOG],
    description: 'Submit task form (Create Task)',
    group: 'Dialog',
  },
  {
    action: Action.SUBMIT_COMMENT,
    keys: ['meta+enter', 'ctrl+enter'],
    scopes: [Scope.EDIT_COMMENT],
    description: 'Submit review comment',
    group: 'Comments',
  },
];

/** User keybinding overrides: binding id → single chord token (P3-2). */
export type KeyBindingOverrides = Record<string, string>;

/**
 * Stable id for a single-chord binding, derived from its action + scopes.
 * Unique across `keyBindings` (same action always differs by scope).
 */
export function bindingKey(action: Action, scopes?: Scope[]): string {
  return `${action}:${(scopes ?? []).join(',')}`;
}

function defaultKeysOf(binding: KeyBinding): string[] {
  return Array.isArray(binding.keys) ? binding.keys : [binding.keys];
}

/**
 * Get keyboard bindings for a specific action and scope, applying any user
 * overrides (which replace a binding's default keys with a single chord).
 */
export function getKeysFor(
  action: Action,
  scope?: Scope,
  overrides?: KeyBindingOverrides
): string[] {
  return keyBindings
    .filter(
      (binding) =>
        binding.action === action &&
        (!scope || !binding.scopes || binding.scopes.includes(scope))
    )
    .flatMap((binding) => {
      const override = overrides?.[bindingKey(binding.action, binding.scopes)];
      return override ? [override] : defaultKeysOf(binding);
    });
}

export interface EffectiveKeyBinding {
  id: string;
  action: Action;
  scopes?: Scope[];
  description: string;
  group?: string;
  defaultKeys: string[];
  keys: string[];
  overridden: boolean;
}

/** All single-chord bindings with overrides applied, for the rebinding UI. */
export function getEffectiveKeyBindings(
  overrides: KeyBindingOverrides
): EffectiveKeyBinding[] {
  return keyBindings.map((binding) => {
    const id = bindingKey(binding.action, binding.scopes);
    const defaultKeys = defaultKeysOf(binding);
    const override = overrides[id];
    return {
      id,
      action: binding.action,
      scopes: binding.scopes,
      description: binding.description,
      group: binding.group,
      defaultKeys,
      keys: override ? [override] : defaultKeys,
      overridden: !!override,
    };
  });
}

/**
 * Bindings exposed in Settings must have a mounted consumer in the current UI.
 * Keeping dormant legacy bindings in the semantic registry is useful for
 * incremental migrations, but advertising them as configurable would promise
 * behavior that the application cannot perform.
 */
const CONFIGURABLE_BINDING_IDS = new Set([
  bindingKey(Action.EXIT, [Scope.DIALOG]),
  bindingKey(Action.EXIT, [Scope.EDIT_COMMENT]),
  bindingKey(Action.CREATE, [Scope.PROJECTS]),
  bindingKey(Action.SUBMIT, [Scope.DIALOG]),
  bindingKey(Action.APPROVE_REQUEST, [Scope.APPROVALS]),
  bindingKey(Action.DENY_APPROVAL, [Scope.APPROVALS]),
  bindingKey(Action.SUBMIT_FOLLOW_UP, [Scope.FOLLOW_UP_READY]),
  bindingKey(Action.SUBMIT_TASK, [Scope.DIALOG]),
  bindingKey(Action.SUBMIT_COMMENT, [Scope.EDIT_COMMENT]),
]);

export function getConfigurableKeyBindings(
  overrides: KeyBindingOverrides
): EffectiveKeyBinding[] {
  return getEffectiveKeyBindings(overrides).filter((binding) =>
    CONFIGURABLE_BINDING_IDS.has(binding.id)
  );
}

function scopesOverlap(a?: Scope[], b?: Scope[]): boolean {
  // An undefined scope, or the explicit GLOBAL scope, means the binding is
  // active everywhere — it overlaps every scope. (GLOBAL is always kept active
  // alongside the view scopes, so a GLOBAL chord genuinely collides in any view.)
  if (!a || !b) return true;
  if (a.includes(Scope.GLOBAL) || b.includes(Scope.GLOBAL)) return true;
  return a.some((scope) => b.includes(scope));
}

/**
 * Bindings that collide with `target`: an overlapping scope AND a shared chord.
 * Used to warn on rebind (two actions firing on the same key in the same scope).
 */
export function findChordConflicts(
  target: EffectiveKeyBinding,
  all: EffectiveKeyBinding[]
): EffectiveKeyBinding[] {
  return all.filter(
    (other) =>
      other.id !== target.id &&
      scopesOverlap(other.scopes, target.scopes) &&
      other.keys.some((key) => target.keys.includes(key))
  );
}

/**
 * Get binding info for a specific action and scope
 */
export function getBindingFor(
  action: Action,
  scope?: Scope
): KeyBinding | undefined {
  return keyBindings.find(
    (binding) =>
      binding.action === action &&
      (!scope || !binding.scopes || binding.scopes.includes(scope))
  );
}

/**
 * Get sequential binding for a specific action ID
 */
export function getSequentialBindingFor(
  actionId: string
): SequentialBinding | undefined {
  return sequentialBindings.find((binding) => binding.actionId === actionId);
}

/**
 * Format sequential keys for display (e.g., ['g', 's'] -> 'G S')
 */
export function formatSequentialKeys(keys: string[]): string {
  return keys.map((k) => k.toUpperCase()).join(' ');
}
