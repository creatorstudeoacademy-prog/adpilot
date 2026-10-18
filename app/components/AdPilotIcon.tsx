/**
 * AdPilot brand icon — paper-plane mark in brand gradient.
 * Used in the support chat widget (button + header).
 */
export function AdPilotIcon({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect width="48" height="48" rx="12" fill="url(#adpilot-g)" />
      <path
        d="M10 24.5 38 10l-8.5 28-8-10.5-11.5-3zm11.5 3L38 10 22 32l-3.5-8.5 3-3z"
        fill="#fff"
        opacity="0.95"
      />
      <path d="M21.5 27.5 38 10 22 32l-.5-4.5z" fill="#fff" />
      <defs>
        <linearGradient
          id="adpilot-g"
          x1="0"
          y1="0"
          x2="48"
          y2="48"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#5c6ac4" />
          <stop offset="1" stopColor="#3f4a9e" />
        </linearGradient>
      </defs>
    </svg>
  );
}
