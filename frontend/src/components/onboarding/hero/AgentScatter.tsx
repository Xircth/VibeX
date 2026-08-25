import { SCATTER_SLOTS } from './agentScatterSlots';
import { AgentMark } from './AgentMark';

const SCATTER_AGENTS = [
  'claude',
  'codex',
  'deepseek',
  'cursor',
  'openclaw',
  'opencode',
  'pi',
  'grok',
  'aider',
  'amazonq',
  'amp',
  'auggie',
  'cline',
  'codebuddy',
  'continue',
  'copilot',
  'crush',
  'droid',
  'antigravity',
  'goose',
  'hermes',
  'kimi',
  'openhands',
  'qwen',
  'roo',
] as const;

export function AgentScatter() {
  return (
    <div
      className="onboarding-agent-scatter"
      data-testid="onboarding-hero-scatter"
      aria-hidden
    >
      {SCATTER_SLOTS.map((slot, index) => {
        const id = SCATTER_AGENTS[index % SCATTER_AGENTS.length];
        return (
          <span
            key={`${id}-${index}`}
            className="onboarding-agent-scatter-mark"
            style={{
              left: `${slot.x}%`,
              top: `${slot.y}%`,
              width: slot.s,
              height: slot.s,
              opacity: slot.o,
              transform: `translate(-50%, -50%) rotate(${slot.r}deg)`,
            }}
          >
            <AgentMark id={id} />
          </span>
        );
      })}
    </div>
  );
}
