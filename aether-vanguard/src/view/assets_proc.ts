// 程序化像素素材（字符画 + 调色板，硬边、1px 深色描边、左上光源，遵循改版文档像素规范）：
// 装备图标（护甲/饰品 × 5 品质）、盾牌、地牢/城镇装饰（水井、铁砧、祭坛、补给泉、水晶、熔岩缝、墓碑、蛛网、路灯、告示牌、长椅、栅栏、骨堆）。

import * as Phaser from 'phaser';

type Pal = Record<string, string>;

/** 用字符画绘制到画布：'.' 透明，其余字符查调色板 */
function drawArt(ctx: CanvasRenderingContext2D, rows: string[], pal: Pal, ox = 0, oy = 0): void {
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c === '.' || c === ' ') continue;
      const col = pal[c];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(ox + x, oy + y, 1, 1);
    }
  });
}

function artTexture(scene: Phaser.Scene, key: string, rows: string[], pal: Pal): void {
  if (scene.textures.exists(key)) return;
  const w = Math.max(...rows.map(r => r.length)), h = rows.length;
  const t = scene.textures.createCanvas(key, w, h)!;
  const ctx = t.getContext();
  drawArt(ctx, rows, pal);
  t.refresh();
}

/** 品质色（与 data/items.ts RARITY 一致）：粗制 精良 稀有 史诗 传说 */
export const RARITY_HEX = ['#c9b9a2', '#a3c979', '#7fb6d8', '#c9a2f0', '#f0bd7c'];
const RARITY_DARK = ['#7d6f5c', '#5f8a3e', '#3f7598', '#7d58a8', '#b0783a'];

const ARMOR: Record<string, string[]> = {
  plate: [
    '..oo....oo..',
    '.oLLo..oLLo.',
    'oLMMLooLMMLo',
    'oLMMMLLMMMDo',
    'oLMMMMMMMMDo',
    '.oMMRRRRMDo.',
    '.oMMRRRRMDo.',
    '.oMMMMMMMDo.',
    '.oMMMMMMDDo.',
    '.oDMMMMMDDo.',
    '..oDDDDDDo..',
    '...oooooo...',
  ],
  robe: [
    '....oooo....',
    '...oLMMDo...',
    '..oLMRRMDo..',
    '.oLMMRRMMDo.',
    '.oLMMMMMMDo.',
    'oLMMMMMMMMDo',
    'oLMMMRRMMMDo',
    'oLMMMRRMMMDo',
    'oLMMMMMMMMDo',
    'oLMMMMMMMDDo',
    'oDDDDDDDDDDo',
    '.oooooooooo.',
  ],
  leather: [
    '..oo....oo..',
    '.oLMo..oMDo.',
    '.oLMMooMMDo.',
    'oLMMMMMMMMDo',
    'oLMoMMMMoMDo',
    'oLMMMRRMMMDo',
    'oLMMMRRMMMDo',
    'oLMoMMMMoMDo',
    'oLMMMMMMMMDo',
    '.oDDMMMMDDo.',
    '.ooooooooo..',
    '............',
  ],
};
const ARMOR_BASE: Record<string, [string, string, string]> = {
  plate: ['#d8dce6', '#a8afbd', '#6b7280'],
  robe: ['#a88ad8', '#7a5cb0', '#4a3478'],
  leather: ['#c89a6a', '#9a6a3e', '#6b4424'],
};
const TRINKET: Record<string, string[]> = {
  ring: [
    '............',
    '....oRRo....',
    '...oRWRRo...',
    '....oRRo....',
    '...oGGGGo...',
    '..oGo..oGo..',
    '..oGo..oGo..',
    '..oGo..oDo..',
    '...oGDDDo...',
    '....oooo....',
    '............',
    '............',
  ],
  amulet: [
    '.oG......Go.',
    '..oG....Go..',
    '...oG..Go...',
    '....oGGo....',
    '....oGGo....',
    '...oRRRRo...',
    '..oRWRRRRo..',
    '..oRRRRRRo..',
    '..oRRRRRDo..',
    '...oRRRDo...',
    '....oooo....',
    '............',
  ],
  chip: [
    '..o.o.o.o...',
    '.oooooooooo.',
    'ooMMMMMMMMoo',
    '.oMRRRRRRMo.',
    'ooMRWRRRRMoo',
    '.oMRRRRRRMo.',
    'ooMRRRRRDMoo',
    '.oMMMMMMMMo.',
    'oooooooooooo',
    '..o.o.o.o...',
    '............',
    '............',
  ],
};

