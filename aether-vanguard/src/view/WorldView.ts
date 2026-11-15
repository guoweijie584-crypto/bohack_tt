// 世界渲染：地面瓦片层（受光）、2.5D 墙块（墙顶上移一格 + 南向砖面，按脚底 y 排序）、
// 装饰（0x72 / NA 城镇 / 程序化，三类统一映射）、火把与发光装饰的点光源、迷雾（已探索 + 当前可见双掩码）。

import * as Phaser from 'phaser';
import { DEPTH, TILE } from '../config';
import { T } from '../data/tiles';
import { hash2 } from '../core/rng';
import type { Decor } from '../game/types';
import { G } from '../game/state';
import { spikesUp } from '../game/world';
import { decorFootprint } from '../world/decor';
import type { GridMap } from '../world/grid';
import { ART, DT, WALL_FACES, hasDtFrame } from './assets';
import { TOWN_PROPS, townPropTexture } from './assets_na';
import { themeOf, type ThemeDef } from './theme';

interface LightRef { light: Phaser.GameObjects.Light; base: number; seed: number; flicker: boolean }

/** 装饰外观描述：tex/frame 或动画；origin 默认底边中点；sort=true 参与 y 排序 */
interface DecorLook {
  tex: string;
  frame?: string | number;
  anim?: string;
  scale?: number;
  sort?: boolean;
  /** 发光：颜色、半径、强度、是否闪烁 */
  light?: [number, number, number, boolean];
  /** 额外加色光晕 */
  glow?: number;
  /** y 偏移（世界单位） */
  dy?: number;
}

/** 装饰 kind → 外观（含变体 v 的随机选择）；未知 kind 返回 null 并只告警一次 */
function lookFor(d: Decor): DecorLook | null {
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(hash2(d.x * 0.37, d.y * 0.73) * arr.length) % arr.length];
  const prop = (name: string): DecorLook | null => (TOWN_PROPS[name] ? { tex: townPropTexture(name)!, frame: name, sort: true } : null);
  switch (d.kind) {
    case 'torch': case 'brazier': return { tex: 'torch', sort: true, light: [210, 0xffa040, 1.5, true], glow: 0xffa040 };
    case 'rune': return { tex: 'ring', scale: 0.22, sort: false, glow: 0xc9a2f0 };
    case 'rubble': return { tex: 'pt_rock_gray', frame: Math.floor(hash2(d.x, d.y) * 5), sort: false };
    case 'warehouse': return prop('house_beige');
    case 'crate': return { tex: DT, frame: 'crate', sort: true };
    case 'barrel': return prop('barrel_town');
    case 'skull': return { tex: DT, frame: 'skull', sort: false };
    case 'bones': return { tex: 'deco_bones', sort: false };
    case 'column': case 'pillar': return { tex: DT, frame: 'column', sort: true };
    case 'spikes': return { tex: DT, frame: 'floor_spikes_anim_f0', anim: 'floor_spikes', sort: false };
    case 'crystal': return { tex: 'deco_crystal', sort: true, light: [150, 0x7fd8f0, 1.2, false], glow: 0x7fd8f0 };
    case 'lava_vent': return { tex: 'deco_lava_vent', sort: false, light: [170, 0xff7030, 1.4, true], glow: 0xff6020 };
    case 'grave': return { tex: 'deco_grave', sort: true };
    case 'cobweb': return { tex: 'deco_cobweb', sort: false };
    case 'fountain': return { tex: 'deco_fountain', scale: 2, sort: true, light: [160, 0x6fc8ff, 1.0, false], glow: 0x6fc8ff };
    case 'altar': return { tex: 'deco_altar', scale: 2, sort: true, light: [150, 0xb080ff, 1.1, true], glow: 0xb080ff };
    case 'well': return { tex: 'deco_well', scale: 2, sort: true, light: [140, 0x8fe0ff, 0.7, false] };
    case 'anvil': return { tex: 'deco_anvil', sort: true };
    case 'lamp': return { tex: 'deco_lamp', sort: true, light: [190, 0xffd080, 1.1, true], glow: 0xffc860 };
    case 'sign': return { tex: 'deco_sign', sort: true };
    case 'bench': return { tex: 'deco_bench', scale: 2, sort: true };
    case 'fence_h': return { tex: 'deco_fence_h', sort: true };
    case 'fence_v': return { tex: 'deco_fence_v', sort: true };
    case 'stall': return prop(pick(['stall_a', 'stall_b']));
    case 'goods': return prop('goods');
    case 'pots': return prop('pots');
    case 'statue': return { ...prop('statue_orb')!, light: [140, 0x8fd8ff, 0.9, false] };
    case 'statue_lion': return prop('statue_lion');
    case 'statue_frog': return prop('statue_frog');
    case 'tree': return prop(pick(['tree_round', 'tree_round2', 'tree_pine', 'tree_round', 'tree_pink']));
    case 'tree_big': return prop(pick(['tree_big_green', 'tree_big_pink', 'tree_big_orange', 'trees_green']));
    case 'trees': return prop(pick(['trees_pine', 'trees_green', 'trees_pink']));
    case 'bush': return prop(pick(['bush_a', 'bush_b', 'bush_berry']));
    case 'flowers': return { ...prop(pick(['flower_a', 'flower_b']))!, sort: false };
    case 'rocks': return prop('rocks');
    case 'stump': return prop('stump');
    case 'banner': return prop(pick(['banner_a', 'banner_b', 'banner_c']));
    // 建筑精灵宽度与 world/decor.ts 脚印一致：house_a/warehouse/hall/library/temple 4 格，house_b/商铺 3 格
    case 'house_a': return prop((d.v ?? 0) % 2 ? 'house_orange2' : 'house_orange');
    case 'house_b': return prop((d.v ?? 0) % 2 ? 'hut' : 'house_wood');
    case 'house': return prop(pick(['house_orange', 'house_orange2', 'house_beige', 'house_wood', 'hut']));
    case 'shop_potion': return prop('shop_sign');
    case 'shop_smith': return { ...prop('kiln')!, light: [150, 0xff9040, 1.1, true] };
    case 'hall': return prop('hall_green');
    case 'temple': return prop('shrine');
    case 'library': return prop('cabin');
    case 'manor': return prop('manor');
    case 'arena_gate': return prop('arch');
    case 'arch': return prop('arch');
    case 'watchtower': return prop('watchtower');
    case 'stash': case 'chest_static': return { tex: DT, frame: 'chest_full_open_anim_f0', sort: true };
    default: return null;
  }
}

