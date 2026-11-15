// 按 id 同步模拟层实体 → Phaser 对象：玩家、怪物（含镜像）、NPC、投射物、伤害区域、掉落、传送阵。

import * as Phaser from 'phaser';
import { DEPTH } from '../config';
import { clsOf } from '../data/classes';
import { G } from '../game/state';
import type { Drop, Enemy, Hazard, Npc, Player, Portal, Projectile } from '../game/types';
import { ART, DT, hasDtFrame, skinKey } from './assets';
import { ActorView, armorGlow, classShield, playerWeaponFrame, staffTint } from './ActorView';
import { ELEM_COLOR, themeOf } from './theme';

const RARITY_GLOW = [0xc9b9a2, 0xa3c979, 0x7fb6d8, 0xc9a2f0, 0xf0bd7c];

export class EntityViews {
  player?: ActorView;
  private playerCid = '';
  private playerArmorGlow: number | null = null;
  readonly enemies = new Map<number, ActorView>();
  readonly npcs = new Map<number, ActorView>();
  private projs = new Map<number, Phaser.GameObjects.Sprite | Phaser.GameObjects.Image>();
  private projGlow = new Map<number, Phaser.GameObjects.Image>();
  private hazards = new Map<number, Phaser.GameObjects.Container>();
  private drops = new Map<number, Phaser.GameObjects.Container>();
  private portals = new Map<number, Phaser.GameObjects.Container>();
  private seenDeaths = new Set<number>();

  constructor(private readonly scene: Phaser.Scene) {}

  lookup(id: number): ActorView | undefined {
    if (this.player && this.player.id === id) return this.player;
    return this.enemies.get(id) ?? this.npcs.get(id);
  }

  /** 切换地图时清空所有实体视图（玩家视图保留） */
  reset(): void {
    for (const v of this.enemies.values()) v.destroy();
    for (const v of this.npcs.values()) v.destroy();
    for (const o of this.projs.values()) o.destroy();
    for (const o of this.projGlow.values()) o.destroy();
    for (const o of this.hazards.values()) o.destroy();
    for (const o of this.drops.values()) o.destroy();
    for (const o of this.portals.values()) o.destroy();
    this.enemies.clear(); this.npcs.clear(); this.projs.clear(); this.projGlow.clear();
    this.hazards.clear(); this.drops.clear(); this.portals.clear(); this.seenDeaths.clear();
  }

  sync(time: number): void {
    this.syncPlayer(G.player, time);
    this.syncEnemies(time);
    this.syncNpcs(time);
    this.syncProjectiles();
    this.syncHazards(time);
    this.syncDrops(time);
    this.syncPortals(time);
  }

  // ---------------- 玩家 ----------------
  private syncPlayer(p: Player | null, time: number): void {
    if (!p) { this.player?.destroy(); this.player = undefined; this.playerCid = ''; return; }
    if (!this.player || this.playerCid !== p.cid) {
      this.player?.destroy();
      this.player = new ActorView(this.scene, p.id, skinKey(p.cid), 'player');
      this.playerCid = p.cid;
      this.player.setShield(classShield(p.cid));
      this.player.setAura(p.cid);
      const th = themeOf(G.theme);
      this.player.light = this.scene.lights.addLight(p.x, p.y, th.playerLight[0], th.playerLight[1], th.playerLight[2]);
      this.playerArmorGlow = null;
    }
    const v = this.player;
    v.setWeapon(playerWeaponFrame(p), p.stat?.weapon === 'staff' ? staffTint(p.stat.element) : undefined);
    // 元素法师：杖头光球随普攻元素在火/冰之间交替（被动“元素共鸣”）
    if (p.cid === 'elemage') v.setWeapon(playerWeaponFrame(p), Math.floor(G.realTime * 1.5) % 2 ? 0x8fe0ff : 0xff8a3a);
    const glow = armorGlow(p);
    if (glow !== this.playerArmorGlow && glow !== null) { v.setGlow(glow, 1.4); this.playerArmorGlow = glow; }
    v.sync(p, time);
  }

