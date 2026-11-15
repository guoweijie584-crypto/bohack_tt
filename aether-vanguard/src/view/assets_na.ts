// Ninja Adventure（pixel-boy & AAA，CC0）补充素材：特效序列帧、投射物、粒子、怪物（4 向）、城镇建筑与植物。
// 文件来自 jam-ready-assets 镜像，原样放在 public/assets/na/（含 LICENSE.txt）。

import * as Phaser from 'phaser';
import { assetUrl } from '../core/assetUrl';

const NA = 'assets/na/';

/** [key, 路径, 帧宽, 帧高, 帧数, 帧率] —— 帧尺寸已逐张核对 */
export const FX_SHEETS: ReadonlyArray<readonly [string, string, number, number, number, number]> = [
  ['fx_slash_arc', 'FX/Slash/SpriteSheetArc.png', 38, 34, 6, 24],
  ['fx_slash_01', 'FX/Slash/SpriteSheetSlash01.png', 26, 32, 5, 24],
  ['fx_slash_multi', 'FX/Slash/SpriteSheetMulti.png', 30, 30, 9, 24],
  ['fx_slash_curved', 'FX/Attack/SlashCurved/SpriteSheet.png', 32, 32, 4, 20],
  ['fx_slash_double', 'FX/Attack/SlashDoubleCurved/SpriteSheet.png', 32, 32, 4, 20],
  ['fx_cut', 'FX/Attack/Cut/SpriteSheet.png', 32, 32, 4, 22],
  ['fx_cut_double', 'FX/Attack/CutDouble/SpriteSheet.png', 32, 32, 5, 22],
  ['fx_cut_x', 'FX/Attack/CutX/SpriteSheet.png', 32, 32, 4, 20],
  ['fx_claw', 'FX/Attack/Claw/SpriteSheet.png', 32, 32, 4, 20],
  ['fx_claw_double', 'FX/Attack/ClawDouble/SpriteSheet.png', 32, 32, 4, 20],
  ['fx_circular', 'FX/Attack/CircularSlash/SpriteSheet.png', 32, 32, 4, 18],
  ['fx_explosion', 'FX/Elemental/Explosion/SpriteSheet.png', 40, 40, 9, 20],
  ['fx_flam', 'FX/Elemental/Flam/SpriteSheet.png', 25, 30, 8, 16],
  ['fx_ice', 'FX/Elemental/Ice/SpriteSheet.png', 32, 32, 10, 20],
  ['fx_ice_b', 'FX/Elemental/Ice/SpriteSheetB.png', 32, 32, 9, 20],
  ['fx_ice_flake', 'FX/Elemental/Ice/SpriteSheetFlake.png', 32, 32, 9, 18],
  ['fx_thunder', 'FX/Elemental/Thunder/SpriteSheet.png', 20, 28, 8, 22],
  ['fx_rock', 'FX/Elemental/Rock/SpriteSheet.png', 30, 30, 14, 22],
  ['fx_rock_spike', 'FX/Elemental/RockSpike/SpriteSheet.png', 45, 48, 12, 22],
  ['fx_water', 'FX/Elemental/Water/SpriteSheet.png', 40, 33, 11, 20],
  ['fx_plant', 'FX/Elemental/Plant/SpriteSheet.png', 30, 28, 8, 18],
  ['fx_aura', 'FX/Magic/Aura/SpriteSheet.png', 25, 24, 5, 12],
  ['fx_boost', 'FX/Magic/Boost/SpriteSheet.png', 53, 35, 8, 14],
  ['fx_circle_orange', 'FX/Magic/Circle/SpriteSheetOrange.png', 32, 32, 4, 10],
  ['fx_circle_white', 'FX/Magic/Circle/SpriteSheetWhite.png', 32, 32, 4, 10],
  ['fx_circle_spark', 'FX/Magic/Circle/SpriteSheetSpark.png', 32, 32, 6, 12],
  ['fx_circle_spark2', 'FX/Magic/Circle/SpriteSheetSpark2.png', 32, 32, 5, 12],
  ['fx_shield_blue', 'FX/Magic/Shield/SpriteSheetBlue.png', 24, 26, 6, 14],
  ['fx_shield_yellow', 'FX/Magic/Shield/SpriteSheetYellow.png', 24, 26, 6, 14],
  ['fx_spark', 'FX/Magic/Spark/SpriteSheet.png', 45, 35, 6, 14],
  ['fx_spirit', 'FX/Magic/Spirit/SpriteSheet.png', 32, 32, 5, 14],
  ['fx_spirit_blue', 'FX/Magic/Spirit/SpriteSheetBlue.png', 32, 32, 5, 14],
  ['fx_spirit_double', 'FX/Magic/Spirit/SpriteSheetDouble.png', 32, 32, 5, 14],
  ['fx_smoke', 'FX/Smoke/Smoke/SpriteSheet.png', 32, 32, 6, 14],
  ['fx_smoke_ring', 'FX/Smoke/SmokeCircular/SpriteSheet.png', 24, 14, 10, 20],
  // 投射物（循环）
  ['pj_energy', 'FX/Projectile/EnergyBall.png', 16, 16, 4, 12],
  ['pj_big_energy', 'FX/Projectile/BigEnergyBall.png', 24, 24, 4, 12],
  ['pj_fireball', 'FX/Projectile/Fireball.png', 16, 16, 4, 12],
  ['pj_icespike', 'FX/Projectile/IceSpike.png', 18, 10, 8, 14],
  ['pj_shuriken', 'FX/Projectile/Shuriken.png', 16, 16, 2, 16],
  ['pj_shuriken_magic', 'FX/Projectile/ShurikenMagic.png', 16, 16, 2, 16],
  ['pj_canon', 'FX/Projectile/CanonBall.png', 16, 16, 5, 12],
  ['pj_rock', 'FX/Projectile/SpriteSheetRock.png', 16, 16, 4, 12],
  ['pj_plant', 'FX/Projectile/PlantSpike.png', 24, 20, 4, 12],
  // 粒子（每帧一种碎片形态，作随机帧使用）
  ['pt_fire', 'FX/Particle/Fire.png', 12, 12, 8, 12],
  ['pt_snow', 'FX/Particle/Snow.png', 8, 8, 7, 8],
  ['pt_leaf', 'FX/Particle/Leaf.png', 12, 7, 6, 8],
  ['pt_leaf_pink', 'FX/Particle/LeafPink.png', 12, 7, 6, 8],
  ['pt_spark', 'FX/Particle/Spark.png', 10, 8, 7, 14],
  ['pt_rock', 'FX/Particle/Rock.png', 16, 16, 5, 10],
  ['pt_rock_gray', 'FX/Particle/RockGray.png', 16, 16, 5, 10],
  ['pt_wood', 'FX/Particle/Wood.png', 16, 16, 6, 10],
  ['pt_vase', 'FX/Particle/Vase.png', 14, 14, 6, 10],
  ['pt_grass', 'FX/Particle/Grass.png', 12, 13, 6, 10],
];
/** 循环播放的序列（投射物/光环），其余播放一次后隐藏 */
const LOOPING = new Set(['pj_energy', 'pj_big_energy', 'pj_fireball', 'pj_icespike', 'pj_shuriken', 'pj_shuriken_magic', 'pj_canon', 'pj_rock', 'pj_plant', 'fx_aura', 'fx_circle_orange', 'fx_circle_white', 'fx_circle_spark', 'fx_circle_spark2', 'fx_shield_blue', 'fx_shield_yellow', 'fx_spirit', 'fx_spirit_blue', 'fx_spirit_double', 'fx_boost']);

