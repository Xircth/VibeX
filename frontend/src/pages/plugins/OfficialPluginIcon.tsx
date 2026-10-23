import type { LucideIcon } from 'lucide-react';
import { type ComponentType, type SVGProps, useId, useState } from 'react';

import { CONTRIBUTION_ICONS } from '@/components/plugins/contributionIcon';
import type { CoreFoundationArtworkKey } from '@/features/plugins/coreFoundationPlugins';
import type { CatalogListing } from '@/lib/api/plugins';

import {
  listingPackageIds,
  type MarketplaceListingIdentity,
} from './marketplaceListing';
import {
  officialPluginI18nKey,
  type OfficialPluginI18nKey,
} from './officialPlugins';

export type PluginArtworkComponent = ComponentType<SVGProps<SVGSVGElement>>;

export type DshBuiltinItemKey =
  | 'subagent'
  | 'webSearch'
  | 'agentLoop'
  | 'terminal'
  | 'agentTeam'
  | 'voiceInput'
  | 'autoReview'
  | 'devTools';

/**
 * 1. 子智能体 (Subagent) — Two overlapping rounded squares (blue + emerald teal)
 */
export function PluginArtworkSubagent(props: SVGProps<SVGSVGElement>) {
  const uid = useId();
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <defs>
        <linearGradient id={`${uid}-a`} x1="10" y1="10" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#60A5FA" />
          <stop offset="100%" stopColor="#2563EB" />
        </linearGradient>
        <linearGradient id={`${uid}-b`} x1="15" y1="15" x2="26" y2="26" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#34D399" />
          <stop offset="100%" stopColor="#059669" />
        </linearGradient>
      </defs>
      <rect x="10" y="10" width="11" height="11" rx="2.8" fill={`url(#${uid}-a)`} />
      <rect x="15" y="15" width="11" height="11" rx="2.8" fill={`url(#${uid}-b)`} fillOpacity="0.92" />
      <rect x="15" y="15" width="6" height="6" rx="1.2" fill="#1D4ED8" fillOpacity="0.35" />
    </svg>
  );
}

/**
 * 2. 网页搜索 (Web Search) — Blue/cyan dual-tone magnifying glass
 */
