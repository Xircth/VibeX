import { SettingsShell } from "@/components/settings/settings-shell"

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <SettingsShell>{children}</SettingsShell>
}
