/**
 * Centralized SVG icon library — Lucide-compatible stroke icons (24×24 viewBox).
 * All icons default to 16×16 rendered size. Override with the `size` prop.
 * Use `strokeWidth` (default 2) for thicker/thinner strokes.
 */

export type IconProps = {
  size?: number;
  className?: string;
  strokeWidth?: number;
  style?: React.CSSProperties;
};

function Ic({
  size = 16,
  className,
  strokeWidth = 2,
  style,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style }}
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** × close / dismiss / remove */
export function IconX(p: IconProps) {
  return <Ic {...p}><path d="M18 6 6 18M6 6l12 12" /></Ic>;
}

/** ✓ checkmark / accept / keep */
export function IconCheck(p: IconProps) {
  return <Ic {...p}><path d="m20 6-11 11-5-5" /></Ic>;
}

/** ↶ rotate counter-clockwise — undo / discard / restore */
export function IconRotateCcw(p: IconProps) {
  return (
    <Ic {...p}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </Ic>
  );
}

/** ↻ rotate clockwise — refresh / regenerate / reload */
export function IconRefreshCw(p: IconProps) {
  return (
    <Ic {...p}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 9" />
      <path d="M21 3v6h-6" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 15" />
      <path d="M3 21v-6h6" />
    </Ic>
  );
}

/** ⧉ copy to clipboard */
export function IconCopy(p: IconProps) {
  return (
    <Ic {...p}>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Ic>
  );
}

/** ⚙ settings / preferences */
export function IconSettings(p: IconProps) {
  return (
    <Ic {...p}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </Ic>
  );
}

/** ▤ terminal / console / shell */
export function IconTerminal(p: IconProps) {
  return (
    <Ic {...p}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" x2="20" y1="19" y2="19" />
    </Ic>
  );
}

/** 📁 📂 folder open */
export function IconFolderOpen(p: IconProps) {
  return (
    <Ic {...p}>
      <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </Ic>
  );
}

/** 🔍 search / find */
export function IconSearch(p: IconProps) {
  return (
    <Ic {...p}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Ic>
  );
}

/** 💬 chat message / ask mode */
export function IconMessageSquare(p: IconProps) {
  return (
    <Ic {...p}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </Ic>
  );
}

/** ⚡ zap / agent / lightning / fast */
export function IconZap(p: IconProps) {
  return <Ic {...p}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></Ic>;
}

/** 🤖 bot / AI agent model */
export function IconBot(p: IconProps) {
  return (
    <Ic {...p}>
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </Ic>
  );
}

/** 🧠 reasoning / Thought section (muted in chat timeline) */
export function IconBrain(p: IconProps) {
  return (
    <Ic {...p}>
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
    </Ic>
  );
}

/** ☰ hamburger menu / sidebar toggle */
export function IconMenu(p: IconProps) {
  return (
    <Ic {...p}>
      <line x1="4" x2="20" y1="6" y2="6" />
      <line x1="4" x2="20" y1="12" y2="12" />
      <line x1="4" x2="20" y1="18" y2="18" />
    </Ic>
  );
}

/** ■ stop / halt — filled square */
export function IconSquareFill(p: IconProps) {
  return (
    <Ic {...p} strokeWidth={0}>
      <rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" />
    </Ic>
  );
}

/** ● status dot — filled circle */
export function IconDot({ size = 8, className, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 8 8"
      fill="currentColor"
      className={className}
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style }}
      aria-hidden
    >
      <circle cx="4" cy="4" r="4" />
    </svg>
  );
}

/** ⚠ alert triangle / warning / error */
export function IconAlertTriangle(p: IconProps) {
  return (
    <Ic {...p}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" x2="12" y1="9" y2="13" />
      <line x1="12" x2="12.01" y1="17" y2="17" />
    </Ic>
  );
}

/** 👁 eye / diff view / preview */
export function IconEye(p: IconProps) {
  return (
    <Ic {...p}>
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </Ic>
  );
}

/** 🗑 trash / delete / clear all */
export function IconTrash(p: IconProps) {
  return (
    <Ic {...p}>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </Ic>
  );
}

/** + plus / add / new */
export function IconPlus(p: IconProps) {
  return (
    <Ic {...p}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Ic>
  );
}

/** ← arrow left / back */
export function IconArrowLeft(p: IconProps) {
  return <Ic {...p}><path d="m15 18-6-6 6-6" /></Ic>;
}

/** → arrow right / forward */
export function IconArrowRight(p: IconProps) {
  return <Ic {...p}><path d="m9 18 6-6-6-6" /></Ic>;
}

/** ↻ rotate clockwise / reload page */
export function IconRotateCw(p: IconProps) {
  return (
    <Ic {...p}>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </Ic>
  );
}

/** 🔒 lock / https */
export function IconLock(p: IconProps) {
  return (
    <Ic {...p}>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Ic>
  );
}

/** 🌐 globe / http / browser */
export function IconGlobe(p: IconProps) {
  return (
    <Ic {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </Ic>
  );
}

/** 🔍+ zoom in / magnify */
export function IconZoomIn(p: IconProps) {
  return (
    <Ic {...p}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
      <path d="M11 8v6M8 11h6" />
    </Ic>
  );
}

/** 🔍- zoom out */
export function IconZoomOut(p: IconProps) {
  return (
    <Ic {...p}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
      <path d="M8 11h6" />
    </Ic>
  );
}

/** [1:1] reset zoom / actual size */
export function IconMaximize2(p: IconProps) {
  return (
    <Ic {...p}>
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" x2="14" y1="3" y2="10" />
      <line x1="3" x2="10" y1="21" y2="14" />
    </Ic>
  );
}

/** 💬+ add page/element to chat */
export function IconMessagePlus(p: IconProps) {
  return (
    <Ic {...p}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M12 7v6M9 10h6" />
    </Ic>
  );
}

/** ◎ element inspector / pick element / crosshair cursor */
export function IconCrosshair(p: IconProps) {
  return (
    <Ic {...p}>
      <circle cx="12" cy="12" r="10" />
      <line x1="22" x2="18" y1="12" y2="12" />
      <line x1="6" x2="2" y1="12" y2="12" />
      <line x1="12" x2="12" y1="6" y2="2" />
      <line x1="12" x2="12" y1="22" y2="18" />
    </Ic>
  );
}

/** ↖ mouse pointer / element picker — DevTools inspect cursor */
export function IconMousePointer(p: IconProps) {
  return (
    <Ic {...p}>
      <path d="m4 4 7.07 17 2.51-7.39L21 11.07z" />
    </Ic>
  );
}

