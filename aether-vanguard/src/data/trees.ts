// 数据移植自 legacy index(1).html（源能斗士 II），行号见各段注释。改数值请保持 id 不变以兼容存档。
// 新版修订：节点描述 d 改为与 eff 一致的真实效果（legacy 多处“名不副实”，见 code_part1 §3、versions_docs §2.3）。
// 节点名 n、eff 键与数值、奥义 id 均未改动；终极节点写明实际解锁的奥义（融合职业多数复用基础奥义）。
import type { TreeNode, ClassTree, RouteDef, RouteId, EffMap, EffKey } from './types';

// L424-494
function nd(n: string, d: string, eff?: EffMap, ult?: string): TreeNode { return { n, d, eff: eff || {}, ult: ult || null }; }
export const TREES: Record<string, ClassTree> = {
 warrior:{A:{n:'【强攻】',nodes:[nd('猛击','攻击 +18%',{atk:.18}),nd('横扫','攻击与技能范围 +25%',{range:.25}),
   nd('破甲打击','无视 30% 护甲',{pen:.3}),nd('狂怒旋风','解锁奥义「狂怒旋风」，攻击 +20%',{atk:.2},'whirl')]},
  B:{n:'【坚守】',nodes:[nd('铁壁','护盾效果 +40%',{shield:.4}),nd('嘲讽','护甲 +12%',{armor:.12}),
   nd('坚守姿态','最大生命 +20%',{hp:.2}),nd('不屈壁垒','解锁奥义「不屈壁垒」，护甲 +30%',{armor:.3},'bulwark')]}},
 pyro:{A:{n:'【焚烬】',nodes:[nd('火球术','灼烧伤害 +35%',{burn:.35}),nd('火焰风暴','攻击与技能范围 +30%',{range:.3}),
   nd('燃烧增幅','元素状态时长 +35%',{elemDur:.35}),nd('末日焚域','解锁奥义「末日焚域」，灼烧伤害 +50%',{burn:.5},'inferno')]},
  B:{n:'【爆燃】',nodes:[nd('火焰爆裂','技能伤害 +18%',{skillDmg:.18}),nd('烈焰冲击','攻击 +15%',{atk:.15}),
   nd('火焰暴击','暴击率 +10%',{crit:.1}),nd('陨火坠落','解锁奥义「陨火坠落」，技能伤害 +30%',{skillDmg:.3},'meteors')]}},
 ranger:{A:{n:'【狙击】',nodes:[nd('精准射击','暴击率 +15%',{crit:.15}),nd('穿透箭','投射物穿透 +2',{pierce:2}),
   nd('弱点洞察','攻击 +18%',{atk:.18}),nd('千钧一射','解锁奥义「千钧一射」，暴击率 +20%',{crit:.2},'piercer')]},
  B:{n:'【游击】',nodes:[nd('连珠箭','冷却缩减 +12%',{cdr:.12}),nd('荆棘陷阱','攻击与技能范围 +35%',{range:.35}),
   nd('疾跑','移速 +14%',{spd:.14}),nd('箭雨','解锁奥义「箭雨」，技能伤害 +25%',{skillDmg:.25},'arrowRain')]}},
 cryo:{A:{n:'【冻结】',nodes:[nd('冰箭','冰霜效果 +30%',{freeze:.3}),nd('冰环','元素状态时长 +40%',{elemDur:.4}),
   nd('深度严寒','技能伤害 +15%',{skillDmg:.15}),nd('绝对零度','解锁奥义「绝对零度」，冰霜效果 +50%',{freeze:.5},'zero')]},
  B:{n:'【寒冰屏障】',nodes:[nd('寒冰护盾','护盾效果 +50%',{shield:.5}),nd('冰墙','护甲 +20%',{armor:.2}),
   nd('冰霜护甲','最大生命 +12%',{hp:.12}),nd('永冻领域','解锁奥义「永冻领域」，冰霜效果 +40%',{freeze:.4},'permafrost')]}},
 storm:{A:{n:'【连锁雷霆】',nodes:[nd('雷击','连锁目标 +2',{chain:2}),nd('连锁闪电','雷电伤害 +25%',{shock:.25}),
   nd('导电','源能回复 +5/秒',{mpRegen:5}),nd('雷霆风暴','解锁奥义「雷霆风暴」，雷电伤害 +40%',{shock:.4},'thunderStorm')]},
  B:{n:'【雷霆爆裂】',nodes:[nd('雷霆冲击','技能伤害 +22%',{skillDmg:.22}),nd('过载','暴击率 +12%',{crit:.12}),
   nd('雷霆震击','击退 +80%',{knock:.8}),nd('天雷陨落','解锁奥义「天雷陨落」，技能伤害 +40%',{skillDmg:.4},'thunderBolt')]}},
 assassin:{A:{n:'【暗杀】',nodes:[nd('匕首突袭','暴击率 +15%',{crit:.15}),nd('潜行','潜行时长 +3 秒',{stealth:3}),
   nd('背刺','攻击 +50%',{atk:.5}),nd('暗影绝杀','解锁奥义「暗影绝杀」，暴击率 +25%',{crit:.25},'execute')]},
  B:{n:'【淬毒】',nodes:[nd('淬毒匕首','普攻附加中毒，中毒伤害 +50%',{poison:.5}),nd('毒雾','攻击与技能范围 +30%',{range:.3}),
   nd('麻痹毒药','普攻附带迟缓，迟缓强化 +40%',{slow:.4}),nd('蚀骨剧毒','解锁奥义「蚀骨剧毒」，中毒伤害 +100%',{poison:1},'venom')]}},
 knight:{A:{n:'【重骑冲锋】',nodes:[nd('骑枪突刺','攻击 +22%',{atk:.22}),nd('践踏冲击','攻击与技能范围 +25%',{range:.25}),
   nd('重甲强化','护甲 +25%',{armor:.25}),nd('雷霆冲锋','解锁奥义「雷霆冲锋」，击退 +100%',{knock:1},'cavalry')]},
  B:{n:'【游骑射击】',nodes:[nd('马上射箭','移速 +12%',{spd:.12}),nd('箭盾协同','护盾效果 +40%',{shield:.4}),
   nd('移动射击','冷却缩减 +15%',{cdr:.15}),nd('千骑箭阵','解锁奥义「箭雨」，投射物穿透 +2',{pierce:2},'arrowRain')]}},
 armored:{A:{n:'【破甲暗杀】',nodes:[nd('重甲突袭','无视 35% 护甲',{pen:.35}),nd('破甲斩击','攻击 +25%',{atk:.25}),
   nd('匿甲潜行','潜行时长 +2 秒',{stealth:2}),nd('破阵暗袭','解锁奥义「暗影绝杀」，无视 30% 护甲',{pen:.3},'execute')]},
  B:{n:'【戍卫绞杀】',nodes:[nd('浴血反击','最大生命 +18%',{hp:.18}),nd('护甲吸血','伤害吸血 8%',{lifesteal:.08}),
   nd('威慑怒吼','护甲 +15%',{armor:.15}),nd('铁血绞杀','解锁奥义「狂怒旋风」，攻击 +40%',{atk:.4},'whirl')]}},
 elemage:{A:{n:'【焚冰毁灭】',nodes:[nd('冰火弹','灼烧伤害 +25%，冰霜效果 +25%',{burn:.25,freeze:.25}),
   nd('熔霜爆破','技能伤害 +20%',{skillDmg:.2}),nd('温压失衡','元素状态时长 +40%',{elemDur:.4}),
   nd('冰火湮灭','解锁奥义「末日焚域」，灼烧伤害 +50%，冰霜效果 +50%',{burn:.5,freeze:.5},'inferno')]},
  B:{n:'【元素调和】',nodes:[nd('形态切换','冷却缩减 +15%',{cdr:.15}),nd('元素护盾','护盾效果 +50%',{shield:.5}),
   nd('元素回流','源能回复 +6/秒',{mpRegen:6}),nd('双元领域','解锁奥义「永冻领域」，元素状态时长 +60%',{elemDur:.6},'permafrost')]}},
 ninja:{A:{n:'【影袭飞刃】',nodes:[nd('手里剑','投射物穿透 +2',{pierce:2}),nd('瞬步','移速 +18%',{spd:.18}),
   nd('暗影标记','暴击率 +18%',{crit:.18}),nd('千影瞬杀','解锁奥义「暗影绝杀」，攻击 +40%',{atk:.4},'execute')]},
  B:{n:'【诡术陷阱】',nodes:[nd('多重陷阱','攻击与技能范围 +40%',{range:.4}),nd('烟雾隐身','潜行时长 +3 秒',{stealth:3}),
   nd('麻痹暗器','普攻附带迟缓，迟缓强化 +50%',{slow:.5}),nd('幻罗毒域','解锁奥义「蚀骨剧毒」，中毒伤害 +80%',{poison:.8},'venom')]}},
 stormblade:{A:{n:'【雷影暗杀】',nodes:[nd('雷刃突袭','雷电伤害 +30%',{shock:.3}),nd('雷隐','潜行时长 +2 秒',{stealth:2}),
   nd('电光背刺','暴击率 +20%',{crit:.2}),nd('雷影瞬杀','解锁奥义「雷霆风暴」，连锁目标 +3',{chain:3},'thunderStorm')]},
  B:{n:'【爆裂雷毒】',nodes:[nd('淬雷毒刃','普攻附加中毒，中毒伤害 +60%',{poison:.6}),nd('雷暴毒云','元素状态时长 +40%',{elemDur:.4}),
   nd('过载麻痹','技能伤害 +20%',{skillDmg:.2}),nd('风暴毒爆','解锁奥义「末日焚域」，雷电伤害 +50%',{shock:.5},'inferno')]}},
 stormguard:{A:{n:'【雷霆战阵】',nodes:[nd('雷拳冲击','攻击 +22%',{atk:.22}),nd('雷霆震荡','攻击与技能范围 +30%',{range:.3}),
   nd('充能打击','雷电伤害 +30%',{shock:.3}),nd('万雷撼地','解锁奥义「雷霆风暴」，连锁目标 +3',{chain:3},'thunderStorm')]},
  B:{n:'【雷霆壁垒】',nodes:[nd('雷霆护甲','护甲 +30%',{armor:.3}),nd('静电斥力','击退 +80%',{knock:.8}),
   nd('守护光环','最大生命 +20%',{hp:.2}),nd('风暴庇护','解锁奥义「不屈壁垒」，护盾效果 +80%',{shield:.8},'bulwark')]}}
};
/* ---------- 魔法 / 机械：技能路线（独立可点的技能树，各路线点数分开计数） ---------- */
export const ROUTES: Record<RouteId, RouteDef> = {
 magic:{id:'magic',name:'奥术',en:'ARCANE',icon:'❈',color:'#c9a2f0',
  desc:'咏唱源能，强化元素状态与法术爆发；点满解锁奥义「源能风暴」。',
  mpRegen:8,skillDmg:1.15,cdMul:1,pierce:0,spdMul:1,
  nodes:[nd('源能亲和','源能回复 +4/秒',{mpRegen:4}),
    nd('法术共鸣','技能伤害 +15%',{skillDmg:.15}),
    nd('元素增幅','元素状态时长 +40%',{elemDur:.4}),
    nd('奥术穿透','元素与克制伤害 +20%',{elemPen:.2}),
    nd('源能风暴','解锁奥义「源能风暴」，技能伤害 +20%',{skillDmg:.2},'storm')]},
 tech:{id:'tech',name:'机械',en:'TECH',icon:'⌖',color:'#7fd6c4',
  desc:'铸造外装，强化弹道、冷却与机动；点满解锁奥义「天基轨道炮」。',
  mpRegen:3,skillDmg:1,cdMul:.85,pierce:1,spdMul:1.06,
  nodes:[nd('战术外装','冷却缩减 +10%',{cdr:.1}),
    nd('穿甲弹头','投射物穿透 +1',{pierce:1}),
    nd('伺服关节','移速 +10%',{spd:.1}),
    nd('过载核心','普攻命中回复源能 +5',{mpOnHit:5}),
    nd('天基轨道炮','解锁奥义「天基轨道炮」，技能伤害 +35%',{skillDmg:.35},'orbital')]}
};

