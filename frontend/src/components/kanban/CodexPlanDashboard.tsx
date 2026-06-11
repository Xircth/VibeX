import { AlertCircle } from 'lucide-react';

export function CodexPlanDashboard() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Codex Account
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Account and rate-limit data is not read through Codex app-server in
          the ACP-native agent platform.
        </p>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-border bg-background p-4 text-sm text-muted-foreground">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <div className="font-medium text-foreground">
            Runtime account probing removed
          </div>
          <div className="mt-1">
            Codex live sessions now run through the ACP agent runtime. Any
            future account surface should be added through the registry-driven
            agent settings flow instead of starting Codex app-server.
          </div>
        </div>
      </div>
    </div>
  );
}
