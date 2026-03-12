"use client"

import { usePlatform } from "./use-platform"

export function useIsMac(): boolean {
  const { isMac } = usePlatform()
  return isMac
}