const warned = new Set<string>();

export class WorldView {
  map: GridMap | null = null;
  theme: ThemeDef = themeOf('city');
  private objs: Phaser.GameObjects.GameObject[] = [];
  private tilemap?: Phaser.Tilemaps.Tilemap;
  private layer?: Phaser.Tilemaps.TilemapLayer;
  private fogTex?: Phaser.Textures.CanvasTexture;
  private fogImg?: Phaser.GameObjects.Image;
  private fogData?: ImageData;
  private lights: LightRef[] = [];
  /** 可破坏装饰的视图（按 decor id），破坏后移除 */
  readonly decorViews = new Map<number, Phaser.GameObjects.GameObject[]>();
  private decorRefs = new Map<number, Decor>();
  private themeId = 'city';
  private fogDirty = true;
  private lastFogHash = -1;
  /** 地刺：帧与伤害判定同步（world.spikesUp） */
  private spikes: Array<{ d: Decor; s: Phaser.GameObjects.Image; up: boolean }> = [];
  /** 水面格（波纹动画：两帧交替） */
  private waterTiles: Array<[number, number]> = [];
  private waterFrame = 0;
  /** 一次性交互装饰（补给泉/祭坛）：用过后（v=1）熄灭 */
  private usable: Array<{ d: Decor; light?: LightRef; glow?: Phaser.GameObjects.Image; dimmed: boolean }> = [];
  private syncTick = 0;

  constructor(private readonly scene: Phaser.Scene) {}

