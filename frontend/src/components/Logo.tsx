import vibeXLogo from '@/assets/vibex_logo.png';
import { APP_NAME } from '@/lib/branding';

interface LogoProps {
  showText?: boolean;
  size?: 'default' | 'window' | 'hero';
  className?: string;
}

const logoSizeClass: Record<NonNullable<LogoProps['size']>, string> = {
  default: 'h-6 w-6',
  window: 'h-9 w-9',
  hero: 'h-[81px] w-[81px]',
};

export function Logo({
  showText = true,
  size = 'default',
  className = '',
}: LogoProps) {
  return (
    <span
      className={`logo inline-flex items-center gap-2 select-none ${className}`}
    >
      <img
        src={vibeXLogo}
        alt={`${APP_NAME} logo`}
        className={`${logoSizeClass[size]} shrink-0 object-contain`}
      />
      {showText ? (
        <span className="text-xl font-bold tracking-tight">{APP_NAME}</span>
      ) : null}
    </span>
  );
}
