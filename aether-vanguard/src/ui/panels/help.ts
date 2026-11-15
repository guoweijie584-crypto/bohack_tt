// 帮助/设置：操作说明、自动攻击开关（默认关）、音量滑块、全屏、保存并返回标题、删除当前角色存档。

import { esc } from '../../core/util';
import { ELEM, STATUS } from '../../data/elements';
import type { ElementId, StatusId } from '../../data/types';
import { getVolume, setVolume } from '../../audio/sfx';
import { deleteSlot } from '../../game/save';
import { G } from '../../game/state';
import { elemIcon, ico, statusIcon } from '../icons';
import { C_GOOD, C_INFO, cssColor, run, safe, ui } from '../shared';
import { kc } from '../text';
import { btn, sec } from './common';
import type { PanelDef } from './types';

const ELEM_DESC: Record<ElementId, string> = {
  physical: '普通兵器伤害', fire: '灼烧：持续伤害', ice: '迟缓 / 冻结', lightning: '感电：连锁弹跳',
  poison: '中毒：持续伤害', arcane: '奥术奥义', tech: '机械奥义',
};

type VolKey = 'master' | 'music' | 'sfx';
const VOL_LABEL: Record<VolKey, string> = { master: '总音量', music: '音乐', sfx: '音效' };

function volumes(): Record<VolKey, number> {
  return safe(() => getVolume(), { master: 0.8, music: 0.6, sfx: 0.8 });
}

function slider(k: VolKey, v: number): string {
  const n = Math.round(v * 100);
  return `<div class="row">${ico(k === 'music' ? 'scroll' : 'speaker', 1)}<span class="w5">${VOL_LABEL[k]}</span>`
    + `<input type="range" class="vol" min="0" max="100" step="5" value="${n}" data-vol="${k}"><b class="w3 vol-v" data-vol-v="${k}">${n}</b></div>`;
}

function isFullscreen(): boolean {
  return typeof document !== 'undefined' && !!document.fullscreenElement;
}