/** 盾牌（手持，朝右；元气骑士式挂在身前） */
const SHIELDS: Record<string, { rows: string[]; pal: Pal }> = {
  shield_round: {
    rows: [
      '..oooo..',
      '.oMMMMo.',
      'oMWWWWMo',
      'oMWBBWMo',
      'oMWBBWMo',
      'oMWWWWMo',
      '.oMMMMo.',
      '..oooo..',
    ],
    pal: { o: '#2b1d14', M: '#9aa3b2', W: '#8a5a32', B: '#d8dce6' },
  },
  shield_kite: {
    rows: [
      'oooooooo',
      'oMLLLLDo',
      'oMLGGLDo',
      'oMGGGGDo',
      'oMLGGLDo',
      '.oMLLDo.',
      '..oMDo..',
      '...oo...',
    ],
    pal: { o: '#1f2430', M: '#c8ccd8', L: '#3f8a52', G: '#f0c96b', D: '#6b7280' },
  },
  shield_storm: {
    rows: [
      '.oooooo.',
      'oMLLLLDo',
      'oLLYYLLo',
      'oLYYLLLo',
      'oLLYYLLo',
      'oLLLYLLo',
      '.oMLLDo.',
      '..oooo..',
    ],
    pal: { o: '#1a1530', M: '#b8a8e8', L: '#5a3fa0', Y: '#ffe070', D: '#3a2870' },
  },
};

