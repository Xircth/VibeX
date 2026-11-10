import type { CSSProperties, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export type ProductContextMenuHeader = {
  title: string;
  subtitle?: string | null;
};

export type ProductContextMenuItem =
  | {
      type?: 'item';
      id: string;
      label: string;
      labelNode?: ReactNode;
      icon?: LucideIcon;
      iconNode?: ReactNode;
      labelStyle?: CSSProperties;
      disabled?: boolean;
      disabledReason?: string;
      danger?: boolean;
      onSelect: () => void;
    }
  | {
      type: 'emoji-row';
      id: string;
      emojis: readonly string[];
      extraEmojis?: readonly string[];
      moreLabel?: string;
      onPick: (emoji: string) => void;
    }
  | {
      type: 'separator';
      id: string;
    }
  | {
      type: 'label';
      id: string;
      label: string;
    }
  | {
      type: 'submenu';
      id: string;
      label: string;
      icon?: LucideIcon;
      iconNode?: ReactNode;
      disabled?: boolean;
      disabledReason?: string;
      danger?: boolean;
      /** When set, clicking the row runs this and closes. Hover still opens children. */
      onSelect?: () => void;
      children: ProductContextMenuItem[];
    };

export type OpenProductContextMenuInput = {
  x: number;
  y: number;
  items: ProductContextMenuItem[];
  header?: ProductContextMenuHeader | null;
  ariaLabel?: string;
};
