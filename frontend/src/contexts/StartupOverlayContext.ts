import { createContext, type ReactNode } from 'react';

// Startup UI shares the active route's theme, portals and modal host.
export const StartupOverlayContext = createContext<ReactNode>(null);
