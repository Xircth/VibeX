import { useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { conversationApi } from './conversationApi';
import type { ConversationBundlePayload } from 'shared/types';

export function ConversationBundlePanel() {
  const [conversationId, setConversationId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [destinationPath, setDestinationPath] = useState('');
  const [bundleText, setBundleText] = useState('');
  const [busy, setBusy] = useState(false);

  const exportBundle = async () => {
    const id = conversationId.trim();
    if (!id) {
      toast.error('请填写会话 ID');
      return;
    }
    setBusy(true);
    try {
      const result = await conversationApi.export({
        conversationId: id,
        destinationPath: destinationPath.trim() || null,
      });
      setBundleText(JSON.stringify(result.bundle, null, 2));
      toast.success('会话包已导出');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '会话包导出失败');
    } finally {
      setBusy(false);
    }
  };

  const importBundle = async () => {
    const workspace = workspaceId.trim();
    if (!workspace) {
      toast.error('请填写工作区 ID');
      return;
    }
    setBusy(true);
    try {
      const bundle = JSON.parse(bundleText) as ConversationBundlePayload;
      const result = await conversationApi.import({ workspaceId: workspace, bundle });
      setConversationId(result.conversationId);
      toast.success('会话包已导入');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '会话包导入失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-inline-group space-y-3 p-3">
      <div>
        <div className="text-xs font-semibold">会话包导入导出</div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          导出 VibeX 事件源会话，或从会话包恢复为可渲染时间线。
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <Input
          value={conversationId}
          placeholder="会话 ID"
          onChange={(event) => setConversationId(event.target.value)}
          disabled={busy}
        />
        <Input
          value={destinationPath}
          placeholder="可选导出路径"
          onChange={(event) => setDestinationPath(event.target.value)}
          disabled={busy}
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          className="h-8 text-xs"
          onClick={() => void exportBundle()}
          disabled={busy}
        >
          <Download className="mr-1 h-3.5 w-3.5" />
          导出会话包
        </Button>
        <Input
          value={workspaceId}
          placeholder="导入目标工作区 ID"
          onChange={(event) => setWorkspaceId(event.target.value)}
          disabled={busy}
        />
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 text-xs"
          onClick={() => void importBundle()}
          disabled={busy || !bundleText.trim()}
        >
          <Upload className="mr-1 h-3.5 w-3.5" />
          导入
        </Button>
      </div>
      <Textarea
        value={bundleText}
        placeholder="导出的会话包 JSON 会显示在这里，也可以粘贴会话包 JSON 后导入。"
        onChange={(event) => setBundleText(event.target.value)}
        disabled={busy}
        className="min-h-28 text-xs"
      />
    </div>
  );
}
