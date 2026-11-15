// 角色渲染（玩家 / 怪物 / 镜像对手 / NPC）：
// 身体帧动画（idle/run/hit，NA 怪物 4 向）、元气骑士式手持武器（随瞄准旋转、攻击挥砍/突刺/后坐）、
// 盾牌、椭圆硬影（随高度缩放）、受击闪白、状态染色、出生淡入、精英/首领描边辉光、头顶血条与状态点、职业光环粒子。

import * as Phaser from 'phaser';
import { DEPTH } from '../config';
import { RARITY } from '../data/items';
import type { Actor, Enemy, Npc, Player } from '../game/types';
import { ART, DT, hasDtFrame, skinKey } from './assets';
import { MONSTER_ALIAS, NA_MONSTERS } from './assets_na';
import { ELEM_COLOR } from './theme';

type BodyKind = { kind: 'skin'; key: string } | { kind: 'dt2'; base: string } | { kind: 'dt1'; base: string } | { kind: 'na'; key: string };

function resolveBody(sprite: string | undefined): BodyKind {
  const s = sprite ?? 'goblin';
  if (s.startsWith('skin_')) return { kind: 'skin', key: s };
  const na = MONSTER_ALIAS[s] ?? (s in NA_MONSTERS ? s : null);
  if (na) return { kind: 'na', key: na };
  if (hasDtFrame(`${s}_idle_anim_f0`)) return { kind: 'dt2', base: s };
  if (hasDtFrame(`${s}_anim_f0`)) return { kind: 'dt1', base: s };
  return { kind: 'dt2', base: 'goblin' };
}

/** 职业默认武器外观 */
const CLASS_WEAPON: Record<string, string> = {
  warrior: 'weapon_knight_sword', knight: 'weapon_spear', armored: 'weapon_cleaver', stormguard: 'weapon_mace',
  pyro: 'weapon_red_magic_staff', cryo: 'weapon_green_magic_staff', storm: 'weapon_green_magic_staff', elemage: 'weapon_red_magic_staff',
  ranger: 'weapon_bow', assassin: 'weapon_knife', ninja: 'weapon_katana', stormblade: 'weapon_knife',
};
const CLASS_SHIELD: Record<string, string> = { warrior: 'shield_round', knight: 'shield_kite', stormguard: 'shield_storm' };
/** 职业光环粒子 */
const CLASS_AURA: Record<string, { tex: string; tint: number[]; dir: 'up' | 'orbit' | 'drift'; freq: number }> = {
  pyro: { tex: 'pt_fire', tint: [0xffffff], dir: 'up', freq: 140 },
  cryo: { tex: 'pt_snow', tint: [0xffffff], dir: 'drift', freq: 170 },
  storm: { tex: 'spark', tint: [0xffe36a, 0xc9a2f0], dir: 'orbit', freq: 120 },
  elemage: { tex: 'px3', tint: [0xff8a3a, 0x8fe0ff], dir: 'orbit', freq: 110 },
  stormblade: { tex: 'spark', tint: [0xffe36a, 0x9a7ad0], dir: 'orbit', freq: 150 },
  stormguard: { tex: 'spark', tint: [0xffe36a], dir: 'orbit', freq: 160 },
  assassin: { tex: 'px', tint: [0x6a4a8a, 0x2a1a3a], dir: 'drift', freq: 160 },
  ninja: { tex: 'px', tint: [0x3a4a8a, 0xc03040], dir: 'drift', freq: 180 },
};

const STATUS_PIP: Record<string, number> = { burn: 0xff9a55, freeze: 0x8fd8f0, slow: 0xb0c8e8, shock: 0xf6d76e, poison: 0xa8d06a, stun: 0xffffff };

export class ActorView {
  readonly root: Phaser.GameObjects.Container;
  readonly body: Phaser.GameObjects.Sprite;
  readonly shadow: Phaser.GameObjects.Image;
  weapon?: Phaser.GameObjects.Image;
  shield?: Phaser.GameObjects.Image;
  /** 法杖杖头的元素光球 */
  private tipGlow?: Phaser.GameObjects.Image;
  private bar?: Phaser.GameObjects.Graphics;
  private nameTag?: Phaser.GameObjects.Text;
  private aura?: Phaser.GameObjects.Particles.ParticleEmitter;
  light?: Phaser.GameObjects.Light;
  private bodyKind: BodyKind;
  private baseTint = 0xffffff;
  private flashing = false;
  private weaponKey = '';
  private shieldKey = '';
  private lastAnim = '';
  private dying = false;
  private glowAdded = false;
  /** 视觉尺寸（世界单位）用于血条/飘字定位 */
  height = 48;
  /** 飞行单位悬浮高度（世界单位），0 = 贴地 */
  hover = 0;

