import vibeUltraLogo from '@/assets/vibe-ultra.png';
import { APP_NAME } from '@/lib/branding';

interface LogoProps {
  showText?: boolean;
}

export function Logo({ showText = true }: LogoProps) {
  return (
    <span className="logo inline-flex items-center gap-2 select-none">
      <img
        src={vibeUltraLogo}
        alt={`${APP_NAME} logo`}
        className="h-6 w-6 shrink-0 object-contain"
      />
      {showText ? (
        <span className="text-xl font-bold tracking-tight">{APP_NAME}</span>
      ) : null}
    </span>
  );
}
