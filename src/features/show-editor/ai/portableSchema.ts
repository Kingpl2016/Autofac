import { z } from "zod";

/**
 * 把 zod schema 转成各家模型接口都接受的 JSON Schema 子集。
 *
 * 各家对 JSON Schema 的支持不一样（OpenAI 严格模式不接受 `oneOf`、要求所有字段必填；Gemini 只认 OpenAPI 子集；
 * 一些 OpenAI 兼容服务不认 `minimum` / `pattern`）。这里统一成最保守的形态：
 *
 * - 所有对象字段都在 `required` 里、`additionalProperties: false`（zod 的 `io: "output"` 已保证，可省略的字段是 `nullable`）；
 * - `oneOf` → `anyOf`，`const` → 单值 `enum`，去掉 `default` 与 `$schema`；
 * - 数值范围、长度、正则、数组长度这类约束写进 `description`，不作为关键字出现——结构由我们自己的 zod 校验兜底，
 *   不依赖模型接口去强制。
 */

/** JSON Schema 节点（只处理用到的形态）。 */
type Node = Record<string, unknown>;

/** 搬进说明里的约束关键字。 */
const CONSTRAINTS: Record<string, (v: unknown) => string> = {
  minimum: (v) => `min ${String(v)}`,
  maximum: (v) => `max ${String(v)}`,
  exclusiveMinimum: (v) => `> ${String(v)}`,
  exclusiveMaximum: (v) => `< ${String(v)}`,
  minLength: (v) => `at least ${String(v)} chars`,
  maxLength: (v) => `at most ${String(v)} chars`,
  pattern: (v) => `pattern ${String(v)}`,
  minItems: (v) => `at least ${String(v)} items`,
  maxItems: (v) => `at most ${String(v)} items`,
  format: (v) => `format ${String(v)}`,
};

/** 递归改写一个节点。 */
function rewrite(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewrite);
  if (typeof node !== "object" || node === null) return node;
  const src = node as Node;
  const out: Node = {};
  const notes: string[] = [];
  for (const [k, v] of Object.entries(src)) {
    if (k === "$schema" || k === "default" || k === "description") continue;
    if (k in CONSTRAINTS) {
      notes.push(CONSTRAINTS[k](v));
      continue;
    }
    if (k === "oneOf") out.anyOf = rewrite(v);
    else if (k === "const") out.enum = [v];
    else out[k] = rewrite(v);
  }
  const desc = [typeof src.description === "string" ? src.description : "", notes.length > 0 ? `(${notes.join(", ")})` : ""]
    .filter(Boolean)
    .join(" ");
  if (desc) out.description = desc;
  return out;
}

/**
 * 生成可移植的 JSON Schema。
 *
 * @param schema zod schema（可省略的字段用 `.nullable().default(null)`）。
 * @returns JSON Schema 对象。
 */
export function toPortableJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return rewrite(z.toJSONSchema(schema, { io: "output", target: "draft-7", unrepresentable: "any" })) as Record<string, unknown>;
}

/** 校验结果（与 AI SDK 的 `validate` 回调同形）。 */
export type PortableValidation<T> = { success: true; value: T } | { success: false; error: Error };

/**
 * 用 zod 宽松地解析模型输出：漏写的可省略字段补 `null`，多写的字段忽略；失败时给出模型能看懂的错误说明。
 *
 * @param schema zod schema。
 * @param value 模型给出的值。
 * @returns 解析结果。
 */
export function validateWith<T>(schema: z.ZodType<T>, value: unknown): PortableValidation<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { success: true, value: parsed.data };
  const lines = parsed.error.issues.slice(0, 12).map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`);
  return { success: false, error: new Error(`Invalid input:\n${lines.join("\n")}`) };
}
