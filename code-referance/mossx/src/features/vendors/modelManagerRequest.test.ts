// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import {
  consumeVendorModelManagerRequest,
  requestVendorModelManager,
  VENDOR_MODEL_MANAGER_REQUEST_EVENT,
} from "./modelManagerRequest";

describe("modelManagerRequest", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("stores and consumes codex request", () => {
    requestVendorModelManager({ target: "codex", addMode: true });

    const request = consumeVendorModelManagerRequest();
    expect(request).toEqual({
      target: "codex",
      addMode: true,
    });

    expect(consumeVendorModelManagerRequest()).toBeNull();
  });

  it("defaults target to claude for unsupported payload", () => {
    window.sessionStorage.setItem(
      "mossx.vendor.model-manager-request",
      JSON.stringify({ target: "other", addMode: 0 }),
    );

    expect(consumeVendorModelManagerRequest()).toEqual({
      target: "claude",
      addMode: false,
    });
  });

  it("emits request event", () => {
    let fired = false;
    const listener = () => {
      fired = true;
    };
    window.addEventListener(VENDOR_MODEL_MANAGER_REQUEST_EVENT, listener);

    requestVendorModelManager({ target: "claude" });

    window.removeEventListener(VENDOR_MODEL_MANAGER_REQUEST_EVENT, listener);
    expect(fired).toBe(true);
  });
});
