import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronsDown,
  ChevronsUp,
  Circle,
  Move,
  Paintbrush,
  Redo2,
  ScanSearch,
  Square,
  Type,
  Undo2,
} from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { PRODUCT_MENU_CONTENT_CLASS } from '@/components/ui/product-menu-classes';
import { cn } from '@/lib/utils';
import {
  MARK_PRESET_COLORS,
  parseAnnotationColor,
  type AnnotationTool,
} from './imagePreviewAnnotations';
import { SCALE_PRESETS } from './imagePreviewViewport';

type MarkKind = Extract<AnnotationTool, 'rect' | 'ellipse'>;

type ImagePreviewToolbarProps = {
  annotate: boolean;
  chromeVisible: boolean;
  tool: AnnotationTool;
  markKind: MarkKind;
  color: string;
  strokeWidth: number;
  brushSize: number;
  fontSize: number;
  scale: number;
  canUndo: boolean;
  canRedo: boolean;
  markOpen: boolean;
  brushOpen: boolean;
  textOpen: boolean;
  onToolChange: (tool: AnnotationTool) => void;
  onMarkKindChange: (kind: MarkKind) => void;
  onColorChange: (color: string) => void;
  onStrokeWidthChange: (value: number) => void;
  onBrushSizeChange: (value: number) => void;
  onFontSizeChange: (value: number) => void;
  onScaleChange: (scale: number) => void;
  onFit: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleChrome: () => void;
  onMarkOpenChange: (open: boolean) => void;
  onBrushOpenChange: (open: boolean) => void;
  onTextOpenChange: (open: boolean) => void;
};

