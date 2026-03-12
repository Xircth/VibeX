"use client"

import { useTheme } from "next-themes"
import { Toaster, type ToasterProps } from "sonner"

export function AppToaster(props: ToasterProps) {
  const { resolvedTheme } = useTheme()
  const theme = props.theme ?? (resolvedTheme === "dark" ? "dark" : "light")

  return <Toaster {...props} theme={theme} />
}
