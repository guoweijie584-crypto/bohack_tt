// 像素图标：全部用 canvas 逐像素绘制 16×16（自动 1px 深色描边），替代 legacy 的 emoji/Unicode 图标。
// - 技能图标按 kind 造型 + 元素色；职业徽记按职业主色；属性/资源/面板/状态等通用图标；
// - 结果缓存为 dataURL，HTML 里用 <i class="ico"> + background-image 放大（image-rendering: pixelated）；
// - 无 DOM 环境（测试）返回空占位，不报错。

import { shade } from '../core/util';
import { clsOf } from '../data/classes';
import { ELEM } from '../data/elements';
import type { ElementId, SkillKind } from '../data/types';
import { hasDom } from './dom';

type Px = string | null;
const N = 16;
const OUT = '#1a100b';

/** 固定色板（ascii 图案用的字母） */
const PAL: Record<string, string> = {
  w: '#fff3dd', k: '#2a1d16',
  y: '#f2cd8c', Y: '#b8823e', L: '#fff0c0',
  s: '#c9c4bc', S: '#7d7770', l: '#f2efe8',
  n: '#8a5a34', N: '#5a3a22',
  r: '#df5f57', R: '#8c2f2a', p: '#f4a39a',
  u: '#5fa9d8', U: '#2b5a80', v: '#a6dcf5',
  g: '#a3c979', G: '#5a7a3a',
  m: '#c29ae8', M: '#6e4c98',
  t: '#7fd6c4', T: '#3f8a7c',
  e: '#e8d6b4', E: '#a88a62',
  h: '#f0c8a0',
  f: '#ffd36a', F: '#ff8a3a',
};

/** 像素画布（颜色字符串数组），提供基本几何与自动描边 */
class Pix {
  readonly d: Px[] = new Array<Px>(N * N).fill(null);
  set(x: number, y: number, c: Px): void {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= N || y >= N) return;
    this.d[y * N + x] = c;
  }
  get(x: number, y: number): Px {
    if (x < 0 || y < 0 || x >= N || y >= N) return null;
    return this.d[y * N + x];
  }
  rect(x: number, y: number, w: number, h: number, c: string): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c);
  }
  /** Bresenham 直线 */
  line(x0: number, y0: number, x1: number, y1: number, c: string): void {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let guard = 0; guard < 64; guard++) {
      this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  /** 像素中心落在圆内（cx,cy 为连续坐标） */
  static inDisc(x: number, y: number, cx: number, cy: number, r: number): boolean {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
    return dx * dx + dy * dy <= r * r;
  }
  disc(cx: number, cy: number, r: number, c: string): void {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (Pix.inDisc(x, y, cx, cy, r)) this.set(x, y, c);
  }
  ring(cx: number, cy: number, r0: number, r1: number, c: string, keep?: (x: number, y: number) => boolean): void {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (Pix.inDisc(x, y, cx, cy, r1) && !Pix.inDisc(x, y, cx, cy, r0) && (!keep || keep(x, y))) this.set(x, y, c);
    }
  }
  /** 多边形填充（像素中心判定） */
  poly(pts: ReadonlyArray<readonly [number, number]>, c: string): void {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const px = x + 0.5, py = y + 0.5;
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) this.set(x, y, c);
    }
  }
  /** ascii 图案：每行 16 字符，'.' 透明，其余查 pal（覆盖 PAL） */
  art(rows: readonly string[], pal: Record<string, string> = {}): void {
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (ch === '.' || ch === ' ') continue;
        const c = pal[ch] ?? PAL[ch];
        if (c) this.set(x, y, c);
      }
    });
  }
  /** 自动描边：与不透明像素 4 邻接的透明像素涂成描边色 */
  outline(c = OUT): void {
    const mark: number[] = [];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (this.get(x, y)) continue;
      if (this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1)) mark.push(y * N + x);
    }
    for (const i of mark) this.d[i] = c;
  }
  toCanvas(): HTMLCanvasElement {
    const cv = document.createElement('canvas');
    cv.width = N; cv.height = N;
    const ctx = cv.getContext('2d');
    if (!ctx) return cv;
    for (let i = 0; i < this.d.length; i++) {
      const c = this.d[i];
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(i % N, Math.floor(i / N), 1, 1);
    }
    return cv;
  }
}

/** 主色派生三阶：a 主色、b 亮、c 暗 */
function tones(a: string): { a: string; b: string; c: string } {
  return { a, b: shade(a, 0.45), c: shade(a, -0.45) };
}

