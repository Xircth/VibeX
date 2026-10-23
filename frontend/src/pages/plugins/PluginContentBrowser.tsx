import {
  Table,
  pixel,
  proportional,
  useTableTreeData,
  useTableTreeState,
  type TableColumn,
} from '@astryxdesign/core/Table';
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  Cpu,
  Eye,
  FileCode2,
  Folder,
  GitBranch,
  Sparkles,
  Webhook,
  Wrench,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import '@/components/previews/markdownFileProse.css';
import type {
  CatalogListing,
  PluginContentDocument,
  PluginContributionCatalogItem,
  PluginControlItem,
} from '@/lib/api/plugins';
import { resolvePluginTelemetry } from './PluginAttributeBadges';
import {
  isOfficialPluginId,
  officialPluginReadme,
  resolveOfficialPluginKey,
  type OfficialPluginI18nKey,
} from './officialPlugins';

export interface PackageTreeNode extends Record<string, unknown> {
  id: string;
  name: string;
  displayName: string;
  nodeType: 'folder' | 'file';
  kindLabel: string;
  sizeLabel: string;
  children?: PackageTreeNode[];
}

interface RepoTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
  kind?: string;
}

interface MutableRepoTreeFolder {
  name: string;
  path: string;
  depth: number;
  folders: Map<string, MutableRepoTreeFolder>;
  files: Array<{
    name: string;
    path: string;
    kindLabel: string;
    sizeLabel: string;
  }>;
  deepItemCount: number;
}

const MAX_PACKAGE_TREE_LEVELS = 3;
const githubRepoTreeCache = new Map<string, RepoTreeEntry[]>();

const KIND_ORDER = [
  'ui',
  'skill',
  'mcp',
  'hook',
  'workflow',
  'runtime',
  'other',
] as const;

const UI_CONTRIBUTION_KINDS = new Set([
  'ui',
  'viewer',
  'file_opener',
  'file.opener',
  'preview_provider',
  'artifact.preview',
  'app_surface',
  'app.surface',
  'app_panel',
  'app.panel',
  'app_tab',
  'app.tab',
  'kanban_view',
  'app.kanban.view',
  'settings_page',
  'app.settings.page',
  'settings_section',
  'app.settings.section',
  'status',
  'app.status',
  'toolbar',
  'app.toolbar',
  'command',
  'app.command',
  'composer_slash',
  'app.composer.slash',
  'composer_action',
  'app.composer.action',
  'timeline_card',
  'conversation.timeline.card',
  'app_rail_section',
  'app.rail.section',
]);

function kindGroup(kind: string) {
  const normalized = kind.trim().toLowerCase();
  if (normalized === 'skill' || normalized === 'content.skill') return 'skill';
  if (normalized === 'mcp' || normalized === 'content.mcp') return 'mcp';
  if (normalized === 'hook' || normalized === 'content.hook') return 'hook';
  if (
    normalized === 'workflow' ||
    normalized === 'workflow_binding' ||
    normalized === 'workflow.binding' ||
    normalized === 'action'
  ) {
    return 'workflow';
  }
  if (normalized === 'runtime') return 'runtime';
  if (UI_CONTRIBUTION_KINDS.has(normalized)) {
    return 'ui';
  }
  return 'other';
}

function renderComponentGroupIcon(kind: string) {
  switch (kind) {
    case 'ui':
    case 'viewer':
      return <Eye aria-hidden="true" className="dsh-component-group-icon" />;
    case 'mcp':
      return <Wrench aria-hidden="true" className="dsh-component-group-icon" />;
    case 'runtime':
      return <Cpu aria-hidden="true" className="dsh-component-group-icon" />;
    case 'skill':
      return (
        <Sparkles aria-hidden="true" className="dsh-component-group-icon" />
      );
    case 'workflow':
      return (
        <GitBranch aria-hidden="true" className="dsh-component-group-icon" />
      );
    case 'hook':
      return (
        <Webhook aria-hidden="true" className="dsh-component-group-icon" />
      );
    default:
      return <Boxes aria-hidden="true" className="dsh-component-group-icon" />;
  }
}

const OFFICIAL_PLUGIN_COMPONENTS: Partial<
  Record<OfficialPluginI18nKey, PluginContentDocument[]>
