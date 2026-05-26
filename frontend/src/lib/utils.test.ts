import { describe, it, expect } from 'vitest';
import { cn, formatFileSize } from './utils';

describe('cn', () => {
  it('should merge class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('should handle conditional classes', () => {
    expect(cn('base', false && 'hidden', 'visible')).toBe('base visible');
  });

  it('should handle undefined and null', () => {
    expect(cn('foo', undefined, null, 'bar')).toBe('foo bar');
  });

  it('should handle empty inputs', () => {
    expect(cn()).toBe('');
  });

  it('should handle object syntax', () => {
    expect(cn({ active: true, disabled: false })).toBe('active');
  });

  it('should merge conflicting Tailwind utility classes', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });

  it('should preserve custom text color tokens with text sizes', () => {
    expect(cn('text-low', 'text-base')).toBe('text-low text-base');
  });
});

describe('formatFileSize', () => {
  it('should return empty string for null/undefined', () => {
    expect(formatFileSize(null)).toBe('');
    expect(formatFileSize(undefined)).toBe('');
  });

  it('should format bytes', () => {
    expect(formatFileSize(BigInt(500))).toBe('500 B');
  });

  it('should format kilobytes', () => {
    expect(formatFileSize(BigInt(2048))).toBe('2.0 KB');
  });

  it('should format megabytes', () => {
    expect(formatFileSize(BigInt(1048576))).toBe('1.0 MB');
  });

  it('should format fractional sizes', () => {
    expect(formatFileSize(BigInt(1536))).toBe('1.5 KB');
  });
});