export function PluginArtworkWebSearch(props: SVGProps<SVGSVGElement>) {
  const uid = useId();
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <defs>
        <linearGradient id={`${uid}-ring`} x1="10" y1="10" x2="23" y2="23" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#38BDF8" />
          <stop offset="100%" stopColor="#2563EB" />
        </linearGradient>
      </defs>
      <circle cx="16.5" cy="16.5" r="6.2" stroke={`url(#${uid}-ring)`} strokeWidth="2.8" />
      <path d="M12.2 14.2C13 12.5 14.6 11.4 16.5 11.4" stroke="#7DD3FC" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M21.2 21.2L25.5 25.5" stroke="#2563EB" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 3. Agent 循环 (Agent Loop) — Purple-blue gradient orb with 4-point star
 */
export function PluginArtworkAgentLoop(props: SVGProps<SVGSVGElement>) {
  const uid = useId();
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <defs>
        <linearGradient id={`${uid}-orb`} x1="9" y1="9" x2="27" y2="27" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#60A5FA" />
          <stop offset="50%" stopColor="#6366F1" />
          <stop offset="100%" stopColor="#A855F7" />
        </linearGradient>
      </defs>
      <circle cx="18" cy="18" r="8.5" fill={`url(#${uid}-orb)`} />
      <path
        d="M18 11.8L19.8 16.2L24.2 18L19.8 19.8L18 24.2L16.2 19.8L11.8 18L16.2 16.2L18 11.8Z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

/**
 * 4. 终端 (Terminal / Shell) — Crisp blue `>_` prompt
 */
export function PluginArtworkTerminal(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <path
        d="M11.5 13L17 18L11.5 23"
        stroke="#2563EB"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M18.5 23H24.5"
        stroke="#60A5FA"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * 5. 智能体团队 (Agent Team) — Four colorful rounded nodes forming a 4-way hub
 */
export function PluginArtworkAgentTeam(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <path d="M16 10.5C16 9.67 16.67 9 17.5 9H18.5C19.33 9 20 9.67 20 10.5V15H16V10.5Z" fill="#3B82F6" />
      <path d="M16 21H20V25.5C20 26.33 19.33 27 18.5 27H17.5C16.67 27 16 26.33 16 25.5V21Z" fill="#06B6D4" />
      <path d="M9 17.5C9 16.67 9.67 16 10.5 16H15V20H10.5C9.67 20 9 19.33 9 18.5V17.5Z" fill="#10B981" />
      <path d="M21 16H25.5C26.33 16 27 16.67 27 17.5V18.5C27 19.33 26.33 20 25.5 20H21V16Z" fill="#6366F1" />
      <circle cx="13" cy="13" r="1.8" fill="#38BDF8" />
      <circle cx="23" cy="13" r="1.8" fill="#818CF8" />
      <circle cx="13" cy="23" r="1.8" fill="#34D399" />
      <circle cx="23" cy="23" r="1.8" fill="#22D3EE" />
    </svg>
  );
}

/**
 * 6. 语音输入 (Voice Input) — Vertical soundwave bars
 */
export function PluginArtworkVoiceInput(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <rect x="10" y="15.5" width="2.2" height="5" rx="1.1" fill="#93C5FD" />
      <rect x="13.5" y="12.5" width="2.2" height="11" rx="1.1" fill="#3B82F6" />
      <rect x="17" y="10" width="2.2" height="16" rx="1.1" fill="#2563EB" />
      <rect x="20.5" y="13" width="2.2" height="10" rx="1.1" fill="#3B82F6" />
      <rect x="24" y="15.5" width="2.2" height="5" rx="1.1" fill="#93C5FD" />
    </svg>
  );
}

/**
 * 7. 自动授权审查 (Auto Permission Review) — Soft blue shield with white checkmark
 */
export function PluginArtworkAutoReview(props: SVGProps<SVGSVGElement>) {
  const uid = useId();
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <defs>
        <linearGradient id={`${uid}-shield`} x1="10" y1="9" x2="26" y2="27" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#93C5FD" />
          <stop offset="100%" stopColor="#3B82F6" />
        </linearGradient>
      </defs>
      <path
        d="M18 9.5L25.5 12.6V17.8C25.5 22.3 22.4 25.6 18 27C13.6 25.6 10.5 22.3 10.5 17.8V12.6L18 9.5Z"
        fill={`url(#${uid}-shield)`}
      />
      <path
        d="M14.8 18.2L17.1 20.5L21.5 15.8"
        stroke="#FFFFFF"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 8. 开发者工具 (Developer Tools) — Blue code window with magnifying glass
 */
export function PluginArtworkDevTools(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <rect x="9.5" y="10" width="14" height="15" rx="2.8" fill="#3B82F6" />
      <path d="M12.5 14H19.5M12.5 17.5H17.5M12.5 21H16" stroke="#DBEAFE" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="22.5" cy="21.5" r="3.6" fill="#EFF6FF" stroke="#2563EB" strokeWidth="2" />
      <path d="M25.2 24.2L27.2 26.2" stroke="#2563EB" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function PluginArtworkOffice(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <rect x="10" y="9.5" width="13" height="16" rx="2.5" fill="#93C5FD" />
      <rect x="13" y="11" width="13" height="16" rx="2.5" fill="#3B82F6" />
      <path d="M16 15.5H23M16 19H23M16 22.5H20.5" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function PluginArtworkWorkflowCreator(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <path d="M14 13H18.5C20 13 21 14 21 15.5V20.5C21 22 22 23 23.5 23H24.5" stroke="#6366F1" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="12" cy="13" r="3" fill="#3B82F6" />
      <circle cx="12" cy="23" r="3" fill="#60A5FA" />
      <circle cx="24.5" cy="18" r="3.2" fill="#8B5CF6" />
    </svg>
  );
}

function PluginArtworkSessionEnhance(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <path
        d="M9.5 13C9.5 11.3 10.8 10 12.5 10H23.5C25.2 10 26.5 11.3 26.5 13V20C26.5 21.7 25.2 23 23.5 23H15.5L11 26.2V23C10.1 22.7 9.5 21.5 9.5 20V13Z"
        fill="#3B82F6"
      />
      <path d="M13 16.5H15.5L17 13.5L19 19.5L20.5 16.5H23" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PluginArtworkHostChrome(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <rect x="9" y="10" width="18" height="16" rx="3" stroke="#3B82F6" strokeWidth="2.2" />
      <path d="M9 14.8H27" stroke="#60A5FA" strokeWidth="1.8" />
      <circle cx="12" cy="12.4" r="1" fill="#3B82F6" />
      <circle cx="15" cy="12.4" r="1" fill="#60A5FA" />
    </svg>
  );
}

function PluginArtworkHostSurface(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <path d="M18 10L26.5 14.2L18 18.4L9.5 14.2L18 10Z" fill="#3B82F6" />
      <path d="M9.5 18.2L18 22.4L26.5 18.2" stroke="#60A5FA" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.5 22L18 26.2L26.5 22" stroke="#93C5FD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PluginArtworkProviderImport(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <path d="M18 10V20.5M18 20.5L14 16.5M18 20.5L22 16.5" stroke="#2563EB" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 23V24.5C11 25.6 11.9 26.5 13 26.5H23C24.1 26.5 25 25.6 25 24.5V23" stroke="#60A5FA" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function PluginArtworkProviderSwitch(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <rect x="9.5" y="11" width="17" height="6" rx="3" fill="#3B82F6" />
      <circle cx="23" cy="14" r="2" fill="#FFFFFF" />
      <rect x="9.5" y="19" width="17" height="6" rx="3" fill="#93C5FD" />
      <circle cx="13" cy="22" r="2" fill="#2563EB" />
    </svg>
  );
}

function PluginArtworkScience(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <ellipse cx="18" cy="18" rx="9.5" ry="4" transform="rotate(-30 18 18)" stroke="#3B82F6" strokeWidth="1.8" />
      <ellipse cx="18" cy="18" rx="9.5" ry="4" transform="rotate(30 18 18)" stroke="#6366F1" strokeWidth="1.8" />
      <circle cx="18" cy="18" r="2.6" fill="#06B6D4" />
    </svg>
  );
}

function PluginArtworkOpenConnector(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <path d="M15 21L21 15" stroke="#2563EB" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M13.5 17L11.5 19C10 20.5 10 23 11.5 24.5C13 26 15.5 26 17 24.5L19 22.5" stroke="#3B82F6" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M17 13.5L19 11.5C20.5 10 23 10 24.5 11.5C26 13 26 15.5 24.5 17L22.5 19" stroke="#06B6D4" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function PluginArtworkComputerUse(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <rect x="9" y="10" width="18" height="12.5" rx="2.4" stroke="#3B82F6" strokeWidth="2.2" />
      <path d="M14.5 26H21.5M18 22.5V26" stroke="#60A5FA" strokeWidth="2" strokeLinecap="round" />
      <path d="M16.5 13.5L21 16L18.5 17L19.8 19.5L18.3 20.2L17 17.7L15.5 19V13.5Z" fill="#2563EB" />
    </svg>
  );
}

