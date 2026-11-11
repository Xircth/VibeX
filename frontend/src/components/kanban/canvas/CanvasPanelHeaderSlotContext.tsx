import { createContext, useContext } from 'react';

export const CanvasPanelHeaderSlotContext = createContext<HTMLElement | null>(
  null
);

export function useCanvasPanelHeaderSlot(): HTMLElement | null {
  return useContext(CanvasPanelHeaderSlotContext);
}
