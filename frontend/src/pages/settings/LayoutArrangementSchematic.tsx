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
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  DEFAULT_KANBAN_ARRANGEMENT,
  DEFAULT_LAYOUT_ARRANGEMENT,
  KANBAN_ZONE_LETTERS,
  ZONE_LETTERS,
  arrangementsEqual,
  swapArrangementSlots,
  type KanbanArrangement,
  type KanbanSlot,
  type LayoutArrangement,
  type LayoutSlot,
} from '@/lib/layoutArrangement';

/**
 * Draggable miniature of a page layout. Controlled components: dragging one
 * zone onto another slot swaps them in the *draft* value; nothing is
 * persisted until the settings action bar saves it.
 */

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

interface WorkspaceLayoutSchematicProps {
  value: LayoutArrangement;
  onChange: (next: LayoutArrangement) => void;
}

export function WorkspaceLayoutSchematic({
  value,
  onChange,
}: WorkspaceLayoutSchematicProps) {
  const { t } = useTranslation('settings');
  const sensors = useSchematicSensors();

  const handleDragEnd = (event: DragEndEvent) => {
    const source = event.active.data.current?.slot as LayoutSlot | undefined;
    const target = event.over?.id as LayoutSlot | undefined;
    if (!source || !target || source === target) return;

    onChange(swapArrangementSlots(value, source, target));
  };

  const cell = (slot: LayoutSlot, className: string) => (
    <SlotCell
      slot={slot}
      letter={ZONE_LETTERS[value[slot]]}
      label={t(`appearance.layout.zones.${value[slot]}`)}
      className={className}
    />
  );

  return (
    <div className="flex flex-col gap-2">
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="flex h-40 w-full max-w-md gap-1.5 rounded-lg border border-border bg-background/60 p-1.5">
          {cell('left', 'w-[18%]')}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            {cell('center', 'min-h-0 flex-1')}
            {cell('bottom', 'h-[30%]')}
          </div>
          {cell('right', 'w-[24%]')}
        </div>
      </DndContext>

      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange(DEFAULT_LAYOUT_ARRANGEMENT)}
          disabled={arrangementsEqual(value, DEFAULT_LAYOUT_ARRANGEMENT)}
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          {t('appearance.layout.reset')}
        </Button>
      </div>
    </div>
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
  const sensors = useSchematicSensors();

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
    <div className="flex flex-col gap-2">
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="flex h-28 w-full max-w-md gap-1.5 rounded-lg border border-border bg-background/60 p-1.5">
          {cell('left', 'w-[26%]')}
          {cell('center', 'min-w-0 flex-1')}
          {cell('right', 'w-[24%]')}
        </div>
      </DndContext>

      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange(DEFAULT_KANBAN_ARRANGEMENT)}
          disabled={arrangementsEqual(value, DEFAULT_KANBAN_ARRANGEMENT)}
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          {t('appearance.layout.reset')}
        </Button>
      </div>
    </div>
  );
}
