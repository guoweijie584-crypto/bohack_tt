// 标题界面：多角色存档槽（改版意见：不能转职但可开多个人物、登录后不用重来）、新建角色、导入旧版存档。
// 背景由 GameScene 渲染（主城地图缓慢平移），这里只叠半透明遮罩与 UI。

import { clamp, esc } from '../core/util';
import { CLASSES, clsOf } from '../data/classes';
import { ELEM } from '../data/elements';
import { SKILLS } from '../data/skills';
import { ROUTES } from '../data/trees';
import type { ClassDef, RouteId } from '../data/types';
import { continueGame, newGame } from '../game/sim';
import type { Player } from '../game/types';
import { deleteSlot, hasLegacy, importLegacy, listSlots, SLOT_COUNT, type SlotInfo, writeSlot } from '../game/save';
import { setMusic } from '../audio/sfx';
import { skinUrl } from './bridge';
import { closestAct, el, q } from './dom';
import { ico, routeIcon, skillIcon } from './icons';
import { passiveText } from './panels/char';
import { portrait } from './panels/common';
import { C_BAD, C_GOOD, cssColor, ensureAudio, errMsg, safe, sfx, ui } from './shared';
import { fmtDate, fmtTime, kc, WEAPON_NAME } from './text';

const NAMES = ['余烬', '霜语', '雷鸣', '影刃', '曙光', '游隼', '铁砧', '星火', '晨岚', '流萤', '北辰', '青锋'];
const NAME_MAX = 12;

/** 清洗角色名：去控制字符与首尾空白，最多 12 个字符（按码点） */
export function sanitizeName(raw: string): string {
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029]/g, '').trim();
  return Array.from(s).slice(0, NAME_MAX).join('');
}

/** 存档槽卡片（纯函数，测试转义） */
export function slotCardHtml(i: number, info: SlotInfo | null): string {
  if (!info) {
    return `<div class="slot empty pxb"><div class="sl-no">槽位 ${i + 1}</div>`
      + `<div class="sl-img">${ico('plus', 3)}</div><div class="sl-name dim">空槽位</div>`
      + '<div class="dim">创建一名新的斗士</div>'
      + `<div class="btns"><button class="btn primary" data-t="new" data-v="${i}">新建角色</button></div></div>`;
  }
  const c = clsOf(info.cid);
  return `<div class="slot pxb"><div class="sl-no">槽位 ${i + 1}</div>`
    + `<div class="sl-img">${portrait(info.cid, 3)}</div>`
    + `<div class="sl-name t24" style="color:${cssColor(c.color)}">${esc(info.name || c.name)}</div>`
    + `<div>${esc(c.name)} · Lv.${Math.floor(info.lv)}</div>`
    + `<div class="dim">最深 第 ${Math.floor(info.bestFloor)} 层 · ${esc(fmtTime(info.playTime))}</div>`
    + `<div class="dim">${esc(fmtDate(info.updatedAt))}</div>`
    + `<div class="btns"><button class="btn primary" data-t="continue" data-v="${i}">继续</button>`
    + `<button class="btn danger sm" data-t="delete" data-v="${i}">删除</button></div></div>`;
}

/* ------------------------------------------------------------------ */
/* 状态                                                                 */
/* ------------------------------------------------------------------ */
let root: HTMLElement | null = null;
let mainEl: HTMLElement | null = null;
let view: 'slots' | 'create' = 'slots';
let createSlot = 0;
let pickCid = CLASSES[0].id;
let pickRoute: RouteId = 'magic';
let slotsCache: Array<SlotInfo | null> = [];
let skinWait = 0;
/** 皮肤就绪后只补绘一次立绘 */
let skinRetry = true;

export function titleVisible(): boolean { return !!root && !root.hidden; }

/* ------------------------------------------------------------------ */
/* 渲染                                                                 */
/* ------------------------------------------------------------------ */
function readSlots(): Array<SlotInfo | null> {
  const list = safe(() => listSlots(), [] as Array<SlotInfo | null>);
  const out: Array<SlotInfo | null> = [];
  for (let i = 0; i < SLOT_COUNT; i++) out.push(list[i] ?? null);
  return out;
}