/* ------------------------------------------------------------------ */
/* ascii 图案                                                           */
/* ------------------------------------------------------------------ */
const ART_HEART = [
  '................', '................', '................',
  '...rrr....rrr...', '..rpprr..rrrrr..', '..rpprrrrrrrrR..', '..rprrrrrrrrrR..', '..rrrrrrrrrrrR..',
  '...rrrrrrrrrR...', '....rrrrrrrR....', '.....rrrrrR.....', '......rrrR......', '.......rR.......',
];
const ART_DROP = [
  '................', '................',
  '.......aa.......', '......aaaa......', '......aaaa......', '.....abaaaa.....', '....abaaaaaa....', '....abaaaaac....',
  '...abaaaaaaac...', '...abaaaaaaac...', '...aaaaaaaaac...', '....aaaaaaac....', '.....caaaac.....', '......cccc......',
];
const ART_SHIELD = [
  '................',
  '..cccccccccccc..', '..caaaaabaaaac..', '..caaaaabaaaac..', '..caaaabbbaaac..', '..cabbbbwbbbac..',
  '..caaaabbbaaac..', '..caaaaabaaaac..', '..caaaaabaaaac..', '...caaaabaaac...', '...caaaabaaac...',
  '....caaabaac....', '.....caabac.....', '......cabc......', '.......cc.......',
];
const ART_BOOT = [
  '................', '................',
  '....nnnnn.......', '....nNnnnww.....', '....nNnnnw......', '....nNnnn.......', '....nNnnn.......',
  '....nNnnnn......', '....nNnnnnnn....', '...nnNnnnnnnn...', '...nnnnnnnnnnn..', '...NNNNNNNNNNN..',
];
const ART_BOOK = [
  '................', '................',
  '...aaaa..aaaa...', '..awwwwaawwwwa..', '..awEEwaawEEwa..', '..awwwwaawwwwa..', '..awEEwaawEEwa..',
  '..awwwwaawwwwa..', '..awEEwaawEEwa..', '..awwwwaawwwwa..', '..aaaaaaaaaaaa..', '...cccc..cccc...',
];
const ART_HOURGLASS = [
  '................',
  '...YYYYYYYYYY...', '....e......e....', '....eyyyyyye....', '.....eyyyye.....', '......eyye......',
  '.......ee.......', '.......ee.......', '......e.ye......', '.....e..y.e.....', '....e...y..e....',
  '....e.yyyy.e....', '....eyyyyyye....', '...YYYYYYYYYY...',
];
const ART_SKULL = [
  '................', '................',
  '.....wwwwww.....', '....wwwwwwww....', '...wwwwwwwwww...', '...wkkwwwwkkw...', '...wkkwwwwkkw...',
  '...wwwwkkwwww...', '....wwwwwwww....', '.....wkwkwkw....', '.....wwwwwww....',
];
const ART_STAIRS = [
  '................', '................', '................',
  '..........ggg...', '..........gGg...', '.......gggggg...', '.......gGGGGg...', '....ggggggggg...',
  '....gGGGGGGGg...', '.gggggggggggg...', '.gGGGGGGGGGGg...', '.gggggggggggg...',
];
const ART_CHEST = [
  '................', '................', '................',
  '...NNNNNNNNNN...', '..NnnnnnnnnnnN..', '..NnnnnnnnnnnN..', '..NyyyyyyyyyyN..', '..NnnnnyynnnnN..',
  '..NnnnnYYnnnnN..', '..NnnnnnnnnnnN..', '..NnnnnnnnnnnN..', '..NNNNNNNNNNNN..',
];
const ART_SCROLL = [
  '................', '................',
  '..NnnnnnnnnnnN..', '...eeeeeeeeee...', '...eEEEEEEEEe...', '...eeeeeeeeee...', '...eEEEEEEeee...',
  '...eeeeeeeeee...', '...eEEEEEEEEe...', '...eeeeeeeeee...', '...eEEEEeeeee...', '...eeeeeeeeee...',
  '..NnnnnnnnnnnN..',
];
const ART_QUESTION = [
  '................', '................',
  '.....yyyyy......', '....yy...yy.....', '....yy...yy.....', '........yy......', '.......yy.......',
  '......yy........', '......yy........', '................', '......yy........', '......yy........',
];
const ART_BAG = [
  '................',
  '......NNNN......', '.......nn.......', '......nnnn......', '.....nnnnnn.....', '....nnnnnnnn....',
  '...nnnnnnnnnn...', '...nnnyyyynnn...', '..nnnnnnnnnnnn..', '..nnnnnnnnnnnN..', '..nnnnnnnnnnnN..',
  '...nnnnnnnnnN...', '....NNNNNNNN....',
];
const ART_PERSON = [
  '................', '................',
  '......hhhh......', '.....hhhhhh.....', '.....hhhhhh.....', '.....hhhhhh.....', '......hhhh......',
  '................', '...aaaaaaaaaa...', '..aaaaaaaaaaaa..', '..aaaaaaaaaaaa..', '..aaaaaaaaaaaa..', '..cccccccccccc..',
];
const ART_FLAME = [
  '................',
  '.......F........', '......FF........', '......FFF.......', '.....FFFF.F.....', '.....FFfFFF.....',
  '....FFffFFF.....', '...FFfffFFFF....', '...FFffwfFFF....', '...FFfwwffFF....', '...FFfwwwfFF....',
  '....FfwwwfF.....', '.....FffffF.....', '......FFFF......',
];
const ART_BOLT = [
  '................',
  '.........yyy....', '........yyy.....', '.......yyy......', '......yyy.......', '.....yyyyyyy....',
  '........yyy.....', '.......yyy......', '......yyy.......', '.....yyy........', '....yy..........',
  '...y............',
];
const ART_HELMET = [
  '................', '................',
  '.....aaaaaa.....', '....abbaaaaa....', '...abaaaaaaac...', '...aaaaaaaaac...', '...akkkkkkkkc...',
  '...aaaakkaaac...', '...aaaakkaaac...', '...caaaaaaacc...', '....ccaaaacc....', '.....cccccc.....',
];
const ART_HAT = [
  '................',
  '.........a......', '........aa......', '.......aab......', '......aaab......', '.....aaaaab.....',
  '.....aaaaaa.....', '....aaaaaaaa....', '....yyyyyyyy....', '..cccccccccccc..', '....hhhhhhhh....',
  '....hkkhhkkh....', '.....hhhhhh.....',
];
const ART_HOOD = [
  '................',
  '......aaaa......', '.....aaaaaa.....', '....aaaaaaaa....', '...aaaccccaaa...', '...aacchhccaa...',
  '...aachkkhcaa...', '...aachhhhcaa...', '...aaaccccaaa...', '..aaaaaaaaaaaa..', '..aaaaaaaaaaaa..',
  '..cccccccccccc..',
];
const ART_MASK = [
  '................', '................',
  '.....aaaaaa.....', '....aaaaaaaa....', '...aaaaaaaaaa...', '...kkkkkkkkkk...', '...kwwkkkkwwk...',
  '...kkkkkkkkkk...', '...hhhhhhhhhh...', '....hhhhhhhh....', '.....cccccc.....', '....cccccccc....',
];