/** NA 怪物：64×64 = 4 列方向（下/上/左/右）× 4 行帧，每帧 16×16 */
export const NA_MONSTERS: Record<string, string> = {
  na_eye: 'Actor/Monster/Eye/Eye.png',
  na_eye2: 'Actor/Monster/Eye2/Eye2.png',
  na_flam: 'Actor/Monster/Flam/SpriteSheet.png',
  na_flam2: 'Actor/Monster/Flam2/SpriteSheet.png',
  na_spider_red: 'Actor/Monster/SpiderRed/SpriteSheet.png',
  na_spider_yellow: 'Actor/Monster/SpiderYellow/SpriteSheet.png',
  na_spirit: 'Actor/Monster/Spirit/SpriteSheet.png',
  na_spirit2: 'Actor/Monster/Spirit2/SpriteSheet.png',
  na_skull: 'Actor/Monster/Skull/SpriteSheet.png',
  na_skull_blue: 'Actor/Monster/SkullBlue/SpriteSheet.png',
  na_slime: 'Actor/Monster/Slime/Slime.png',
  na_slime2: 'Actor/Monster/Slime2/Slime2.png',
  na_slime3: 'Actor/Monster/Slime3/Slime3.png',
  na_slime4: 'Actor/Monster/Slime4/Slime4.png',
  na_larva: 'Actor/Monster/Larva/Larva.png',
  na_mollusc: 'Actor/Monster/Mollusc/Mollusc.png',
};
/** 程序化怪物别名 → NA 怪物（数据表里写 proc_* 时渲染层用这些） */
export const MONSTER_ALIAS: Record<string, string> = {
  proc_eye: 'na_eye',
  proc_wisp: 'na_flam',
  proc_spider: 'na_spider_red',
  proc_ghost: 'na_spirit',
  proc_skull: 'na_skull',
};