/** 装饰（地牢/城镇），原点在底边中点 */
const DECOR_ART: Record<string, { rows: string[]; pal: Pal }> = {
  well: {
    rows: [
      '...oooooooooo...',
      '..oWWWWWWWWWWo..',
      '..oW........Wo..',
      '..oW...oo...Wo..',
      '..oW...oR...Wo..',
      '..oW...oR...Wo..',
      '.ooooooooooooooo',
      'oSSSSSSSSSSSSSSo',
      'oSLLLLLLLLLLLLSo',
      'oSLBBBBBBBBBBLSo',
      'oSLBBbBBBBbBBLSo',
      'oSLLLLLLLLLLLLSo',
      'oSSDSSDSSDSSDSSo',
      'oSDSSDSSDSSDSSDo',
      '.oooooooooooooo.',
    ],
    pal: { o: '#1f1612', W: '#7a5232', R: '#c8c0b0', S: '#8a8a96', L: '#b0b0bc', D: '#5a5a66', B: '#2f5f7a', b: '#6fb0d0' },
  },
  anvil: {
    rows: [
      '.oooooooooo.',
      'oLLLLLLLLLLo',
      'oMMMMMMMMMDo',
      '.ooMMMMMDoo.',
      '...oMMMDo...',
      '...oMMMDo...',
      '..oMMMMMDo..',
      '.oooooooooo.',
      '.oWWWWWWWWo.',
      '.oWWWWWWWWo.',
      '.oooooooooo.',
    ],
    pal: { o: '#15151a', L: '#c8ccd8', M: '#6b7280', D: '#3a3f4a', W: '#6b4424' },
  },
  altar: {
    rows: [
      '.....oooooo.....',
      '....oPPPPPPo....',
      '....oPWWWWPo....',
      '....oPPPPPPo....',
      '..oooooooooooo..',
      '..oLLLLLLLLLLo..',
      '.oSSSSSSSSSSSSo.',
      '.oSLLLLLLLLLLSo.',
      '.oSLRRRRRRRRLSo.',
      '.oSLLLLLLLLLLSo.',
      'oSSSSSSSSSSSSSSo',
      'oDDDDDDDDDDDDDDo',
      '.oooooooooooooo.',
    ],
    pal: { o: '#1a1420', P: '#a070e0', W: '#f0e0ff', L: '#c8c0d0', S: '#8a8296', D: '#4a4458', R: '#c03050' },
  },
  fountain: {
    rows: [
      '.......oo.......',
      '......oBBo......',
      '......obBo......',
      '.......oo.......',
      '......oSSo......',
      '..oooooSSooooo..',
      '.oSSSSSSSSSSSSo.',
      'oSBBBBBBBBBBBBSo',
      'oSBbBBBBBBBbBBSo',
      'oSBBBBBbBBBBBBSo',
      'oSSSSSSSSSSSSSSo',
      'oDDDDDDDDDDDDDDo',
      '.oooooooooooooo.',
    ],
    pal: { o: '#151a22', S: '#a8b0c0', D: '#5a6272', B: '#3a8ac8', b: '#bff0ff' },
  },
  crystal: {
    rows: [
      '.....o......',
      '....oWo.....',
      '....oWCo..o.',
      '...oWCCo.oWo',
      '...oWCCCooCo',
      '.o.oWCCCDoCo',
      'oWooWCCCDoCo',
      'oCCoWCCCDoDo',
      'oCDoWCCDDoDo',
      '.ooooooooooo',
    ],
    pal: { o: '#102030', W: '#e8fbff', C: '#7fd8f0', D: '#3a8aa8' },
  },
  lava_vent: {
    rows: [
      '...oo..oo...',
      '..oRYo.oRo..',
      '.ooRRooYRo..',
      'oSSRYRRRRSSo',
      'oSDDRRRRDDSo',
      '.oSSDDDDSSo.',
      '..oooooooo..',
    ],
    pal: { o: '#1a0c08', R: '#e05020', Y: '#ffd050', S: '#5a4440', D: '#3a2a26' },
  },
  grave: {
    rows: [
      '...oooooo...',
      '..oLLLLLLo..',
      '.oLMMMMMMDo.',
      '.oLMDDDDMDo.',
      '.oLMMDMMMDo.',
      '.oLMMDMMMDo.',
      '.oLMMMMMMDo.',
      '.oLMMMMMMDo.',
      'oGGGGGGGGGGo',
      '.oooooooooo.',
    ],
    pal: { o: '#151218', L: '#b8b0c0', M: '#7a7488', D: '#4a4458', G: '#3f5a34' },
  },
  cobweb: {
    rows: [
      'W.....W.....',
      '.W...W.W....',
      '..WWWWWWW...',
      '..W.W.W.W...',
      'WWWWWWWWWWW.',
      '..W.W.W.W...',
      '..WWWWWWW...',
      '.W...W.W....',
      'W.....W.....',
    ],
    pal: { W: 'rgba(220,220,235,0.55)' },
  },
  bones: {
    rows: [
      '..o.....o...',
      '.oWo...oWoo.',
      '..oWWoWWWWo.',
      '...oWWWo....',
      '.ooWWoWWo...',
      'oWWo...oWWo.',
      '.oo.....oo..',
    ],
    pal: { o: '#2a2420', W: '#e8e0d0' },
  },
  lamp: {
    rows: [
      '..oooo..',
      '.oYYYYo.',
      '.oYWWYo.',
      '.oYYYYo.',
      '..oooo..',
      '...oo...',
      '...oo...',
      '...oo...',
      '...oo...',
      '...oo...',
      '...oo...',
      '..oooo..',
      '.oooooo.',
    ],
    pal: { o: '#2a2a33', Y: '#ffd070', W: '#fff6d0' },
  },
  sign: {
    rows: [
      'oooooooooooo',
      'oWWWWWWWWWWo',
      'oWDDWWDDDWWo',
      'oWWWWWWWWWWo',
      'oWDDDWWDDWWo',
      'oooooooooooo',
      '.....oo.....',
      '.....oo.....',
      '.....oo.....',
      '....oooo....',
    ],
    pal: { o: '#3a2414', W: '#c89a62', D: '#6b4424' },
  },
  bench: {
    rows: [
      'oooooooooooooooo',
      'oWWWWWWWWWWWWWWo',
      'oDDDDDDDDDDDDDDo',
      'oWWWWWWWWWWWWWWo',
      'oooooooooooooooo',
      '.oo..........oo.',
      '.oo..........oo.',
    ],
    pal: { o: '#2a1a10', W: '#b07a44', D: '#7a5028' },
  },
  fence_h: {
    rows: [
      '.oo....oo....oo.',
      'oWWooooWWooooWWo',
      'oWWWWWWWWWWWWWWo',
      'oWWooooWWooooWWo',
      'oWWWWWWWWWWWWWWo',
      'oWWooooWWooooWWo',
      'oDDo..oDDo..oDDo',
      '.oo....oo....oo.',
    ],
    pal: { o: '#2a1a10', W: '#b98a50', D: '#7a5028' },
  },
  fence_v: {
    rows: [
      '.oo.',
      'oWWo',
      'oWWo',
      'oWWo',
      'oWWo',
      'oWWo',
      'oWWo',
      'oWWo',
      'oWWo',
      'oWWo',
      'oWWo',
      'oWWo',
      'oWWo',
      'oWWo',
      'oDDo',
      '.oo.',
    ],
    pal: { o: '#2a1a10', W: '#b98a50', D: '#7a5028' },
  },
  spike_trap: {
    rows: [
      'oooooooooooooooo',
      'oDDDDDDDDDDDDDDo',
      'oDWoDDWoDDWoDDDo',
      'oDDDDDDDDDDDDDDo',
      'oDDWoDDWoDDWoDDo',
      'oDDDDDDDDDDDDDDo',
      'oooooooooooooooo',
    ],
    pal: { o: '#151218', D: '#4a4052', W: '#c8c8d8' },
  },
};