function renderSlots(): void {
  if (!mainEl) return;
  slotsCache = readSlots();
  const legacy = safe(() => hasLegacy(), false);
  const anyFree = slotsCache.some(s => !s);
  mainEl.innerHTML = `<div class="slots">${slotsCache.map((s, i) => slotCardHtml(i, s)).join('')}</div>
    <div class="t-actions">
      ${legacy ? `<button class="btn" data-t="import"${anyFree ? '' : ' disabled'}>${ico('scroll', 1)}导入旧版存档</button>` : ''}
      <button class="btn" data-t="lore">${ico('scroll', 1)}世界观</button>
      <button class="btn" data-t="help">${ico('question', 1)}操作说明</button>
    </div>
    ${legacy && !anyFree ? '<div class="dim">存档槽已满：删除一个角色后才能导入旧版存档。</div>' : ''}`;
}

function statBar(label: string, v: number, max: number, color: string): string {
  const w = clamp(v / max, 0.04, 1);
  return `<div class="sbar"><span class="dim">${label}</span><i><b style="width:${(w * 100).toFixed(0)}%;background:${cssColor(color)}"></b></i></div>`;
}

function classDetailHtml(c: ClassDef): string {
  const ps = passiveText(c.id);
  const sks = SKILLS[c.id] ?? [];
  const el = ELEM[c.element];
  return `<div class="cd-img">${portrait(c.id, 4)}</div>
    <div class="cd-info">
      <div><b class="t24" style="color:${cssColor(c.color)}">${esc(c.name)}</b> <span class="dim">${esc(c.en)}${c.tag ? ' · ' + esc(c.tag) : ''}${c.core ? ' · 核心 ' + esc(c.core) : ''}</span></div>
      <div>${esc(c.desc)}</div>
      <div class="sbars">
        ${statBar('生命', c.hp, 230, '#df5f57')}${statBar('源能', c.mp, 170, '#5fa9d8')}${statBar('攻击', c.atk, 30, '#e8a765')}
        ${statBar('护甲', c.armor, 16, '#b8b2aa')}${statBar('移速', c.spd, 1.9, '#a3c979')}${statBar('暴击', c.crit, 0.3, '#f2cd8c')}
      </div>
      <div class="dim">武器 ${esc(WEAPON_NAME[c.weapon])} · 元素 <span style="color:${cssColor(el?.c)}">${esc(el?.n ?? '')}</span> · 射程 ${c.range}</div>
      <div class="cd-skills">${sks.map(s => `<span class="cd-sk" data-tip="text:${esc(`${s.key} ${s.n}：${s.d}`)}">${skillIcon(s.kind, s.el, 1)}${kc(s.key)}${esc(s.n)}</span>`).join('')}</div>
      <div class="passive">${ico('star', 1, '#f2cd8c')}隐藏被动 <b class="gold">${esc(ps.name)}</b> <span class="dim">${esc(ps.desc)}</span></div>
    </div>`;
}

function renderPicks(): void {
  if (!mainEl) return;
  const classes = mainEl.querySelector<HTMLElement>('.tc-classes');
  const detail = mainEl.querySelector<HTMLElement>('.tc-detail');
  const routes = mainEl.querySelector<HTMLElement>('.tc-routes');
  if (classes) {
    classes.innerHTML = CLASSES.map(c =>
      `<button class="ccard${c.id === pickCid ? ' on' : ''}" data-t="pick" data-v="${esc(c.id)}">${portrait(c.id, 2)}`
      + `<b style="color:${cssColor(c.color)}">${esc(c.name)}</b><span class="dim">${esc(c.tag ?? '')}</span></button>`).join('');
  }
  if (detail) detail.innerHTML = classDetailHtml(clsOf(pickCid));
  if (routes) {
    routes.innerHTML = (Object.keys(ROUTES) as RouteId[]).map(id => {
      const r = ROUTES[id];
      return `<button class="rcard${id === pickRoute ? ' on' : ''}" data-t="route" data-v="${id}">${routeIcon(id, 2)}`
        + `<span><b style="color:${cssColor(r.color)}">${esc(r.name)}路线</b> <span class="dim">${esc(r.en)}</span><br><span class="dim">${esc(r.desc)}</span></span></button>`;
    }).join('');
  }
}

