/** The Kinglet mark: a side-profile kinglet whose crest forms the crown. */
export default function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="5 -2 88 88" className={className} aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M91 38 80 43.5C80 50 76 57 70 62 59 72 43 73 32 67L8 52.5l3.5-3L7 43.5 30 54C36 44 45 32 54 30l1-13 5 6 4-10 4 9.5 5-6.5 1 12.5c3 1 5 3.5 6 6zM69 36a2.4 2.4 0 1 0 0 .01z"
      />
    </svg>
  );
}