export function buildProcAssets(scene: Phaser.Scene): void {
  for (const [type, rows] of Object.entries(ARMOR)) {
    const [l, m, d] = ARMOR_BASE[type];
    for (let r = 0; r < 5; r++) {
      artTexture(scene, `armor_${type}_${r}`, rows, { o: '#15121a', L: l, M: m, D: d, R: RARITY_HEX[r] });
    }
  }
  for (const [type, rows] of Object.entries(TRINKET)) {
    for (let r = 0; r < 5; r++) {
      artTexture(scene, `trinket_${type}_${r}`, rows, {
        o: '#15121a', G: '#f0c96b', D: '#a07a2a', M: '#5a6272', W: '#ffffff', R: RARITY_HEX[r],
      });
    }
  }
  for (const [k, v] of Object.entries(SHIELDS)) artTexture(scene, k, v.rows, v.pal);
  for (const [k, v] of Object.entries(DECOR_ART)) artTexture(scene, `deco_${k}`, v.rows, v.pal);
  // 稀有度掉落光柱（竖向渐隐条）
  for (let r = 0; r < 5; r++) {
    const key = `beam_${r}`;
    if (scene.textures.exists(key)) continue;
    const t = scene.textures.createCanvas(key, 6, 40)!;
    const c = t.getContext();
    for (let y = 0; y < 40; y++) {
      const a = (y / 40) ** 1.6;
      c.fillStyle = hexA(RARITY_HEX[r], a * 0.85);
      c.fillRect(1, y, 4, 1);
      c.fillStyle = hexA('#ffffff', a * 0.6);
      c.fillRect(2, y, 2, 1);
    }
    t.refresh();
  }
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`;
}

export const RARITY_DARK_HEX = RARITY_DARK;
export const DECOR_ART_KEYS = Object.keys(DECOR_ART);
