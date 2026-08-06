import { useEffect, useState } from 'react';
import { Check, ChevronDown, Pencil, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

interface SessionItem {
  id: string;
  displayName: string;
  statusLabel: string;
  continuityLabel: string;
}

interface SessionSelectorProps {
  sessions: SessionItem[];
  selectedSessionId?: string;
  compactSessionLabel: string;
  selectedSessionLabel: string;
  onSelectSession: (id: string) => void;
  onStartNewSession: () => void;
  onRenameSession: (id: string, name: string | null) => void | Promise<void>;
  dropdownSide?: 'top' | 'bottom';
}

const NEW_SESSION_LABEL = '\u65B0\u5EFA\u4F1A\u8BDD';

export function SessionSelector({
  sessions,
  selectedSessionId,
  compactSessionLabel,
  selectedSessionLabel,
  onSelectSession,
  onStartNewSession,
  onRenameSession,
  dropdownSide = 'bottom',
}: SessionSelectorProps) {
  const [open, setOpen] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  useEffect(() => {
    if (
      editingSessionId &&
      !sessions.some((session) => session.id === editingSessionId)
    ) {
      setEditingSessionId(null);
      setDraftName('');
    }
  }, [editingSessionId, sessions]);

  if (sessions.length === 0) return null;

  const beginRename = (sessionId: string) => {
    const session = sessions.find((item) => item.id === sessionId);
    setEditingSessionId(sessionId);
    setDraftName(session?.displayName ?? '');
  };

  const submitRename = async () => {
    if (!editingSessionId) return;
    await onRenameSession(editingSessionId, draftName.trim() || null);
    setEditingSessionId(null);
    setDraftName('');
  };

  const cancelRename = () => {
    setEditingSessionId(null);
    setDraftName('');
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-raised-selector
          className="raised-control flex h-5 items-center gap-1 px-2 text-[11px] font-medium"
          title={selectedSessionLabel}
        >
          <span className="max-w-[96px] truncate">{compactSessionLabel}</span>
          <ChevronDown className="h-2.5 w-2.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={dropdownSide}
        align="end"
        sideOffset={1}
        avoidCollisions={false}
        className="w-72 p-1"
      >
        <div className="space-y-1">
          {sessions.map((session) => {
            const isEditing = editingSessionId === session.id;
            const isSelected = selectedSessionId === session.id;

            return (
              <div
                key={session.id}
                className={cn(
                  'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                  !isEditing &&
                    'cursor-pointer hover:bg-accent hover:text-accent-foreground',
                  isSelected && !isEditing && 'bg-accent'
                )}
                onClick={() => {
                  if (!isEditing) {
                    setOpen(false);
                    onSelectSession(session.id);
                  }
                }}
              >
                <div className="min-w-0 flex-1">
                  {isEditing ? (
                    <Input
                      value={draftName}
                      onChange={(event) => setDraftName(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onBlur={() => void submitRename()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void submitRename();
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          cancelRename();
                        }
                      }}
                      className="h-7 rounded-sm border-border/60 bg-background text-xs"
                      autoFocus
                    />
                  ) : (
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate max-w-[180px]">
                          {session.displayName}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {session.continuityLabel}
                        </div>
                      </div>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {session.statusLabel}
                      </span>
                    </div>
                  )}
                </div>

                {isEditing ? (
                  <>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        event.stopPropagation();
                        void submitRename();
                      }}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        event.stopPropagation();
                        cancelRename();
                      }}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="opacity-0 transition-opacity group-hover:opacity-100 text-muted-foreground hover:text-foreground"
                    onClick={(event) => {
                      event.stopPropagation();
                      beginRename(session.id);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onStartNewSession();
          }}
          className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          {`+ ${NEW_SESSION_LABEL}`}
        </button>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
