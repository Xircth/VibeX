import { useEffect, useId, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';

type FileTreeNameInputProps = {
  label: string;
  value: string;
  placeholder?: string;
  selectName?: boolean;
  error?: string | null;
  onChange: (value: string) => void;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
};

export function FileTreeNameInput({
  label,
  value,
  placeholder,
  selectName = false,
  error,
  onChange,
  onConfirm,
  onCancel,
}: FileTreeNameInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const submittingRef = useRef(false);
  const cancelledRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    if (input && selectName) {
      const extension = input.value.lastIndexOf('.');
      input.setSelectionRange(
        0,
        extension > 0 ? extension : input.value.length
      );
    }
  }, [selectName]);

  const confirm = async () => {
    if (submittingRef.current || cancelledRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      await onConfirm();
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <Input
        ref={inputRef}
        className="file-tree-name-input min-w-0"
        aria-label={label}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        value={value}
        placeholder={placeholder}
        disabled={isSubmitting}
        onChange={(event) => onChange(event.target.value)}
        onKeyDownCapture={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) {
            event.stopPropagation();
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            cancelledRef.current = true;
            onCancel();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            void confirm();
          }
        }}
        onBlur={() => {
          if (submittingRef.current || cancelledRef.current) return;
          if (value.trim()) {
            void confirm();
          } else {
            onCancel();
          }
        }}
      />
      {error ? (
        <span id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
