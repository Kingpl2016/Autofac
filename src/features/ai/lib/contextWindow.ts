/**
 * 常见模型的上下文窗口（tokens），对话框里显示“上下文用量 / 上限”用。
 *
 * 按模型 id 的规则匹配（不区分大小写，第一条命中的为准），数值取各家公开的默认上限；
 * 各家更新很快，对不上的模型返回 `null`，界面只显示已用量。
 */
const RULES: readonly [RegExp, number][] = [
  // 名字里直接写了上限的（moonshot-v1-32k、xxx-128k）
  [/(\d+)k\b/, -1],
  [/deepseek/, 128_000],
  [/qwen-?turbo|qwen-?long|qwen-plus-latest|qwen3?-coder-plus/, 1_000_000],
  [/qwen3-max|qwen3/, 262_144],
  [/qwen-?max/, 32_768],
  [/qwen-?plus/, 131_072],
  [/qwen2\.5/, 32_768],
  [/kimi-k2/, 262_144],
  [/kimi|moonshot/, 131_072],
  [/glm-4\.[56]/, 200_000],
  [/glm/, 128_000],
  [/gpt-4\.1/, 1_047_576],
  [/gpt-5/, 400_000],
  [/\bo[134](-|$)/, 200_000],
  [/gpt-4o|gpt-4-turbo/, 128_000],
  [/claude/, 200_000],
  [/gemini/, 1_048_576],
  [/llama-?3\.[1-3]|llama-?4/, 131_072],
  [/mistral|mixtral/, 32_768],
];

/**
 * 模型的上下文窗口。
 *
 * @param model 模型 id（例如 `deepseek-chat`）。
 * @returns tokens；不认识的模型为 `null`。
 */
export function contextWindowOf(model: string): number | null {
  const id = model.trim().toLowerCase();
  for (const [re, size] of RULES) {
    const m = re.exec(id);
    if (!m) continue;
    if (size > 0) return size;
    const k = Number(m[1]);
    if (k >= 4 && k <= 4096) return k * 1024;
  }
  return null;
}