  constructor(private readonly scene: Phaser.Scene, readonly id: number, sprite: string, private readonly role: 'player' | 'enemy' | 'npc', scale = 1, tint?: number) {
    this.bodyKind = resolveBody(sprite);
    this.shadow = scene.add.image(0, 0, 'shadow').setAlpha(0.34).setDepth(DEPTH.shadow);
    this.root = scene.add.container(0, 0);
    const first = this.firstFrame();
    // 角色不参与场景光照：避免随身光源/技能光把角色照成一团白，任何明暗下都能看清动作（改版文档 §5.2）
    this.body = scene.add.sprite(0, 0, first.tex, first.frame).setOrigin(0.5, 1).setScale(ART * scale);
    this.root.add(this.body);
    if (tint !== undefined) { this.baseTint = tint; this.body.setTint(tint); }
    this.height = this.body.displayHeight;
    const sw = Math.max(10, this.body.width * 0.8);
    this.shadow.setScale((sw / 16) * ART * scale, ART * scale * 0.9);
    this.playAnim('idle', 1);
  }

  private firstFrame(): { tex: string; frame: string | number } {
    const b = this.bodyKind;
    switch (b.kind) {
      case 'skin': return { tex: b.key, frame: 'idle_0' };
      case 'na': return { tex: b.key, frame: 0 };
      case 'dt2': return { tex: DT, frame: `${b.base}_idle_anim_f0` };
      case 'dt1': return { tex: DT, frame: `${b.base}_anim_f0` };
    }
  }

  private playAnim(state: 'idle' | 'run' | 'hit', dir: 1 | -1, vy = 0, vx = 0): void {
    const b = this.bodyKind;
    let key: string;
    switch (b.kind) {
      case 'skin': key = `${b.key}_${state === 'hit' ? 'hit' : state}`; break;
      case 'dt2': key = `${b.base}_${state === 'run' ? 'run' : 'idle'}`; break;
      case 'dt1': key = b.base; break;
      case 'na': {
        const d = Math.abs(vx) >= Math.abs(vy) ? (vx === 0 && vy === 0 ? 'd' : dir > 0 ? 'r' : 'l') : vy > 0 ? 'd' : 'u';
        key = `${b.key}_${d}`;
        break;
      }
    }
    if (key !== this.lastAnim && this.scene.anims.exists(key)) {
      this.body.play(key, true);
      this.lastAnim = key;
    }
  }

