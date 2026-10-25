interface UniverseSelectProps {
  /** 输入框 id，用于和外部 `<label>` 关联 */
  id: string;
  /** 可选的全部 Universe */
  universes: number[];
  /** 当前选中的 Universe */
  value: number | null;
  onChange: (universe: number) => void;
}

/**
 * Universe 选择下拉。
 *
 * 用原生 `<select>`：最多 100 个选项，原生控件自带键盘检索（输入数字直接跳转）与读屏语义。
 */
export function UniverseSelect({ id, universes, value, onChange }: UniverseSelectProps) {
  return (
    <select
      id={id}
      className="tabular h-11 w-40 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      value={value ?? ""}
      disabled={universes.length === 0}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {universes.map((u) => (
        <option key={u} value={u}>
          {u}
        </option>
      ))}
    </select>
  );
}