  /** 主题切换后刷新玩家随身光 */
  refreshPlayerLight(): void {
    const v = this.player;
    if (!v?.light) return;
    const th = themeOf(G.theme);
    v.light.radius = th.playerLight[0];
    v.light.color.set(((th.playerLight[1] >> 16) & 255) / 255, ((th.playerLight[1] >> 8) & 255) / 255, (th.playerLight[1] & 255) / 255);
    v.light.intensity = th.playerLight[2];
  }

  // ---------------- 怪物 ----------------
  private syncEnemies(time: number): void {
    const map = G.map;
    const alive = new Set<number>();
    for (const e of G.enemies) {
      alive.add(e.id);
      let v = this.enemies.get(e.id);
      if (!v) {
        if (e.dead) continue;
        v = this.makeEnemy(e);
        this.enemies.set(e.id, v);
      }
      if (e.dead) {
        if (!this.seenDeaths.has(e.id)) {
          this.seenDeaths.add(e.id);
          const id = e.id;
          v.die(() => this.enemies.delete(id));
        }
        continue;
      }
      // 迷雾：不在当前视野内的怪物不显示（首领除外，HUD 另行处理）
      const visible = !map || map.isVisibleWorld(e.x, e.y);
      v.root.setVisible(visible);
      v.shadow.setVisible(visible);
      v.sync(e, time);
    }
    for (const [id, v] of this.enemies) {
      if (!alive.has(id) && !this.seenDeaths.has(id)) { v.destroy(); this.enemies.delete(id); }
    }
  }

  private makeEnemy(e: Enemy): ActorView {
    const def = e.def;
    let scale = def.scale ?? 1;
    if (e.elite && !e.boss) scale *= 1.25;
    const v = new ActorView(this.scene, e.id, def.sprite ?? 'goblin', 'enemy', scale, def.tint);
    if (def.flying) v.hover = 10;
    if (e.rival) {
      v.setWeapon(classWeaponForRival(e.rival.cid), ELEM_COLOR[clsOf(e.rival.cid).element]);
      v.setShield(classShield(e.rival.cid));
      v.setGlow(0xff4050, 2);
      v.setNameTag(def.n, '#ff9a8a'); // def.n 已是「镜像 · 职业名」
    } else if (e.boss) v.setGlow(0xff5040, 3);
    else if (e.elite) v.setGlow(0xf0bd7c, 2);
    return v;
  }

  // ---------------- NPC ----------------
  private syncNpcs(time: number): void {
    const alive = new Set<number>();
    for (const n of G.npcs) {
      alive.add(n.id);
      let v = this.npcs.get(n.id);
      if (!v) {
        // 有英雄皮肤用皮肤；否则按怪物/NA 精灵基名渲染（如 wogol）
        const sprite = hasSkin(this.scene, n.sprite) ? skinKey(n.sprite) : n.sprite;
        v = new ActorView(this.scene, n.id, sprite, 'npc');
        v.setNameTag(n.name, n.role === 'villager' ? '#d8d0c0' : '#ffe6a0');
        this.npcs.set(n.id, v);
      }
      v.sync(npcAsActor(n), time);
    }
    for (const [id, v] of this.npcs) if (!alive.has(id)) { v.destroy(); this.npcs.delete(id); }
  }

  // ---------------- 投射物 ----------------
  private syncProjectiles(): void {
    const alive = new Set<number>();
    for (const p of G.projectiles) {
      alive.add(p.id);
      let o = this.projs.get(p.id);
      if (!o) { o = this.makeProjectile(p); this.projs.set(p.id, o); }
      const a = Math.atan2(p.vy, p.vx);
      o.setPosition(p.x, p.y - 14).setDepth(DEPTH.sorted + p.y + 2);
      if (!p.kind.includes('shuriken')) o.setRotation(a);
      const g = this.projGlow.get(p.id);
      g?.setPosition(p.x, p.y - 14);
    }
    for (const [id, o] of this.projs) if (!alive.has(id)) {
      o.destroy(); this.projs.delete(id);
      this.projGlow.get(id)?.destroy(); this.projGlow.delete(id);
    }
  }

