import { CommitInput } from "../components/CommitInput";

/** 解析数字输入；不是有限数字时返回 `null`（不提交）。 */
function num(text: string): number | null {
  const v = Number(text.trim().replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

/**
 * 舞台工具条里的紧凑数字输入：标签 + 提交式输入框 + 单位。
 */
export function StageField({ label, value, unit, onCommit }: { label: string; value: number; unit: string; onCommit: (v: number) => void }) {
  return (
    <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
      <span aria-hidden>{label}</span>
      <CommitInput
        label={label}
        value={Number(value.toFixed(2))}
        inputMode="numeric"
        className="num h-6 w-14 px-1 text-[11px]"
        onCommit={(text) => {
          const v = num(text);
          if (v !== null) onCommit(v);
        }}
      />
      <span aria-hidden>{unit}</span>
    </label>
  );
}
