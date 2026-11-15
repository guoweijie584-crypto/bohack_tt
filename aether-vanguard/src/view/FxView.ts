// 一次性表现事件 → 画面：刀光（NA 序列帧）、元素命中/爆炸、雷电链、光束、波纹、粒子、伤害数字、残影、
// 施法法阵、升级光柱、死亡烟雾、震屏/闪屏、瞬时点光源。特效亮度不超过角色太多（改版文档 §5.2：先看清角色动作）。

import * as Phaser from 'phaser';
import { DEPTH } from '../config';
import { rng } from '../core/rng';
import type { FxEvent } from '../game/types';
import { ART, DIGIT_FONT } from './assets';
import { ELEM_COLOR } from './theme';
import type { ActorView } from './ActorView';

const hex = (c: string): number => (c.startsWith('#') ? parseInt(c.slice(1), 16) : 0xffffff);

interface TempLight { light: Phaser.GameObjects.Light; t: number; dur: number; base: number }

const SLASH_STYLE: Record<string, string[]> = {
  sword: ['fx_slash_arc', 'fx_slash_curved', 'fx_slash_01'],
  heavy: ['fx_slash_double', 'fx_circular'],
  dagger: ['fx_cut', 'fx_cut_double'],
  claw: ['fx_claw', 'fx_claw_double'],
  staff: ['fx_circle_spark2'],
};

export class FxView {
  private sparks: Phaser.GameObjects.Particles.ParticleEmitter;
  private dust: Phaser.GameObjects.Particles.ParticleEmitter;
  private tempLights: TempLight[] = [];
  private slashFlip = false;
  private floaterCount = 0;
  /** 卡肉（hit-stop）：剩余冻结秒数与冷却，避免密集战斗时频繁卡顿发粘 */
  private hitStop = 0;
  private hitStopCd = 0;

  /** 请求一次卡肉；冷却期内只接受更长的停顿（如首领倒下） */
  requestHitStop(dur: number): void {
    if (this.hitStopCd > 0 && dur < 0.1) return;
    this.hitStop = Math.max(this.hitStop, dur);
    this.hitStopCd = 0.25;
  }
  /** GameScene 每帧调用：返回 true 表示本帧暂停模拟 */
  consumeHitStop(dt: number): boolean {
    this.hitStopCd = Math.max(0, this.hitStopCd - dt);
    if (this.hitStop <= 0) return false;
    this.hitStop -= dt;
    return true;
  }
  /** 跑动扬尘 */
  footDust(x: number, y: number): void {
    this.dust.setParticleTint(0xb8a890);
    this.dust.setParticleSpeed(8, 26);
    this.dust.explode(2, x, y);
  }

  constructor(private readonly scene: Phaser.Scene, private readonly actorLookup: (id: number) => ActorView | undefined) {
    this.sparks = scene.add.particles(0, 0, 'px', {
      emitting: false, lifespan: { min: 220, max: 560 }, speed: { min: 40, max: 160 },
      scale: { start: ART, end: 0 }, alpha: { start: 1, end: 0.2 }, blendMode: Phaser.BlendModes.ADD,
    }).setDepth(DEPTH.overFx + 2);
    this.dust = scene.add.particles(0, 0, 'px3', {
      emitting: false, lifespan: { min: 300, max: 700 }, speed: { min: 20, max: 70 }, gravityY: 60,
      scale: { start: ART * 0.9, end: 0.2 }, alpha: { start: 0.9, end: 0 },
    }).setDepth(DEPTH.overFx + 1);
  }