export const helpPanel: PanelDef = {
  title: () => '操作与设置',
  tabs: true,
  wide: true,
  body({ p }) {
    const vol = volumes();
    const elems = (Object.keys(ELEM) as ElementId[]).map(k =>
      `<div class="kv"><span style="color:${cssColor(ELEM[k].c)}">${elemIcon(k, 1)}${esc(ELEM[k].n)}</span><span class="dim">${esc(ELEM_DESC[k])}</span></div>`).join('');
    const sts = (Object.keys(STATUS) as StatusId[]).map(k =>
      `<span class="st" style="color:${cssColor(STATUS[k].c)}">${statusIcon(k, 1)}${esc(STATUS[k].n)}</span>`).join('');
    const saveBlock = p
      ? `<div class="soft">进度自动保存在本机浏览器（每个角色一个存档槽，共 4 个）。<div class="btns">`
        + btn('保存并返回标题', 'to-title', '', { primary: true })
        + btn('删除当前角色存档', 'wipe', '', { danger: true }) + '</div></div>'
      : '<div class="soft dim">尚未进入游戏。</div>';
    return `<div class="grid2 help">
      <div>
        ${sec('操作')}
        <div class="soft lines">
          <div>${kc('W')}${kc('A')}${kc('S')}${kc('D')} / 方向键 移动</div>
          <div>${kc('鼠标左键')} 按住朝光标方向连续攻击；点击地上的装备拾取</div>
          <div>${kc('Q')}${kc('E')}${kc('R')} 职业技能 · ${kc('鼠标右键')} 奥义</div>
          <div>${kc('空格')} 冲刺（沿行走方向）</div>
          <div>${kc('1')} 生命药水 · ${kc('2')} 源能药水 · ${kc('F')} 交互/拾取</div>
          <div>${kc('C')}/${kc('Tab')} 角色 ${kc('B')} 背包 ${kc('K')} 技能 ${kc('P')} 转职</div>
          <div>${kc('M')} 地图 ${kc('J')} 日志 ${kc('H')} 帮助 ${kc('Esc')} 关闭面板 / 暂停</div>
          <div>${kc('T')} 切换自动攻击</div>
        </div>
        ${sec('自动攻击')}
        <div class="soft">当前：<b class="${G.autoAttack ? 'up' : 'down'}">${G.autoAttack ? '开启' : '关闭'}</b>
          ${btn(G.autoAttack ? '关闭自动攻击' : '开启自动攻击', 'auto', '', { small: true })}
          <div class="dim">开启后自动攻击射程内最近的可见敌人；关闭时按住左键朝鼠标方向攻击（默认关闭，触屏设备默认开启）。</div>
        </div>
        ${sec('声音与画面')}
        <div class="soft">
          ${slider('master', vol.master)}${slider('music', vol.music)}${slider('sfx', vol.sfx)}
          <div class="btns">${btn(isFullscreen() ? '退出全屏' : '全屏', 'fullscreen', '')}</div>
        </div>
      </div>
      <div>
        ${sec('元素与状态')}
        <div class="soft">${elems}<div class="sts">${sts}</div>
          <div class="dim">命中怪物弱点元素伤害提高，同系元素有抗性；灼烧/中毒叠层有上限，伤害在施加时结算快照。</div></div>
        ${sec('成长')}
        <div class="soft dim">等级上限 50 · 每级 +3 属性点 / +2 技能点 · 经验与金币自动吸取 · 装备需点击拾取（背包满时留在地上）·
          任一职业 Lv.10 可在转职殿融合一次 · 怪物掉落材料可在铁匠铺强化装备 · 主城仓库可存放装备。</div>
        ${sec('存档')}
        ${saveBlock}
      </div>
    </div>`;
  },
  input(target) {
    const k = target.dataset.vol as VolKey | undefined;
    if (!k) return;
    const v = volumes();
    v[k] = Math.max(0, Math.min(1, Number(target.value) / 100));
    safe(() => setVolume(v.master, v.music, v.sfx), undefined);
    const lb = target.parentElement?.querySelector<HTMLElement>(`[data-vol-v="${k}"]`);
    if (lb) lb.textContent = String(Math.round(v[k] * 100));
  },
  action(act, _v, { p }) {
    if (act === 'auto') {
      G.autoAttack = !G.autoAttack;
      ui.toast(`自动攻击已${G.autoAttack ? '开启' : '关闭'}`, C_GOOD);
      return;
    }
    if (act === 'fullscreen') {
      // iPhone Safari 等没有 Fullscreen API（直接调用会抛 “is not a function”）；老浏览器的返回值不是 Promise
      const exiting = isFullscreen();
      const target: Document | HTMLElement | undefined = exiting ? document : document.documentElement;
      const fn = (exiting ? document.exitFullscreen : document.documentElement?.requestFullscreen) as (() => unknown) | undefined;
      if (!target || typeof fn !== 'function') { ui.toast('当前浏览器不支持全屏', C_INFO); return; }
      let req: unknown;
      try {
        req = fn.call(target);
      } catch {
        ui.toast('浏览器拒绝了全屏请求', C_INFO);
        return;
      }
      Promise.resolve(req).then(() => ui.rerender(), () => ui.toast('浏览器拒绝了全屏请求', C_INFO));
      return;
    }
    if (act === 'to-title' && p) {
      ui.toTitle(true);
      return;
    }
    if (act === 'wipe' && p) {
      ui.confirm({
        title: '删除角色存档',
        html: `确定删除角色 <b>${esc(p.name)}</b>（槽位 ${G.slot + 1}）的存档并返回标题？<br><span class="down">此操作无法恢复。</span>`,
        okText: '删除',
        danger: true,
        onOk: () => {
          const slot = G.slot;
          if (run(() => deleteSlot(slot), '存档已删除')) ui.toTitle(false);
        },
      });
    }
  },
};
