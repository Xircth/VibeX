import { create } from 'zustand';

interface AgentCommandOutputState {
  outputByTool: Record<string, string>;
  setOutput: (toolUseId: string, output: string) => void;
  clear: (toolUseId: string) => void;
}

export const useAgentCommandOutputStore = create<AgentCommandOutputState>(
  (set) => ({
    outputByTool: {},
    setOutput: (toolUseId, output) =>
      set((state) => ({
        outputByTool: { ...state.outputByTool, [toolUseId]: output },
      })),
    clear: (toolUseId) =>
      set((state) => {
        if (!(toolUseId in state.outputByTool)) {
          return state;
        }
        const outputByTool = { ...state.outputByTool };
        delete outputByTool[toolUseId];
        return { outputByTool };
      }),
  })
);
