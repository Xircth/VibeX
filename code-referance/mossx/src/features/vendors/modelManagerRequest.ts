export type VendorModelManagerTarget = "claude" | "codex";

export interface VendorModelManagerRequest {
  target: VendorModelManagerTarget;
  addMode?: boolean;
}

const REQUEST_STORAGE_KEY = "mossx.vendor.model-manager-request";
export const VENDOR_MODEL_MANAGER_REQUEST_EVENT =
  "mossx:vendor-model-manager-request";

export function requestVendorModelManager(
  request: VendorModelManagerRequest,
): void {
  if (typeof window === "undefined") {
    return;
  }

  const payload = {
    target: request.target === "codex" ? "codex" : "claude",
    addMode: Boolean(request.addMode),
    timestamp: Date.now(),
  } satisfies VendorModelManagerRequest & { timestamp: number };

  try {
    window.sessionStorage.setItem(REQUEST_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore storage write errors
  }

  window.dispatchEvent(new CustomEvent(VENDOR_MODEL_MANAGER_REQUEST_EVENT));
}

export function consumeVendorModelManagerRequest():
  | VendorModelManagerRequest
  | null {
  if (typeof window === "undefined") {
    return null;
  }

  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(REQUEST_STORAGE_KEY);
    window.sessionStorage.removeItem(REQUEST_STORAGE_KEY);
  } catch {
    return null;
  }

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<VendorModelManagerRequest>;
    const target = parsed.target === "codex" ? "codex" : "claude";
    return {
      target,
      addMode: Boolean(parsed.addMode),
    };
  } catch {
    return null;
  }
}
