import { useEffect } from "react";
import { normalizeHexColor, getContrastingTextColor } from "../../../utils/colorUtils";

export function useUserMessageBubbleColor(userMsgColor: string) {
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const root = document.documentElement;
    const normalized = normalizeHexColor(userMsgColor);

    if (normalized) {
      root.style.setProperty("--surface-bubble-user", normalized);
      root.style.setProperty("--color-message-user-bg", normalized);
      root.style.setProperty("--color-message-user-text", getContrastingTextColor(normalized));
      try {
        window.localStorage.setItem("userMsgColor", normalized);
      } catch {
        // ignore localStorage write failures
      }
      return;
    }

    root.style.removeProperty("--surface-bubble-user");
    root.style.removeProperty("--color-message-user-bg");
    root.style.removeProperty("--color-message-user-text");
    try {
      window.localStorage.removeItem("userMsgColor");
    } catch {
      // ignore localStorage write failures
    }
  }, [userMsgColor]);
}
