import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '@/lib/utils';
import {
  COLLABORATION_ZONE_LETTERS,
  KANBAN_ZONE_LETTERS,
  ZONE_LETTERS,
  swapArrangementSlots,
  type CollaborationArrangement,
  type CollaborationSlot,
  type KanbanArrangement,
  type KanbanSlot,
  type LayoutArrangement,
  type LayoutZone,
} from '@/lib/layoutArrangement';

/**
 * Draggable miniature of a page layout. Controlled components: dragging one
 * zone onto another slot swaps them in the *draft* value; nothing is
 * persisted until the settings action bar saves it.
 */

type WorkspaceColumnSlot = 'left' | 'center' | 'right';

const WORKSPACE_COLUMN_SLOTS: readonly WorkspaceColumnSlot[] = [
  'left',
  'center',
  'right',
];

const WORKSPACE_COLUMN_ZONES: readonly Exclude<LayoutZone, 'terminal'>[] = [
  'dock',
  'workspace',
  'session',
];

function workspaceColumnArrangement(
  arrangement: LayoutArrangement
): Record<'left' | 'center' | 'right', Exclude<LayoutZone, 'terminal'>> {
  const columns = {
    left: arrangement.left,
    center: arrangement.center,
    right: arrangement.right,
  };
  const missing = WORKSPACE_COLUMN_ZONES.filter(
    (zone) => !Object.values(columns).includes(zone)
  );
  const next = { ...columns };
  for (const slot of WORKSPACE_COLUMN_SLOTS) {
    if (next[slot] === 'terminal') {
      next[slot] = missing.shift() ?? 'workspace';
    }
  }
  return next as Record<
    'left' | 'center' | 'right',
    Exclude<LayoutZone, 'terminal'>
  >;
}

function ZoneChip({
  slot,
  letter,
  label,
}: {
  slot: string;
  letter: string;
  label: string;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: `zone-${slot}`,
      data: { slot },
    });

  return (
    // Deliberately a div: `.settings-page button` carries a global 2rem
    // height rule that would squash the chip; dnd-kit's attributes still
    // provide role="button" and keyboard focusability.
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={cn(
        'flex h-full w-full min-w-0 select-none flex-col items-center justify-center gap-1 rounded-md border border-border bg-muted/60 px-1 text-foreground transition-colors',
        isDragging
          ? 'z-20 cursor-grabbing border-primary/50 bg-muted shadow-md'
          : 'cursor-grab hover:border-primary/40 hover:bg-muted'
      )}
      style={{ transform: CSS.Translate.toString(transform) }}
      aria-label={label}
    >
      <span className="text-sm font-semibold leading-none">{letter}</span>
      <span className="w-full truncate text-center text-[10px] leading-tight text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

function SlotCell({
  slot,
  letter,
  label,
  className,
}: {
  slot: string;
  letter: string;
  label: string;
  className?: string;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: slot });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'relative min-w-0 rounded-md transition-shadow',
        isOver && 'ring-2 ring-primary/60',
        className
      )}
    >
      <ZoneChip slot={slot} letter={letter} label={label} />
    </div>
  );
}

function useSchematicSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  );
}

function ThreeColumnFrame({
  children,
  onDragEnd,
}: {
  children: ReactNode;
  onDragEnd: (event: DragEndEvent) => void;
}) {
  const sensors = useSchematicSensors();

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="flex h-44 w-full gap-1.5 rounded-lg border border-border bg-background/60 p-1.5">
        {children}
      </div>
    </DndContext>
  );
}

interface WorkspaceLayoutSchematicProps {
  value: LayoutArrangement;
  onChange: (next: LayoutArrangement) => void;
}

export function WorkspaceLayoutSchematic({
  value,
  onChange,
}: WorkspaceLayoutSchematicProps) {
  const { t } = useTranslation('settings');

  const columns = workspaceColumnArrangement(value);

  const handleDragEnd = (event: DragEndEvent) => {
    const source = event.active.data.current?.slot as
      | WorkspaceColumnSlot
      | undefined;
    const target = event.over?.id as WorkspaceColumnSlot | undefined;
    if (!source || !target || source === target) return;
    if (
      !WORKSPACE_COLUMN_SLOTS.includes(source) ||
      !WORKSPACE_COLUMN_SLOTS.includes(target)
    ) {
      return;
    }

    const swapped = swapArrangementSlots(columns, source, target);
    onChange({ ...swapped, bottom: 'terminal' });
  };

  const cell = (slot: WorkspaceColumnSlot, className: string) => (
    <SlotCell
      slot={slot}
      letter={ZONE_LETTERS[columns[slot]]}
      label={t(`appearance.layout.zones.${columns[slot]}`)}
      className={className}
    />
  );

  return (
    <ThreeColumnFrame onDragEnd={handleDragEnd}>
      {cell('left', 'w-[26%]')}
      {cell('center', 'min-w-0 flex-1')}
      {cell('right', 'w-[24%]')}
    </ThreeColumnFrame>
  );
}

interface KanbanLayoutSchematicProps {
  value: KanbanArrangement;
  onChange: (next: KanbanArrangement) => void;
}

export function KanbanLayoutSchematic({
  value,
  onChange,
}: KanbanLayoutSchematicProps) {
  const { t } = useTranslation('settings');

  const handleDragEnd = (event: DragEndEvent) => {
    const source = event.active.data.current?.slot as KanbanSlot | undefined;
    const target = event.over?.id as KanbanSlot | undefined;
    if (!source || !target || source === target) return;

    onChange(swapArrangementSlots(value, source, target));
  };

  const cell = (slot: KanbanSlot, className: string) => (
    <SlotCell
      slot={slot}
      letter={KANBAN_ZONE_LETTERS[value[slot]]}
      label={t(`appearance.layout.kanbanZones.${value[slot]}`)}
      className={className}
    />
  );

  return (
    <ThreeColumnFrame onDragEnd={handleDragEnd}>
      {cell('left', 'w-[26%]')}
      {cell('center', 'min-w-0 flex-1')}
      {cell('right', 'w-[24%]')}
    </ThreeColumnFrame>
  );
}

interface CollaborationLayoutSchematicProps {
  value: CollaborationArrangement;
  onChange: (next: CollaborationArrangement) => void;
}

export function CollaborationLayoutSchematic({
  value,
  onChange,
}: CollaborationLayoutSchematicProps) {
  const { t } = useTranslation('settings');

  const handleDragEnd = (event: DragEndEvent) => {
    const source = event.active.data.current?.slot as
      | CollaborationSlot
      | undefined;
    const target = event.over?.id as CollaborationSlot | undefined;
    if (!source || !target || source === target) return;

    onChange(swapArrangementSlots(value, source, target));
  };

  const cell = (slot: CollaborationSlot, className: string) => (
    <SlotCell
      slot={slot}
      letter={COLLABORATION_ZONE_LETTERS[value[slot]]}
      label={t(`appearance.layout.collaborationZones.${value[slot]}`)}
      className={className}
    />
  );

  return (
    <ThreeColumnFrame onDragEnd={handleDragEnd}>
      {cell('left', 'w-[26%]')}
      {cell('center', 'min-w-0 flex-1')}
      {cell('right', 'w-[24%]')}
    </ThreeColumnFrame>
  );
}