  private makeProjectile(p: Projectile): Phaser.GameObjects.Sprite | Phaser.GameObjects.Image {
    const col = p.color ? parseInt(p.color.replace('#', ''), 16) : (ELEM_COLOR[p.el] ?? 0xffffff);
    let o: Phaser.GameObjects.Sprite | Phaser.GameObjects.Image;
    const sprite = (key: string, tint?: number): Phaser.GameObjects.Sprite => {
      const s = this.scene.add.sprite(p.x, p.y, key, 0).setScale(ART);
      if (this.scene.anims.exists(key)) s.play(key);
      if (tint !== undefined) s.setTint(tint);
      return s;
    };
    switch (p.kind) {
      case 'arrow': case 'enemyArrow': o = this.scene.add.image(p.x, p.y, 'na_arrow').setScale(ART); break;
      case 'fireball': o = sprite('pj_fireball'); break;
      case 'iceShard': o = sprite('pj_icespike'); break;
      case 'bolt': o = this.scene.add.image(p.x, p.y, 'bolt').setScale(ART).setTint(col).setBlendMode(Phaser.BlendModes.ADD); break;
      case 'shuriken': {
        const s = sprite('pj_shuriken');
        this.scene.tweens.add({ targets: s, angle: 360, duration: 300, repeat: -1 });
        o = s;
        break;
      }
      case 'dagger': o = this.scene.add.image(p.x, p.y, 'na_kunai').setScale(ART); break;
      case 'enemyOrb': o = sprite('pj_energy', col); break;
      default: o = sprite('pj_energy', col);
    }
    if (p.kind !== 'arrow' && p.kind !== 'enemyArrow' && p.kind !== 'dagger') {
      const g = this.scene.add.image(p.x, p.y, 'glow').setScale(p.team === 'enemy' ? 0.5 : 0.4).setTint(col)
        .setBlendMode(Phaser.BlendModes.ADD).setAlpha(p.team === 'enemy' ? 0.45 : 0.32).setDepth(DEPTH.overFx - 3);
      this.projGlow.set(p.id, g);
    }
    return o;
  }

  // ---------------- 伤害区域 ----------------
  private syncHazards(time: number): void {
    const alive = new Set<number>();
    for (const h of G.hazards) {
      alive.add(h.id);
      let c = this.hazards.get(h.id);
      if (!c) { c = this.makeHazard(h); this.hazards.set(h.id, c); }
      if (h.followId !== undefined) {
        const f = h.followId === G.player?.id ? G.player : G.enemies.find(e => e.id === h.followId);
        if (f) { h.x = f.x; h.y = f.y; }
      }
      c.setPosition(h.x, h.y);
      // 陨石预警：延迟期间脉动；其余：按寿命淡出
      if (h.delay > 0) {
        const k = 0.5 + 0.5 * Math.sin(time * 0.025);
        c.setAlpha(0.55 + 0.45 * k);
      } else {
        const lifeK = h.maxLife > 0 ? Math.min(1, h.life / Math.min(0.4, h.maxLife)) : 1;
        c.setAlpha(lifeK);
      }
      const spin = c.getByName('spin') as Phaser.GameObjects.Image | null;
      if (spin) spin.rotation = time * 0.004;
    }
    for (const [id, c] of this.hazards) if (!alive.has(id)) {
      this.scene.tweens.add({ targets: c, alpha: 0, duration: 200, onComplete: () => c.destroy() });
      this.hazards.delete(id);
    }
  }