/* ------------------------------------------------------------------ */
/* 图标定义                                                             */
/* ------------------------------------------------------------------ */
type Draw = (g: Pix, a: string, b: string, c: string) => void;

function drawSword(g: Pix): void {
  for (let t = 0; t <= 7; t++) { g.set(6 + t, 10 - t, PAL.s); g.set(6 + t, 9 - t, PAL.l); }
  [[3, 8], [4, 9], [5, 10], [6, 11], [7, 12]].forEach(([x, y]) => g.set(x, y, PAL.y));
  g.set(4, 11, PAL.n); g.set(3, 12, PAL.N); g.set(2, 13, PAL.Y);
}
function drawDagger(g: Pix): void {
  for (let t = 0; t <= 4; t++) { g.set(8 + t, 8 - t, PAL.s); g.set(8 + t, 7 - t, PAL.l); }
  [[5, 6], [6, 7], [7, 8], [8, 9], [9, 10]].forEach(([x, y]) => g.set(x, y, PAL.y));
  g.set(6, 9, PAL.n); g.set(5, 10, PAL.n); g.set(4, 11, PAL.N); g.set(3, 12, PAL.Y);
}
function drawStaff(g: Pix, a: string, b: string): void {
  for (let t = 0; t <= 7; t++) { g.set(3 + t, 13 - t, PAL.n); g.set(4 + t, 13 - t, PAL.N); }
  g.disc(11.5, 4.5, 2.9, a);
  g.set(10, 3, b); g.set(11, 3, PAL.w);
}
function drawBow(g: Pix): void {
  g.ring(3, 8, 5.6, 7.1, PAL.n, (x, y) => x >= 4 && y >= 1 && y <= 14);
  g.line(4, 2, 4, 14, PAL.l);
  g.line(3, 8, 12, 8, PAL.S);
  g.set(13, 8, PAL.s); g.set(12, 7, PAL.s); g.set(12, 9, PAL.s);
  g.set(2, 7, PAL.r); g.set(2, 9, PAL.r);
}
function drawGear(g: Pix, a: string, b: string, c: string): void {
  for (let k = 0; k < 8; k++) {
    const ang = (k / 8) * Math.PI * 2;
    const x = Math.round(7.5 + Math.cos(ang) * 5.6 - 0.5), y = Math.round(7.5 + Math.sin(ang) * 5.6 - 0.5);
    g.rect(x, y, 2, 2, c);
  }
  g.ring(8, 8, 2, 5, a);
  g.ring(8, 8, 3.6, 5, b, (x, y) => x + y < 15);
}
function drawStar4(g: Pix, a: string, b: string, c: string): void {
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = Math.abs(x + 0.5 - 8), dy = Math.abs(y + 0.5 - 8);
    if (Math.sqrt(dx) + Math.sqrt(dy) <= Math.sqrt(6.8)) g.set(x, y, dx + dy < 2.6 ? b : (x + 0.5 > 8 && y + 0.5 > 8 ? c : a));
  }
  g.set(7, 7, PAL.w);
}
function drawPotion(g: Pix, a: string, b: string, c: string): void {
  g.rect(6, 1, 4, 2, PAL.n);
  g.rect(7, 3, 2, 2, '#cfe3ea');
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (!Pix.inDisc(x, y, 8, 10, 4.8)) continue;
    if (y < 8) g.set(x, y, '#cfe3ea');
    else g.set(x, y, x >= 10 ? c : a);
  }
  g.set(5, 9, b); g.set(5, 10, b); g.set(6, 8, PAL.w);
}

