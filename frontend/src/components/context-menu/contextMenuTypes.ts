import type { LucideIcon } from 'lucide-react';

export type ProductContextMenuItem =
  | {
      type?: 'item';
      id: string;
      label: string;
      icon?: LucideIcon;
      disabled?: boolean;
      danger?: boolean;
      onSelect: () => void;
    }
  | {
      type: 'separator';
      id: string;
    }
  | {
      type: 'submenu';
      id: string;
      label: string;
      icon?: LucideIcon;
      children: ProductContextMenuItem[];
    };

export type OpenProductContextMenuInput = {
  x: number;
  y: number;
  items: ProductContextMenuItem[];
};
