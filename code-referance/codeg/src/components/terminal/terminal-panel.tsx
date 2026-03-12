"use client"

import { useTerminalContext } from "@/contexts/terminal-context"
import { TerminalTabBar } from "./terminal-tab-bar"
import { TerminalView } from "./terminal-view"

export function TerminalPanel() {
  const { isOpen, tabs, activeTabId } = useTerminalContext()

  return (
    <section
      data-terminal-panel-region="true"
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <TerminalTabBar />
      <div className="relative flex-1 min-h-0 overflow-hidden">
        {tabs.map((tab) => (
          <TerminalView
            key={tab.id}
            terminalId={tab.id}
            isActive={tab.id === activeTabId}
            isVisible={isOpen}
          />
        ))}
      </div>
    </section>
  )
}