const ICONS = {
  heart: g => g.art(ART_HEART),
  drop: (g, a, b, c) => g.art(ART_DROP, { a, b, c }),
  shield: (g, a, b, c) => g.art(ART_SHIELD, { a, b, c, w: PAL.w }),
  boot: g => g.art(ART_BOOT),
  book: (g, a, _b, c) => g.art(ART_BOOK, { a, c }),
  hourglass: g => g.art(ART_HOURGLASS, { e: '#cfe3ea' }),
  skull: g => g.art(ART_SKULL, { w: '#efe3cf' }),
  stairs: g => g.art(ART_STAIRS),
  chest: g => g.art(ART_CHEST),
  scroll: g => g.art(ART_SCROLL),
  question: g => g.art(ART_QUESTION),
  bag: g => g.art(ART_BAG),
  person: (g, a, _b, c) => g.art(ART_PERSON, { a, c }),
  flame: g => g.art(ART_FLAME),
  bolt: g => g.art(ART_BOLT),
  sword: g => drawSword(g),
  dagger: g => drawDagger(g),
  staff: (g, a, b) => drawStaff(g, a, b),
  bow: g => drawBow(g),
  gear: (g, a, b, c) => drawGear(g, a, b, c),
  star: (g, a, b, c) => drawStar4(g, a, b, c),
  potion: (g, a, b, c) => drawPotion(g, a, b, c),
  coin: g => {
    g.disc(8, 8, 5.7, PAL.Y);
    g.disc(8, 8, 4.6, PAL.y);
    g.rect(7, 5, 2, 6, PAL.Y);
    g.set(5, 4, PAL.L); g.set(4, 5, PAL.L); g.set(5, 5, PAL.L); g.set(4, 6, PAL.L);
  },
  gem: (g, a, b, c) => {
    g.poly([[8, 1.5], [14, 7], [8, 14.5], [2, 7]], a);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (!g.get(x, y)) continue;
      if (y < 6) g.set(x, y, b);
      else if (x >= 8) g.set(x, y, c);
    }
    g.set(6, 4, PAL.w);
  },
  essence: (g, a, b, c) => {
    g.disc(8, 8, 5.3, a);
    g.ring(8, 8, 2.2, 3.4, b, (x, y) => y < 8 || x < 7);
    g.ring(8, 8, 4.2, 5.3, c, (x, y) => x + y > 16);
    g.set(6, 5, PAL.w); g.set(12, 2, b); g.set(2, 12, b);
  },
  target: g => {
    g.ring(8, 8, 4.6, 6.4, PAL.r);
    g.ring(8, 8, 1.6, 2.9, PAL.r);
    g.rect(7, 7, 2, 2, PAL.w);
  },
  plus: g => { g.rect(6, 3, 4, 10, PAL.g); g.rect(3, 6, 10, 4, PAL.g); g.rect(7, 4, 1, 8, '#d4f0a8'); },
  lock: g => {
    g.ring(8, 7.5, 2.2, 3.6, PAL.s, (_x, y) => y < 8);
    g.rect(4, 7, 8, 7, PAL.y);
    g.rect(4, 12, 8, 2, PAL.Y);
    g.rect(7, 9, 2, 3, PAL.k);
  },
  check: g => {
    const pts: Array<[number, number, number, number]> = [[3, 8, 6, 11], [6, 11, 12, 4], [3, 9, 6, 12], [6, 12, 12, 5]];
    for (const [a, b, c, d] of pts) g.line(a, b, c, d, PAL.g);
  },
  cross: g => {
    g.line(3, 3, 12, 12, PAL.r); g.line(4, 3, 12, 11, PAL.r); g.line(3, 4, 11, 12, PAL.r);
    g.line(12, 3, 3, 12, PAL.r); g.line(11, 3, 3, 11, PAL.r); g.line(12, 4, 4, 12, PAL.r);
  },
  close: g => {
    g.line(4, 4, 11, 11, PAL.e); g.line(5, 4, 11, 10, PAL.e);
    g.line(11, 4, 4, 11, PAL.e); g.line(10, 4, 4, 10, PAL.e);
  },
  arrowUp: g => {
    g.poly([[8, 1.5], [14, 8], [10.5, 8], [10.5, 14], [5.5, 14], [5.5, 8], [2, 8]], PAL.g);
    g.line(8, 3, 8, 13, '#d4f0a8');
  },
  arrowRight: (g, a) => { g.poly([[3, 2], [14, 8], [3, 14]], a); },
  portal: (g, a, b) => {
    g.ring(8, 8, 4.4, 6.6, a);
    g.ring(8, 8, 1.8, 3, b);
    g.rect(7, 7, 2, 2, PAL.w);
    g.set(2, 2, b); g.set(13, 3, b); g.set(12, 13, b);
  },
  tree: g => {
    g.line(8, 4, 4, 11, PAL.S); g.line(8, 4, 12, 11, PAL.S);
    g.disc(8, 4, 2.2, PAL.y); g.disc(4, 12, 2.2, PAL.g); g.disc(12, 12, 2.2, PAL.m);
  },
  merge: g => {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const inA = Pix.inDisc(x, y, 6, 8.5, 4.4), inB = Pix.inDisc(x, y, 10.5, 8.5, 4.4);
      if (inA && inB) g.set(x, y, PAL.w);
      else if (inA) g.set(x, y, '#f0804a');
      else if (inB) g.set(x, y, '#7fc4dd');
    }
  },
  map: g => {
    g.rect(2, 3, 12, 10, PAL.e);
    g.rect(6, 3, 1, 10, PAL.E); g.rect(10, 3, 1, 10, PAL.E);
    g.set(4, 10, PAL.r); g.set(5, 9, PAL.r); g.set(7, 9, PAL.r); g.set(8, 8, PAL.r);
    g.line(11, 5, 13, 7, PAL.R); g.line(13, 5, 11, 7, PAL.R);
  },
  speaker: g => {
    g.rect(2, 6, 3, 4, PAL.s);
    g.poly([[5, 6], [9.5, 2], [9.5, 14], [5, 10]], PAL.s);
    g.ring(9, 8, 3, 4.2, PAL.l, x => x >= 11);
    g.ring(9, 8, 5.2, 6.4, PAL.l, x => x >= 12);
  },
  screen: g => {
    const c = PAL.e;
    g.rect(2, 2, 4, 2, c); g.rect(2, 2, 2, 4, c);
    g.rect(10, 2, 4, 2, c); g.rect(12, 2, 2, 4, c);
    g.rect(2, 12, 4, 2, c); g.rect(2, 10, 2, 4, c);
    g.rect(10, 12, 4, 2, c); g.rect(12, 10, 2, 4, c);
  },
  trash: g => {
    g.rect(3, 3, 10, 2, PAL.S); g.rect(6, 2, 4, 1, PAL.S);
    g.rect(4, 6, 8, 8, PAL.s);
    g.rect(6, 7, 1, 6, PAL.S); g.rect(9, 7, 1, 6, PAL.S);
  },
  hammer: g => {
    for (let t = 0; t <= 7; t++) { g.set(6 + t, 7 + t, PAL.n); g.set(7 + t, 7 + t, PAL.N); }
    g.poly([[1, 5], [5, 1], [9.5, 5.5], [5.5, 9.5]], PAL.s);
    g.line(2, 5, 5, 2, PAL.l);
  },
  exp: g => {
    g.poly([[8, 2], [13, 8], [8, 14], [3, 8]], PAL.g);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (g.get(x, y) && x < 8 && y < 8) g.set(x, y, '#d4f0a8');
    g.set(6, 6, PAL.w);
  },
  swords: g => {
    for (let t = 0; t <= 8; t++) { g.set(4 + t, 11 - t, PAL.s); g.set(11 - t, 11 - t, PAL.l); }
    g.line(2, 11, 5, 14, PAL.y); g.line(10, 14, 13, 11, PAL.y);
    g.set(2, 13, PAL.n); g.set(13, 13, PAL.n);
  },
  bubble: g => {
    g.rect(2, 3, 12, 8, PAL.w);
    g.rect(3, 2, 10, 10, PAL.w);
    g.set(4, 12, PAL.w); g.set(4, 13, PAL.w); g.set(5, 12, PAL.w);
    g.set(5, 7, PAL.k); g.set(8, 7, PAL.k); g.set(11, 7, PAL.k);
  },
  dash: (g, a, b) => {
    for (const ox of [2, 7]) {
      g.line(ox, 3, ox + 4, 7, a); g.line(ox, 12, ox + 4, 8, a);
      g.line(ox + 1, 3, ox + 5, 7, b); g.line(ox + 1, 12, ox + 5, 8, b);
    }
  },
  snow: (g, a, b) => {
    g.line(8, 2, 8, 13, a); g.line(2, 8, 13, 8, a);
    g.line(4, 4, 12, 12, b); g.line(12, 4, 4, 12, b);
    g.rect(7, 7, 2, 2, PAL.w);
  },
  poisonDrop: g => {
    g.art(ART_DROP, { a: '#a8d06a', b: '#d4f0a8', c: '#5a7a3a' });
    g.set(7, 9, PAL.k); g.set(9, 9, PAL.k); g.set(8, 11, PAL.k);
  },
  helmet: (g, a, b, c) => g.art(ART_HELMET, { a, b, c }),
  hat: (g, a, b, c) => g.art(ART_HAT, { a, b, c }),
  hood: (g, a, b, c) => g.art(ART_HOOD, { a, b, c }),
  mask: (g, a, b, c) => g.art(ART_MASK, { a, b, c }),
  dot: (g, a) => g.disc(8, 8, 4, a),
} satisfies Record<string, Draw>;