> = {
  computerUse: [
    {
      path: 'app/settings-pages/computer-use.md',
      kind: 'settings_page',
      title: '电脑控制',
      content: '电脑控制',
    },
    {
      path: 'app/status/computer-use-status.md',
      kind: 'status',
      title: '电脑控制',
      content: '电脑控制',
    },
    {
      path: 'contents/skills/computer-use/SKILL.md',
      kind: 'skill',
      title: 'Computer Use',
      content: 'Computer Use',
    },
    {
      path: 'contents/mcps/computer-use.json',
      kind: 'mcp',
      title: 'Computer Use MCP',
      content: 'Computer Use MCP',
    },
  ],
  browser: [
    {
      path: 'app/panels/browser.md',
      kind: 'app_panel',
      title: 'Browser',
      content: 'Browser',
    },
    {
      path: 'app/settings-pages/browser-settings.md',
      kind: 'settings_page',
      title: '浏览器',
      content: '浏览器',
    },
    {
      path: 'app/surfaces/settings.md',
      kind: 'app_surface',
      title: '浏览器设置',
      content: '浏览器设置',
    },
    {
      path: 'app/rail-sections/open.md',
      kind: 'app_rail_section',
      title: 'Browser',
      content: 'Browser',
    },
    {
      path: 'contents/skills/vibex-browser/SKILL.md',
      kind: 'skill',
      title: 'VibeX Browser',
      content: 'VibeX Browser',
    },
    {
      path: 'contents/mcps/browser.json',
      kind: 'mcp',
      title: 'Browser',
      content: 'Browser',
    },
  ],
  office: [
    {
      path: 'app/openers/office-file-opener.md',
      kind: 'file_opener',
      title: 'Office Preview',
      content: 'Office Preview\n.docx .pptx .xlsx',
    },
    {
      path: 'contents/skills/pptx/SKILL.md',
      kind: 'skill',
      title: 'PowerPoint',
      content: 'PowerPoint',
    },
    {
      path: 'contents/skills/word/SKILL.md',
      kind: 'skill',
      title: 'Word',
      content: 'Word',
    },
    {
      path: 'contents/skills/excel/SKILL.md',
      kind: 'skill',
      title: 'Excel',
      content: 'Excel',
    },
    {
      path: 'contents/skills/morph-ppt/SKILL.md',
      kind: 'skill',
      title: 'Morph PPT',
      content: 'Morph PPT',
    },
    {
      path: 'contents/skills/morph-ppt-3d/SKILL.md',
      kind: 'skill',
      title: 'Morph PPT 3D',
      content: 'Morph PPT 3D',
    },
    {
      path: 'contents/skills/pitch-deck/SKILL.md',
      kind: 'skill',
      title: 'Pitch deck',
      content: 'Pitch deck',
    },
    {
      path: 'contents/skills/academic-paper/SKILL.md',
      kind: 'skill',
      title: 'Academic paper',
      content: 'Academic paper',
    },
    {
      path: 'contents/skills/data-dashboard/SKILL.md',
      kind: 'skill',
      title: 'Data dashboard',
      content: 'Data dashboard',
    },
    {
      path: 'contents/skills/financial-model/SKILL.md',
      kind: 'skill',
      title: 'Financial model',
      content: 'Financial model',
    },
    {
      path: 'contents/skills/word-form/SKILL.md',
      kind: 'skill',
      title: 'Word form',
      content: 'Word form',
    },
    {
      path: 'contents/workflows/create-document/workflow.json',
      kind: 'workflow',
      title: '创建文档',
      content: '创建文档',
    },
    {
      path: 'contents/workflows/modify-document/workflow.json',
      kind: 'workflow',
      title: '修改文档',
      content: '修改文档',
    },
    {
      path: 'contents/workflows/create-presentation/workflow.json',
      kind: 'workflow',
      title: '创建演示文稿',
      content: '创建演示文稿',
    },
    {
      path: 'contents/workflows/modify-presentation/workflow.json',
      kind: 'workflow',
      title: '修改演示文稿',
      content: '修改演示文稿',
    },
    {
      path: 'contents/workflows/analyze-spreadsheet/workflow.json',
      kind: 'workflow',
      title: '分析表格',
      content: '分析表格',
    },
    {
      path: 'contents/workflows/generate-spreadsheet/workflow.json',
      kind: 'workflow',
      title: '生成表格',
      content: '生成表格',
    },
    {
      path: 'depends/runtimes/officecli.json',
      kind: 'runtime',
      title: 'officecli',
      content: 'officecli',
    },
  ],
  workflowCreator: [
    {
      path: 'app/openers/workflow-source-opener.md',
      kind: 'file_opener',
      title: 'Workflow Studio',
      content: 'Workflow Studio\n.vibex-workflow.json',
    },
    {
      path: 'app/surfaces/workflow-studio.md',
      kind: 'app_surface',
      title: 'Workflow Studio',
      content: 'Workflow Studio',
    },
    {
      path: 'contents/skills/vibex-workflow-creator/SKILL.md',
      kind: 'skill',
      title: 'Workflow Creator',
      content: 'Workflow Creator',
    },
    {
      path: 'contents/mcps/workflow-control.json',
      kind: 'mcp',
      title: 'Workflow control MCP',
      content: 'Workflow control MCP',
    },
  ],
  sessionEnhance: [
    {
      path: 'contents/skills/vibex-session-enhance/SKILL.md',
      kind: 'skill',
      title: '会话增强',
      content: '会话增强',
    },
    {
      path: 'contents/mcps/session.json',
      kind: 'mcp',
      title: '会话 MCP',
      content: '会话 MCP',
    },
  ],
  openConnector: [
    {
      path: 'app/tabs/console.md',
      kind: 'app_tab',
      title: 'Open Connector',
      content: 'Open Connector',
    },
    {
      path: 'app/surfaces/settings.md',
      kind: 'app_surface',
      title: 'Open Connector',
      content: 'Open Connector',
    },
    {
      path: 'app/status/runtime-status.md',
      kind: 'status',
      title: 'Open Connector',
      content: 'Open Connector',
    },
    {
      path: 'app/commands/runtime-status-command.md',
      kind: 'command',
      title: 'Open Connector 状态',
      content: 'Open Connector 状态',
    },
    {
      path: 'contents/skills/open-connector/SKILL.md',
      kind: 'skill',
      title: 'Open Connector',
      content: 'Open Connector',
    },
    {
      path: 'contents/mcps/open-connector.json',
      kind: 'mcp',
      title: 'Open Connector',
      content: 'Open Connector',
    },
    {
      path: 'depends/runtimes/open-connector.json',
      kind: 'runtime',
      title: 'open-connector',
      content: 'open-connector',
    },
  ],
  remoteSsh: [
    {
      path: 'app/surfaces/connect-panel.md',
      kind: 'app_surface',
      title: 'Remote SSH',
      content: 'Remote SSH',
    },
    {
      path: 'app/remote-provisioners/ssh.md',
      kind: 'remote_provisioner',
      title: 'SSH',
      content: 'SSH',
    },
  ],
  providerSwitch: [
    {
      path: 'app/provider-catalogs/claude-code.md',
      kind: 'provider_model_catalog',
      title: 'Claude Code',
      content: 'Claude Code',
    },
    {
      path: 'app/provider-catalogs/codex.md',
      kind: 'provider_model_catalog',
      title: 'Codex',
      content: 'Codex',
    },
    {
      path: 'app/provider-catalogs/antigravity.md',
      kind: 'provider_model_catalog',
      title: 'Antigravity',
      content: 'Antigravity',
    },
    {
      path: 'app/provider-catalogs/grok.md',
      kind: 'provider_model_catalog',
      title: 'Grok',
      content: 'Grok',
    },
    {
      path: 'app/provider-catalogs/pi.md',
      kind: 'provider_model_catalog',
      title: 'Pi',
      content: 'Pi',
    },
    {
      path: 'app/provider-catalogs/hermes.md',
      kind: 'provider_model_catalog',
      title: 'Hermes',
      content: 'Hermes',
    },
    {
      path: 'app/provider-catalogs/openclaw.md',
      kind: 'provider_model_catalog',
      title: 'OpenClaw',
      content: 'OpenClaw',
    },
    {
      path: 'app/provider-catalogs/kimi-code.md',
      kind: 'provider_model_catalog',
      title: 'Kimi Code',
      content: 'Kimi Code',
    },
    {
      path: 'app/provider-catalogs/cline.md',
      kind: 'provider_model_catalog',
      title: 'Cline',
      content: 'Cline',
    },
    {
      path: 'app/provider-catalogs/opencode.md',
      kind: 'provider_model_catalog',
      title: 'OpenCode',
      content: 'OpenCode',
    },
    {
      path: 'app/provider-catalogs/mimo-code.md',
      kind: 'provider_model_catalog',
      title: 'MiMo Code',
      content: 'MiMo Code',
    },
    {
      path: 'app/provider-catalogs/deepseek-harness.md',
      kind: 'provider_model_catalog',
      title: 'DeepSeek Harness',
      content: 'DeepSeek Harness',
    },
  ],
  pluginDevelopment: [
    {
      path: 'contents/skills/vibex-plugin-development/SKILL.md',
      kind: 'skill',
      title: 'VibeX 插件开发',
      content: 'VibeX 插件开发',
    },
  ],
  science: [
    {
      path: 'contents/skills/scientific-brainstorming/SKILL.md',
      kind: 'skill',
      title: 'Scientific Brainstorming',
      content: 'Scientific Brainstorming',
    },
    {
      path: 'contents/skills/hypothesis-generation/SKILL.md',
      kind: 'skill',
      title: 'Scientific Hypothesis Generation',
      content: 'Scientific Hypothesis Generation',
    },
    {
      path: 'contents/skills/experimental-design/SKILL.md',
      kind: 'skill',
      title: 'Experimental Design',
      content: 'Experimental Design',
    },
    {
      path: 'contents/skills/statistical-analysis/SKILL.md',
      kind: 'skill',
      title: 'Statistical Analysis',
      content: 'Statistical Analysis',
    },
    {
      path: 'contents/skills/exploratory-data-analysis/SKILL.md',
      kind: 'skill',
      title: 'Exploratory Data Analysis',
      content: 'Exploratory Data Analysis',
    },
    {
      path: 'contents/skills/scientific-visualization/SKILL.md',
      kind: 'skill',
      title: 'Scientific Visualization',
      content: 'Scientific Visualization',
    },
    {
      path: 'contents/skills/literature-review/SKILL.md',
      kind: 'skill',
      title: 'Literature Review',
      content: 'Literature Review',
    },
    {
      path: 'contents/skills/scientific-writing/SKILL.md',
      kind: 'skill',
      title: 'Scientific Writing',
      content: 'Scientific Writing',
    },
  ],
  kanbanViews: [
    {
      path: 'app/commands/kanban-filter-command.md',
      kind: 'command',
      title: 'Filter Kanban Tasks',
      content: 'Filter Kanban Tasks',
    },
    {
      path: 'contents/skills/kanban-triage/SKILL.md',
      kind: 'skill',
      title: 'Kanban Task Triage',
      content: 'Kanban Task Triage',
    },
  ],
  notes: [
    {
      path: 'app/commands/open-notes.md',
      kind: 'command',
      title: 'Open Workspace Notes',
      content: 'Open Workspace Notes',
    },
    {
      path: 'contents/skills/session-notes/SKILL.md',
      kind: 'skill',
      title: 'Workspace & Session Notes',
      content: 'Workspace & Session Notes',
    },
  ],
  promptEnhancer: [
    {
      path: 'app/commands/enhance-prompt-command.md',
      kind: 'command',
      title: 'Enhance Composer Prompt',
      content: 'Enhance Composer Prompt',
    },
    {
      path: 'contents/skills/prompt-refinement/SKILL.md',
      kind: 'skill',
      title: 'Prompt Refinement & Context Structuring',
      content: 'Prompt Refinement & Context Structuring',
    },
  ],
};

function normalizeDocumentPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
}

function extractDocumentResourceId(value: string): string {
  const segments = normalizeDocumentPath(value).split('/').filter(Boolean);
  if (segments.length === 0) return '';
  const last = segments[segments.length - 1];
  if (last === 'skill.md' && segments.length >= 2) {
    return segments[segments.length - 2];
  }
  if (last === 'workflow.json' && segments.length >= 2) {
    return segments[segments.length - 2];
  }
  return last.replace(/\.(md|json|ya?ml|toml)$/i, '');
}

function contributionDefaultPath(kind: string, id: string): string {
  switch (kind) {
    case 'skill':
      return `contents/skills/${id}/SKILL.md`;
    case 'mcp':
      return `contents/mcps/${id}.json`;
    case 'hook':
      return `contents/hooks/${id}.json`;
    case 'workflow':
    case 'workflow_binding':
    case 'action':
      return `contents/workflows/${id}/workflow.json`;
    case 'runtime':
      return `depends/runtimes/${id}.json`;
    case 'file_opener':
      return `app/openers/${id}.md`;
    case 'preview_provider':
      return `app/previews/${id}.md`;
    case 'app_surface':
      return `app/surfaces/${id}.md`;
    case 'app_panel':
      return `app/panels/${id}.md`;
    case 'app_tab':
      return `app/tabs/${id}.md`;
    case 'kanban_view':
      return `app/kanban-views/${id}.md`;
    case 'settings_page':
      return `app/settings-pages/${id}.md`;
    case 'settings_section':
      return `app/settings/${id}.md`;
    case 'status':
      return `app/status/${id}.md`;
    case 'toolbar':
      return `app/toolbar/${id}.md`;
    case 'command':
      return `app/commands/${id}.md`;
    case 'composer_slash':
      return `app/composer/${id}.md`;
    case 'composer_action':
      return `app/composer-actions/${id}.md`;
    case 'timeline_card':
      return `app/timeline/${id}.md`;
    case 'app_rail_section':
      return `app/rail-sections/${id}.md`;
    default:
      return `app/${kind}/${id}.md`;
  }
}

