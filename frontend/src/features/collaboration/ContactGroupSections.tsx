import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { ContactSection } from './contactGroups';

/** Drag payload for moving a contact (thread id) between sections. */
export const CONTACT_DRAG_TYPE = 'application/x-vibex-contact';

/** Ignore blur from a just-closed menu restoring focus to its trigger. */
export const CONTACT_GROUP_RENAME_BLUR_GRACE_MS = 250;

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
  const acceptBlurRef = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
    const id = window.setTimeout(() => {
      acceptBlurRef.current = true;
    }, CONTACT_GROUP_RENAME_BLUR_GRACE_MS);
    return () => window.clearTimeout(id);
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
        onBlur={() => {
          if (!acceptBlurRef.current) {
            window.setTimeout(() => {
              if (!doneRef.current) ref.current?.focus();
            }, 0);
            return;
          }
          finish(true);
        }}
      />
    </div>
  );
}

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
              <div
                className="collaboration-contact-section-header is-renaming"
                data-testid={`collaboration-contact-section-header-${section.id}`}
              >
                <ChevronRight
                  aria-hidden
                  className="collaboration-contact-section-chevron"
                />
                <ContactGroupNameInput
                  initialValue={section.name}
                  placeholder={renamePlaceholder}
                  testId="collaboration-contact-group-rename-input"
                  onSubmit={(name) => onRenameSubmit(section.id, name)}
                  onCancel={onRenameCancel}
                />
                <span className="collaboration-contact-section-count">
                  {section.entries.length}
                </span>
              </div>
            ) : (
              <button
                type="button"
                className="collaboration-contact-section-header"
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
