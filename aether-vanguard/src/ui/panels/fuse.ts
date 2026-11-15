// 转职殿（融合转职）：逐项 ✓/✗ 条件与进度（改版意见 #17）、确认弹窗（只能融合一次）→ doFuse。

import { esc } from '../../core/util';
import { clsOf } from '../../data/classes';
import { ELEM } from '../../data/elements';
import { doFuse, type FuseOption, fuseOptions } from '../../game/player';
import type { Player } from '../../game/types';
import { ico } from '../icons';
import { cssColor, quiet, safe, ui } from '../shared';
import { passiveText } from './char';
import { btn, portrait, sec } from './common';
import type { PanelDef } from './types';

function cardHtml(o: FuseOption, p: Player): string {
  const f = o.fusion;
  const a = clsOf(f.from[0]), b = clsOf(f.from[1]);
  const el = ELEM[f.element];
  const ps = passiveText(f.id);
  const reasons = o.reasons.map(r => `<div class="reason ${r.ok ? 'ok' : 'no'}">${ico(r.ok ? 'check' : 'cross', 1)}${esc(r.text)}</div>`).join('');
  const done = !!p.fusedFrom;
  const label = done ? '已转职（只能一次）' : o.ready ? '融合转职' : '条件未满足';
  return `<div class="card fuse${o.ready && !done ? ' ready' : ' locked'}">
    <div class="fc-head">${portrait(f.id, 2)}<div><b class="t24" style="color:${cssColor(f.color)}">${esc(f.name)}</b> <span class="dim">${esc(f.en)}</span>
      <div class="dim">${esc(a.name)} + ${esc(b.name)} · <span style="color:${cssColor(el?.c)}">${esc(el?.n ?? '')}</span></div></div></div>
    <div>${esc(f.desc)}</div>
    <div class="dim">隐藏被动：<span class="gold">${esc(ps.name)}</span> ${esc(ps.desc)}</div>
    <div class="reasons">${reasons}</div>
    ${btn(label, 'fuse', f.id, { primary: o.ready && !done, disabled: !o.ready || done })}
  </div>`;
}

export const fusePanel: PanelDef = {
  title: () => '转职殿 · 融合转职',
  tabs: true,
  wide: true,
  needsPlayer: true,
  body({ p }) {
    if (!p) return '';
    const opts = safe(() => fuseOptions(p), [] as FuseOption[]);
    const cur = clsOf(p.cid);
    const intro = `<div class="soft">当前职业 <b style="color:${cssColor(cur.color)}">${esc(cur.name)}</b> Lv.${p.lv}。`
      + '当前职业达到 <b>Lv.10</b> 即可与另一职业的技艺融合，成为新的融合职业：继承来源职业技能，拥有自己的双分支技能树、奥义与隐藏被动。'
      + '<br><span class="gold">融合只能进行一次</span>，完成后无法再更换职业；想体验其他职业请在标题界面新建角色（最多 4 个存档槽）。'
      + (p.fusedFrom ? `<br><span class="up">${ico('check', 1)}你已完成融合转职。</span>` : '') + '</div>';
    if (!opts.length) {
      return intro + sec('可融合职业') + '<div class="soft dim">当前职业没有可用的融合路线（融合职业无法再次融合）。</div>';
    }
    return intro + sec('可融合职业') + `<div class="grid3 fuse-grid">${opts.map(o => cardHtml(o, p)).join('')}</div>`;
  },
  action(act, v, { p }) {
    if (!p || act !== 'fuse') return;
    const opt = safe(() => fuseOptions(p), [] as FuseOption[]).find(o => o.fusion.id === v);
    if (!opt || !opt.ready || p.fusedFrom) return;
    const f = opt.fusion;
    ui.confirm({
      title: '确认融合转职',
      html: `融合为 <b style="color:${cssColor(f.color)}">${esc(f.name)}</b>（${esc(clsOf(f.from[0]).name)} + ${esc(clsOf(f.from[1]).name)}）？`
        + '<br><span class="down">融合只能进行一次，之后无法更换职业。</span>'
        + '<br><span class="dim">等级、装备与金币保留；技能变为融合职业的技能组，并开启新的技能树。</span>',
      okText: '融合',
      onOk: () => {
        quiet(() => doFuse(p, f.id)); // doFuse 自己提示成功/失败
        ui.rerender();
        ui.refreshHud();
      },
    });
  },
};
