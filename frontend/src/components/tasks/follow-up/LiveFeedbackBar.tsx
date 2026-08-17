import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createPluginControlApi } from '@/lib/api/plugins';
import { configuredBackendTransport } from '@/lib/backendTransport';

export function LiveFeedbackBar({
  conversationId,
  visible,
}: {
  conversationId?: string | null;
  visible: boolean;
}) {
  const { t } = useTranslation('conversation');
  const api = useMemo(
    () => createPluginControlApi(configuredBackendTransport),
    []
  );
  const { data: feedbackOn } = useQuery({
    queryKey: ['session-enhance-feedback'],
    queryFn: async () => {
      const catalog = await api.catalog();
      const plugin = catalog.plugins.find(
        (item) => item.id === 'vibex.session-enhance'
      );
      if (!plugin?.enabled) return false;
      const detail = await api.productDetail(plugin.id);
      return detail.config.feedback !== false;
    },
    staleTime: 5_000,
  });
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  if (!visible || !feedbackOn || !conversationId) return null;

  const send = async () => {
    const next = text.trim();
    if (!next || sending) return;
    setSending(true);
    try {
      await configuredBackendTransport.call('conversation_submit_feedback', {
        conversationId,
        text: next,
      });
      setText('');
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      className="flex items-center gap-2 px-3 pb-1"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <Input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t('liveFeedback.placeholder')}
        aria-label={t('liveFeedback.placeholder')}
        disabled={sending}
      />
      <Button type="submit" size="sm" disabled={sending || !text.trim()}>
        {t('liveFeedback.send')}
      </Button>
    </form>
  );
}