/* ---------- 效果文字（UI 汇总展示用；与上面节点描述同一套措辞） ---------- */
/** 以百分比显示的效果键 */
export const EFF_PCT: ReadonlySet<EffKey> = new Set<EffKey>([
  'atk', 'range', 'pen', 'shield', 'armor', 'hp', 'burn', 'elemDur', 'skillDmg', 'crit', 'cdr', 'spd',
  'freeze', 'shock', 'knock', 'poison', 'slow', 'lifesteal', 'elemPen',
]);
export const EFF_LABEL: Record<EffKey, string> = {
  atk: '攻击', range: '攻击与技能范围', pen: '护甲穿透', shield: '护盾效果', armor: '护甲', hp: '最大生命',
  burn: '灼烧伤害', elemDur: '元素状态时长', skillDmg: '技能伤害', crit: '暴击率', pierce: '投射物穿透',
  cdr: '冷却缩减', spd: '移速', freeze: '冰霜效果', chain: '连锁目标', shock: '雷电伤害', mpRegen: '源能回复',
  knock: '击退', stealth: '潜行时长', poison: '中毒伤害', slow: '普攻迟缓强化', lifesteal: '伤害吸血',
  elemPen: '元素与克制伤害', mpOnHit: '普攻命中回复源能',
};
/** 单个效果的文字，如 “攻击 +18%”“潜行时长 +3 秒”“源能回复 +5/秒” */
export function effLine(k: EffKey, v: number): string {
  const sign = v >= 0 ? '+' : '-';
  const a = Math.abs(v);
  if (EFF_PCT.has(k)) return `${EFF_LABEL[k]} ${sign}${Math.round(a * 1000) / 10}%`;
  if (k === 'stealth') return `${EFF_LABEL[k]} ${sign}${a} 秒`;
  if (k === 'mpRegen') return `${EFF_LABEL[k]} ${sign}${a}/秒`;
  return `${EFF_LABEL[k]} ${sign}${a}`;
}
/** 一组效果的文字（顿号分隔），空效果返回空串 */
export function effText(eff: EffMap): string {
  const parts: string[] = [];
  for (const k of Object.keys(eff) as EffKey[]) {
    const v = eff[k];
    if (typeof v === 'number' && v !== 0) parts.push(effLine(k, v));
  }
  return parts.join('、');
}