export function ImagePreviewToolbar({
  annotate,
  chromeVisible,
  tool,
  markKind,
  color,
  strokeWidth,
  brushSize,
  fontSize,
  scale,
  canUndo,
  canRedo,
  markOpen,
  brushOpen,
  textOpen,
  onToolChange,
  onMarkKindChange,
  onColorChange,
  onStrokeWidthChange,
  onBrushSizeChange,
  onFontSizeChange,
  onScaleChange,
  onFit,
  onUndo,
  onRedo,
  onToggleChrome,
  onMarkOpenChange,
  onBrushOpenChange,
  onTextOpenChange,
}: ImagePreviewToolbarProps) {
  const { t } = useTranslation('conversation');
  const zoomPercent = Math.round(scale * 100);
  const scaleOptions = useMemo(() => {
    const percents = SCALE_PRESETS.map((preset) => Math.round(preset * 100));
    if (!percents.includes(zoomPercent)) {
      return [...percents, zoomPercent].sort((left, right) => left - right);
    }
    return percents;
  }, [zoomPercent]);
  const markActive = tool === 'rect' || tool === 'ellipse';

  return (
    <TooltipProvider delayDuration={280} disableHoverableContent>
      <div
        className="image-preview-toolbar"
        data-testid="image-preview-toolbar"
        data-stowed={chromeVisible ? 'false' : 'true'}
      >
        {chromeVisible ? (
          <div className="image-preview-toolbar-tools">
            {annotate ? (
              <>
                <ToolbarIconButton
                  label={t('imagePreview.toolView')}
                  active={tool === 'view'}
                  onClick={() => onToolChange('view')}
                >
                  <Move className="h-4 w-4" />
                </ToolbarIconButton>
                <Popover
                  open={markOpen}
                  onOpenChange={(open) => {
                    onMarkOpenChange(open);
                    if (open) {
                      onToolChange(markKind);
                      onBrushOpenChange(false);
                      onTextOpenChange(false);
                    }
                  }}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className={toolbarButtonClass(markActive)}
                          aria-label={t('imagePreview.toolMark')}
                          aria-pressed={markActive}
                          onClick={() => onToolChange(markKind)}
                        >
                          {markKind === 'ellipse' ? (
                            <Circle className="h-4 w-4" />
                          ) : (
                            <Square className="h-4 w-4" />
                          )}
                        </button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6}>
                      {t('imagePreview.toolMark')}
                    </TooltipContent>
                  </Tooltip>
                  <PopoverContent
                    side="top"
                    align="center"
                    className={cn(
                      PRODUCT_MENU_CONTENT_CLASS,
                      'image-preview-toolbar-popover w-56 p-2'
                    )}
                  >
                    <MarkOptions
                      markKind={markKind}
                      color={color}
                      strokeWidth={strokeWidth}
                      onMarkKindChange={onMarkKindChange}
                      onColorChange={onColorChange}
                      onStrokeWidthChange={onStrokeWidthChange}
                    />
                  </PopoverContent>
                </Popover>
                <Popover
                  open={brushOpen}
                  onOpenChange={(open) => {
                    onBrushOpenChange(open);
                    if (open) {
                      onToolChange('brush');
                      onMarkOpenChange(false);
                      onTextOpenChange(false);
                    }
                  }}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className={toolbarButtonClass(tool === 'brush')}
                          aria-label={t('imagePreview.toolBrush')}
                          aria-pressed={tool === 'brush'}
                          onClick={() => onToolChange('brush')}
                        >
                          <Paintbrush className="h-4 w-4" />
                        </button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6}>
                      {t('imagePreview.toolBrush')}
                    </TooltipContent>
                  </Tooltip>
                  <PopoverContent
                    side="top"
                    align="center"
                    className={cn(
                      PRODUCT_MENU_CONTENT_CLASS,
                      'image-preview-toolbar-popover w-56 p-2'
                    )}
                  >
                    <ColorField color={color} onColorChange={onColorChange} />
                    <RangeControl
                      label={t('imagePreview.brushSize')}
                      value={brushSize}
                      min={6}
                      max={48}
                      onChange={onBrushSizeChange}
                    />
                  </PopoverContent>
                </Popover>
                <Popover
                  open={textOpen}
                  onOpenChange={(open) => {
                    onTextOpenChange(open);
                    if (open) {
                      onToolChange('text');
                      onMarkOpenChange(false);
                      onBrushOpenChange(false);
                    }
                  }}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className={toolbarButtonClass(tool === 'text')}
                          aria-label={t('imagePreview.toolText')}
                          aria-pressed={tool === 'text'}
                          onClick={() => onToolChange('text')}
                        >
                          <Type className="h-4 w-4" />
                        </button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6}>
                      {t('imagePreview.toolText')}
                    </TooltipContent>
                  </Tooltip>
                  <PopoverContent
                    side="top"
                    align="center"
                    className={cn(
                      PRODUCT_MENU_CONTENT_CLASS,
                      'image-preview-toolbar-popover w-56 p-2'
                    )}
                  >
                    <ColorField color={color} onColorChange={onColorChange} />
                    <RangeControl
                      label={t('imagePreview.fontSize')}
                      value={fontSize}
                      min={14}
                      max={72}
                      onChange={onFontSizeChange}
                    />
                  </PopoverContent>
                </Popover>
                <span className="image-preview-toolbar-sep" />
                <ToolbarIconButton
                  label={t('imagePreview.undo')}
                  disabled={!canUndo}
                  onClick={onUndo}
                >
                  <Undo2 className="h-4 w-4" />
                </ToolbarIconButton>
                <ToolbarIconButton
                  label={t('imagePreview.redo')}
                  disabled={!canRedo}
                  onClick={onRedo}
                >
                  <Redo2 className="h-4 w-4" />
                </ToolbarIconButton>
                <span className="image-preview-toolbar-sep" />
              </>
            ) : null}
            <Select
              value={String(zoomPercent)}
              onValueChange={(value) => onScaleChange(Number(value) / 100)}
            >
              <SelectTrigger
                aria-label={t('imagePreview.zoomPercent')}
                className="image-preview-scale-trigger"
              >
                <SelectValue>{`${zoomPercent}%`}</SelectValue>
              </SelectTrigger>
              <SelectContent
                side="top"
                align="center"
                className="min-w-[6.5rem]"
              >
                {scaleOptions.map((percent) => (
                  <SelectItem key={percent} value={String(percent)}>
                    {percent}%
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ToolbarIconButton
              label={t('imagePreview.fitAria')}
              onClick={onFit}
            >
              <ScanSearch className="h-4 w-4" />
            </ToolbarIconButton>
            <span className="image-preview-toolbar-sep" />
          </div>
        ) : null}
        <ToolbarIconButton
          label={
            chromeVisible
              ? t('imagePreview.hideChrome')
              : t('imagePreview.showChrome')
          }
          expanded={chromeVisible}
          onClick={onToggleChrome}
        >
          {chromeVisible ? (
            <ChevronsDown className="h-4 w-4" />
          ) : (
            <ChevronsUp className="h-4 w-4" />
          )}
        </ToolbarIconButton>
      </div>
    </TooltipProvider>
  );
}

