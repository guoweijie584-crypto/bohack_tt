// 模拟主循环（固定步长）：输入 → 玩家移动/瞄准/动作 → 怪物 → 投射物 → 伤害区域 → 掉落 → 刷怪 → 场景交互 → 迷雾 → 自动存档。
// 移植自 legacy update() L2969–3021，修正：固定 60Hz、敌人速度与帧率无关、面板打开时单机暂停但表现层照常。

import { TILE } from '../config';
import { computeFov } from '../world/los';
import { moveCircle } from '../world/collision';
import { G, emit } from './state';
import { makePlayer, recalc, tickPlayer } from './player';
import { addToBag, equipItem, rollItem, usePotion, weaponTypeOf } from './items';
import { loadSlot, saveGame } from './save';
import { isStunned, speedMul, tickKnockback, tickStatus } from './combat';
import { aimAngle, attackReach, autoTarget, basicAttack, castSkill, castUlt, dash, resetCombatState, tickDash } from './skills';
import { updateEnemies } from './enemies';
import { updateProjectiles } from './projectiles';
import { updateHazards } from './hazards';
import { updateDrops } from './drops';
import { updateSpawner } from './spawner';
import { enterCity, interact, updateWorld } from './world';

/** 迷雾视野半径（格） */
const FOV_RADIUS = 7;
let fovTile = -1;
let fovT = 0;
/**
 * 上一步处于面板暂停：面板里的操作（买卖/强化/装备/加点/融合/路线/祭坛…）UI 本身不存档，
 * 而暂停期间自动存档计时也不走——恢复模拟的第一步立即存档一次，避免关面板后刷新页面丢失。
 */
let resumeSave = false;

/** 新建角色并进入主城 */
export function newGame(cid: string, route: 'magic' | 'tech', name: string, slot: number): void {
  G.slot = slot;
  G.seed = (Math.random() * 0x7fffffff) | 0; // 每局迷宫不同（联机时改用房间种子）
  G.shops = {}; // 货架按角色等级/武器类型生成，不能沿用上一个角色的
  resumeSave = false;
  resetCombatState();
  const p = makePlayer(cid, route, name);
  recalc(p, true);
  // 新角色送一把职业对应的粗制武器（legacy newGame 行为）
  const starter = rollItem(1, { rarity: 0, slot: 'weapon', weaponType: weaponTypeOf(cid) });
  if (addToBag(p, starter)) equipItem(p, starter.uid);
  recalc(p, true);
  G.player = p;
  G.mode = 'play';
  G.time = 0;
  G.panel = null;
  enterCity('spawn');
  fovTile = -1;
  saveGame();
  emit({ t: 'ui', what: 'hud' });
  emit({ t: 'ui', what: 'skillbar' });
  emit({ t: 'banner', text: `${name}，欢迎来到曙光主城`, sub: '按 F 与 NPC 交谈 · 传送阵前往迷宫' });
}

/** 读取存档槽继续游戏（统一从主城出发；地图与怪物不存档） */
export function continueGame(slot: number): boolean {
  const p = loadSlot(slot);
  if (!p) return false;
  resetCombatState();
  G.seed = (Math.random() * 0x7fffffff) | 0;
  G.slot = slot;
  G.shops = {}; // 换角色：上一个角色的货架作废
  resumeSave = false;
  G.player = p;
  G.mode = 'play';
  G.panel = null;
  recalc(p, true);
  enterCity('spawn');
  fovTile = -1;
  emit({ t: 'ui', what: 'hud' });
  emit({ t: 'ui', what: 'skillbar' });
  emit({ t: 'banner', text: `欢迎回来，${p.name}`, sub: `Lv.${p.lv}` });
  return true;
}

/** 固定步长推进一次模拟 */
export function step(dt: number): void {
  const p = G.player;
  const map = G.map;
  if (G.mode !== 'play' || !p || !map) { G.input.pressed.clear(); return; }
  if (G.panel || G.paused) { resumeSave = true; G.input.pressed.clear(); G.input.attack = false; return; }
  if (resumeSave) {
    resumeSave = false;
    saveGame();
  }
  G.time += dt;
  const inp = G.input;

  // ---- 玩家移动 ----
  const stunned = isStunned(p);
  if (p.dashT > 0) {
    tickDash(p, dt);
  } else if (!stunned && (inp.mx || inp.my)) {
    const sp = p.stat.spd * 92 * speedMul(p);
    moveCircle(map, p, inp.mx * sp * dt, inp.my * sp * dt);
    p.vx = inp.mx * sp;
    p.vy = inp.my * sp;
    if (!inp.hasAim && inp.mx) p.facing = inp.mx > 0 ? 1 : -1;
  } else {
    p.vx = 0;
    p.vy = 0;
  }

  // ---- 瞄准 ----
  p.aim = aimAngle(p);
  if (inp.hasAim || p.anim === 'attack' || p.anim === 'cast') p.facing = Math.cos(p.aim) >= 0 ? 1 : -1;

  // ---- 动作 ----
  if (!stunned) {
    for (const act of inp.pressed) {
      switch (act) {
        case 'q': castSkill(p, 0); break;
        case 'e': castSkill(p, 1); break;
        case 'r': castSkill(p, 2); break;
        case 'ult': castUlt(p); break;
        case 'dash': dash(p); break;
        case 'interact': interact(); break;
        case 'potionHp': usePotion(p, 'hp'); break;
        case 'potionMp': usePotion(p, 'mp'); break;
      }
    }
    // 普攻：按住左键朝鼠标攻击；或开启自动攻击时有目标就攻击（改版意见 #20）
    if (p.cd.atk <= 0 && p.dashT <= 0) {
      const auto = G.autoAttack && !!autoTarget(p.x, p.y, attackReach(p), 'player');
      if (inp.attack || auto) basicAttack(p);
    }
  }
  inp.pressed.clear();

  // ---- 玩家自身状态 ----
  tickPlayer(p, dt);
  tickStatus(p, dt);
  tickKnockback(p, dt);
  p.flash = Math.max(0, p.flash - dt);
  p.animT += dt;
  if ((p.anim === 'attack' && p.animT > 0.26) || (p.anim === 'cast' && p.animT > 0.32) || (p.anim === 'hurt' && p.animT > 0.2)) {
    p.anim = 'idle';
  }
  if (p.anim === 'idle' || p.anim === 'run') p.anim = Math.hypot(p.vx, p.vy) > 8 ? 'run' : 'idle';
  if (G.mode !== 'play') return; // 可能在结算中死亡

  // ---- 世界 ----
  updateEnemies(dt);
  updateProjectiles(dt);
  updateHazards(dt);
  updateDrops(dt);
  updateSpawner(dt);
  updateWorld(dt);
  if (G.map !== map) { fovTile = -1; return; } // 本步切换了场景

  // ---- 迷雾（玩家换格或每 0.25s 重算一次）----
  if (map.fog) {
    const tile = Math.floor(p.y / TILE) * map.w + Math.floor(p.x / TILE);
    fovT -= dt;
    if (tile !== fovTile || fovT <= 0) {
      computeFov(map, p.x, p.y, FOV_RADIUS);
      fovTile = tile;
      fovT = 0.25;
    }
  }

  // ---- 自动存档 ----
  G.saveT += dt;
  if (G.saveT > 20) {
    G.saveT = 0;
    saveGame();
  }
}
