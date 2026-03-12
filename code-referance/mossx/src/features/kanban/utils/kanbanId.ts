let counter = 0;

export function generateKanbanId(): string {
  counter += 1;
  return `kb_${Date.now()}_${counter}`;
}

let panelCounter = 0;

export function generatePanelId(): string {
  panelCounter += 1;
  return `panel_${Date.now()}_${panelCounter}`;
}