/* ------------------------------------------------------------------ */
/* 技能图标（按 kind 造型，element 着色）                                 */
/* ------------------------------------------------------------------ */
const ROCK = '#6f5a4a', ROCK_L = '#a08672';
const SKILL_DRAW: Record<SkillKind, Draw> = {
  cleave: (g, a, b) => {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const inA = Pix.inDisc(x, y, 7, 8, 6.6), inB = Pix.inDisc(x, y, 10, 8, 5.6);
      if (!inA || inB) continue;
      const edge = Pix.inDisc(x + 1, y, 10, 8, 5.6) || Pix.inDisc(x, y + 1, 10, 8, 5.6) || Pix.inDisc(x, y - 1, 10, 8, 5.6);
      g.set(x, y, edge ? b : a);
    }
    g.set(13, 3, PAL.w); g.set(12, 2, b); g.set(14, 4, b);
  },
  charge: (g, a, b) => {
    g.rect(3, 7, 7, 2, a);
    g.poly([[9, 3], [14.5, 8], [9, 13]], a);
    g.line(9, 4, 12, 7, b);
    g.rect(1, 4, 3, 1, b); g.rect(1, 11, 3, 1, b); g.rect(2, 7, 1, 2, b);
  },
  buff: (g, a, b, c) => g.art(ART_SHIELD, { a, b, c, w: PAL.w }),
  shot: (g, a, b, c) => {
    g.line(2, 13, 8, 7, c); g.line(3, 13, 9, 7, a); g.line(2, 12, 8, 6, a);
    g.disc(10.5, 5.5, 3.4, a); g.disc(10.5, 5.5, 2.2, b);
    g.set(10, 4, PAL.w); g.set(9, 5, PAL.w);
  },
  meteor: (g, a, b, c) => {
    g.line(1, 14, 8, 7, c); g.line(2, 14, 9, 7, a); g.line(1, 13, 8, 6, a); g.line(3, 14, 9, 8, b);
    g.disc(10.5, 5.5, 3.7, ROCK); g.disc(10, 5, 1.9, ROCK_L);
    g.set(7, 9, b); g.set(5, 11, PAL.w);
  },
  meteors: (g, a, b) => {
    for (const [ox, oy] of [[9, 1], [2, 6], [9, 9]] as const) {
      g.line(ox, oy + 5, ox + 2, oy + 3, a); g.line(ox + 1, oy + 5, ox + 3, oy + 3, b);
      g.disc(ox + 4, oy + 2, 2, ROCK); g.set(ox + 3, oy + 1, ROCK_L);
    }
  },
  nova: (g, a, b) => {
    g.ring(8, 8, 5.2, 7, a);
    g.ring(8, 8, 2.2, 3.4, b);
    g.rect(7, 7, 2, 2, PAL.w);
  },
  multi: (g, a, b) => {
    const ends: Array<[number, number]> = [[4, 2], [10, 5], [13, 11]];
    for (const [ex, ey] of ends) { g.line(2, 13, ex, ey, a); g.set(ex, ey, PAL.w); }
    g.set(4, 3, b); g.set(9, 5, b); g.set(12, 11, b);
  },
  trap: (g, a, b, c) => {
    g.ring(8, 8, 4.6, 6.4, a);
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2 + Math.PI / 8;
      g.set(Math.round(7.5 + Math.cos(ang) * 3.8), Math.round(7.5 + Math.sin(ang) * 3.8), b);
    }
    g.disc(8, 8, 2.1, c);
    g.rect(7, 7, 2, 2, PAL.w);
  },
  chain: (g, a, b) => {
    g.line(3, 12, 5, 7, a); g.line(5, 7, 6, 9, a); g.line(6, 9, 8, 4, a);
    g.line(8, 4, 10, 9, a); g.line(10, 9, 11, 7, a); g.line(11, 7, 13, 11, a);
    for (const [x, y] of [[3, 12], [8, 4], [13, 11]] as const) { g.disc(x + 0.5, y + 0.5, 1.7, b); g.set(x, y, PAL.w); }
  },
  beam: (g, a, b) => {
    g.rect(5, 6, 10, 4, a);
    g.rect(5, 7, 10, 2, b);
    g.rect(6, 7, 8, 1, PAL.w);
    g.disc(3.5, 8, 3, b); g.set(3, 7, PAL.w);
    g.set(9, 4, b); g.set(12, 12, b);
  },
  aura: (g, a, b, c) => {
    g.ring(8, 8, 5, 6.7, a, (x, y) => Math.floor((Math.atan2(y + 0.5 - 8, x + 0.5 - 8) + Math.PI) / (Math.PI / 6)) % 2 === 0);
    g.disc(8, 8, 2.7, b);
    g.rect(7, 7, 2, 2, PAL.w);
    g.set(8, 3, c); g.set(3, 8, c); g.set(12, 8, c); g.set(8, 12, c);
  },
};

