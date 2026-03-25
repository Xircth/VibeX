import { Keyboard } from 'lucide-react';

const SHORTCUT_ITEMS = [
  {
    name: 'Markdown 文件预览/编辑切换',
    keys: '鼠标中键',
    description: '在文件预览标签页中切换 Markdown 预览与源码编辑。',
  },
  {
    name: '打开终端栏',
    keys: 'Ctrl + ~',
    description: '在当前工作区中打开终端栏。',
  },
  {
    name: '打开左侧文件管理器',
    keys: 'Ctrl + P',
    description: '切换左侧文件管理器面板。',
  },
  {
    name: '打开全局搜索',
    keys: 'Ctrl + Shift + F',
    description: '打开工作区全局搜索面板。',
  },
  {
    name: '消息发送',
    keys: 'Ctrl + Enter',
    description: '在执行区发送消息。',
  },
  {
    name: '打开设置',
    keys: 'Ctrl + ,',
    description: '打开设置窗口。',
  },
  {
    name: '保存文件',
    keys: 'Ctrl + S',
    description: '在文件预览标签页保存当前文件。',
  },
] as const;

export function ShortcutSettings() {
  return (
    <div className="max-w-2xl mx-auto py-6 px-4">
      <div className="mb-4">
        <h2 className="text-base font-semibold">快捷键</h2>
        <p className="text-xs text-muted-foreground mt-1">
          当前提供的默认快捷键如下。
        </p>
      </div>

      <div className="space-y-3">
        {SHORTCUT_ITEMS.map((item) => (
          <section
            key={item.name}
            className="rounded-xl border bg-card p-4 space-y-2"
          >
            <div className="flex items-center gap-2">
              <Keyboard className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">{item.name}</h3>
            </div>
            <p className="text-xs text-muted-foreground">{item.description}</p>
            <kbd className="inline-flex rounded-md border bg-muted px-2 py-1 text-[11px] font-mono text-muted-foreground">
              {item.keys}
            </kbd>
          </section>
        ))}
      </div>
    </div>
  );
}
