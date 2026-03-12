export function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function isDefaultWorkspacePath(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return (
    normalized.includes("/.codemoss/workspace") ||
    normalized.includes("/com.zhukunpenglinyutong.codemoss/workspace")
  );
}
