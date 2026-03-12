import type { IDockviewPanelProps } from 'dockview-react';
import { FileText } from 'lucide-react';

function DockviewWelcomePanel(_props: IDockviewPanelProps) {
  return (
    <div
      className="h-full w-full flex items-center justify-center bg-background text-muted-foreground text-sm"
      data-panel="welcome"
    >
      <div className="text-center space-y-2">
        <FileText className="h-8 w-8 opacity-40 mx-auto" />
        <p className="font-medium">欢迎</p>
        <p className="text-xs">打开文件或查看差异</p>
      </div>
    </div>
  );
}

export default DockviewWelcomePanel;
