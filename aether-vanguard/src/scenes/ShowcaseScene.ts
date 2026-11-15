// 开发用素材展示场景（?showcase）：验证墙体合成、地砖、职业皮肤、怪物动画、光照与辉光。
import * as Phaser from 'phaser';
import { ART, DT, PLAIN_HEROES, SKINS, preloadAssets, registerAssets, skinKey } from '../view/assets';

const MONSTERS = ['tiny_zombie', 'goblin', 'imp', 'skelet', 'masked_orc', 'orc_warrior', 'orc_shaman', 'wogol', 'chort', 'pumpkin_dude', 'doc', 'angel'];
const BIG = ['big_zombie', 'ogre', 'big_demon'];
const STATIC = ['muddy', 'swampy', 'zombie', 'ice_zombie', 'necromancer', 'slug', 'tiny_slug'];

export class ShowcaseScene extends Phaser.Scene {
  constructor() { super('showcase'); }
  preload(): void { preloadAssets(this); }
  create(): void {
    registerAssets(this);
    const W = 34, H = 22;
    const solid = (x: number, y: number): boolean => x < 1 || y < 3 || x >= W - 1 || y >= H - 1 || (x >= 14 && x <= 16 && y >= 8 && y <= 12) || (y === 15 && x > 4 && x < 12);
    const data: number[][] = [];
    for (let y = 0; y < H; y++) {
      const row: number[] = [];
      for (let x = 0; x < W; x++) row.push(solid(x, y) ? 8 : ((x * 7 + y * 13) % 17 < 12 ? 0 : 1 + ((x * 3 + y * 5) % 7)));
      data.push(row);
    }
    const map = this.make.tilemap({ data, tileWidth: 16, tileHeight: 16 });
    const ts = map.addTilesetImage('floors')!;
    const layer = map.createLayer(0, ts, 0, 0)!.setScale(ART).setLighting(true);
    void layer;
    const walk = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H && !solid(x, y);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!solid(x, y)) continue;
      let boundary = false;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) if (walk(x + ox, y + oy)) boundary = true;
      if (!boundary) continue;
      const mask = (walk(x, y - 1) ? 1 : 0) | (walk(x + 1, y) ? 2 : 0) | (walk(x, y + 1) ? 4 : 0) | (walk(x - 1, y) ? 8 : 0);
      const face = (mask & 4) !== 0;
      const v = face ? ((x * 31 + y * 17) % 9 === 0 ? 4 + ((x + y) % 7) : 0) : 0;
      if (face) {
        this.add.image(x * 32, (y + 1) * 32, 'walls', `w${mask}_${v}`).setOrigin(0, 1).setScale(ART).setLighting(true).setDepth(100 + (y + 1) * 32);
      } else {
        this.add.image(x * 32, y * 32, 'walls', `w${mask}_0`).setOrigin(0, 0).setCrop(0, 0, 16, 16).setScale(ART).setLighting(true).setDepth(50);
      }
    }
    // 职业皮肤
    const ids = Object.keys(SKINS);
    ids.forEach((id, i) => {
      const x = 64 + i * 40, y = 4 * 32 + 40;
      this.add.image(x, y, 'shadow').setScale(ART).setAlpha(0.45).setDepth(90);
      const s = this.add.sprite(x, y + 2, skinKey(id), 'idle_0').setOrigin(0.5, 1).setScale(ART).setDepth(100 + y).setLighting(true);
      s.play(i % 2 ? `${skinKey(id)}_run` : `${skinKey(id)}_idle`);
      this.add.text(x, y + 8, id, { fontSize: '9px', color: '#fff' }).setOrigin(0.5, 0).setDepth(9999);
    });
    PLAIN_HEROES.forEach((h, i) => {
      const x = 64 + i * 40, y = 6 * 32 + 40;
      this.add.sprite(x, y, skinKey(h), 'idle_0').setOrigin(0.5, 1).setScale(ART).setDepth(100 + y).setLighting(true).play(`${skinKey(h)}_idle`);
    });
    MONSTERS.forEach((m, i) => {
      const x = 64 + i * 36, y = 13 * 32 + 30;
      this.add.sprite(x, y, DT, `${m}_idle_anim_f0`).setOrigin(0.5, 1).setScale(ART).setDepth(100 + y).setLighting(true).play(`${m}_run`);
    });
    STATIC.forEach((m, i) => {
      const x = 64 + i * 36, y = 17 * 32 + 30;
      this.add.sprite(x, y, DT, `${m}_anim_f0`).setOrigin(0.5, 1).setScale(ART).setDepth(100 + y).setLighting(true).play(m);
    });
    BIG.forEach((m, i) => {
      const x = 22 * 32 + i * 80, y = 18 * 32 + 30;
      this.add.sprite(x, y, DT, `${m}_idle_anim_f0`).setOrigin(0.5, 1).setScale(ART).setDepth(100 + y).setLighting(true).play(`${m}_idle`);
    });
    // 道具
    ['flask_big_red', 'flask_big_blue', 'flask_big_green', 'skull', 'crate', 'weapon_knight_sword', 'weapon_red_magic_staff', 'weapon_bow', 'weapon_knife', 'weapon_spear', 'weapon_golden_sword'].forEach((f, i) => {
      const x = 19 * 32 + (i % 6) * 34, y = 5 * 32 + Math.floor(i / 6) * 50;
      this.add.image(x, y, DT, f).setOrigin(0.5, 1).setScale(ART).setDepth(100 + y).setLighting(true);
    });
    this.add.sprite(26 * 32, 9 * 32, DT, 'chest_full_open_anim_f0').setScale(ART).setDepth(100 + 9 * 32).play('chest_full_open');
    // NA 怪物（4 向）
    ['na_eye', 'na_flam', 'na_spider_red', 'na_spirit', 'na_skull', 'na_slime'].forEach((k, i) => {
      ['d', 'l', 'r'].forEach((d, j) => {
        this.add.sprite(64 + i * 40, 9 * 32 + 30 + j * 0, k, 0).setScale(ART).setOrigin(0.5, 1).setDepth(500).setX(64 + i * 120 + j * 34).play(`${k}_${d}`);
      });
    });
    // NA 特效循环
    ['fx_slash_arc', 'fx_explosion', 'fx_ice', 'fx_thunder', 'fx_flam', 'fx_circle_spark', 'fx_smoke', 'fx_cut_double'].forEach((k, i) => {
      const s = this.add.sprite(64 + i * 70, 11 * 32 + 10, k, 0).setScale(ART).setDepth(600).setBlendMode(Phaser.BlendModes.ADD);
      s.play({ key: k, repeat: -1 });
    });
    // 城镇建筑
    ['house_orange', 'shop_sign', 'kiln', 'hall_green', 'shrine', 'cabin'].forEach((k, i) => {
      const tex = ['shrine'].includes(k) ? 'na_house' : 'na_house';
      this.add.image(19 * 32 + (i % 3) * 140, 13 * 32 + Math.floor(i / 3) * 170, tex, k).setOrigin(0.5, 1).setScale(ART).setDepth(700).setLighting(true);
    });
    // 程序化装备图标、盾、装饰
    ['armor_plate_0', 'armor_plate_4', 'armor_robe_2', 'armor_leather_3', 'trinket_ring_1', 'trinket_amulet_4', 'trinket_chip_2', 'shield_round', 'shield_kite', 'shield_storm', 'mat_gem', 'mat_part', 'mat_essence', 'expgem',
      'deco_well', 'deco_anvil', 'deco_altar', 'deco_fountain', 'deco_crystal', 'deco_lava_vent', 'deco_grave', 'deco_lamp', 'deco_sign', 'deco_bench', 'deco_fence_h'].forEach((k, i) => {
      this.add.image(64 + (i % 14) * 40, 20 * 32 + Math.floor(i / 14) * 40, k).setOrigin(0.5, 1).setScale(ART).setDepth(800);
    });
    this.add.bitmapText(9 * 32, 19 * 32, 'font_dmg', '1234 +56 !', 9).setScale(3).setTint(0xffd070).setDepth(900);
    this.add.sprite(28 * 32, 9 * 32, DT, 'coin_anim_f0').setScale(ART).setDepth(100 + 9 * 32).play('coin');
    // 光照：环境暗 + 火把
    this.lights.enable().setAmbientColor(0x4a4458);
    const torches = [[6, 3], [12, 3], [20, 3], [27, 3], [8, 16]];
    for (const [tx, ty] of torches) {
      const x = tx * 32 + 16, y = ty * 32 + 14;
      this.add.image(x, y + 6, 'torch').setScale(ART).setDepth(100 + (ty + 1) * 32 + 1);
      this.add.sprite(x, y - 6, 'flame', 'fl0').setScale(ART).setDepth(100 + (ty + 1) * 32 + 2).play('flame');
      this.add.image(x, y - 6, 'glow').setScale(0.9).setBlendMode(Phaser.BlendModes.ADD).setTint(0xffa040).setAlpha(0.5).setDepth(100000);
      this.lights.addLight(x, y + 20, 200, 0xffb060, 1.6);
    }
    this.lights.addLight(9 * 32, 9 * 32, 260, 0xfff0d0, 1.2);
    const cam = this.cameras.main;
    cam.setZoom(Math.min(this.scale.width / (W * 32), this.scale.height / (H * 32)));
    cam.centerOn((W * 32) / 2, (H * 32) / 2);
    const pf = cam.filters.internal.addParallelFilters();
    pf.top.addThreshold(0.55, 1);
    pf.top.addBlur(1, 2, 2, 1);
    pf.blend.blendMode = Phaser.BlendModes.ADD;
    pf.blend.amount = 0.5;
    cam.filters.external.addVignette(0.5, 0.5, 0.95, 0.25);
    (window as unknown as { __ready: boolean }).__ready = true;
  }
}