/* ------------------------------------------------------------------ */
/* 缓存与输出                                                           */
/* ------------------------------------------------------------------ */
const cache = new Map<string, { url: string; canvas: HTMLCanvasElement }>();

function build(key: string, draw: (g: Pix) => void): { url: string; canvas: HTMLCanvasElement } | null {
  if (!hasDom()) return null;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const g = new Pix();
    draw(g);
    g.outline();
    const canvas = g.toCanvas();
    const v = { url: canvas.toDataURL('image/png'), canvas };
    cache.set(key, v);
    return v;
  } catch {
    return null;
  }
}

function html(entry: { url: string } | null, scale: number, cls: string): string {
  const s = 16 * scale;
  const extra = cls ? ' ' + cls : '';
  if (!entry) return `<i class="ico${extra}" style="width:${s}px;height:${s}px"></i>`;
  return `<i class="ico${extra}" style="width:${s}px;height:${s}px;background-image:url(${entry.url})"></i>`;
}

export type IconName = keyof typeof ICONS;

/** 默认主色（可着色图标未传颜色时） */
const DEFAULT_TINT: Partial<Record<string, string>> = {
  drop: '#5fa9d8', shield: '#b8b2aa', book: '#8a6cc8', person: '#e8a765', gear: '#9a958e', star: '#f2cd8c',
  potion: '#df5f57', gem: '#b98ae8', essence: '#7fd6c4', portal: '#c29ae8', arrowRight: '#ff6b5f', dash: '#7fd6c4',
  snow: '#8fd8f0', staff: '#c29ae8', helmet: '#b8b2aa', hat: '#c29ae8', hood: '#7c9660', mask: '#6e4c98', dot: '#e8a765',
};