  private makeHazard(h: Hazard): Phaser.GameObjects.Container {
    const c = this.scene.add.container(h.x, h.y).setDepth(DEPTH.floorDecal + 2);
    const col = ELEM_COLOR[h.el] ?? 0xffffff;
    const disc = this.scene.add.image(0, 0, 'disc').setScale((h.r * 2) / 64, (h.r * 2) / 64 * 0.62).setTint(col).setAlpha(h.kind === 'meteor' ? 0.16 : 0.12);
    const ring = this.scene.add.image(0, 0, 'ring').setScale((h.r * 2) / 64, (h.r * 2) / 64 * 0.62).setTint(col).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0.8);
    c.add([disc, ring]);
    const s = h.style;
    const add = (key: string, scale: number, tint?: number, name?: string, x = 0, y = 0, add = true): Phaser.GameObjects.Sprite | null => {
      if (!this.scene.anims.exists(key) && !this.scene.textures.exists(key)) return null;
      const sp = this.scene.add.sprite(x, y, key, 0).setScale(scale);
      if (add) sp.setBlendMode(Phaser.BlendModes.ADD);
      if (this.scene.anims.exists(key)) sp.play({ key, repeat: -1, startFrame: Math.floor(Math.random() * 3) });
      if (tint !== undefined) sp.setTint(tint);
      if (name) sp.setName(name);
      c.add(sp);
      return sp;
    };
    /** 在区域内散布 n 个循环小特效（火海/毒雾/冰面） */
    const scatter = (key: string, n: number, scale: number, tint?: number, additive = true): void => {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.6, rr = h.r * (0.25 + Math.random() * 0.6);
        add(key, scale, tint, undefined, Math.cos(a) * rr, Math.sin(a) * rr * 0.62, additive);
      }
    };
    const big = Math.max(1, h.r / 60);
    switch (s) {
      // ---- 火 ----
      case 'firefield': case 'inferno': scatter('fx_flam', Math.round(4 + big * 3), ART * 0.9); disc.setAlpha(0.18); break;
      case 'firestorm': case 'meteor': case 'meteors':
        c.add(this.scene.add.image(0, 0, 'crosshair').setScale(ART * 1.4).setTint(col));
        break;
      // ---- 毒 ----
      case 'poisonCloud': case 'venom': scatter('fx_smoke', Math.round(3 + big * 2), ART * 1.1, 0x9fe06a, false); disc.setAlpha(0.16); break;
      // ---- 冰 ----
      case 'zero': case 'frost': scatter('fx_ice_b', Math.round(3 + big * 2), ART * 0.9); disc.setAlpha(0.2); break;
      case 'permafrost': scatter('fx_ice_flake', Math.round(4 + big * 2), ART * 0.8); add('fx_circle_white', (h.r / 16) * 0.85, 0x9fe8ff, 'spin'); break;
      // ---- 雷 ----
      case 'thunderStorm': add('fx_circle_spark', (h.r / 16) * 0.9, 0xffe36a, 'spin'); scatter('fx_thunder', 3, ART * 0.8); break;
      case 'thunderBolt': c.add(this.scene.add.image(0, 0, 'crosshair').setScale(ART * 1.8).setTint(0xffe36a)); break;
      // ---- 奥术 / 机械 ----
      case 'storm': add('fx_circle_spark2', (h.r / 16) * 0.95, 0xc9a2f0, 'spin'); add('fx_spirit_double', ART * 1.4, 0xc9a2f0); break;
      case 'orbital': add('fx_circle_white', (h.r / 16), 0x7fe6d4, 'spin'); break;
      // ---- 物理 ----
      case 'whirl': add('fx_circular', (h.r / 16) * 0.9, undefined, 'spin'); break;
      case 'bulwark': add('fx_shield_yellow', h.r / 12); ring.setTint(0xf0c96b); break;
      case 'thorns': ring.setAlpha(0.5); c.add(this.scene.add.image(0, -2, DT, 'floor_spikes_anim_f3').setScale(ART)); break;
      case 'arrowRain': case 'rock': c.add(this.scene.add.image(0, 0, 'crosshair').setScale(ART).setTint(col)); break;
      case 'cavalry': case 'execute': case 'piercer': add('fx_smoke', ART, 0xd8c8b0, undefined, 0, 0, false); disc.setAlpha(0.05); ring.setAlpha(0.2); break;
      default:
        if (h.kind === 'trap') { ring.setAlpha(0.5); c.add(this.scene.add.image(0, -2, DT, 'floor_spikes_anim_f3').setScale(ART)); }
        else if (h.kind === 'meteor') c.add(this.scene.add.image(0, 0, 'crosshair').setScale(ART * 1.4).setTint(col));
        else add('fx_circle_white', (h.r / 16) * 0.9, col, 'spin');
    }
    return c;
  }

  // ---------------- 掉落 ----------------
  private syncDrops(time: number): void {
    const alive = new Set<number>();
    // 屏幕外剔除：掉落很多时（高击杀率）不渲染视野外的（实机：600 个屏幕外掉落仍掉到 20fps）
    const view = this.scene.cameras.main.worldView;
    const m = 48;
    for (const d of G.drops) {
      alive.add(d.id);
      let c = this.drops.get(d.id);
      if (!c) { c = this.makeDrop(d); this.drops.set(d.id, c); }
      const onScreen = d.x > view.x - m && d.x < view.right + m && d.y > view.y - m && d.y < view.bottom + m;
      const visible = onScreen && (!G.map || G.map.isExploredWorld(d.x, d.y));
      c.setVisible(visible);
      if (!visible) continue;
      const bob = d.kind === 'chest' ? 0 : Math.sin(time * 0.004 + d.id) * 1.5;
      c.setPosition(d.x, d.y - (d.z || 0) + bob).setDepth(DEPTH.sorted + d.y);
      if (d.kind === 'chest' && d.opened && !c.getData('opened')) {
        c.setData('opened', true);
        const s = c.getByName('chest') as Phaser.GameObjects.Sprite | null;
        if (s && this.scene.anims.exists('chest_full_open')) s.play('chest_full_open');
      }
    }
    for (const [id, c] of this.drops) if (!alive.has(id)) { c.destroy(); this.drops.delete(id); }
  }

  private makeDrop(d: Drop): Phaser.GameObjects.Container {
    const c = this.scene.add.container(d.x, d.y);
    // 掉落物不开光照：与光晕（ADD）混排时减少批次切换，且在暗处也能看清
    const img = (key: string, frame?: string | number, scale = ART): Phaser.GameObjects.Image =>
      this.scene.add.image(0, 0, key, frame).setOrigin(0.5, 1).setScale(scale);
    switch (d.kind) {
      case 'exp': c.add([this.glowImg(0x7ff0a8, 0.3), img('expgem')]); break;
      case 'gold': {
        const s = this.scene.add.sprite(0, 0, DT, 'coin_anim_f0').setOrigin(0.5, 1).setScale(ART).play('coin');
        c.add([this.glowImg(0xffd060, 0.25), s]);
        break;
      }
      case 'hp': c.add(img(DT, 'flask_big_red')); break;
      case 'mp': c.add(img(DT, 'flask_big_blue')); break;
      case 'mat': c.add([this.glowImg(0xc070ff, 0.25), img(`mat_${d.mat ?? 'gem'}`)]); break;
      case 'item': {
        const it = d.item;
        const r = it?.rarity ?? 0;
        const key = it?.sprite ?? 'weapon_rusty_sword';
        const beam = this.scene.add.image(0, 2, `beam_${r}`).setOrigin(0.5, 1).setScale(ART * 1.2, ART * (0.8 + r * 0.25)).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0.8);
        const icon = hasDtFrame(key) ? img(DT, key, ART * 0.85) : img(key, undefined, ART * 0.7);
        icon.setRotation(hasDtFrame(key) ? -0.6 : 0);
        c.add([this.glowImg(RARITY_GLOW[r], 0.35), beam, icon]);
        if (r >= 3) this.scene.tweens.add({ targets: beam, alpha: { from: 0.55, to: 0.95 }, duration: 600, yoyo: true, repeat: -1 });
        break;
      }
      case 'chest': {
        const tier = d.tier ?? 0;
        const s = this.scene.add.sprite(0, 0, DT, 'chest_full_open_anim_f0').setOrigin(0.5, 1).setScale(ART * (1 + tier * 0.3)).setName('chest');
        if (tier >= 2) s.setTint(0xffe0a0);
        c.add([this.glowImg(tier >= 2 ? 0xffd060 : 0xffffff, 0.2 + tier * 0.1), s]);
        break;
      }
    }
    return c;
  }

  private glowImg(color: number, alpha: number): Phaser.GameObjects.Image {
    return this.scene.add.image(0, -6, 'glow').setScale(0.42).setTint(color).setAlpha(alpha).setBlendMode(Phaser.BlendModes.ADD);
  }

  // ---------------- 传送阵 ----------------
  private syncPortals(time: number): void {
    const alive = new Set<number>();
    for (const p of G.portals) {
      alive.add(p.id);
      let c = this.portals.get(p.id);
      if (!c) { c = this.makePortal(p); this.portals.set(p.id, c); }
      c.setPosition(p.x, p.y).setAlpha(p.open ? 1 : 0.35);
      const ring = c.getByName('ring') as Phaser.GameObjects.Image | null;
      if (ring) ring.setScale(ART * (1 + Math.sin(time * 0.004) * 0.05), ART * (1 + Math.sin(time * 0.004) * 0.05));
      const inner = c.getByName('inner') as Phaser.GameObjects.Sprite | null;
      if (inner) inner.setVisible(p.open);
    }
    for (const [id, c] of this.portals) if (!alive.has(id)) { c.destroy(); this.portals.delete(id); }
  }

  private makePortal(p: Portal): Phaser.GameObjects.Container {
    const col = p.kind === 'next' ? 0x8fe0ff : p.kind === 'city' ? 0xffe0a0 : p.kind === 'arena' ? 0xff8060 : p.kind === 'secret' ? 0x9affc8 : p.kind === 'boss' ? 0xff4050 : 0xc9a2f0;
    const c = this.scene.add.container(p.x, p.y).setDepth(DEPTH.floorDecal + 4);
    const ring = this.scene.add.image(0, 0, 'portal').setScale(ART).setTint(col).setBlendMode(Phaser.BlendModes.ADD).setName('ring');
    const inner = this.scene.add.sprite(0, -2, 'fx_circle_spark', 0).setScale(ART * 1.3, ART * 0.65).setTint(col).setBlendMode(Phaser.BlendModes.ADD).setName('inner');
    if (this.scene.anims.exists('fx_circle_spark')) inner.play({ key: 'fx_circle_spark', repeat: -1 });
    const glow = this.scene.add.image(0, -10, 'glow').setScale(1.1, 0.8).setTint(col).setAlpha(0.35).setBlendMode(Phaser.BlendModes.ADD);
    const label = this.scene.add.text(0, -40, p.label, {
      fontFamily: '"Fusion Pixel 12px Proportional SC", "Fusion Pixel 12px Proportional", "PingFang SC", sans-serif',
      fontSize: '12px', color: '#' + col.toString(16).padStart(6, '0'), stroke: '#120c08', strokeThickness: 3,
    }).setOrigin(0.5, 1).setScale(0.5);
    c.add([glow, ring, inner, label]);
    const light = this.scene.lights.addLight(p.x, p.y - 10, 150, col, 1.2);
    // 传送阵移除/切图时一并释放光源（否则光源会跨地图累积）
    c.once(Phaser.GameObjects.Events.DESTROY, () => this.scene.lights.removeLight(light));
    return c;
  }
}

