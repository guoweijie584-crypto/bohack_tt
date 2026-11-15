// 游戏场景：固定步长模拟 + 渲染同步 + 相机 + 后处理 + 输入 + 事件分发（特效/UI/音频）。
import * as Phaser from 'phaser';
import { SIM_DT, SIM_MAX_STEPS, VIEW_H, VIEW_W } from '../config';
import { damp } from '../core/util';
import { G } from '../game/state';
import { step } from '../game/sim';
import { clickPickup } from '../game/drops';
import { genCity } from '../world/mapgen';
import { handleAudioEvents, initAudio, setMusic } from '../audio/sfx';
import { handleUiEvents, initUI, onHotkey, updateUI } from '../ui/index';
import { initKeyboard } from '../ui/keyboard';
import { EntityViews } from '../view/EntityViews';
import { FxView } from '../view/FxView';
import { WorldView } from '../view/WorldView';
import { themeOf } from '../view/theme';
import type { GridMap } from '../world/grid';

export class GameScene extends Phaser.Scene {
  private world!: WorldView;
  private ents!: EntityViews;
  private fx!: FxView;
  private acc = 0;
  private builtMap: GridMap | null = null;
  private backdrop: GridMap | null = null;
  private bloom?: Phaser.Filters.ParallelFilters;
  private threshold?: Phaser.Filters.Threshold;
  private vignette?: Phaser.Filters.Vignette;
  private pointer = { x: 0, y: 0, has: false };
  private camX = 0;
  private camY = 0;
  private music = '';
  private ambient: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private dustT = 0;
  private stepN = 0;
  private lowHp = false;

  constructor() { super('game'); }

