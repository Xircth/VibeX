import { useEffect, useState } from 'react';

import {
  PluginActionEditor,
  type PluginActionDraft,
} from '@/components/plugins/PluginActionEditor';
import type { BackendTransport } from '@/lib/backendTransport';

export function ComposerPluginActions({
  transport,
  message,
  onMessageChange,
  onReadyChange,
}: {
  transport: BackendTransport;
  message: string;
  onMessageChange: (message: string) => void;
  onReadyChange?: (ready: boolean) => void;
}) {
  const [action, setAction] = useState<PluginActionDraft | null>(null);

  useEffect(() => {
    if (!message.trim()) {
      setAction(null);
    }
  }, [message]);

  return (
    <PluginActionEditor
      transport={transport}
      value={action}
      showPromptEditor={false}
      onReadyChange={onReadyChange}
      onChange={(nextAction) => {
        const actionPrompt = nextAction.promptBlocks
          .map((block) => block.text)
          .join('\n');
        const combinedPrompt = [message.trimEnd(), actionPrompt]
          .filter(Boolean)
          .join('\n\n');
        setAction({
          ...nextAction,
          promptBlocks: [{ type: 'text', text: combinedPrompt }],
        });
        onMessageChange(combinedPrompt);
      }}
    />
  );
}