/** 城镇道具矩形（像素），H = TilesetHouse.png，N = TilesetNature.png；已逐个裁切核对 */
export const TOWN_PROPS: Record<string, readonly ['H' | 'N', number, number, number, number]> = {
  house_orange: ['H', 0, 0, 64, 48],
  house_beige: ['H', 64, 0, 64, 48],
  house_orange2: ['H', 128, 0, 64, 48],
  shop_red: ['H', 192, 0, 64, 48],
  shop_sign: ['H', 256, 0, 48, 48],
  hall_green: ['H', 304, 0, 64, 48],
  kiln: ['H', 368, 0, 48, 48],
  house_wood: ['H', 416, 0, 48, 48],
  cabin: ['H', 464, 0, 64, 64],
  manor: ['H', 400, 112, 64, 112],
  shrine: ['H', 400, 224, 64, 80],
  hut: ['H', 304, 304, 48, 48],
  torii: ['H', 6, 82, 36, 30],
  statue_lion: ['H', 14, 240, 36, 48],
  statue_orb: ['H', 48, 240, 32, 32],
  statue_frog: ['H', 48, 272, 32, 32],
  arch: ['H', 464, 320, 48, 44],
  banner_a: ['H', 352, 320, 16, 30],
  banner_b: ['H', 368, 320, 16, 30],
  banner_c: ['H', 400, 320, 16, 30],
  stall_a: ['H', 256, 256, 48, 28],
  stall_b: ['H', 304, 256, 48, 28],
  barrel_town: ['H', 288, 176, 16, 16],
  pots: ['H', 256, 208, 48, 16],
  goods: ['H', 304, 224, 48, 32],
  watchtower: ['H', 256, 48, 48, 128],
  tree_round: ['N', 0, 0, 32, 32],
  tree_pine: ['N', 32, 0, 32, 32],
  tree_dead: ['N', 64, 0, 32, 32],
  tree_round2: ['N', 256, 0, 32, 32],
  tree_pink: ['N', 224, 0, 32, 32],
  trees_pine: ['N', 0, 32, 64, 48],
  trees_green: ['N', 64, 32, 64, 48],
  trees_pink: ['N', 192, 32, 64, 48],
  tree_big_green: ['N', 48, 288, 48, 48],
  tree_big_pink: ['N', 0, 288, 48, 48],
  tree_big_orange: ['N', 144, 288, 48, 48],
  stump: ['N', 0, 133, 32, 24],
  bush_a: ['N', 0, 160, 16, 16],
  bush_b: ['N', 16, 160, 16, 16],
  flower_a: ['N', 0, 176, 16, 16],
  flower_b: ['N', 16, 176, 16, 16],
  bush_berry: ['N', 64, 224, 16, 16],
  rocks: ['N', 272, 208, 96, 16],
};

