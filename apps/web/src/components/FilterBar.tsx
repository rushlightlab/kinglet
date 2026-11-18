interface FilterBarProps {
  value: string;
  onChange: (value: string) => void;
  onEnter: () => void;
  onRefresh: () => void;
  count: number;
  busy: boolean;
  error: string | null;
}

export default function FilterBar({ value, onChange, onEnter, onRefresh, count, busy, error }: FilterBarProps) {
  return (
    <div className="flex items-center gap-3 border-b border-[#1c2230] px-4 py-2">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onEnter();
        }}
        spellCheck={false}
        placeholder={`level:error service:api "timeout" -healthcheck`}
        className="min-w-0 max-w-2xl flex-1 rounded-md border border-[#1c2230] bg-[#11151f] px-3 py-1.5 font-mono text-xs outline-none focus:border-amber-500/50"
      />
      {error ? (
        <span className="truncate text-xs text-red-400">{error}</span>
      ) : (
        <span className="shrink-0 text-xs text-[#8b93a3]">
          {busy ? "…" : `${count.toLocaleString()} events`}
        </span>
      )}
      <button
        onClick={onRefresh}
        className="shrink-0 rounded-md border border-[#1c2230] px-2 py-1 text-xs hover:bg-[#11151f]"
      >
        Refresh
      </button>
    </div>
  );
}
