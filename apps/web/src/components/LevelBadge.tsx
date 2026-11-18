import { LEVEL_COLORS, LEVEL_NAMES } from "../types";

export function LevelBadge({ level }: { level: number }) {
  const color = LEVEL_COLORS[level] ?? "#6b756c";
  const name = LEVEL_NAMES[level] ?? "?";
  const hot = level >= 4;
  return (
    <span
      className="inline-block w-11 shrink-0 rounded-[3px] border px-1 py-0.5 text-center text-[10px] font-semibold uppercase"
      style={{
        color,
        borderColor: `${color}33`,
        backgroundColor: `${color}0f`,
        ...(hot ? { textShadow: `0 0 12px ${color}66` } : {}),
      }}
    >
      {name}
    </span>
  );
}