function renderCreate(): void {
  if (!mainEl) return;
  mainEl.innerHTML = `<div class="create pxb">
    <div class="tc-head"><b>新建角色 · 槽位 ${createSlot + 1}</b><span class="dim">职业创建后不可更改（Lv.10 可融合转职一次）</span></div>
    <div class="tc-row"><span>名字</span><input class="tc-name" maxlength="${NAME_MAX}" placeholder="为你的斗士命名" autocomplete="off" spellcheck="false">
      <button class="btn sm" data-t="rand">随机</button></div>
    <div class="tc-sec">选择职业</div>
    <div class="tc-classes"></div>
    <div class="tc-detail soft"></div>
    <div class="tc-sec">选择源能路线（独立技能树，可在主城议会更换）</div>
    <div class="tc-routes"></div>
    <div class="btns"><button class="btn" data-t="back">返回</button><button class="btn primary big" data-t="start">开始征程</button></div>
  </div>`;
  renderPicks();
  const input = q<HTMLInputElement>(mainEl, '.tc-name');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); startNew(); }
  });
  input.focus({ preventScroll: true });
}

function render(): void {
  skinRetry = true;
  if (view === 'create') renderCreate();
  else renderSlots();
}

/* ------------------------------------------------------------------ */
/* 动作                                                                 */
/* ------------------------------------------------------------------ */
function startNew(): void {
  if (!mainEl) return;
  ensureAudio();
  const input = mainEl.querySelector<HTMLInputElement>('.tc-name');
  const name = sanitizeName(input?.value ?? '') || NAMES[Math.floor(Math.random() * NAMES.length)];
  try {
    newGame(pickCid, pickRoute, name, createSlot);
  } catch (e) {
    ui.toast('无法开始游戏：' + errMsg(e), C_BAD);
    sfx('uiDeny');
    return;
  }
  sfx('portal');
  view = 'slots';
  hideTitle();
}

function doContinue(slot: number): void {
  let ok = false;
  try {
    ok = continueGame(slot);
  } catch (e) {
    ui.toast('读取存档失败：' + errMsg(e), C_BAD);
    return;
  }
  if (!ok) { ui.toast('读取存档失败：存档损坏或不存在', C_BAD); sfx('uiDeny'); renderSlots(); return; }
  sfx('portal');
  hideTitle();
}

function doDelete(slot: number): void {
  const info = slotsCache[slot];
  if (!info) return;
  ui.confirm({
    title: '删除角色',
    html: `确定删除槽位 ${slot + 1} 的角色 <b>${esc(info.name)}</b>（${esc(clsOf(info.cid).name)} Lv.${Math.floor(info.lv)}）？<br><span class="down">此操作无法恢复。</span>`,
    okText: '删除',
    danger: true,
    onOk: () => {
      try {
        deleteSlot(slot);
        ui.toast('角色已删除', C_GOOD);
      } catch (e) {
        ui.toast('删除失败：' + errMsg(e), C_BAD);
      }
      renderSlots();
    },
  });
}

/** 导入 legacy 存档：importLegacy 只读不写，这里把它写入第一个空槽后直接继续（不删除旧档） */
function doImport(): void {
  ensureAudio();
  const slot = readSlots().findIndex(x => !x);
  if (slot < 0) { ui.toast('存档槽已满，请先删除一个角色', C_BAD); return; }
  const run = (): void => {
    let imported: Player | null = null;
    try {
      imported = importLegacy();
    } catch (e) {
      ui.toast('导入失败：' + errMsg(e), C_BAD);
      return;
    }
    if (!imported) { ui.toast('没有找到可导入的旧版存档', C_BAD); return; }
    if (!safe(() => writeSlot(slot, imported!), false)) { ui.toast('导入失败：无法写入存档（浏览器存储不可用或已满）', C_BAD); return; }
    markImported();
    ui.toast(`已导入旧版存档：${imported.name || clsOf(imported.cid).name}（槽位 ${slot + 1}）`, C_GOOD);
    doContinue(slot);
  };
  if (importedBefore()) {
    ui.confirm({
      title: '再次导入旧版存档',
      html: '旧版存档之前已经导入过一次。再次导入会在空槽位创建一个新的角色副本，确定继续？',
      okText: '导入',
      onOk: run,
    });
  } else {
    run();
  }
}

