export type LayoutMode = "desktop" | "tablet" | "phone";

export function useLayoutMode() {
  // Always return "desktop" mode to disable responsive layout
  return "desktop" as LayoutMode;
}