function entryOf(name: IconName, color?: string): { url: string; canvas: HTMLCanvasElement } | null {
  const tint = color ?? DEFAULT_TINT[name] ?? '#e8a765';
  const draw: Draw = ICONS[name];
  return build(`i:${name}:${tint}`, g => {
    const t = tones(tint);
    draw(g, t.a, t.b, t.c);
  });
}

/** 通用图标 HTML */
export function ico(name: IconName, scale = 1, color?: string, cls = ''): string {
  return html(entryOf(name, color), scale, cls);
}
/** 通用图标的画布（绘制到其它 canvas 用） */
export function icoCanvas(name: IconName, color?: string): HTMLCanvasElement | null {
  return entryOf(name, color)?.canvas ?? null;
}

/** 技能图标：kind 造型 + 元素色；ult=true 时右上角加金色星标 */
export function skillIcon(kind: SkillKind, el: ElementId, scale = 2, ult = false, cls = ''): string {
  const col = ELEM[el]?.c ?? '#e8a765';
  const e = build(`s:${kind}:${col}:${ult ? 1 : 0}`, g => {
    const t = tones(col);
    (SKILL_DRAW[kind] ?? SKILL_DRAW.shot)(g, t.a, t.b, t.c);
    if (ult) {
      g.set(13, 0, PAL.y); g.set(12, 1, PAL.y); g.set(13, 1, PAL.L); g.set(14, 1, PAL.y); g.set(13, 2, PAL.y);
    }
  });
  return html(e, scale, cls);
}

