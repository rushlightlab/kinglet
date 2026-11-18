export default function Crown({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="#fbbf24"
        stroke="#fbbf24"
        strokeWidth="1.5"
        strokeLinejoin="round"
        d="M3 8l4.5 3L12 4l4.5 7 4.5-3v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
      />
    </svg>
  );
}
