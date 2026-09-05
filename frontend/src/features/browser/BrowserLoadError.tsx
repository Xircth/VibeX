import { CircleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  browserErrorCode,
  browserLoadErrorKind,
  type BrowserLoadErrorInfo,
} from './chromiumNetError';

const TITLE_KEYS = {
  notFound: 'webPreviewPanel.errorNotFound',
  timedOut: 'webPreviewPanel.errorTimedOut',
  connection: 'webPreviewPanel.errorConnection',
  certificate: 'webPreviewPanel.errorCertificate',
  generic: 'webPreviewPanel.errorTitle',
} as const;

interface BrowserLoadErrorProps {
  error: BrowserLoadErrorInfo;
  onRetry: () => void;
}

export function BrowserLoadError({ error, onRetry }: BrowserLoadErrorProps) {
  const { t } = useTranslation('panels');
  const code = browserErrorCode(error);
  const kind = browserLoadErrorKind(error);

  return (
    <div
      role="alert"
      className="absolute inset-0 flex items-center justify-center bg-background px-8 text-center"
    >
      <div className="flex -translate-y-6 flex-col items-center">
        <CircleAlert
          className="mb-5 h-11 w-11 stroke-[1.5] text-muted-foreground"
          aria-hidden="true"
        />
        <h2 className="text-lg font-semibold tracking-[-0.01em] text-foreground">
          {t(TITLE_KEYS[kind])}
        </h2>
        {code ? (
          <p className="mt-2 font-mono text-xs text-muted-foreground">{code}</p>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-5 h-8"
          onClick={onRetry}
        >
          {t('webPreviewPanel.errorRetry')}
        </Button>
      </div>
    </div>
  );
}