/** 普攻图标（按武器类型） */
export function weaponIcon(type: 'sword' | 'staff' | 'bow' | 'dagger', el: ElementId, scale = 2): string {
  if (type === 'staff') return ico('staff', scale, ELEM[el]?.c);
  return ico(type, scale);
}

/** 元素图标 */
export function elemIcon(el: ElementId, scale = 1): string {
  switch (el) {
    case 'fire': return ico('flame', scale);
    case 'ice': return ico('snow', scale, ELEM.ice.c);
    case 'lightning': return ico('bolt', scale);
    case 'poison': return ico('poisonDrop', scale);
    case 'arcane': return ico('star', scale, ELEM.arcane.c);
    case 'tech': return ico('gear', scale, ELEM.tech.c);
    default: return ico('sword', scale);
  }
}

const CLASS_SHAPE: Record<string, IconName> = {
  warrior: 'helmet', knight: 'helmet', armored: 'helmet', stormguard: 'helmet',
  pyro: 'hat', cryo: 'hat', storm: 'hat', elemage: 'hat',
  ranger: 'hood', ninja: 'hood', assassin: 'mask', stormblade: 'mask',
};
/** 职业徽记（立绘未就绪时的兜底） */
export function classIcon(cid: string, scale = 2, cls = ''): string {
  return ico(CLASS_SHAPE[cid] ?? 'person', scale, clsOf(cid).color, cls);
}
export function classIconCanvas(cid: string): HTMLCanvasElement | null {
  return icoCanvas(CLASS_SHAPE[cid] ?? 'person', clsOf(cid).color);
}

/** 路线图标 */
export function routeIcon(route: string, scale = 1): string {
  return route === 'tech' ? ico('gear', scale, '#7fd6c4') : ico('star', scale, '#c29ae8');
}

/** 状态/元素异常图标 */
export function statusIcon(s: string, scale = 1): string {
  switch (s) {
    case 'burn': return ico('flame', scale);
    case 'freeze': return ico('snow', scale, '#8fd8f0');
    case 'shock': return ico('bolt', scale);
    case 'poison': return ico('poisonDrop', scale);
    case 'slow': return ico('hourglass', scale);
    case 'stun': return ico('star', scale, '#f6d76e');
    default: return ico('dot', scale);
  }
}
