// 通用数学与格式化工具

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const dist = (x1: number, y1: number, x2: number, y2: number): number => Math.hypot(x2 - x1, y2 - y1);
export const dist2 = (x1: number, y1: number, x2: number, y2: number): number => {
  const dx = x2 - x1, dy = y2 - y1;
  return dx * dx + dy * dy;
};
export const angleTo = (x1: number, y1: number, x2: number, y2: number): number => Math.atan2(y2 - y1, x2 - x1);
/** 帧率无关的指数平滑系数：1 - e^(-k·dt) */
export const damp = (k: number, dt: number): number => 1 - Math.exp(-k * dt);
/** 把角度规整到 (-π, π] */
export const wrapAngle = (a: number): number => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
};
/** 点到线段距离（legacy distToSeg） */
export function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const l2 = vx * vx + vy * vy;
  let t = l2 ? ((px - ax) * vx + (py - ay) * vy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}
/** 1.2k 风格数字（legacy fmt） */
export const fmt = (n: number): string => (n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(Math.floor(n)));
/** '#rrggbb' → 0xrrggbb */
export const hexToInt = (hex: string): number => parseInt(hex.slice(1), 16);
/** 颜色明暗调整（legacy shade，amt ∈ [-1,1]） */
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = clamp(Math.round(r + (amt > 0 ? (255 - r) * amt : r * amt)), 0, 255);
  g = clamp(Math.round(g + (amt > 0 ? (255 - g) * amt : g * amt)), 0, 255);
  b = clamp(Math.round(b + (amt > 0 ? (255 - b) * amt : b * amt)), 0, 255);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}
/** HTML 转义（legacy 联机/面板有 XSS 风险，所有动态文本都要过这里） */
export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