function PluginArtworkKanbanViews(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <rect x="9.5" y="10.5" width="4.5" height="15" rx="1.5" fill="#2563EB" />
      <rect x="15.75" y="10.5" width="4.5" height="11" rx="1.5" fill="#3B82F6" />
      <rect x="22" y="10.5" width="4.5" height="13.5" rx="1.5" fill="#93C5FD" />
    </svg>
  );
}

function PluginArtworkNotes(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <rect x="10" y="9.5" width="16" height="17" rx="2.8" fill="#3B82F6" />
      <path d="M13.5 14.5H22.5M13.5 18H22.5M13.5 21.5H18.5" stroke="#FFFFFF" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function PluginArtworkPromptEnhancer(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <path d="M19 9.5L20.8 14.7L26 16.5L20.8 18.3L19 23.5L17.2 18.3L12 16.5L17.2 14.7L19 9.5Z" fill="#6366F1" />
      <path d="M12 21.5L12.8 23.7L15 24.5L12.8 25.3L12 27.5L11.2 25.3L9 24.5L11.2 23.7L12 21.5Z" fill="#38BDF8" />
    </svg>
  );
}

export function PluginArtworkDefault(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 36 36" fill="none" aria-hidden="true" {...props}>
      <rect x="10" y="10" width="7" height="7" rx="2" fill="#3B82F6" />
      <rect x="19" y="10" width="7" height="7" rx="2" fill="#93C5FD" />
      <rect x="10" y="19" width="7" height="7" rx="2" fill="#60A5FA" />
      <rect x="19" y="19" width="7" height="7" rx="2" fill="#2563EB" />
    </svg>
  );
}

export const DSH_BUILTIN_ITEM_GLYPHS: Record<
  DshBuiltinItemKey,
  PluginArtworkComponent
> = {
  subagent: PluginArtworkSubagent,
  webSearch: PluginArtworkWebSearch,
  agentLoop: PluginArtworkAgentLoop,
  terminal: PluginArtworkTerminal,
  agentTeam: PluginArtworkAgentTeam,
  voiceInput: PluginArtworkVoiceInput,
  autoReview: PluginArtworkAutoReview,
  devTools: PluginArtworkDevTools,
};

