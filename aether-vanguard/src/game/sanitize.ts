// 读档用的 unknown → 具体类型收窄工具（progression 辅助模块）。
// 存档来自 localStorage，可能被手改、截断或来自旧版本，所有字段都要校验后再用。

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 有限数字，否则默认值 */
export const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** 夹在 [lo,hi] 的整数（向下取整），非数字取默认值 */
export function int(v: unknown, lo: number, hi: number, d = lo): number {
  const n = Math.floor(num(v, d));
  return n < lo ? lo : n > hi ? hi : n;
}

/** 非负有限数（金币、时长等），非数字取 0 */
export const nonNeg = (v: unknown): number => Math.max(0, num(v, 0));

export const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);

export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
