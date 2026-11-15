// 可播种随机数（Mulberry32，与 legacy seeded() 同算法，但改为实例，不再替换全局 RND）。

export class Rng {
  private t: number;
  constructor(seed: number = (Math.random() * 2 ** 32) >>> 0) {
    this.t = seed >>> 0 || 1;
  }
  /** [0,1) */
  next(): number {
    this.t = (this.t + 0x6d2b79f5) >>> 0;
    let a = this.t;
    a = Math.imul(a ^ (a >>> 15), a | 1);
    a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
    return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
  }
  /** [a,b) 浮点 */
  range(a: number, b: number): number {
    return a + this.next() * (b - a);
  }
  /** [a,b] 整数（含两端，与 legacy RI 一致） */
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

/** 全局非确定性随机（战斗掷骰、粒子等表现层） */
export const rng = new Rng();

/** FNV-1a 字符串哈希（legacy hashStr） */
export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 确定性二维哈希 → [0,1)（legacy hash2，用于装饰摆放/地砖变体） */
export function hash2(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}
