/**
 * Web Seek brand mark: a beacon (lower-left dot) emitting signal ripples that
 * reach out to a discovered "spark" (upper-right) — i.e. seeking and finding
 * across the web. Uses `currentColor` throughout so it inherits the surrounding
 * text color (the accent in the header). Two-tone accent is applied by the
 * caller via `text-*` (base) and the spark picking up its own class if desired.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      role="img"
      aria-label="Web Seek"
      focusable="false"
    >
      {/* Signal ripples radiating from the beacon toward the spark. */}
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
      >
        <path d="M5 12 A7 7 0 0 1 12 19" opacity={0.6} />
        <path d="M5 7.4 A11.6 11.6 0 0 1 16.6 19" opacity={0.32} />
      </g>
      {/* Beacon origin. */}
      <circle cx="5" cy="19" r="1.7" fill="currentColor" />
      {/* Discovered spark. */}
      <path
        d="M17.4 3.3 C17.76 6.14 18.46 6.84 21.3 7.2 C18.46 7.56 17.76 8.26 17.4 11.1 C17.04 8.26 16.34 7.56 13.5 7.2 C16.34 6.84 17.04 6.14 17.4 3.3 Z"
        fill="currentColor"
      />
    </svg>
  );
}