  handle(events: readonly FxEvent[]): void {
    this.floaterCount = 0;
    for (const e of events) {
      switch (e.t) {
        case 'slash': this.slash(e.x, e.y, e.a, e.r, hex(e.color), e.style, e.flip); break;
        case 'burst': this.burst(e.x, e.y, hex(e.color), e.n, e.spd); break;
        case 'ring':
          // 内外半径接近的静止圈 = 怪物/首领的范围预警（enemyState.telegraphAt：r0 = 0.9r）
          if (e.r0 >= e.r1 * 0.85 && e.dur > 0.15) this.telegraph(e.x, e.y, e.r1, e.dur, 'circle', hex(e.color));
          else this.ring(e.x, e.y, e.r0, e.r1, hex(e.color), e.dur);
          break;
        case 'telegraph': this.telegraph(e.x, e.y, e.r, e.dur, e.shape, e.color ? hex(e.color) : 0xff4040, e.x1, e.y1); break;
        case 'beam': this.beam(e.x0, e.y0, e.x1, e.y1, e.w, e.el, hex(e.color)); break;
        case 'chain': this.chain(e.pts, hex(e.color)); break;
        case 'line': this.line(e.x0, e.y0, e.x1, e.y1, hex(e.color), e.w); break;
        case 'impact': this.impact(e.x, e.y, e.el, e.size); break;
        case 'explosion': this.explosion(e.x, e.y, e.r, e.el); if (e.r >= 90) this.requestHitStop(0.035); break;
        case 'floater': this.floater(e.x, e.y, e.text, hex(e.color), e.size, !!e.crit); if (e.crit) this.requestHitStop(0.04); break;
        case 'shake': this.scene.cameras.main.shake(Math.min(260, 60 + e.amt * 14), Math.min(0.012, e.amt * 0.0009)); break;
        case 'flash': {
          const c = Phaser.Display.Color.HexStringToColor(e.color ?? '#ffffff');
          this.scene.cameras.main.flash(Math.min(260, 80 + e.amt * 300), c.red, c.green, c.blue, true);
          break;
        }
        case 'afterimage': this.afterimage(e.actorId); break;
        case 'cast': this.cast(e.actorId, e.el); break;
        case 'spawn': this.spawn(e.x, e.y, !!e.boss); break;
        case 'death': this.death(e.x, e.y, hex(e.color), !!e.big); if (e.big) this.requestHitStop(e.kind && /boss|warden|lich|shadow_lord/.test(e.kind) ? 0.12 : 0.06); break;
        case 'pickup': this.pickup(e.x, e.y, hex(e.color)); break;
        case 'levelup': this.levelup(e.x, e.y); break;
        default: break;
      }
    }
  }

  update(dt: number): void {
    for (let i = this.tempLights.length - 1; i >= 0; i--) {
      const l = this.tempLights[i];
      l.t += dt;
      const k = 1 - l.t / l.dur;
      if (k <= 0) { this.scene.lights.removeLight(l.light); this.tempLights.splice(i, 1); continue; }
      l.light.intensity = l.base * k * k;
    }
  }

  /** 瞬时点光源（爆炸、施法、雷击），自动衰减移除 */
  flashLight(x: number, y: number, radius: number, color: number, intensity: number, dur: number): void {
    if (this.tempLights.length > 8) return;
    const light = this.scene.lights.addLight(x, y, radius, color, intensity);
    this.tempLights.push({ light, t: 0, dur, base: intensity });
  }