  build(map: GridMap, themeId: string, decor: readonly Decor[]): void {
    this.clear();
    this.map = map;
    this.themeId = themeId;
    this.theme = themeOf(themeId);
    const th = this.theme;
    // ---- 地面 ----
    const data: number[][] = [];
    for (let y = 0; y < map.h; y++) {
      const row: number[] = [];
      for (let x = 0; x < map.w; x++) row.push(this.floorIndex(map, x, y, themeId));
      data.push(row);
    }
    this.tilemap = this.scene.make.tilemap({ data, tileWidth: 16, tileHeight: 16 });
    const ts = this.tilemap.addTilesetImage('floors')!;
    const layer = this.tilemap.createLayer(0, ts, 0, 0) as Phaser.Tilemaps.TilemapLayer;
    this.layer = layer;
    this.waterTiles = [];
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) if (map.get(x, y) === T.WATER) this.waterTiles.push([x, y]);
    layer.setScale(ART).setDepth(DEPTH.floor).setLighting(true);
    if (th.tint !== 0xffffff) layer.setTint(th.tint);
    // ---- 墙体（贴地实心格）----
    const isWall = (x: number, y: number): boolean => {
      const t = map.get(x, y);
      return t === T.WALL || t === T.VOID;
    };
    const walk = (x: number, y: number): boolean => map.inBounds(x, y) && !isWall(x, y) && map.get(x, y) !== T.BLOCK;
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        if (!isWall(x, y)) continue;
        let boundary = false;
        for (let oy = -1; oy <= 1 && !boundary; oy++) for (let ox = -1; ox <= 1; ox++) if (walk(x + ox, y + oy)) { boundary = true; break; }
        if (!boundary) continue;
        const mask = (walk(x, y - 1) ? 1 : 0) | (walk(x + 1, y) ? 2 : 0) | (walk(x, y + 1) ? 4 : 0) | (walk(x - 1, y) ? 8 : 0);
        const face = (mask & 4) !== 0;
        if (face) {
          const r = hash2(x * 1.7, y * 2.3);
          const v = r < 0.12 ? 4 + Math.floor(r / 0.12 * (WALL_FACES.length - 4)) : 0;
          const img = this.scene.add.image(x * TILE, (y + 1) * TILE, 'walls', `w${mask}_${Math.min(v, WALL_FACES.length - 1)}`)
            .setOrigin(0, 1).setScale(ART).setLighting(true).setDepth(DEPTH.sorted + (y + 1) * TILE);
          if (th.tint !== 0xffffff) img.setTint(th.tint);
          this.objs.push(img);
          // 墙脚硬阴影带（改版文档：硬影，无模糊）
          const sh = this.scene.add.rectangle(x * TILE, (y + 1) * TILE, TILE, 6, 0x000000, 0.28).setOrigin(0, 0).setDepth(DEPTH.floorDecal);
          this.objs.push(sh);
        } else {
          const img = this.scene.add.image(x * TILE, y * TILE, 'walls', `w${mask}_0`)
            .setOrigin(0, 0).setCrop(0, 0, 16, 16).setScale(ART).setLighting(true).setDepth(DEPTH.floor + 1);
          if (th.tint !== 0xffffff) img.setTint(th.tint);
          this.objs.push(img);
        }
      }
    }
    // ---- 装饰 ----
    for (const d of decor) this.addDecor(d);
    // ---- 迷雾 ----
    if (map.fog) this.buildFog(map);
    this.fogDirty = true;
  }

  /** 地砖索引（floors 贴图帧号） */
  private floorIndex(map: GridMap, x: number, y: number, themeId: string): number {
    const t = map.get(x, y);
    if (t === T.BLOCK) {
      // 阻挡装饰的脚印格：按 8 邻格中最常见的地面类型取帧（否则柱子/木箱下面是虚空黑块、路灯下面是一块草地）
      const counts = new Map<number, number>();
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        const t2 = map.get(x + ox, y + oy);
        if (t2 === T.BLOCK || t2 === T.WALL || t2 === T.VOID || t2 === T.WATER || t2 === T.LAVA || t2 === T.PIT) continue;
        counts.set(t2, (counts.get(t2) ?? 0) + 1);
      }
      let best: number = themeId === 'city' ? T.CITY : T.FLOOR, bn = 0;
      for (const [t2, n] of counts) if (n > bn) { best = t2; bn = n; }
      return this.indexForType(best, x, y, themeId);
    }
    return this.indexForType(t, x, y, themeId);
  }

  private indexForType(t: number, x: number, y: number, themeId: string): number {
    const h = hash2(x, y);
    switch (t) {
      case T.FLOOR: case T.DECO: return h < 0.62 ? 0 : 1 + Math.floor(((h - 0.62) / 0.38) * 7);
      case T.RUIN: return 13;
      case T.CITY: return 9;
      case T.GRASS: return h < 0.55 ? 17 : 18 + Math.floor(((h - 0.55) / 0.45) * 4);
      case T.WATER: return 11;
      case T.LAVA: return 12;
      case T.EXIT: return 14;
      case T.PATH: return h < 0.6 ? 22 : 23 + Math.floor(((h - 0.6) / 0.4) * 4);
      case T.BRIDGE: return 16;
      case T.BLOCK: return themeId === 'city' ? 9 : 0;
      default: return 8;
    }
  }

  addDecor(d: Decor): void {
    const look = lookFor(d);
    if (!look) {
      if (!warned.has(d.kind)) { warned.add(d.kind); console.warn('[WorldView] 未映射的装饰 kind:', d.kind); }
      return;
    }
    const objs: Phaser.GameObjects.GameObject[] = [];
    const x = d.x, y = d.y + (look.dy ?? 0);
    const scale = ART * (look.scale ?? 1);
    let main: Phaser.GameObjects.Sprite | Phaser.GameObjects.Image;
    if (d.kind === 'spikes') {
      const s = this.scene.add.image(x, y, DT, 'floor_spikes_anim_f0').setOrigin(0.5, 1).setScale(scale).setLighting(true).setDepth(DEPTH.floorDecal + 1);
      this.spikes.push({ d, s, up: false });
      this.objs.push(s);
      return;
    }
    if (look.anim) {
      const s = this.scene.add.sprite(x, y, look.tex, look.frame).setOrigin(0.5, 1).setScale(scale).setLighting(true);
      s.play({ key: look.anim, startFrame: Math.floor(hash2(x, y) * 3) });
      main = s;
    } else {
      main = this.scene.add.image(x, y, look.tex, look.frame).setOrigin(0.5, 1).setScale(scale).setLighting(true);
    }
    main.setDepth(look.sort === false ? DEPTH.floorDecal + 1 : DEPTH.sorted + y);
    objs.push(main);
    if (d.kind === 'torch') {
      const fl = this.scene.add.sprite(x, y - 18, 'flame', 'fl0').setOrigin(0.5, 1).setScale(ART).setDepth(main.depth + 0.5);
      fl.play({ key: 'flame', startFrame: Math.floor(hash2(x, y) * 4) });
      objs.push(fl);
    }
    let glowImg: Phaser.GameObjects.Image | undefined;
    if (look.glow !== undefined) {
      const g = this.scene.add.image(x, y - (d.kind === 'torch' ? 26 : 14), 'glow')
        .setScale(d.kind === 'torch' ? 0.75 : 1.0).setBlendMode(Phaser.BlendModes.ADD).setTint(look.glow).setAlpha(0.3)
        .setDepth(DEPTH.overFx - 5);
      objs.push(g);
      glowImg = g;
      this.scene.tweens.add({ targets: g, alpha: { from: 0.22, to: 0.38 }, duration: 600 + hash2(x, y) * 500, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    }
    const light = d.light ? [d.light.radius, d.light.color, d.light.intensity, d.light.flicker] as const : look.light;
    let ref: LightRef | undefined;
    if (light) {
      const [radius, color, intensity, flicker] = light;
      const L = this.scene.lights.addLight(x, y - 12, radius, color, intensity);
      ref = { light: L, base: intensity, seed: hash2(x * 3.1, y * 1.3) * 100, flicker };
      this.lights.push(ref);
    }
    if (d.kind === 'fountain' || d.kind === 'altar') this.usable.push({ d, light: ref, glow: glowImg, dimmed: false });
    this.objs.push(...objs);
    if (d.breakable) { this.decorViews.set(d.id, objs); this.decorRefs.set(d.id, d); }
  }

  /** 可破坏装饰被打碎时调用：移除精灵并刷新脚印处的地砖（world 已把 BLOCK 改回 FLOOR） */
  removeDecor(id: number): void {
    const objs = this.decorViews.get(id);
    if (!objs) return;
    for (const o of objs) o.destroy();
    this.decorViews.delete(id);
    const d = this.decorRefs.get(id);
    this.decorRefs.delete(id);
    const map = this.map, layer = this.layer;
    if (!d || !map || !layer) return;
    const fp = decorFootprint(d);
    for (let y = fp.ty; y < fp.ty + fp.h; y++) for (let x = fp.tx; x < fp.tx + fp.w; x++) {
      const tile = layer.getTileAt(x, y);
      if (tile) tile.index = this.floorIndex(map, x, y, this.themeId);
    }
  }

  private buildFog(map: GridMap): void {
    const key = 'fog_mask';
    if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
    this.fogTex = this.scene.textures.createCanvas(key, map.w, map.h)!;
    this.fogTex.setSmoothPixelArt(false);
    this.fogTex.setFilter(Phaser.Textures.FilterMode.LINEAR);
    this.fogData = this.fogTex.getContext().createImageData(map.w, map.h);
    this.fogImg = this.scene.add.image(0, 0, key).setOrigin(0, 0).setScale(TILE).setDepth(DEPTH.overFx + 50);
    this.objs.push(this.fogImg);
  }

  /** 每帧：迷雾刷新（掩码变化时）、光源闪烁、地刺/可破坏物/一次性装饰同步 */
  update(time: number): void {
    // 水面波纹：每 0.45s 两帧交替（逐格错相，避免整片同步闪）
    const wf = Math.floor(time / 450) % 2;
    if (wf !== this.waterFrame && this.layer && this.waterTiles.length) {
      this.waterFrame = wf;
      for (const [x, y] of this.waterTiles) {
        const tile = this.layer.getTileAt(x, y);
        if (tile) tile.index = ((x + y + wf) % 2) ? 27 : 11; // 改 index 而不是 putTileAt，保留主题色调
      }
    }
    for (const sp of this.spikes) {
      const up = spikesUp(sp.d);
      if (up !== sp.up) { sp.up = up; sp.s.setFrame(up ? 'floor_spikes_anim_f3' : 'floor_spikes_anim_f0'); }
    }
    for (const u of this.usable) {
      if (!u.dimmed && u.d.v === 1) {
        u.dimmed = true;
        if (u.light) { u.light.base *= 0.25; u.light.light.intensity = u.light.base; u.light.flicker = false; }
        if (u.glow) { this.scene.tweens.killTweensOf(u.glow); u.glow.setAlpha(0.06); }
      }
    }
    if (++this.syncTick % 6 === 0 && this.decorViews.size) {
      const alive = new Set(G.decor.map(d => d.id));
      for (const id of [...this.decorViews.keys()]) if (!alive.has(id)) this.removeDecor(id);
    }
    for (const l of this.lights) {
      if (!l.flicker) continue;
      const t = time * 0.001 + l.seed;
      l.light.intensity = l.base * (0.86 + 0.1 * Math.sin(t * 9.1) + 0.06 * Math.sin(t * 23.7));
    }
    const map = this.map;
    if (!map || !map.fog || !this.fogTex || !this.fogData) return;
    // 简单哈希判断掩码是否变化（visible 的和 + 已探索计数）
    let hsh = 0;
    for (let i = 0; i < map.visible.length; i += 1) hsh = (hsh * 31 + map.visible[i] * 7 + map.explored[i]) | 0;
    if (!this.fogDirty && hsh === this.lastFogHash) return;
    this.lastFogHash = hsh;
    this.fogDirty = false;
    const d = this.fogData.data;
    const fog = Phaser.Display.Color.HexStringToColor(this.theme.fog);
    for (let i = 0; i < map.visible.length; i++) {
      const a = map.visible[i] ? 0 : map.explored[i] ? 150 : 255;
      d[i * 4] = fog.red; d[i * 4 + 1] = fog.green; d[i * 4 + 2] = fog.blue; d[i * 4 + 3] = a;
    }
    this.fogTex.getContext().putImageData(this.fogData, 0, 0);
    this.fogTex.refresh();
  }

  clear(): void {
    for (const o of this.objs) o.destroy();
    this.objs = [];
    for (const l of this.lights) this.scene.lights.removeLight(l.light);
    this.lights = [];
    this.decorViews.clear();
    this.decorRefs.clear();
    this.spikes = [];
    this.usable = [];
    this.waterTiles = [];
    this.layer?.destroy();
    this.tilemap?.destroy();
    this.layer = undefined;
    this.tilemap = undefined;
    this.fogTex = undefined;
    this.fogImg = undefined;
    this.fogData = undefined;
    this.map = null;
  }

  /** 供调试：检查帧是否存在 */
  static frameOk(name: string): boolean { return hasDtFrame(name); }
}
