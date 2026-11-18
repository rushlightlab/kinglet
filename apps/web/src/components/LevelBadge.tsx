import { LEVEL_COLORS, LEVEL_NAMES } from "../types";

export function LevelBadge({ level }: { level: number }) {
  const color = LEVEL_COLORS[level] ?? "#64748b";
  const name = LEVEL_NAMES[level] ?? "?";
  return (
    <span
      className="inline-block w-11 shrink-0 rounded-sm px-1 py-0.5 text-center text-[10px] font-semibold uppercase"
      style={{ color, backgroundColor: `${color}1f` }}
    >
      {name}
    </span>
  );
}