  private anim(key: string, x: number, y: number, opts: { scale?: number; rot?: number; tint?: number; add?: boolean; depth?: number; flipY?: boolean; origin?: [number, number] } = {}): Phaser.GameObjects.Sprite | null {
    if (!this.scene.anims.exists(key)) return null;
    const s = this.scene.add.sprite(x, y, key, 0).setScale(opts.scale ?? ART).setRotation(opts.rot ?? 0)
      .setDepth(opts.depth ?? DEPTH.overFx);
    if (opts.origin) s.setOrigin(opts.origin[0], opts.origin[1]);
    if (opts.flipY) s.setFlipY(true);
    if (opts.tint !== undefined && opts.tint !== 0xffffff) s.setTint(opts.tint);
    if (opts.add) s.setBlendMode(Phaser.BlendModes.ADD);
    s.play(key);
    s.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => s.destroy());
    return s;
  }

  /** 攻击预警：红色硬边圈/通道，持续期间脉动，结束前加速闪烁（改版文档 §6：前摇要看得见） */
  private telegraph(x: number, y: number, r: number, dur: number, shape: 'circle' | 'lane', color: number, x1?: number, y1?: number): void {
    const g = this.scene.add.graphics().setDepth(DEPTH.floorDecal + 3);
    const t0 = this.scene.time.now;
    const draw = (): void => {
      const k = Math.min(1, (this.scene.time.now - t0) / (dur * 1000));
      const pulse = 0.5 + 0.5 * Math.sin(k * Math.PI * (4 + k * 10));
      g.clear();
      if (shape === 'lane' && x1 !== undefined && y1 !== undefined) {
        const a = Math.atan2(y1 - y, x1 - x), len = Math.hypot(x1 - x, y1 - y);
        const nx = -Math.sin(a) * r, ny = Math.cos(a) * r;
        const pts = [
          new Phaser.Math.Vector2(x + nx, y + ny), new Phaser.Math.Vector2(x + Math.cos(a) * len + nx, y + Math.sin(a) * len + ny),
          new Phaser.Math.Vector2(x + Math.cos(a) * len - nx, y + Math.sin(a) * len - ny), new Phaser.Math.Vector2(x - nx, y - ny),
        ];
        g.fillStyle(color, 0.12 + 0.12 * k).fillPoints(pts, true);
        g.lineStyle(2, color, 0.5 + 0.4 * pulse).strokePoints(pts, true);
      } else {
        g.fillStyle(color, 0.1 + 0.16 * k).fillEllipse(x, y, r * 2, r * 1.25);
        g.fillStyle(color, 0.22).fillEllipse(x, y, r * 2 * k, r * 1.25 * k);
        g.lineStyle(2, color, 0.55 + 0.4 * pulse).strokeEllipse(x, y, r * 2, r * 1.25);
      }
    };
    draw();
    const ev = this.scene.time.addEvent({ delay: 33, loop: true, callback: draw });
    this.scene.time.delayedCall(dur * 1000, () => { ev.remove(); g.destroy(); });
  }

  private slash(x: number, y: number, a: number, r: number, color: number, style: string, flip?: boolean): void {
    const list = SLASH_STYLE[style] ?? SLASH_STYLE.sword;
    const key = list[Math.floor(rng.next() * list.length)];
    this.slashFlip = flip ?? !this.slashFlip;
    const tint = color === 0xffffff || color === 0xf0e2c4 ? undefined : color;
    if (style === 'staff') {
      // 法杖普攻：杖头处一个小闪光（不要盖住角色本体）
      this.anim(key, x + Math.cos(a) * 16, y - 26 + Math.sin(a) * 8, { scale: ART * 0.45, tint, add: true })?.setAlpha(0.7);
      return;
    }
    const dist = style === 'dagger' ? r * 0.55 : r * 0.42;
    const scale = Math.max(1.2, (r * (style === 'heavy' ? 1.35 : 1.05)) / 34) * (style === 'dagger' ? 0.85 : 1);
    this.anim(key, x + Math.cos(a) * dist, y - 12 + Math.sin(a) * dist, { scale, rot: a, tint, add: true, flipY: this.slashFlip });
  }

  private burst(x: number, y: number, color: number, n: number, spd: number): void {
    this.sparks.setParticleTint(color);
    this.sparks.setParticleSpeed(spd * 0.3, spd);
    this.sparks.explode(Math.min(40, n), x, y - 10);
  }

  private ring(x: number, y: number, r0: number, r1: number, color: number, dur: number): void {
    const img = this.scene.add.image(x, y, 'ring').setTint(color).setBlendMode(Phaser.BlendModes.ADD)
      .setScale((r0 * 2) / 64).setDepth(DEPTH.floorDecal + 3).setAlpha(0.9);
    this.scene.tweens.add({ targets: img, scale: (r1 * 2) / 64, alpha: 0, duration: dur * 1000, ease: 'Cubic.easeOut', onComplete: () => img.destroy() });
  }

  private jagged(g: Phaser.GameObjects.Graphics, x0: number, y0: number, x1: number, y1: number, width: number, color: number): void {
    const segs = Math.max(3, Math.floor(Math.hypot(x1 - x0, y1 - y0) / 22));
    const nx = -(y1 - y0), ny = x1 - x0;
    const nl = Math.hypot(nx, ny) || 1;
    const pts: Array<[number, number]> = [[x0, y0]];
    for (let i = 1; i < segs; i++) {
      const t = i / segs, off = (rng.next() - 0.5) * 18;
      pts.push([x0 + (x1 - x0) * t + (nx / nl) * off, y0 + (y1 - y0) * t + (ny / nl) * off]);
    }
    pts.push([x1, y1]);
    const vs = pts.map(([px, py]) => new Phaser.Math.Vector2(px, py));
    g.lineStyle(width + 4, color, 0.35);
    g.strokePoints(vs);
    g.lineStyle(width, color, 1);
    g.strokePoints(vs);
    g.lineStyle(Math.max(1, width / 2), 0xffffff, 1);
    g.strokePoints(vs);
  }

  private chain(pts: Array<[number, number]>, color: number): void {
    const g = this.scene.add.graphics().setDepth(DEPTH.overFx + 3).setBlendMode(Phaser.BlendModes.ADD);
    let flick = 0;
    const draw = (): void => {
      g.clear();
      for (let i = 0; i < pts.length - 1; i++) this.jagged(g, pts[i][0], pts[i][1] - 12, pts[i + 1][0], pts[i + 1][1] - 12, 2, color);
    };
    draw();
    const ev = this.scene.time.addEvent({ delay: 45, repeat: 4, callback: () => { flick++; draw(); g.setAlpha(1 - flick * 0.18); } });
    this.scene.time.delayedCall(260, () => { ev.remove(); g.destroy(); });
    for (const [px, py] of pts.slice(1)) {
      this.anim('fx_thunder', px, py - 6, { scale: ART * 0.9, origin: [0.5, 1], add: true });
      this.flashLight(px, py, 120, color, 1.6, 0.25);
    }
  }

  private beam(x0: number, y0: number, x1: number, y1: number, w: number, el: string, color: number): void {
    const g = this.scene.add.graphics().setDepth(DEPTH.overFx + 3).setBlendMode(Phaser.BlendModes.ADD);
    const yo = -12;
    if (el === 'lightning') {
      this.jagged(g, x0, y0 + yo, x1, y1 + yo, Math.max(3, w * 0.25), color);
    } else {
      g.lineStyle(w, color, 0.45).lineBetween(x0, y0 + yo, x1, y1 + yo);
      g.lineStyle(Math.max(3, w * 0.45), color, 0.9).lineBetween(x0, y0 + yo, x1, y1 + yo);
      g.lineStyle(Math.max(2, w * 0.15), 0xffffff, 1).lineBetween(x0, y0 + yo, x1, y1 + yo);
    }
    this.scene.tweens.add({ targets: g, alpha: 0, duration: 380, ease: 'Quad.easeIn', onComplete: () => g.destroy() });
    const n = Math.min(10, Math.floor(Math.hypot(x1 - x0, y1 - y0) / 60));
    for (let i = 0; i <= n; i++) {
      const t = i / Math.max(1, n);
      this.sparks.setParticleTint(color);
      this.sparks.setParticleSpeed(20, 90);
      this.sparks.explode(3, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + yo);
    }
    this.flashLight((x0 + x1) / 2, (y0 + y1) / 2, 220, color, 1.8, 0.35);
    this.scene.cameras.main.shake(120, 0.004);
  }

  private line(x0: number, y0: number, x1: number, y1: number, color: number, w: number): void {
    const g = this.scene.add.graphics().setDepth(DEPTH.overFx).setBlendMode(Phaser.BlendModes.ADD);
    g.lineStyle(w, color, 0.6).lineBetween(x0, y0 - 12, x1, y1 - 12);
    g.lineStyle(Math.max(1, w / 3), 0xffffff, 0.9).lineBetween(x0, y0 - 12, x1, y1 - 12);
    this.scene.tweens.add({ targets: g, alpha: 0, duration: 260, onComplete: () => g.destroy() });
  }

  private impact(x: number, y: number, el: string, size: number): void {
    const s = Math.max(0.6, size / 18) * ART * 0.8;
    const c = ELEM_COLOR[el] ?? 0xffffff;
    switch (el) {
      case 'fire': this.anim('fx_flam', x, y - 6, { scale: s, origin: [0.5, 0.8], add: true }); break;
      case 'ice': this.anim('fx_ice_flake', x, y - 10, { scale: s, add: true }); break;
      case 'lightning': this.anim('fx_thunder', x, y - 4, { scale: s, origin: [0.5, 1], add: true }); break;
      case 'poison': this.anim('fx_smoke', x, y - 8, { scale: s * 0.8, tint: 0x9fe06a }); break;
      case 'arcane': case 'tech': this.anim('fx_circle_spark2', x, y - 10, { scale: s * 0.8, tint: c, add: true }); break;
      default: this.anim('fx_cut_x', x, y - 12, { scale: s * 0.7, add: true });
    }
    this.sparks.setParticleTint(c);
    this.sparks.setParticleSpeed(30, 120);
    this.sparks.explode(4, x, y - 12);
  }

  private explosion(x: number, y: number, r: number, el: string): void {
    const c = ELEM_COLOR[el] ?? 0xffc070;
    const s = Math.max(1.4, r / 20) * ART * 0.6;
    switch (el) {
      case 'ice': this.anim('fx_ice', x, y - 8, { scale: s, add: true }); this.anim('fx_ice_b', x, y - 4, { scale: s * 0.8, add: true }); break;
      case 'lightning':
        for (let i = 0; i < 3; i++) this.anim('fx_thunder', x + (rng.next() - 0.5) * r, y + (rng.next() - 0.5) * r * 0.6, { scale: s * 0.9, origin: [0.5, 1], add: true });
        break;
      case 'poison': this.anim('fx_smoke', x, y - 10, { scale: s * 1.2, tint: 0x8fd060 }); break;
      case 'arcane': case 'tech': this.anim('fx_circle_spark', x, y - 6, { scale: s, tint: c, add: true }); this.anim('fx_spirit_double', x, y - 10, { scale: s * 0.8, tint: c, add: true }); break;
      case 'physical': this.anim('fx_rock', x, y - 8, { scale: s * 0.9 }); this.anim('fx_smoke', x, y - 6, { scale: s, tint: 0xd8c8b0 }); break;
      default: this.anim('fx_explosion', x, y - 14, { scale: s, add: true });
    }
    this.ring(x, y, 6, r, c, 0.35);
    this.dust.setParticleTint(0x8a7a6a);
    this.dust.explode(8, x, y);
    this.flashLight(x, y, r * 3, c, 1.5, 0.4);
  }

  private floater(x: number, y: number, text: string, color: number, size: number, crit: boolean): void {
    if (++this.floaterCount > 40) return;
    const numeric = /^[0-9+\-!%x ]+$/.test(text);
    const jx = (rng.next() - 0.5) * 10;
    let obj: Phaser.GameObjects.BitmapText | Phaser.GameObjects.Text;
    if (numeric) {
      obj = this.scene.add.bitmapText(x + jx, y - 24, DIGIT_FONT, text, 9).setOrigin(0.5, 1).setTint(color);
      const s = crit ? 2.4 : size > 12 ? 2.0 : 1.6;
      obj.setScale(s * 1.4);
      this.scene.tweens.add({ targets: obj, scale: s, duration: 140, ease: 'Back.easeOut' });
    } else {
      obj = this.scene.add.text(x + jx, y - 24, text, {
        fontFamily: '"Fusion Pixel 12px Proportional SC", "Fusion Pixel 12px Proportional", "PingFang SC", sans-serif',
        fontSize: '12px', color: '#' + color.toString(16).padStart(6, '0'), stroke: '#1a0f0a', strokeThickness: 3,
      }).setOrigin(0.5, 1).setScale(crit ? 0.8 : 0.6);
    }
    obj.setDepth(DEPTH.floaters);
    this.scene.tweens.add({ targets: obj, y: obj.y - (crit ? 26 : 18), duration: 720, ease: 'Cubic.easeOut' });
    this.scene.tweens.add({ targets: obj, alpha: 0, delay: 480, duration: 260, onComplete: () => obj.destroy() });
  }

  private afterimage(id: number): void {
    const v = this.actorLookup(id);
    if (!v) return;
    const b = v.body;
    const ghost = this.scene.add.image(v.root.x, v.root.y, b.texture.key, b.frame.name)
      .setOrigin(0.5, 1).setScale(b.scaleX, b.scaleY).setFlipX(b.flipX).setTint(0x8fd8ff).setTintMode(Phaser.TintModes.FILL)
      .setAlpha(0.5).setDepth(v.root.depth - 1).setBlendMode(Phaser.BlendModes.ADD);
    this.scene.tweens.add({ targets: ghost, alpha: 0, duration: 260, onComplete: () => ghost.destroy() });
  }

  private cast(id: number, el: string): void {
    const v = this.actorLookup(id);
    if (!v) return;
    const c = ELEM_COLOR[el] ?? 0xffffff;
    const s = this.anim('fx_circle_white', v.root.x, v.root.y + 2, { scale: ART * 1.1, tint: c, add: true, depth: DEPTH.floorDecal + 2 });
    s?.setScale(ART * 1.1, ART * 0.55).setAlpha(0.7);
    this.flashLight(v.root.x, v.root.y - 16, 130, c, 0.8, 0.28);
  }

  private spawn(x: number, y: number, boss: boolean): void {
    if (boss) {
      this.anim('fx_circle_spark', x, y, { scale: ART * 2.6, tint: 0xff6040, add: true, depth: DEPTH.floorDecal + 2 })?.setScale(ART * 2.6, ART * 1.3);
      this.ring(x, y, 10, 160, 0xff6040, 0.8);
      this.scene.cameras.main.shake(400, 0.008);
      this.flashLight(x, y, 300, 0xff6040, 2.4, 0.9);
    } else {
      this.anim('fx_smoke', x, y - 8, { scale: ART * 0.8, tint: 0xb0a0c8 });
    }
  }

  private death(x: number, y: number, color: number, big: boolean): void {
    this.anim('fx_smoke', x, y - 10, { scale: ART * (big ? 1.6 : 0.9), tint: 0xc8b8d0 });
    this.sparks.setParticleTint(color);
    this.sparks.setParticleSpeed(40, big ? 220 : 140);
    this.sparks.explode(big ? 28 : 10, x, y - 12);
    if (big) {
      this.anim('fx_explosion', x, y - 16, { scale: ART * 1.8, add: true });
      this.flashLight(x, y, 260, 0xffc070, 2.0, 0.6);
    }
  }

  private pickup(x: number, y: number, color: number): void {
    const s = this.scene.add.image(x, y - 10, 'spark').setScale(ART).setTint(color).setBlendMode(Phaser.BlendModes.ADD).setDepth(DEPTH.overFx);
    this.scene.tweens.add({ targets: s, y: y - 30, alpha: 0, angle: 90, duration: 380, onComplete: () => s.destroy() });
  }

  private levelup(x: number, y: number): void {
    const beam = this.scene.add.image(x, y, 'beam_4').setOrigin(0.5, 1).setScale(ART * 3, ART * 4).setBlendMode(Phaser.BlendModes.ADD).setDepth(DEPTH.overFx);
    this.scene.tweens.add({ targets: beam, scaleX: 0.5, alpha: 0, duration: 900, ease: 'Quad.easeIn', onComplete: () => beam.destroy() });
    this.anim('fx_boost', x, y - 16, { scale: ART * 1.2, add: true });
    this.ring(x, y, 10, 120, 0xf0c96b, 0.6);
    this.flashLight(x, y, 260, 0xffe6a0, 2.4, 0.8);
    this.floater(x, y - 30, 'LEVEL UP', 0xf0c96b, 14, true);
  }
}
