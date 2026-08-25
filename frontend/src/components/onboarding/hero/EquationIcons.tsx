export function EqIcon({ name }: { name: string }) {
  const common = {
    viewBox: '0 0 24 24',
    className: 'h-full w-full',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (name) {
    case 'vscode':
      return (
        <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
          <path
            fill="#007ACC"
            d="M17.7 2.1 3.4 8.7a1 1 0 0 0 0 1.8l2.4 1.1 5.2-4.2-3.3 6.3 3.3 1.6 8.4 3.9a1 1 0 0 0 1.4-.9V3a1 1 0 0 0-1.4-.9z"
          />
        </svg>
      );
    case 'jetbrains':
      return (
        <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
          <rect x="3" y="3" width="8.2" height="8.2" rx="1" fill="#FE7F2D" />
          <rect x="12.8" y="3" width="8.2" height="8.2" rx="1" fill="#087CFA" />
          <rect x="3" y="12.8" width="8.2" height="8.2" rx="1" fill="#07C160" />
          <rect
            x="12.8"
            y="12.8"
            width="8.2"
            height="8.2"
            rx="1"
            fill="#E53935"
          />
        </svg>
      );
    case 'trae':
      return (
        <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
          <path fill="#2EE6A6" d="M12 3 21 19H3L12 3z" />
        </svg>
      );
    case 'qoder':
      return (
        <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden>
          <circle
            cx="11"
            cy="11"
            r="6.2"
            fill="none"
            stroke="#7C5CFF"
            strokeWidth="2.2"
          />
          <path
            d="M15.4 15.4 20 20"
            stroke="#7C5CFF"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'opensource':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 5v2M12 17v2M5 12h2M17 12h2" />
          <circle cx="12" cy="12" r="8" />
        </svg>
      );
    case 'custom':
      return (
        <svg {...common}>
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
          <circle cx="12" cy="12" r="4" />
          <path d="m8 8 1.2 1.2M16 8l-1.2 1.2M8 16l1.2-1.2M16 16l-1.2-1.2" />
        </svg>
      );
    case 'skills':
      return (
        <svg {...common}>
          <path d="M12 3 14.2 8.5 20 9.2l-4 3.9.9 5.7L12 16.4 7.1 18.8 8 13.1 4 9.2l5.8-.7L12 3z" />
        </svg>
      );
    case 'mcp':
      return (
        <svg {...common}>
          <path d="M8 9H6a3 3 0 0 0 0 6h2" />
          <path d="M16 9h2a3 3 0 0 1 0 6h-2" />
          <path d="M9 12h6" />
        </svg>
      );
    case 'cli':
      return (
        <svg {...common}>
          <path d="m7 8 4 4-4 4M13 16h4" />
        </svg>
      );
    case 'terminal':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m7 10 3 2-3 2M12 15h5" />
        </svg>
      );
    case 'git':
      return (
        <svg {...common}>
          <circle cx="6" cy="18" r="2" />
          <circle cx="12" cy="6" r="2" />
          <circle cx="18" cy="18" r="2" />
          <path d="M8 16.5 11 8.2M13 8.2 16.2 16.2" />
        </svg>
      );
    case 'worktree':
      return (
        <svg {...common}>
          <path d="M12 4v8" />
          <path d="M12 12H7v8" />
          <path d="M12 12h5v8" />
          <circle cx="12" cy="4" r="1.6" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'local':
      return (
        <svg {...common}>
          <rect x="4" y="5" width="16" height="11" rx="1.5" />
          <path d="M8 20h8M12 16v4" />
        </svg>
      );
    case 'webui':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 9h18" />
          <circle cx="6.5" cy="7" r=".6" fill="currentColor" stroke="none" />
          <circle cx="8.7" cy="7" r=".6" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'remote':
      return (
        <svg {...common}>
          <path d="M5 12a7 7 0 0 1 14 0" />
          <path d="M8 12a4 4 0 0 1 8 0" />
          <circle cx="12" cy="16" r="1.2" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'client':
      return (
        <svg {...common}>
          <rect x="7" y="3" width="10" height="18" rx="2" />
          <path d="M10 18h4" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7" />
        </svg>
      );
  }
}
