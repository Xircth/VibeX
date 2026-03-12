import { useEffect, useRef } from "react";
import {
  isGlassSupported,
  setLiquidGlassEffect,
} from "tauri-plugin-liquid-glass-api";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DebugEntry } from "../../../types";

type Params = {
  reduceTransparency: boolean;
  onDebug?: (entry: DebugEntry) => void;
};

export function useLiquidGlassEffect({ reduceTransparency, onDebug }: Params) {
  const supportedRef = useRef<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    const apply = async () => {
      try {
        const window = getCurrentWindow();
        // Always disable window transparency effects (glass/vibrancy)
        // All themes now use opaque backgrounds
        if (supportedRef.current === null) {
          supportedRef.current = await isGlassSupported();
        }
        if (supportedRef.current) {
          await setLiquidGlassEffect({ enabled: false });
        }
        await window.setEffects({ effects: [] });
      } catch (error) {
        if (cancelled || !onDebug) {
          return;
        }
        onDebug({
          id: `${Date.now()}-client-liquid-glass-error`,
          timestamp: Date.now(),
          source: "error",
          label: "liquid-glass/apply-error",
          payload: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void apply();

    return () => {
      cancelled = true;
    };
  }, [onDebug, reduceTransparency]);
}