export const CORE_FOUNDATION_GLYPHS: Record<
  CoreFoundationArtworkKey,
  PluginArtworkComponent
> = {
  corePluginManager: PluginArtworkDefault,
  coreHmr: PluginArtworkAgentLoop,
  coreSettings: PluginArtworkProviderSwitch,
  coreCredentials: PluginArtworkAutoReview,
  coreAgentRuntime: PluginArtworkAgentLoop,
  coreSession: PluginArtworkSessionEnhance,
  coreLlmProviders: PluginArtworkProviderSwitch,
  coreSkills: PluginArtworkPromptEnhancer,
  coreMcp: PluginArtworkOpenConnector,
  coreDelegation: PluginArtworkSubagent,
  coreCompaction: PluginArtworkNotes,
  coreApproval: PluginArtworkAutoReview,
  coreShell: PluginArtworkTerminal,
  coreWorkspaceGit: PluginArtworkWorkflowCreator,
  coreFilesystem: PluginArtworkOffice,
  coreAutomation: PluginArtworkAgentLoop,
  coreChannels: PluginArtworkOpenConnector,
  webuiLayout: PluginArtworkHostChrome,
  webuiConversation: PluginArtworkSessionEnhance,
  webuiKanban: PluginArtworkKanbanViews,
  webuiCommands: PluginArtworkTerminal,
  webuiTheme: PluginArtworkPromptEnhancer,
};

export const OFFICIAL_GLYPHS: Record<
  OfficialPluginI18nKey,
  PluginArtworkComponent
> = {
  office: PluginArtworkOffice,
  workflowCreator: PluginArtworkWorkflowCreator,
  sessionEnhance: PluginArtworkSessionEnhance,
  pluginDevelopment: PluginArtworkDevTools,
  hostChrome: PluginArtworkHostChrome,
  hostSurface: PluginArtworkHostSurface,
  providerImport: PluginArtworkProviderImport,
  providerSwitch: PluginArtworkProviderSwitch,
  remoteSsh: PluginArtworkTerminal,
  science: PluginArtworkScience,
  browser: PluginArtworkWebSearch,
  openConnector: PluginArtworkOpenConnector,
  computerUse: PluginArtworkComputerUse,
  kanbanViews: PluginArtworkKanbanViews,
  notes: PluginArtworkNotes,
  promptEnhancer: PluginArtworkPromptEnhancer,
};

const CORE_PLUGIN_ARTWORK_BY_ID: Record<string, CoreFoundationArtworkKey> = {
  'vibex.core.plugin-manager': 'corePluginManager',
  'vibex.core.hmr': 'coreHmr',
  'vibex.core.settings': 'coreSettings',
  'vibex.core.credentials': 'coreCredentials',
  'vibex.core.agent-runtime': 'coreAgentRuntime',
  'vibex.core.session': 'coreSession',
  'vibex.core.llm-providers': 'coreLlmProviders',
  'vibex.core.skills': 'coreSkills',
  'vibex.core.mcp': 'coreMcp',
  'vibex.core.delegation': 'coreDelegation',
  'vibex.core.compaction': 'coreCompaction',
  'vibex.core.approval': 'coreApproval',
  'vibex.core.shell': 'coreShell',
  'vibex.core.workspace-git': 'coreWorkspaceGit',
  'vibex.core.filesystem': 'coreFilesystem',
  'vibex.core.automation': 'coreAutomation',
  'vibex.core.channels': 'coreChannels',
  'vibex.webui.layout': 'webuiLayout',
  'vibex.webui.conversation': 'webuiConversation',
  'vibex.webui.kanban': 'webuiKanban',
  'vibex.webui.commands': 'webuiCommands',
  'vibex.webui.theme': 'webuiTheme',
};

const MARKETPLACE_ICON_HOST = 'vibex.xforever.xin';
const INITIALS_PALETTE = [
  'color-mix(in srgb, var(--accent) 18%, var(--surface-raised))',
  'color-mix(in srgb, var(--text-primary) 18%, var(--surface-raised))',
  'color-mix(in srgb, hsl(var(--success)) 18%, var(--surface-raised))',
  'color-mix(in srgb, hsl(var(--warning)) 18%, var(--surface-raised))',
] as const;

export function officialGlyphForListing(
  listing: MarketplaceListingIdentity
): OfficialPluginI18nKey | null {
  for (const id of listingPackageIds(listing)) {
    const key = officialPluginI18nKey(id);
    if (key) return key;
  }
  return null;
}