  create(): void {
    this.world = new WorldView(this);
    this.ents = new EntityViews(this);
    this.fx = new FxView(this, id => this.ents.lookup(id));
    this.lights.enable().setAmbientColor(0x808080);
    const cam = this.cameras.main;
    cam.setBackgroundColor('#0b0907');
    this.bloom = cam.filters.internal.addParallelFilters();
    this.threshold = this.bloom.top.addThreshold(0.6, 1);
    this.bloom.top.addBlur(1, 2, 2, 1);
    this.bloom.blend.blendMode = Phaser.BlendModes.ADD;
    this.bloom.blend.amount = 0.5;
    this.vignette = cam.filters.external.addVignette(0.5, 0.5, 0.95, 0.3);
    this.fitCamera();
    this.scale.on('resize', () => this.fitCamera());

    // ---- 输入 ----
    initKeyboard(k => onHotkey(k));
    this.input.mouse?.disableContextMenu();
    // 只有鼠标作为瞄准来源；触屏不设瞄准，走软锁定最近的可见敌人（否则点一次画布后瞄准会永远卡在那个方向）
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (p.wasTouch) return;
      this.pointer = { x: p.x, y: p.y, has: true };
    });
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      initAudio();
      this.pointer = p.wasTouch ? { x: p.x, y: p.y, has: false } : { x: p.x, y: p.y, has: true };
      if (G.mode !== 'play' || G.panel) return;
      const w = this.cameras.main.getWorldPoint(p.x, p.y);
      if (p.rightButtonDown()) { G.input.pressed.add('ult'); return; }
      if (clickPickup(w.x, w.y)) return;
      G.input.attack = true;
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => { if (!p.leftButtonDown()) G.input.attack = false; });
    this.input.on('gameout', () => { G.input.attack = false; });

    try { initUI(); } catch (e) { console.error('[UI] 初始化失败', e); }
    this.setMusic('title');
  }

  /** 相机缩放：保证至少看到 VIEW_W×VIEW_H 世界单位 */
  private fitCamera(): void {
    const cam = this.cameras.main;
    cam.setSize(this.scale.width, this.scale.height);
    cam.setZoom(Math.min(this.scale.width / VIEW_W, this.scale.height / VIEW_H) * 1.0);
  }

  private setMusic(track: string): void {
    if (track === this.music) return;
    this.music = track;
    try { setMusic(track); } catch { /* 音频模块未就绪时忽略 */ }
  }

  override update(time: number, deltaMs: number): void {
    const dt = Math.min(0.1, deltaMs / 1000);
    G.realTime += dt;
    // 鼠标世界坐标（相机移动时也要更新瞄准）；没有鼠标指针时显式关闭瞄准
    if (this.pointer.has) {
      const w = this.cameras.main.getWorldPoint(this.pointer.x, this.pointer.y);
      G.input.aimX = w.x;
      G.input.aimY = w.y;
    }
    G.input.hasAim = this.pointer.has && G.mode === 'play';
    // ---- 固定步长模拟（卡肉期间暂停模拟，渲染照常）----
    if (this.fx.consumeHitStop(dt)) {
      this.acc = 0;
    } else {
      this.acc += dt;
      let n = 0;
      while (this.acc >= SIM_DT && n < SIM_MAX_STEPS) {
        step(SIM_DT);
        this.acc -= SIM_DT;
        n++;
      }
      if (n >= SIM_MAX_STEPS) this.acc = 0;
    }
    // ---- 跑动扬尘 + 脚步声 ----
    const pl = G.player;
    if (pl && G.mode === 'play' && !G.panel && Math.hypot(pl.vx, pl.vy) > 40 && pl.dashT <= 0) {
      this.dustT -= dt;
      if (this.dustT <= 0) {
        this.dustT = 0.16;
        this.fx.footDust(pl.x, pl.y + pl.r * 0.55);
        if ((this.stepN = (this.stepN + 1) % 2) === 0) G.events.push({ t: 'sfx', name: 'step', vol: 0.25 });
      }
    }

    // ---- 场景切换：重建世界视图 ----
    const map = G.mode === 'title' ? this.titleBackdrop() : G.map;
    if (map !== this.builtMap) this.rebuild(map);

    // ---- 渲染同步 ----
    this.ents.sync(time);
    this.world.update(time);
    this.fx.update(dt);
    this.updateCamera(dt, time);

    // ---- 事件分发 ----
    const ev = G.events;
    if (ev.length) {
      this.fx.handle(ev);
      try { handleUiEvents(ev); } catch (e) { console.error(e); }
      try { handleAudioEvents(ev, G.player?.x ?? this.camX, G.player?.y ?? this.camY); } catch (e) { console.error(e); }
      ev.length = 0;
    }
    try { updateUI(dt); } catch (e) { console.error(e); }
    this.updateLowHpVignette(time);
    // 音乐随场景
    if (G.mode === 'title') this.setMusic('title');
    else if (G.boss && !G.boss.dead && G.player && Math.hypot(G.boss.x - G.player.x, G.boss.y - G.player.y) < 700) this.setMusic('boss');
    else this.setMusic(G.scene === 'city' ? 'city' : G.scene === 'arena' ? 'arena' : `dungeon:${G.theme}`);
  }

  /** 低血量警示：生命 < 30% 时暗角变为脉动暗红（主题暗角强度为基准） */
  private updateLowHpVignette(time: number): void {
    const v = this.vignette;
    if (!v) return;
    const p = G.player;
    const base = themeOf(G.theme).vignette;
    const low = !!p && G.mode === 'play' && p.stat && p.hp > 0 && p.hp / p.stat.maxHp < 0.3;
    if (low) {
      const k = 0.5 + 0.5 * Math.sin(time * 0.006);
      v.color.setTo(110, 12, 16);
      v.strength = base + 0.18 + 0.12 * k;
      this.lowHp = true;
    } else if (this.lowHp) {
      v.color.setTo(0, 0, 0);
      v.strength = base;
      this.lowHp = false;
    }
  }

  /** 标题界面背景：主城地图缓慢平移 */
  private titleBackdrop(): GridMap | null {
    if (this.backdrop) return this.backdrop;
    try {
      const gen = genCity();
      this.backdrop = gen.map;
      G.decor = gen.decor;
      G.npcs = gen.npcs;
      G.portals = gen.portals;
      G.theme = 'city';
    } catch {
      this.backdrop = null;
    }
    return this.backdrop;
  }

  private rebuild(map: GridMap | null): void {
    this.builtMap = map;
    this.ents.reset();
    if (!map) { this.world.clear(); return; }
    if (G.mode !== 'title') this.backdrop = null;
    this.world.build(map, G.theme, G.decor);
    const th = themeOf(G.theme);
    this.lights.setAmbientColor(th.ambient);
    if (this.threshold) this.threshold.edge1 = [th.bloom[0], th.bloom[0], th.bloom[0], th.bloom[0]];
    if (this.bloom) this.bloom.blend.amount = th.bloom[1];
    if (this.vignette) this.vignette.strength = th.vignette;
    this.cameras.main.setBackgroundColor(th.bg);
    this.cameras.main.setBounds(-64, -64, map.pixelW + 128, map.pixelH + 128);
    this.ents.refreshPlayerLight();
    this.setAmbientParticles(G.theme);
    const p = G.player;
    if (p && G.mode !== 'title') { this.camX = p.x; this.camY = p.y; } else { this.camX = map.pixelW / 2; this.camY = map.pixelH / 2; }
    this.cameras.main.centerOn(this.camX, this.camY);
  }

  /** 氛围飘屑（落叶/灰尘/火星/雪花），跟随相机视口发射 */
  private setAmbientParticles(themeId: string): void {
    this.ambient?.destroy();
    this.ambient = null;
    const th = themeOf(themeId);
    if (!th.particles) return;
    const pc = th.particles;
    const view = this.cameras.main.worldView;
    const cfg: Phaser.Types.GameObjects.Particles.ParticleEmitterConfig = {
      x: { min: -view.width / 2, max: view.width / 2 },
      y: { min: -view.height / 2, max: view.height / 2 },
      lifespan: { min: 3000, max: 6000 },
      frequency: Math.round(4000 / pc.count),
      speedX: pc.dir === 'drift' ? { min: -14, max: 14 } : { min: -6, max: 6 },
      speedY: pc.dir === 'up' ? { min: -30, max: -12 } : pc.dir === 'down' ? { min: 14, max: 34 } : { min: -6, max: 10 },
      scale: { min: 1.2, max: 2 },
      alpha: { start: 0, end: 0, ease: (t: number) => Math.sin(t * Math.PI) * 0.8 } as unknown as Phaser.Types.GameObjects.Particles.EmitterOpOnUpdateType,
      tint: pc.tint,
      rotate: { min: 0, max: 360 },
      blendMode: pc.tex === 'pt_fire' || pc.tex === 'pt_spark' ? Phaser.BlendModes.ADD : Phaser.BlendModes.NORMAL,
    };
    if (pc.tex.startsWith('pt_')) cfg.frame = [0, 1, 2, 3];
    this.ambient = this.add.particles(0, 0, pc.tex, cfg).setDepth(1_050_000);
  }

  private updateCamera(dt: number, time: number): void {
    const cam = this.cameras.main;
    const p = G.player;
    let tx: number, ty: number;
    if (G.mode === 'title' || !p) {
      const m = this.builtMap;
      if (!m) return;
      tx = m.pixelW / 2 + Math.cos(time * 0.00007) * m.pixelW * 0.25;
      ty = m.pixelH / 2 + Math.sin(time * 0.00005) * m.pixelH * 0.2;
    } else {
      // 略微看向鼠标方向（瞄准前瞻）
      const look = G.input.hasAim ? 0.12 : 0;
      tx = p.x + (G.input.aimX - p.x) * look;
      ty = p.y - 10 + (G.input.aimY - p.y) * look;
    }
    const k = damp(G.mode === 'title' ? 1.5 : 9, dt);
    this.camX += (tx - this.camX) * k;
    this.camY += (ty - this.camY) * k;
    cam.centerOn(this.camX, this.camY);
    this.ambient?.setPosition(cam.worldView.centerX, cam.worldView.centerY);
  }
}