export function resolvePluginComponentDocuments({
  contents,
  pluginId,
  owner,
  plugin,
  contributions,
  listing,
  preferOfficialCatalog,
}: {
  contents: PluginContentDocument[];
  pluginId?: string;
  owner?: string | null;
  plugin?: PluginControlItem | null;
  contributions?: PluginContributionCatalogItem[] | null;
  listing?: CatalogListing | null;
  preferOfficialCatalog?: boolean;
}): PluginContentDocument[] {
  const merged: PluginContentDocument[] = [];
  const appendUnique = (candidate: PluginContentDocument) => {
    const candidatePath = normalizeDocumentPath(candidate.path);
    const candidateKind = candidate.kind.trim().toLowerCase();
    const candidateResourceId = extractDocumentResourceId(candidate.path);
    const candidateTitle = candidate.title.trim().toLowerCase();
    const exists = merged.some((item) => {
      if (normalizeDocumentPath(item.path) === candidatePath) {
        return true;
      }
      if (item.kind.trim().toLowerCase() !== candidateKind) {
        return false;
      }
      const itemResourceId = extractDocumentResourceId(item.path);
      if (
        candidateResourceId &&
        itemResourceId &&
        itemResourceId === candidateResourceId
      ) {
        return true;
      }
      return (
        Boolean(candidateTitle) &&
        item.title.trim().toLowerCase() === candidateTitle
      );
    });
    if (!exists) {
      merged.push(candidate);
    }
  };

  for (const doc of contents) {
    appendUnique(doc);
  }

  if (plugin) {
    for (const appItem of plugin.appContributions ?? []) {
      appendUnique({
        path: contributionDefaultPath(appItem.kind, appItem.id),
        kind: appItem.kind,
        title: appItem.label || appItem.id,
        content: appItem.label || appItem.id,
      });
    }
    for (const skill of plugin.skills ?? []) {
      appendUnique({
        path: skill.path || contributionDefaultPath('skill', skill.id),
        kind: 'skill',
        title: skill.id,
        content: skill.id,
      });
    }
    for (const mcpId of plugin.mcpServers ?? []) {
      appendUnique({
        path: contributionDefaultPath('mcp', mcpId),
        kind: 'mcp',
        title: mcpId,
        content: mcpId,
      });
    }
    for (const hook of plugin.hooks ?? []) {
      appendUnique({
        path: hook.path || contributionDefaultPath('hook', hook.id),
        kind: 'hook',
        title: hook.id,
        content: hook.id,
      });
    }
    for (const workflow of plugin.workflows ?? []) {
      appendUnique({
        path: workflow.path || contributionDefaultPath('workflow', workflow.id),
        kind: 'workflow',
        title: workflow.id,
        content: workflow.id,
      });
    }
    for (const invocation of plugin.invocations ?? []) {
      const kind = invocation.kind === 'command' ? 'command' : 'workflow';
      appendUnique({
        path: contributionDefaultPath(kind, invocation.id),
        kind,
        title: invocation.label || invocation.id,
        content: invocation.label || invocation.id,
      });
    }
    for (const runtime of plugin.runtimes ?? []) {
      appendUnique({
        path: contributionDefaultPath('runtime', runtime.id),
        kind: 'runtime',
        title: runtime.id,
        content: runtime.command || runtime.id,
      });
    }
  }

  const targetPluginId = (plugin?.id ?? pluginId ?? '').trim();
  if (contributions && targetPluginId) {
    for (const item of contributions) {
      if (item.pluginId !== targetPluginId && item.pluginId !== pluginId) {
        continue;
      }
      const normalizedKind =
        item.kind === 'workflow_binding' || item.kind === 'action'
          ? 'workflow'
          : item.kind;
      appendUnique({
        path: contributionDefaultPath(normalizedKind, item.id),
        kind: normalizedKind,
        title: item.label || item.id,
        content: item.label || item.id,
      });
    }
  }

  const effectiveId =
    plugin?.id ?? listing?.offlinePluginId ?? pluginId ?? listing?.pluginName ?? '';
  const effectiveOwner =
    owner ?? plugin?.publisher ?? listing?.owner ?? undefined;
  const officialKey = resolveOfficialPluginKey(effectiveId, effectiveOwner);
  if (
    officialKey &&
    (merged.length === 0 ||
      preferOfficialCatalog ||
      isOfficialPluginId(effectiveId))
  ) {
    for (const doc of OFFICIAL_PLUGIN_COMPONENTS[officialKey] ?? []) {
      appendUnique(doc);
    }
  }

  if (merged.length === 0 && listing) {
    if (listing.opens && listing.opens.length > 0) {
      appendUnique({
        path: `app/openers/${listing.pluginName}.md`,
        kind: 'file_opener',
        title: `${listing.displayName} (${listing.opens.join(', ')})`,
        content: listing.opens.join(' '),
      });
    } else if (listing.hasApp) {
      appendUnique({
        path: `app/surfaces/${listing.pluginName}.md`,
        kind: 'app_surface',
        title: listing.displayName,
        content: listing.displayName,
      });
    }
    if (listing.hasMcp) {
      appendUnique({
        path: `contents/mcps/${listing.pluginName}.json`,
        kind: 'mcp',
        title: `${listing.displayName} MCP`,
        content: listing.displayName,
      });
    }
  }

  return merged;
}