export function allowedMarketplaceIconUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port !== '' && url.port !== '443') return null;
  if (url.hostname !== MARKETPLACE_ICON_HOST) return null;
  const path = url.pathname.toLowerCase();
  if (path.endsWith('.svg') || path.endsWith('.svgz')) return null;
  return url.href;
}

function fnv1a32(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function marketplaceLogoInitials(displayName: string): string {
  const cjk = displayName.match(/[\u3400-\u9fff]/);
  if (cjk) return cjk[0];
  const alnum = displayName.match(/[A-Za-z0-9]/g);
  if (alnum && alnum.length >= 2) {
    return `${alnum[0]}${alnum[1]}`.toUpperCase();
  }
  if (alnum && alnum.length === 1) return alnum[0].toUpperCase();
  return '?';
}

function contributionGlyph(icon: string | null | undefined): LucideIcon | null {
  if (!icon || !(icon in CONTRIBUTION_ICONS)) return null;
  return CONTRIBUTION_ICONS[icon];
}

export function DshBuiltinPluginIcon({
  itemKey,
}: {
  itemKey: DshBuiltinItemKey;
}) {
  const Glyph = DSH_BUILTIN_ITEM_GLYPHS[itemKey] ?? PluginArtworkDefault;
  return (
    <span
      className="product-plugin-icon dsh-card-icon"
      data-dsh-icon={itemKey}
      aria-hidden="true"
    >
      <Glyph className="product-plugin-artwork-svg" />
    </span>
  );
}

export function CoreFoundationPluginIcon({
  artworkKey,
  pluginId,
}: {
  artworkKey: CoreFoundationArtworkKey;
  pluginId?: string;
}) {
  const Glyph = CORE_FOUNDATION_GLYPHS[artworkKey] ?? PluginArtworkDefault;
  return (
    <span
      className="product-plugin-icon dsh-card-icon"
      data-official={artworkKey}
      data-core-plugin={pluginId}
      aria-hidden="true"
    >
      <Glyph className="product-plugin-artwork-svg" />
    </span>
  );
}

export function PluginProductIcon({ pluginId }: { pluginId?: string }) {
  const official = pluginId ? officialPluginI18nKey(pluginId) : null;
  const coreArtwork = pluginId ? CORE_PLUGIN_ARTWORK_BY_ID[pluginId] : null;
  const Glyph =
    (official && OFFICIAL_GLYPHS[official]) ||
    (coreArtwork && CORE_FOUNDATION_GLYPHS[coreArtwork]) ||
    PluginArtworkDefault;

  return (
    <span
      className="product-plugin-icon dsh-card-icon"
      data-official={official ?? coreArtwork ?? undefined}
      aria-hidden="true"
    >
      <Glyph className="product-plugin-artwork-svg" />
    </span>
  );
}

export function PluginMarketplaceLogo({
  listing,
  displayName,
}: {
  listing: CatalogListing;
  displayName: string;
}) {
  const official = officialGlyphForListing(listing);
  const OfficialGlyph = official ? OFFICIAL_GLYPHS[official] : null;
  const CatalogGlyph = contributionGlyph(listing.icon);
  const bitmap = listing.icon ? allowedMarketplaceIconUrl(listing.icon) : null;
  const [bitmapFailed, setBitmapFailed] = useState(false);
  const initials = marketplaceLogoInitials(displayName);
  const fill =
    INITIALS_PALETTE[
      fnv1a32(`${listing.owner}/${listing.pluginName}`) %
        INITIALS_PALETTE.length
    ];

  if (OfficialGlyph) {
    return (
      <span
        className="product-plugin-card-logo dsh-card-icon"
        data-official={official ?? undefined}
        aria-hidden="true"
      >
        <OfficialGlyph className="product-plugin-artwork-svg" />
      </span>
    );
  }

  if (CatalogGlyph) {
    return (
      <span className="product-plugin-card-logo" aria-hidden="true">
        <CatalogGlyph />
      </span>
    );
  }

  if (bitmap && !bitmapFailed) {
    return (
      <span className="product-plugin-card-logo" aria-hidden="true">
        <img
          alt=""
          src={bitmap}
          referrerPolicy="no-referrer"
          onError={() => setBitmapFailed(true)}
        />
      </span>
    );
  }

  return (
    <span
      className="product-plugin-card-logo"
      aria-hidden="true"
      style={{ background: fill }}
    >
      <span className="product-plugin-card-initials">{initials}</span>
    </span>
  );
}