function MarkOptions({
  markKind,
  color,
  strokeWidth,
  onMarkKindChange,
  onColorChange,
  onStrokeWidthChange,
}: {
  markKind: MarkKind;
  color: string;
  strokeWidth: number;
  onMarkKindChange: (kind: MarkKind) => void;
  onColorChange: (color: string) => void;
  onStrokeWidthChange: (value: number) => void;
}) {
  const { t } = useTranslation('conversation');
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <ToolbarIconButton
          label={t('imagePreview.toolMarkRect')}
          active={markKind === 'rect'}
          onClick={() => onMarkKindChange('rect')}
        >
          <Square className="h-4 w-4" />
        </ToolbarIconButton>
        <ToolbarIconButton
          label={t('imagePreview.toolMarkEllipse')}
          active={markKind === 'ellipse'}
          onClick={() => onMarkKindChange('ellipse')}
        >
          <Circle className="h-4 w-4" />
        </ToolbarIconButton>
      </div>
      <RangeControl
        label={t('imagePreview.strokeWidth')}
        value={strokeWidth}
        min={2}
        max={20}
        onChange={onStrokeWidthChange}
      />
      <ColorField color={color} onColorChange={onColorChange} />
    </div>
  );
}

function ColorField({
  color,
  onColorChange,
}: {
  color: string;
  onColorChange: (color: string) => void;
}) {
  const { t } = useTranslation('conversation');
  const [hex, setHex] = useState(color);

  useEffect(() => {
    setHex(color);
  }, [color]);

  const commitHex = () => {
    const parsed = parseAnnotationColor(hex);
    if (parsed) {
      onColorChange(parsed);
      setHex(parsed);
      return;
    }
    setHex(color);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        {MARK_PRESET_COLORS.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-label={preset}
            aria-pressed={color.toLowerCase() === preset}
            className={cn(
              'h-6 w-6 rounded-full border border-border',
              color.toLowerCase() === preset && 'ring-2 ring-foreground/70'
            )}
            style={{ backgroundColor: preset }}
            onClick={() => onColorChange(preset)}
          />
        ))}
      </div>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>{t('imagePreview.colorHex')}</span>
        <input
          value={hex}
          spellCheck={false}
          aria-label={t('imagePreview.colorHex')}
          className="image-preview-hex-input raised-control h-7 min-w-0 flex-1 rounded-[var(--radius)] px-2 font-mono text-xs text-foreground"
          onChange={(event) => setHex(event.target.value)}
          onBlur={commitHex}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitHex();
            }
          }}
        />
      </label>
    </div>
  );
}

function ToolbarIconButton({
  label,
  active = false,
  disabled = false,
  expanded,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={toolbarButtonClass(active)}
          aria-label={label}
          aria-pressed={active}
          aria-expanded={expanded}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function toolbarButtonClass(active: boolean) {
  return cn(
    'image-preview-toolbar-btn inline-flex h-8 w-8 items-center justify-center rounded-full transition',
    active
      ? 'bg-primary text-primary-foreground'
      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
    'disabled:pointer-events-none disabled:opacity-40'
  );
}

function RangeControl({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        aria-label={label}
        className="h-1 w-full accent-primary"
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