export function preloadNA(scene: Phaser.Scene): void {
  for (const [key, path, fw, fh] of FX_SHEETS) scene.load.spritesheet(key, assetUrl(NA + path), { frameWidth: fw, frameHeight: fh });
  for (const [key, path] of Object.entries(NA_MONSTERS)) scene.load.spritesheet(key, assetUrl(NA + path), { frameWidth: 16, frameHeight: 16 });
  scene.load.image('na_house', assetUrl(NA + 'Backgrounds/Tilesets/TilesetHouse.png'));
  scene.load.image('na_floor', assetUrl(NA + 'Backgrounds/Tilesets/TilesetFloor.png'));
  scene.load.image('na_nature', assetUrl(NA + 'Backgrounds/Tilesets/TilesetNature.png'));
  scene.load.image('na_arrow', assetUrl(NA + 'FX/Projectile/Arrow.png'));
  scene.load.image('na_kunai', assetUrl(NA + 'FX/Projectile/Kunai.png'));
  scene.load.image('na_fog', assetUrl(NA + 'FX/Environment/Fog.png'));
  scene.load.image('na_shadow', assetUrl(NA + 'Actor/Character/Shadow.png'));
  scene.load.spritesheet('na_chest_big', assetUrl(NA + 'Items/Treasure/BigTreasureChest.png'), { frameWidth: 16, frameHeight: 14 });
  scene.load.spritesheet('na_coin', assetUrl(NA + 'Items/Treasure/Coin2.png'), { frameWidth: 10, frameHeight: 10 });
}

export function registerNA(scene: Phaser.Scene): void {
  for (const [key, , , , frames, rate] of FX_SHEETS) {
    if (scene.anims.exists(key)) continue;
    const loop = LOOPING.has(key) || key.startsWith('pj_');
    scene.anims.create({
      key,
      frames: scene.anims.generateFrameNumbers(key, { start: 0, end: frames - 1 }),
      frameRate: rate,
      repeat: loop ? -1 : 0,
    });
  }
  // 怪物：方向列 d/u/l/r，每列 4 帧（行）
  const cols: Array<[string, number]> = [['d', 0], ['u', 1], ['l', 2], ['r', 3]];
  for (const key of Object.keys(NA_MONSTERS)) {
    for (const [dir, c] of cols) {
      const k = `${key}_${dir}`;
      if (scene.anims.exists(k)) continue;
      scene.anims.create({ key: k, frames: [0, 1, 2, 3].map(r => ({ key, frame: r * 4 + c })), frameRate: 8, repeat: -1 });
    }
  }
  const house = scene.textures.get('na_house');
  const nature = scene.textures.get('na_nature');
  for (const [name, [sheet, x, y, w, h]] of Object.entries(TOWN_PROPS)) {
    const tex = sheet === 'H' ? house : nature;
    if (!tex.has(name)) tex.add(name, 0, x, y, w, h);
  }
  if (!scene.anims.exists('na_coin')) scene.anims.create({ key: 'na_coin', frames: scene.anims.generateFrameNumbers('na_coin', { start: 0, end: 3 }), frameRate: 10, repeat: -1 });
}

/** 城镇道具所在的纹理 key */
export function townPropTexture(name: string): string | null {
  const p = TOWN_PROPS[name];
  if (!p) return null;
  return p[0] === 'H' ? 'na_house' : 'na_nature';
}
