import React from 'react';
import { cn } from '@/lib/utils';

interface JSONEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  minHeight?: number;
  className?: string;
  id?: string;
}

export const JSONEditor: React.FC<JSONEditorProps> = ({
  value,
  onChange,
  placeholder,
  disabled = false,
  minHeight = 300,
  className,
  id,
}) => {
  return (
    <div
      id={id}
      className={cn(
        'rounded-md border border-input bg-background overflow-hidden',
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
    >
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        className="w-full resize-y border-0 bg-transparent px-3 py-2 text-sm font-mono leading-6 text-foreground outline-none"
        style={{
          minHeight: `${minHeight}px`,
          fontFamily:
            'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
        }}
      />
    </div>
  );
};
