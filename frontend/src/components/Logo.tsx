import { useTheme } from '@/components/ThemeProvider';
import { resolveAppLogo } from '@/lib/appIcon';
import { APP_NAME } from '@/lib/branding';

interface LogoProps {
  showText?: boolean;
  size?: 'default' | 'window' | 'hero' | 'toolbar';
  className?: string;
}

const logoSizeClass: Record<NonNullable<LogoProps['size']>, string> = {
  default: 'h-6 w-6',
  window: 'h-9 w-9',
  hero: 'h-[60.75px] w-[60.75px]',
  toolbar: 'h-[27px] w-[27px]',
};

export function Logo({
  showText = true,
  size = 'default',
  className = '',
}: LogoProps) {
  const { resolvedTheme } = useTheme();
  const logo = resolveAppLogo('lite', resolvedTheme);

  return (
    <span
      className={`logo inline-flex items-center gap-2 select-none ${className}`}
    >
      <img
        src={logo}
        alt={`${APP_NAME} logo`}
        className={`${logoSizeClass[size]} shrink-0 object-contain`}
      />
      {showText ? (
        <span className="text-xl font-bold tracking-tight">{APP_NAME}</span>
      ) : null}
    </span>
  );
}
