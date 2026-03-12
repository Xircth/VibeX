import type { SessionModeInfo } from "@/lib/types"

// Legacy helper kept for compatibility while ACP mode discovery fully
// drives mode selection in connected chat sessions.
export function getAgentModes(): SessionModeInfo[] {
  return []
}
