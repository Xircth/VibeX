import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { AgentMark } from './AgentMark';
import { EqIcon } from './EquationIcons';

type SlotItem = { id: string; label: string; kind: 'agent' | 'mark' };

const SLOT_A: SlotItem[] = [
  { id: 'cursor', label: 'Cursor', kind: 'agent' },
  { id: 'trae', label: 'Trae', kind: 'mark' },
  { id: 'qoder', label: 'Qoder', kind: 'mark' },
  { id: 'vscode', label: 'VS Code', kind: 'mark' },
  { id: 'jetbrains', label: 'JetBrains', kind: 'mark' },
];

const SLOT_B: SlotItem[] = [
  { id: 'claude', label: 'Claude Code', kind: 'agent' },
  { id: 'codex', label: 'Codex', kind: 'agent' },
  { id: 'antigravity', label: 'Antigravity', kind: 'agent' },
  { id: 'openclaw', label: 'OpenClaw', kind: 'agent' },
  { id: 'opencode', label: 'OpenCode', kind: 'agent' },
  { id: 'cline', label: 'Cline', kind: 'agent' },
  { id: 'hermes', label: 'Hermes', kind: 'agent' },
  { id: 'codebuddy', label: 'CodeBuddy', kind: 'agent' },
  { id: 'kimi', label: 'Kimi Code', kind: 'agent' },
  { id: 'pi', label: 'Pi', kind: 'agent' },
  { id: 'grok', label: 'Grok', kind: 'agent' },
  { id: 'deepseek', label: 'DeepSeek', kind: 'agent' },
];

const SLOT_C_ZH: SlotItem[] = [
  { id: 'opensource', label: '完全开源', kind: 'mark' },
  { id: 'custom', label: '高自定义', kind: 'mark' },
  { id: 'skills', label: 'Skills', kind: 'mark' },
  { id: 'mcp', label: 'MCP', kind: 'mark' },
  { id: 'cli', label: 'CLI', kind: 'mark' },
  { id: 'terminal', label: 'Terminal', kind: 'mark' },
  { id: 'git', label: 'Git', kind: 'mark' },
  { id: 'worktree', label: 'WorktreeManager', kind: 'mark' },
  { id: 'local', label: '本地运行', kind: 'mark' },
];

const SLOT_C_EN: SlotItem[] = [
  { id: 'opensource', label: 'Open source', kind: 'mark' },
  { id: 'custom', label: 'Customizable', kind: 'mark' },
  { id: 'skills', label: 'Skills', kind: 'mark' },
  { id: 'mcp', label: 'MCP', kind: 'mark' },
  { id: 'cli', label: 'CLI', kind: 'mark' },
  { id: 'terminal', label: 'Terminal', kind: 'mark' },
  { id: 'git', label: 'Git', kind: 'mark' },
  { id: 'worktree', label: 'Worktree Manager', kind: 'mark' },
  { id: 'local', label: 'Local-first', kind: 'mark' },
];

const SLOT_D_ZH: SlotItem[] = [
  { id: 'webui', label: 'WebUI', kind: 'mark' },
  { id: 'remote', label: '远程连接', kind: 'mark' },
  { id: 'client', label: '客户端 APP', kind: 'mark' },
];

const SLOT_D_EN: SlotItem[] = [
  { id: 'webui', label: 'Web UI', kind: 'mark' },
  { id: 'remote', label: 'Remote', kind: 'mark' },
  { id: 'client', label: 'Client app', kind: 'mark' },
];

export function EquationLine({ locale }: { locale: 'zh' | 'en' }) {
  const c = locale === 'zh' ? SLOT_C_ZH : SLOT_C_EN;
  const d = locale === 'zh' ? SLOT_D_ZH : SLOT_D_EN;
  return (
    <p className="onboarding-eq-line" data-testid="onboarding-eq-line">
      <span className="onboarding-eq-brand">VibeX</span>
      <span className="onboarding-eq-op">=</span>
      <RotateSlot items={SLOT_A} period={2800} />
      <span className="onboarding-eq-op">+</span>
      <RotateSlot items={SLOT_B} period={1700} />
      <span className="onboarding-eq-op">+</span>
      <RotateSlot items={c} period={2400} />
      <span className="onboarding-eq-op">+</span>
      <RotateSlot items={d} period={3100} />
    </p>
  );
}

function RotateSlot({
  items,
  period,
}: {
  items: readonly SlotItem[];
  period: number;
}) {
  const [index, setIndex] = useState(0);
  const measure = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number>();

  useEffect(() => {
    const reduce = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;
    if (reduce) return undefined;
    const id = window.setInterval(() => {
      setIndex((n) => (n + 1) % items.length);
    }, period);
    return () => window.clearInterval(id);
  }, [items.length, period]);

  useLayoutEffect(() => {
    if (measure.current) setWidth(measure.current.offsetWidth);
  }, [index]);

  const item = items[index] ?? items[0];
  return (
    <span className="onboarding-eq-slot" style={width ? { width } : undefined}>
      <span
        ref={measure}
        className="onboarding-eq-slot-measure"
        aria-hidden="true"
      >
        <SlotGlyph item={item} />
        {item.label}
      </span>
      <span key={item.id} className="onboarding-eq-slot-in">
        <SlotGlyph item={item} />
        {item.label}
      </span>
    </span>
  );
}

function SlotGlyph({ item }: { item: SlotItem }) {
  return (
    <span className="onboarding-eq-glyph">
      {item.kind === 'agent' ? (
        <AgentMark id={item.id} title={item.label} />
      ) : (
        <EqIcon name={item.id} />
      )}
    </span>
  );
}