function formatByteSize(bytes: number): string {
  const safeBytes = Math.max(1, bytes);
  if (safeBytes < 1024) return `${safeBytes} B`;
  if (safeBytes < 1024 * 1024) return `${(safeBytes / 1024).toFixed(1)} KB`;
  return `${(safeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatContentSize(content: string): string {
  const bytes = Math.max(1, new TextEncoder().encode(content ?? '').length);
  return formatByteSize(bytes);
}

function inferFileKindLabel(filePath: string, explicitKind?: string): string {
  if (explicitKind && explicitKind.trim()) {
    return explicitKind.trim();
  }
  const fileName = filePath.split('/').at(-1) ?? filePath;
  const lower = fileName.toLowerCase();
  if (lower === 'skill.md') return 'skill';
  if (lower.endsWith('.json')) return 'JSON';
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return 'Markdown';
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'TypeScript';
  if (
    lower.endsWith('.js') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs')
  ) {
    return 'JavaScript';
  }
  if (lower.endsWith('.css')) return 'CSS';
  if (lower.endsWith('.html')) return 'HTML';
  if (
    lower.endsWith('.svg') ||
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.webp')
  ) {
    return 'Asset';
  }
  if (
    lower.endsWith('.yml') ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.toml')
  ) {
    return 'Config';
  }
  return 'File';
}

function entriesFromContents(
  documents: PluginContentDocument[]
): RepoTreeEntry[] {
  if (documents.length === 0) {
    return [
      { path: '.vibex-plugin', type: 'tree' },
      {
        path: '.vibex-plugin/plugin.json',
        type: 'blob',
        size: 1420,
        kind: 'JSON',
      },
      { path: 'src', type: 'tree' },
      { path: 'src/index.ts', type: 'blob', size: 3120, kind: 'TypeScript' },
      { path: 'package.json', type: 'blob', size: 860, kind: 'JSON' },
      { path: 'README.md', type: 'blob', size: 2480, kind: 'Markdown' },
    ];
  }

  return documents
    .map((doc): RepoTreeEntry | null => {
      const rawSegments = doc.path.split('/').filter(Boolean);
      const trimmed =
        rawSegments[0] === 'contents' && rawSegments.length > 1
          ? rawSegments.slice(1)
          : rawSegments;
      if (trimmed.length === 0) return null;
      const capped =
        trimmed.length > MAX_PACKAGE_TREE_LEVELS
          ? [
              ...trimmed.slice(0, MAX_PACKAGE_TREE_LEVELS - 1),
              trimmed[trimmed.length - 1],
            ]
          : trimmed;
      return {
        path: capped.join('/'),
        type: 'blob',
        size: Math.max(1, new TextEncoder().encode(doc.content ?? '').length),
        kind: doc.kind,
      };
    })
    .filter((item): item is RepoTreeEntry => item !== null);
}

function buildRepoTreeNodes(
  entries: RepoTreeEntry[],
  isZh: boolean
): { nodes: PackageTreeNode[]; expandableIds: string[] } {
  const root: MutableRepoTreeFolder = {
    name: '',
    path: '',
    depth: 0,
    folders: new Map(),
    files: [],
    deepItemCount: 0,
  };

  const ensureFolder = (
    parent: MutableRepoTreeFolder,
    segment: string
  ): MutableRepoTreeFolder => {
    const folderPath = parent.path ? `${parent.path}/${segment}` : segment;
    let folder = parent.folders.get(segment);
    if (!folder) {
      folder = {
        name: segment,
        path: folderPath,
        depth: parent.depth + 1,
        folders: new Map(),
        files: [],
        deepItemCount: 0,
      };
      parent.folders.set(segment, folder);
    }
    return folder;
  };

  for (const entry of entries) {
    const segments = entry.path.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    if (entry.type === 'tree') {
      const limit = Math.min(segments.length, MAX_PACKAGE_TREE_LEVELS);
      let current = root;
      for (let idx = 0; idx < limit; idx += 1) {
        current = ensureFolder(current, segments[idx]);
      }
      if (segments.length > MAX_PACKAGE_TREE_LEVELS) {
        current.deepItemCount += 1;
      }
      continue;
    }

    if (segments.length <= MAX_PACKAGE_TREE_LEVELS) {
      let current = root;
      for (let idx = 0; idx < segments.length - 1; idx += 1) {
        current = ensureFolder(current, segments[idx]);
      }
      const fileName = segments[segments.length - 1];
      const filePath = current.path ? `${current.path}/${fileName}` : fileName;
      if (!current.files.some((file) => file.path === filePath)) {
        current.files.push({
          name: fileName,
          path: filePath,
          kindLabel: inferFileKindLabel(filePath, entry.kind),
          sizeLabel:
            typeof entry.size === 'number'
              ? formatByteSize(entry.size)
              : formatContentSize(''),
        });
      }
    } else {
      let current = root;
      for (let idx = 0; idx < MAX_PACKAGE_TREE_LEVELS; idx += 1) {
        current = ensureFolder(current, segments[idx]);
      }
      current.deepItemCount += 1;
    }
  }

  const expandableIds: string[] = [];

  const toNodes = (folder: MutableRepoTreeFolder): PackageTreeNode[] => {
    const folderNodes: PackageTreeNode[] = [...folder.folders.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((childFolder) => {
        const canExpand = childFolder.depth < MAX_PACKAGE_TREE_LEVELS;
        const children = canExpand ? toNodes(childFolder) : [];
        const itemCount = canExpand
          ? children.length
          : childFolder.folders.size +
            childFolder.files.length +
            childFolder.deepItemCount;
        if (canExpand && children.length > 0) {
          expandableIds.push(childFolder.path);
        }
        return {
          id: childFolder.path,
          name: childFolder.name,
          displayName: childFolder.name,
          nodeType: 'folder',
          kindLabel: isZh ? '目录' : 'Folder',
          sizeLabel:
            itemCount > 0
              ? isZh
                ? `${itemCount} 项`
                : `${itemCount} items`
              : '-',
          ...(canExpand && children.length > 0 ? { children } : {}),
        };
      });

    const fileNodes: PackageTreeNode[] = [...folder.files]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((file) => ({
        id: file.path,
        name: file.name,
        displayName: file.name,
        nodeType: 'file',
        kindLabel: file.kindLabel,
        sizeLabel: file.sizeLabel,
      }));

    return [...folderNodes, ...fileNodes];
  };

  return {
    nodes: toNodes(root),
    expandableIds,
  };
}

export function groupedPluginContents(documents: PluginContentDocument[]) {
  const groups = new Map<string, PluginContentDocument[]>();
  for (const document of documents) {
    const group = kindGroup(document.kind);
    const items = groups.get(group) ?? [];
    items.push(document);
    groups.set(group, items);
  }
  return KIND_ORDER.filter((kind) => groups.has(kind)).map((kind) => ({
    kind,
    items: groups.get(kind) ?? [],
  }));
}

export function PluginReadmeView({
  pluginId,
  readme,
}: {
  pluginId: string;
  readme: string;
}) {
  const { t } = useTranslation('settings');
  const value = officialPluginReadme(pluginId, readme, t);
  return (
    <article
      className="product-plugin-readme dsh-plugin-readme-card"
      aria-label={t('plugins.readmeTab')}
    >
      {value.trim() ? (
        <AstryxMarkdown
          value={value}
          className="markdown-file-prose dsh-standard-markdown"
        />
      ) : (
        <p className="product-plugin-muted">{t('plugins.noSummary')}</p>
      )}
    </article>
  );
}

export function PluginContentsView({
  contents,
  pluginId,
  owner,
  plugin,
  contributions,
  listing,
  preferOfficialCatalog,
}: {
  contents: PluginContentDocument[];
  pluginId?: string;
  owner?: string | null;
  plugin?: PluginControlItem | null;
  contributions?: PluginContributionCatalogItem[] | null;
  listing?: CatalogListing | null;
  preferOfficialCatalog?: boolean;
}) {
  const { t, i18n } = useTranslation('settings');
  const isZh = i18n.language.toLowerCase().startsWith('zh');
  const resolvedContents = useMemo(
    () =>
      resolvePluginComponentDocuments({
        contents,
        pluginId,
        owner,
        plugin,
        contributions,
        listing,
        preferOfficialCatalog,
      }),
    [
      contents,
      contributions,
      listing,
      owner,
      plugin,
      pluginId,
      preferOfficialCatalog,
    ]
  );
  const groups = useMemo(
    () => groupedPluginContents(resolvedContents),
    [resolvedContents]
  );
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(groups.map((group) => group.kind))
  );

  useEffect(() => {
    setExpanded(new Set(groups.map((group) => group.kind)));
  }, [groups]);

  if (groups.length === 0) {
    return <p className="product-plugin-muted">{t('plugins.contentsEmpty')}</p>;
  }

  const toggleGroup = (kind: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  return (
    <div
      className="product-plugin-contents dsh-components-catalog"
      role="region"
      aria-label={t('plugins.contentsCatalog')}
    >
      {groups.map((group) => {
        const open = expanded.has(group.kind);
        const label = t(`plugins.contentKind.${group.kind}`, {
          defaultValue: group.kind,
        });
        const listId = `plugin-contents-${group.kind}`;
        return (
          <section
            key={group.kind}
            className="product-plugin-contents-group dsh-component-group"
          >
            <button
              type="button"
              className="product-plugin-contents-toggle dsh-component-group-toggle"
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => toggleGroup(group.kind)}
            >
              {open ? (
                <ChevronDown aria-hidden="true" />
              ) : (
                <ChevronRight aria-hidden="true" />
              )}
              {renderComponentGroupIcon(group.kind)}
              <h2>{label}</h2>
              <span className="dsh-component-count-pill">
                {group.items.length}
              </span>
            </button>
            {open ? (
              <ul id={listId} className="dsh-component-list">
                {group.items.map((item) => {
                  const titleText =
                    item.title ||
                    item.path.split('/').filter(Boolean).at(-1) ||
                    item.path;
                  return (
                    <li key={item.path} className="dsh-component-row">
                      <div className="dsh-component-row-main">
                        <span
                          className="dsh-component-row-icon"
                          aria-hidden="true"
                        >
                          <FileCode2 aria-hidden="true" />
                        </span>
                        <div className="dsh-component-row-copy">
                          <span className="dsh-component-row-title">
                            {titleText}
                          </span>
                          <code className="dsh-component-row-path">
                            {item.path}
                          </code>
                        </div>
                      </div>
                      <div className="dsh-component-row-meta">
                        <span className="dsh-component-kind-tag">
                          {item.kind}
                        </span>
                        <span className="dsh-state-badge">
                          <span
                            className="dsh-state-dot"
                            data-state="done"
                            aria-hidden="true"
                          />
                          <span>{isZh ? '已就绪' : 'Ready'}</span>
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

export function PluginPackageTree({
  contents,
  pluginId,
  owner,
  homepage,
  repo,
  sourceOrigin,
}: {
  contents: PluginContentDocument[];
  pluginId?: string;
  owner?: string | null;
  homepage?: string | null;
  repo?: string | null;
  sourceOrigin?: string | null;
}) {
  const { t, i18n } = useTranslation('settings');
  const isZh = i18n.language.toLowerCase().startsWith('zh');
  const telemetry = useMemo(
    () =>
      resolvePluginTelemetry({
        pluginId: pluginId ?? '',
        owner,
        homepage,
        repo,
        sourceOrigin,
      }),
    [homepage, owner, pluginId, repo, sourceOrigin]
  );
  const repositorySlug = telemetry.repositorySlug;
  const [repoEntries, setRepoEntries] = useState<RepoTreeEntry[] | null>(
    () => githubRepoTreeCache.get(repositorySlug) ?? null
  );

  useEffect(() => {
    const cached = githubRepoTreeCache.get(repositorySlug);
    if (cached) {
      setRepoEntries(cached);
      return;
    }
    if (
      !repositorySlug ||
      !repositorySlug.includes('/') ||
      typeof fetch !== 'function'
    ) {
      return;
    }
    const controller = new AbortController();
    fetch(
      `https://api.github.com/repos/${repositorySlug}/git/trees/HEAD?recursive=1`,
      {
        signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json' },
      }
    )
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          data: {
            tree?: Array<{
              path?: unknown;
              type?: unknown;
              size?: unknown;
            }>;
          } | null
        ) => {
          if (!data || !Array.isArray(data.tree)) return;
          const parsed: RepoTreeEntry[] = data.tree
            .filter(
              (item) =>
                typeof item.path === 'string' &&
                (item.type === 'blob' || item.type === 'tree')
            )
            .map((item) => ({
              path: String(item.path),
              type: item.type as 'blob' | 'tree',
              size:
                typeof item.size === 'number' && Number.isFinite(item.size)
                  ? item.size
                  : undefined,
            }));
          if (parsed.length > 0) {
            githubRepoTreeCache.set(repositorySlug, parsed);
            setRepoEntries(parsed);
          }
        }
      )
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [repositorySlug]);

  const effectiveEntries = useMemo(
    () =>
      repoEntries && repoEntries.length > 0
        ? repoEntries
        : entriesFromContents(contents),
    [contents, repoEntries]
  );

  const { nodes: treeNodes, expandableIds } = useMemo(
    () => buildRepoTreeNodes(effectiveEntries, isZh),
    [effectiveEntries, isZh]
  );

  const { visibleData, treeConfig } = useTableTreeState<PackageTreeNode>({
    data: treeNodes,
    idKey: 'id',
    childrenKey: 'children',
    defaultExpandedIds: expandableIds,
    indent: 'sm',
    treeColumnKey: 'name',
  });

  const treePlugin = useTableTreeData<PackageTreeNode>({
    ...treeConfig,
    hasExpandAllControl: true,
    hasRowClickExpansion: true,
  });

  const columns = useMemo<TableColumn<PackageTreeNode>[]>(
    () => [
      {
        key: 'name',
        header: isZh ? '名称' : 'Name',
        width: proportional(1, { minWidth: 200 }),
        renderCell: (row) => (
          <span
            className={`dsh-tree-cell dsh-tree-cell--${row.nodeType}`}
            title={row.id}
          >
            {row.nodeType === 'folder' ? (
              <Folder aria-hidden="true" className="dsh-tree-cell-icon" />
            ) : (
              <FileCode2 aria-hidden="true" className="dsh-tree-cell-icon" />
            )}
            <span className="dsh-tree-cell-name">{row.displayName}</span>
          </span>
        ),
      },
      {
        key: 'kindLabel',
        header: isZh ? '类型' : 'Type',
        width: pixel(120),
        renderCell: (row) => (
          <span className="dsh-tree-kind-badge" data-node-type={row.nodeType}>
            {row.kindLabel}
          </span>
        ),
      },
      {
        key: 'sizeLabel',
        header: isZh ? '大小' : 'Size',
        width: pixel(100),
        align: 'end',
        renderCell: (row) => (
          <span className="dsh-tree-size-label">{row.sizeLabel}</span>
        ),
      },
    ],
    [isZh]
  );

  return (
    <div
      className="dsh-package-tree-direct"
      role="region"
      aria-label={t('plugins.contentTree')}
    >
      <Table<PackageTreeNode>
        data={visibleData}
        idKey="id"
        columns={columns}
        plugins={{ tree: treePlugin }}
        density="compact"
        dividers="rows"
        hasHover
        aria-label={t('plugins.contentTree')}
        className="dsh-package-tree-table"
      />
    </div>
  );
}