  /** 设置/更换手持武器（frame 为 0x72 武器帧名）；法杖的 elemColor 用于杖头元素光球 */
  setWeapon(frame: string | null, elemColor?: number): void {
    if (!frame) {
      this.weapon?.destroy(); this.weapon = undefined; this.weaponKey = '';
      this.tipGlow?.destroy(); this.tipGlow = undefined;
      return;
    }
    if (frame !== this.weaponKey) {
      this.weapon?.destroy();
      this.weapon = this.scene.add.image(0, 0, DT, frame).setOrigin(0.5, 0.85).setScale(ART);
      this.root.add(this.weapon);
      this.weaponKey = frame;
    }
    const staff = frame.includes('staff');
    if (staff && elemColor !== undefined) {
      if (!this.tipGlow) {
        this.tipGlow = this.scene.add.image(0, 0, 'glow').setScale(0.22).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0.75);
        this.root.add(this.tipGlow);
      }
      this.tipGlow.setTint(elemColor);
    } else if (this.tipGlow) { this.tipGlow.destroy(); this.tipGlow = undefined; }
  }

  setShield(key: string | null): void {
    if ((key ?? '') === this.shieldKey) return;
    this.shield?.destroy();
    this.shield = undefined;
    this.shieldKey = key ?? '';
    if (!key) return;
    this.shield = this.scene.add.image(0, 0, key).setScale(ART);
    this.root.add(this.shield);
  }

  setAura(cid: string | null): void {
    this.aura?.destroy();
    this.aura = undefined;
    const a = cid ? CLASS_AURA[cid] : undefined;
    if (!a) return;
    const cfg: Phaser.Types.GameObjects.Particles.ParticleEmitterConfig = {
      lifespan: { min: 600, max: 1100 },
      frequency: a.freq,
      quantity: 1,
      scale: { start: ART * 0.9, end: 0 },
      alpha: { start: 0.9, end: 0 },
      tint: a.tint,
      blendMode: Phaser.BlendModes.ADD,
      x: { min: -10, max: 10 },
      y: { min: -34, max: -6 },
      speedY: a.dir === 'up' ? { min: -40, max: -18 } : { min: -10, max: 10 },
      speedX: { min: -12, max: 12 },
    };
    if (a.tex === 'pt_fire' || a.tex === 'pt_snow') cfg.frame = [0, 1, 2, 3];
    this.aura = this.scene.add.particles(0, 0, a.tex, cfg).setDepth(DEPTH.overFx - 10);
  }

  setNameTag(text: string, color = '#ffe6b0'): void {
    this.nameTag?.destroy();
    this.nameTag = this.scene.add.text(0, 0, text, {
      fontFamily: '"Fusion Pixel 12px Proportional SC", "Fusion Pixel 12px Proportional", "PingFang SC", sans-serif',
      fontSize: '12px', color, stroke: '#1a0f0a', strokeThickness: 3,
    }).setOrigin(0.5, 1).setScale(0.5).setDepth(DEPTH.worldUi);
  }

  /** 精英/首领/镜像的描边辉光（Phaser 4 Filters） */
  setGlow(color: number, strength: number): void {
    if (this.glowAdded) return;
    this.glowAdded = true;
    this.body.enableFilters();
    this.body.filters?.internal.addGlow(color, strength, 0, 1, false, 8, 6);
  }

  /** 每帧同步（a 为模拟实体） */
  sync(a: Actor, time: number): void {
    if (this.dying) return;
    const x = a.x, y = a.y + a.r * 0.55;
    const z = (a.z || 0) + (this.hover ? this.hover + Math.sin(time * 0.006 + this.id) * 2 : 0);
    this.root.setPosition(x, y - z);
    this.root.setDepth(DEPTH.sorted + y);
    this.shadow.setPosition(x, y + 1);
    const sh = 1 - Math.min(0.5, z / 80);
    this.shadow.setAlpha(0.34 * sh);
    // 朝向与动画
    const moving = Math.hypot(a.vx, a.vy) > 8;
    const facing = a.facing;
    if (this.bodyKind.kind !== 'na') this.body.setFlipX(facing < 0);
    const hurt = a.anim === 'hurt' && a.animT < 0.18;
    this.playAnim(hurt ? 'hit' : moving ? 'run' : 'idle', facing, a.vy, a.vx);
    // 出生淡入
    const e = a as Partial<Enemy>;
    if (e.spawnT !== undefined && e.spawnT > 0) {
      const t = Math.max(0, 1 - e.spawnT / 0.5);
      this.root.setAlpha(t);
      this.body.setScale(this.body.scaleX > 0 ? Math.abs(this.body.scaleX) : this.body.scaleX);
    } else {
      const stealth = this.role === 'player' ? (a as Player).buffs?.stealth > 0 : ((a as Enemy).buffs?.stealth ?? 0) > 0;
      this.root.setAlpha(stealth ? 0.45 : 1);
    }
    // 受击闪白 / 状态染色
    if (a.flash > 0) {
      if (!this.flashing) { this.body.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL); this.flashing = true; }
    } else {
      if (this.flashing) { this.body.setTintMode(Phaser.TintModes.MULTIPLY); this.flashing = false; }
      const st = a.status;
      let tint = this.baseTint;
      if (st.stun && st.stun.t > 0 && (st.freeze?.t ?? 0) > 0) tint = 0x9ee8ff;
      else if ((st.freeze?.t ?? 0) > 0 || (st.slow?.t ?? 0) > 0) tint = 0xb8d8ff;
      else if ((st.poison?.t ?? 0) > 0) tint = 0xc8f0a8;
      else if ((st.burn?.t ?? 0) > 0) tint = Math.sin(time * 0.02) > 0 ? 0xffc8a0 : this.baseTint;
      this.body.setTint(tint);
    }
    // 武器：绕手部锚点旋转；攻击时挥砍/突刺/后坐
    if (this.weapon) this.syncWeapon(a, time, moving);
    if (this.shield) {
      const f = facing;
      this.shield.setPosition(f * 5, -15 + Math.sin(time * 0.008) * 0.6).setFlipX(f < 0);
      // 盾在身前（朝向一侧），瞄准向上时放到身后
      const behind = Math.sin(a.aim) < -0.35;
      this.root.moveTo(this.shield, behind ? 0 : this.root.length - 1);
    }
    // 光环、光源、名字
    this.aura?.setPosition(x, y - z);
    if (this.light) { this.light.x = x; this.light.y = y - 18; }
    // 敌方（镜像）名牌放在血条上方，避免文字被血条压住
    this.nameTag?.setPosition(x, y - z - this.height - (this.role === 'enemy' ? 13 : 4));
    // 头顶血条 / 状态点（敌人）
    if (this.role === 'enemy') this.drawBar(a as Enemy);
  }

  private syncWeapon(a: Actor, time: number, moving: boolean): void {
    const w = this.weapon!;
    const aim = a.aim;
    const left = Math.cos(aim) < 0;
    const handX = Math.cos(aim) * 6, handY = -16 + Math.sin(aim) * 3;
    const bob = moving ? Math.sin(time * 0.02) * 1.2 : Math.sin(time * 0.005) * 0.6;
    let rot = aim + Math.PI / 2;
    let ox = 0, oy = 0;
    const atk = a.anim === 'attack' ? a.animT : 99;
    const isBow = this.weaponKey.includes('bow');
    const isStaff = this.weaponKey.includes('staff');
    const isPoke = this.weaponKey.includes('spear') || this.weaponKey.includes('knife') || this.weaponKey.includes('katana');
    if (atk < 0.22) {
      const t = atk / 0.22;
      if (isBow || isStaff) {
        // 后坐 + 法杖上扬
        const k = Math.sin(t * Math.PI);
        ox = -Math.cos(aim) * 5 * k;
        oy = -Math.sin(aim) * 5 * k - (isStaff ? 4 * k : 0);
      } else if (isPoke) {
        const k = t < 0.35 ? -t / 0.35 * 0.4 : Math.sin(((t - 0.35) / 0.65) * Math.PI);
        ox = Math.cos(aim) * 12 * k;
        oy = Math.sin(aim) * 12 * k;
      } else {
        // 挥砍：前摇后拉 → 扫过 → 收势（改版文档 §6：攻击前摇要看得见）
        const swing = t < 0.25 ? -1.3 * (t / 0.25) : -1.3 + 2.6 * Math.min(1, (t - 0.25) / 0.45);
        rot += (left ? -swing : swing);
      }
    }
    if (isBow) rot = aim; // 弓横向持握
    if (isStaff) {
      // 法杖竖握、杖头向朝向一侧微倾（不像枪一样水平指向）；施法时向瞄准方向前探
      const lean = (left ? -1 : 1) * (0.28 + 0.18 * Math.max(0, Math.cos(aim) * (left ? -1 : 1)));
      const k = atk < 0.22 ? Math.sin((atk / 0.22) * Math.PI) : 0;
      rot = lean + (left ? -1 : 1) * 0.5 * k;
      ox = Math.cos(aim) * 4 * k;
      oy = -3 * k;
    }
    const wx = (isStaff ? (left ? -7 : 7) : handX) + ox, wy = handY + oy + bob;
    w.setPosition(wx, wy).setRotation(rot).setFlipX(isBow ? false : left);
    if (isBow) w.setFlipY(left);
    if (this.tipGlow) {
      // 杖头位置：从握点沿杖身方向（rot 为相对竖直向上的角度）延伸约 0.85×杖长
      const len = w.displayHeight * 0.82;
      this.tipGlow.setPosition(wx + Math.sin(rot) * len, wy - Math.cos(rot) * len).setScale(0.2 + 0.05 * Math.sin(time * 0.01));
    }
    // 瞄准向上时武器在身后（法杖始终在身前侧）
    const behind = !isStaff && Math.sin(aim) < -0.45;
    this.root.moveTo(w, behind ? 0 : this.root.length - 1);
    if (this.tipGlow) this.root.moveTo(this.tipGlow, this.root.length - 1);
  }

  private drawBar(e: Enemy): void {
    const show = e.hp < e.maxHp || e.elite;
    if (!show || e.boss) { this.bar?.setVisible(false); return; }
    if (!this.bar) this.bar = this.scene.add.graphics().setDepth(DEPTH.worldUi - 1);
    const g = this.bar;
    g.clear().setVisible(true);
    const w = Math.max(22, Math.min(46, e.r * 2.4));
    const x = e.x - w / 2, y = e.y + e.r * 0.55 - this.height - 7;
    const bars = Math.max(1, e.bars || 1);
    const per = e.maxHp / bars;
    const layer = Math.min(bars - 1, Math.floor(Math.max(0, e.hp - 0.001) / per));
    const frac = (e.hp - layer * per) / per;
    const cols = [0xdf5f57, 0xf0a050, 0xf0d860, 0x8fd86a, 0x7fb6d8];
    g.fillStyle(0x140c0a, 0.85).fillRect(x - 1, y - 1, w + 2, 5);
    if (layer > 0) g.fillStyle(cols[(layer - 1) % cols.length], 0.9).fillRect(x, y, w, 3);
    g.fillStyle(e.elite ? 0xf0bd7c : cols[layer % cols.length], 1).fillRect(x, y, Math.max(0, w * frac), 3);
    if (e.shield > 0) g.fillStyle(0x9fe0ff, 1).fillRect(x, y - 2, Math.min(w, w * (e.shield / (e.maxHp * 0.35))), 1);
    // 层数小刻度
    for (let i = 1; i < bars; i++) g.fillStyle(0x000000, 0.6).fillRect(x + w + 2 + (i - 1) * 3, y, 2, 3);
    // 状态点
    let px = x;
    for (const [k, col] of Object.entries(STATUS_PIP)) {
      const s = e.status[k as keyof typeof e.status];
      if (s && s.t > 0) { g.fillStyle(col, 1).fillRect(px, y - 4, 2, 2); px += 3; }
    }
  }

  /** 死亡表现：闪白 → 倒下淡出 */
  die(onDone: () => void): void {
    if (this.dying) return;
    this.dying = true;
    this.bar?.destroy();
    this.bar = undefined;
    this.nameTag?.destroy();
    this.aura?.stop();
    this.body.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
    this.scene.tweens.add({
      targets: this.root, alpha: 0, duration: 380, delay: 70,
      onStart: () => this.body.setTintMode(Phaser.TintModes.MULTIPLY).setTint(0x886677),
      onComplete: () => { this.destroy(); onDone(); },
    });
    this.scene.tweens.add({ targets: this.body, angle: this.body.flipX ? -80 : 80, y: -2, duration: 300, ease: 'Quad.easeIn' });
    this.scene.tweens.add({ targets: this.shadow, alpha: 0, duration: 420 });
  }

  destroy(): void {
    this.root.destroy();
    this.shadow.destroy();
    this.bar?.destroy();
    this.nameTag?.destroy();
    this.aura?.destroy();
    if (this.light) this.scene.lights.removeLight(this.light);
  }
}

/** 玩家装备 → 武器外观：已装备武器的 sprite，否则职业默认 */
export function playerWeaponFrame(p: Player): string {
  const it = p.equip.weapon;
  if (it?.sprite && hasDtFrame(it.sprite)) return it.sprite;
  return CLASS_WEAPON[p.cid] ?? 'weapon_regular_sword';
}
export function classShield(cid: string): string | null { return CLASS_SHIELD[cid] ?? null; }
export function classWeaponFrame(cid: string): string { return CLASS_WEAPON[cid] ?? 'weapon_regular_sword'; }
/** 法杖按元素着色 */
export function staffTint(el: string): number | undefined { return ELEM_COLOR[el]; }
/** 护甲品质 → 角色描边色（装备显示在人物身上：护甲品质越高描边越亮） */
export function armorGlow(p: Player): number | null {
  const a = p.equip.armor;
  if (!a || a.rarity < 2) return null;
  return parseInt(RARITY[a.rarity].c.slice(1), 16);
}

export type { Npc };
