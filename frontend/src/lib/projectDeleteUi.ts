import type { CSSProperties } from 'react';
import type { ExternalToast } from 'sonner';

export const PROJECT_DELETE_CONFIRM_CLASSNAME =
  '!w-[404px] !max-w-[404px] sm:!max-w-[404px]';

export const PROJECT_DELETE_CONFIRM_STYLE: CSSProperties = {
  width: '404px',
  maxWidth: 'calc(100vw - 32px)',
};

const COMPACT_TOAST_WIDTH_STYLE: CSSProperties = {
  ['--width' as string]: '224px',
  width: '224px',
  minWidth: '224px',
  maxWidth: '224px',
};

export const PROJECT_DELETE_TOAST_OPTIONS: ExternalToast = {
  className: 'vu-project-delete-toast',
  closeButton: true,
  classNames: {
    toast: 'vu-project-delete-toast',
  },
  style: COMPACT_TOAST_WIDTH_STYLE,
};