/* 旧档“已导入”标记（UI 本地偏好，读写失败时忽略） */
const IMPORTED_KEY = 'aether_vanguard_v3_legacy_imported';
function importedBefore(): boolean {
  try { return window.localStorage.getItem(IMPORTED_KEY) === '1'; } catch { return false; }
}
function markImported(): void {
  try { window.localStorage.setItem(IMPORTED_KEY, '1'); } catch { /* 忽略 */ }
}

function onClick(e: MouseEvent): void {
  if (!root) return;
  ensureAudio();
  const t = closestAct(e.target, root, 'data-t');
  if (!t) return;
  const act = t.dataset.t ?? '';
  const v = t.dataset.v ?? '';
  if (t instanceof HTMLButtonElement && t.disabled) return;
  sfx('ui');
  switch (act) {
    case 'new': createSlot = Number(v) || 0; view = 'create'; render(); break;
    case 'continue': doContinue(Number(v) || 0); break;
    case 'delete': doDelete(Number(v) || 0); break;
    case 'import': doImport(); break;
    case 'lore': ui.openPanel('lore'); break;
    case 'help': ui.openPanel('help'); break;
    case 'back': view = 'slots'; render(); break;
    case 'pick': if (CLASSES.some(c => c.id === v)) { pickCid = v; renderPicks(); } break;
    case 'route': pickRoute = v === 'tech' ? 'tech' : 'magic'; renderPicks(); break;
    case 'rand': {
      const input = mainEl?.querySelector<HTMLInputElement>('.tc-name');
      if (input) input.value = NAMES[Math.floor(Math.random() * NAMES.length)];
      break;
    }
    case 'start': startNew(); break;
  }
}

/** Esc：创建页返回槽位列表；返回 true 表示已处理 */
export function titleBack(): boolean {
  if (!titleVisible() || view !== 'create') return false;
  view = 'slots';
  render();
  return true;
}

/* ------------------------------------------------------------------ */
/* 显示/隐藏                                                            */
/* ------------------------------------------------------------------ */
export function mountTitle(parent: HTMLElement): void {
  root = el('div', 'title');
  root.hidden = true;
  root.innerHTML = `<div class="t-wrap">
      <div class="t-logo">源能斗士</div>
      <div class="t-en">AETHER VANGUARD</div>
      <div class="t-sub">主城 · 迷宫副本 · 融合转职 · 双分支技能树 · 多角色存档</div>
      <div class="t-main"></div>
      <div class="t-foot dim">${kc('WASD')}移动 ${kc('左键')}攻击 ${kc('右键')}奥义 ${kc('QER')}技能 ${kc('空格')}冲刺 ${kc('F')}交互 ${kc('Esc')}暂停</div>
      <div class="t-credit dim">美术：0x72 DungeonTileset II（CC0） · 字体：缝合像素字体 Fusion Pixel（OFL-1.1）</div>
    </div>`;
  parent.appendChild(root);
  mainEl = q(root, '.t-main');
  root.addEventListener('click', onClick);
}

export function showTitle(): void {
  if (!root) return;
  view = 'slots';
  root.hidden = false;
  render();
  skinWait = 0;
  try { setMusic('title'); } catch { /* 音频未就绪 */ }
}

export function hideTitle(): void {
  if (!root) return;
  root.hidden = true;
}

/** 渲染层登记皮肤后刷新立绘（标题可能早于 Phaser 资源就绪显示） */
export function tickTitle(dt: number): void {
  if (!titleVisible()) return;
  skinWait += dt;
  if (skinWait < 0.5) return;
  skinWait = 0;
  if (!mainEl) return;
  // 只有存在兜底徽记、且对应皮肤已登记时才重绘一次（避免周期性重建 DOM 吞掉点击）
  if (!skinRetry || !mainEl.querySelector('.pt-fallback')) return;
  const cid = view === 'create' ? pickCid : (slotsCache.find(s => s)?.cid ?? '');
  if (cid && skinUrl(cid)) {
    skinRetry = false;
    if (view === 'create') renderPicks();
    else renderSlots();
  }
}
