import { ChevronRight, FolderInput, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { ContactSection } from './contactGroups';

/** Drag payload for moving a contact (thread id) between sections. */
export const CONTACT_DRAG_TYPE = 'application/x-vibex-contact';

/** Inline name input used for "新建分组" and renaming a section. */
export function ContactGroupNameInput({
  initialValue = '',
  placeholder,
  onSubmit,
  onCancel,
  testId,
}: {
  initialValue?: string;
  placeholder: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  testId?: string;
}) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (submit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const name = value.trim();
    if (submit && name && name !== initialValue) onSubmit(name);
    else onCancel();
  };
  return (
    <div className="collaboration-contact-group-input">
      <input
        ref={ref}
        value={value}
        maxLength={40}
        placeholder={placeholder}
        aria-label={placeholder}
        data-testid={testId}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            finish(true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            finish(false);
          }
        }}
        onBlur={() => finish(true)}
      />
    </div>
  );
}

export type ContactMenuItem =
  | {
      kind: 'item';
      label: string;
      icon?: ReactNode;
      destructive?: boolean;
      onSelect: () => void;
      testId?: string;
    }
  | {
      kind: 'submenu';
      label: string;
      icon?: ReactNode;
      items: { label: string; onSelect: () => void; testId?: string }[];
      testId?: string;
    }
  | { kind: 'label'; label: string }
  | { kind: 'separator' };

export type ContactMenuState = {
  x: number;
  y: number;
  items: ContactMenuItem[];
} | null;

/** Right-click menu anchored at the pointer (no context-menu primitive exists). */
export function ContactContextMenu({
  menu,
  onClose,
}: {
  menu: ContactMenuState;
  onClose: () => void;
}) {
  return (
    <DropdownMenu
      open={menu !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          className="collaboration-contact-menu-anchor"
          style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={2}
        className="collaboration-contact-menu min-w-[11rem]"
        data-testid="collaboration-contact-menu"
      >
        {menu?.items.map((item, index) => {
          if (item.kind === 'separator')
            return <DropdownMenuSeparator key={`sep-${index}`} />;
          if (item.kind === 'label')
            return (
              <DropdownMenuLabel
                key={`label-${index}`}
                className="text-[11px] font-medium text-muted-foreground"
              >
                {item.label}
              </DropdownMenuLabel>
            );
          if (item.kind === 'submenu')
            return (
              <DropdownMenuSub key={item.label}>
                <DropdownMenuSubTrigger data-testid={item.testId}>
                  <span className="flex items-center gap-2">
                    {item.icon}
                    {item.label}
                  </span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-[9rem]">
                  {item.items.map((sub) => (
                    <DropdownMenuItem
                      key={sub.label}
                      data-testid={sub.testId}
                      onSelect={sub.onSelect}
                    >
                      {sub.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            );
          return (
            <DropdownMenuItem
              key={item.label}
              data-testid={item.testId}
              onSelect={item.onSelect}
              className={cn(
                'gap-2',
                item.destructive && 'text-destructive focus:text-destructive'
              )}
            >
              {item.icon}
              {item.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const contactMenuIcons = {
  move: <FolderInput className="size-3.5 opacity-70" />,
  rename: <Pencil className="size-3.5 opacity-70" />,
  remove: <Trash2 className="size-3.5" />,
};

/** Collapsible sections rendered when the user has at least one group. */
export function ContactGroupSections<E extends { key: string }>({
  sections,
  collapsed,
  renamingId,
  renamePlaceholder,
  toggleLabel,
  onToggle,
  onRenameSubmit,
  onRenameCancel,
  onHeaderContextMenu,
  onDropContact,
  dropTargetId = null,
  renderEntry,
}: {
  sections: ContactSection<E>[];
  collapsed: ReadonlySet<string>;
  renamingId: string | null;
  renamePlaceholder: string;
  toggleLabel: (name: string) => string;
  onToggle: (sectionId: string) => void;
  onRenameSubmit: (sectionId: string, name: string) => void;
  onRenameCancel: () => void;
  onHeaderContextMenu: (
    event: React.MouseEvent,
    section: ContactSection<E>
  ) => void;
  onDropContact: (sectionId: string, threadId: string) => void;
  /** Section highlighted by the page's pointer drag. */
  dropTargetId?: string | null;
  renderEntry: (entry: E) => ReactNode;
}) {
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  return (
    <>
      {sections.map((section) => {
        const isCollapsed = collapsed.has(section.id);
        const bodyId = `collaboration-contact-section-body-${section.id}`;
        return (
          <section
            key={section.id}
            className={cn(
              'collaboration-contact-section',
              (dropTarget === section.id || dropTargetId === section.id) &&
                'is-drop-target'
            )}
            data-contact-section-id={section.id}
            data-drop-state={
              dropTarget === section.id || dropTargetId === section.id
                ? 'target'
                : undefined
            }
            data-testid={`collaboration-contact-section-${section.id}`}
            data-collapsed={isCollapsed ? 'true' : 'false'}
            data-ungrouped={section.ungrouped ? 'true' : undefined}
          >
            {renamingId === section.id ? (
              <ContactGroupNameInput
                initialValue={section.name}
                placeholder={renamePlaceholder}
                testId="collaboration-contact-group-rename-input"
                onSubmit={(name) => onRenameSubmit(section.id, name)}
                onCancel={onRenameCancel}
              />
            ) : (
              <button
                type="button"
                className={cn(
                  'collaboration-contact-section-header',
                  (dropTarget === section.id || dropTargetId === section.id) &&
                    'is-drop-target'
                )}
                aria-expanded={!isCollapsed}
                aria-controls={bodyId}
                aria-label={toggleLabel(section.name)}
                data-testid={`collaboration-contact-section-header-${section.id}`}
                onClick={() => onToggle(section.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onHeaderContextMenu(event, section);
                }}
                onDragOver={(event) => {
                  if (!event.dataTransfer?.types.includes(CONTACT_DRAG_TYPE))
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = 'move';
                  setDropTarget(section.id);
                }}
                onDragLeave={() =>
                  setDropTarget((current) =>
                    current === section.id ? null : current
                  )
                }
                onDrop={(event) => {
                  const threadId =
                    event.dataTransfer?.getData(CONTACT_DRAG_TYPE);
                  setDropTarget(null);
                  if (!threadId) return;
                  event.preventDefault();
                  event.stopPropagation();
                  onDropContact(section.id, threadId);
                }}
              >
                <ChevronRight
                  aria-hidden
                  className="collaboration-contact-section-chevron"
                />
                <span className="collaboration-contact-section-name">
                  {section.name}
                </span>
                <span className="collaboration-contact-section-count">
                  {section.entries.length}
                </span>
              </button>
            )}
            {isCollapsed ? null : (
              <div id={bodyId} className="collaboration-contact-section-body">
                {section.entries.map((entry) => renderEntry(entry))}
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
