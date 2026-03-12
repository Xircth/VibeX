import { useEffect, useState } from "react";
import { getClientStoreSync, writeClientStoreValue } from "../../../services/clientStorage";

export function useTransparencyPreference() {
  const [reduceTransparency, setReduceTransparency] = useState(() => {
    const stored = getClientStoreSync<boolean>("layout", "reduceTransparency");
    // Default to true (reduce transparency enabled) if not set
    if (stored === undefined) {
      return true;
    }
    return stored;
  });

  useEffect(() => {
    writeClientStoreValue("layout", "reduceTransparency", reduceTransparency);
  }, [reduceTransparency]);

  return {
    reduceTransparency,
    setReduceTransparency,
  };
}