function hasSkin(scene: Phaser.Scene, id: string): boolean { return scene.textures.exists(skinKey(id)); }

function classWeaponForRival(cid: string): string {
  const m: Record<string, string> = {
    warrior: 'weapon_knight_sword', knight: 'weapon_spear', armored: 'weapon_cleaver', stormguard: 'weapon_mace',
    pyro: 'weapon_red_magic_staff', cryo: 'weapon_green_magic_staff', storm: 'weapon_green_magic_staff', elemage: 'weapon_red_magic_staff',
    ranger: 'weapon_bow', assassin: 'weapon_knife', ninja: 'weapon_katana', stormblade: 'weapon_knife',
  };
  return m[cid] ?? 'weapon_regular_sword';
}

/** NPC 没有完整 Actor 字段，这里补齐渲染所需的最小集合 */
const npcCache = new Map<number, { vx: number; vy: number; px: number; py: number }>();
function npcAsActor(n: Npc): Parameters<ActorView['sync']>[0] {
  const c = npcCache.get(n.id) ?? { vx: 0, vy: 0, px: n.x, py: n.y };
  c.vx = (n.x - c.px) * 60; c.vy = (n.y - c.py) * 60; c.px = n.x; c.py = n.y;
  npcCache.set(n.id, c);
  return {
    id: n.id, team: 'player', x: n.x, y: n.y, r: n.r, hp: 1, maxHp: 1, facing: n.facing, aim: n.facing > 0 ? 0 : Math.PI,
    vx: c.vx, vy: c.vy, kx: 0, ky: 0, status: {}, flash: 0, anim: 'idle', animT: 0, dead: false, z: 0,
  };
}
