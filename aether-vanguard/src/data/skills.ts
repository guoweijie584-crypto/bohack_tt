// 数据移植自 legacy index(1).html（源能斗士 II），行号见各段注释。改数值请保持 id 不变以兼容存档。
import type { SkillDef, UltDef } from './types';
import { FUSIONS } from './classes';

// L392-420
export const SKILLS: Record<string, SkillDef[]> = {
 warrior:[{key:'Q',n:'猛击',i:'✦',cd:4,cost:12,kind:'cleave',mult:1.9,el:'physical',d:'前方扇形重劈，击退敌人。'},
   {key:'E',n:'突进',i:'➤',cd:7,cost:18,kind:'charge',mult:1.5,el:'physical',d:'沿行走方向冲撞，眩晕路径敌人。'},
   {key:'R',n:'铁壁',i:'⬡',cd:15,cost:22,kind:'buff',mult:0,el:'physical',d:'获得护盾并减伤 6 秒。'}],
 pyro:[{key:'Q',n:'火球术',i:'✹',cd:3.6,cost:16,kind:'shot',mult:1.5,el:'fire',d:'火球命中造成灼烧。'},
   {key:'E',n:'火焰风暴',i:'☄',cd:9,cost:28,kind:'meteor',mult:2.7,el:'fire',d:'指定区域降下火雨，持续燃烧。'},
   {key:'R',n:'火焰爆裂',i:'✺',cd:7,cost:22,kind:'nova',mult:1.8,el:'fire',d:'以自身为中心爆发火焰冲击。'}],
 ranger:[{key:'Q',n:'精准射击',i:'➳',cd:3.5,cost:12,kind:'shot',mult:2,el:'physical',d:'高暴击单体射击，自动索敌。'},
   {key:'E',n:'连珠箭',i:'➶',cd:5,cost:18,kind:'multi',mult:.8,el:'physical',d:'扇形射出 7 支穿透箭。'},
   {key:'R',n:'荆棘陷阱',i:'⌗',cd:9,cost:20,kind:'trap',mult:1.3,el:'physical',d:'布置减速陷阱，踏入定身。'}],
 cryo:[{key:'Q',n:'冰箭',i:'❄',cd:3.4,cost:14,kind:'shot',mult:1.4,el:'ice',d:'冰箭造成减速。'},
   {key:'E',n:'冰环',i:'◉',cd:8,cost:26,kind:'nova',mult:1.6,el:'ice',d:'环形冲击冻结周围敌人。'},
   {key:'R',n:'寒冰护盾',i:'⬢',cd:15,cost:22,kind:'buff',mult:0,el:'ice',d:'吸收伤害的冰霜护盾。'}],
 storm:[{key:'Q',n:'雷击',i:'ϟ',cd:3.4,cost:20,kind:'chain',mult:1.5,el:'lightning',d:'雷电在敌人之间连锁弹跳。'},
   {key:'E',n:'雷霆冲击',i:'⚡',cd:8,cost:32,kind:'beam',mult:3,el:'lightning',d:'贯穿直线的高额雷电伤害。'},
   {key:'R',n:'过载',i:'◈',cd:14,cost:26,kind:'buff',mult:0,el:'lightning',d:'8 秒内技能伤害 +45%。'}],
 assassin:[{key:'Q',n:'匕首突袭',i:'🗡',cd:4,cost:14,kind:'charge',mult:2,el:'physical',d:'瞬步突进并背刺，暴击率提升。'},
   {key:'E',n:'潜行',i:'◐',cd:14,cost:20,kind:'buff',mult:0,el:'poison',d:'隐身 6 秒，下一击必定暴击。'},
   {key:'R',n:'毒雾',i:'☣',cd:9,cost:22,kind:'aura',mult:.6,el:'poison',d:'释放持续中毒与减速的毒雾。'}]
};
/* 融合职业继承来源职业技能并拥有专属奥义 */
FUSIONS.forEach(f => {
  const a=SKILLS[f.from[0]]||SKILLS.warrior,b=SKILLS[f.from[1]]||SKILLS.assassin;
  SKILLS[f.id]=[
    Object.assign({},a[0],{key:'Q',n:a[0].n}),
    Object.assign({},b[1],{key:'E',n:b[1].n}),
    Object.assign({},a[2],{key:'R',n:a[2].n})
  ];
});

// L496-512
export const ULTS: Record<string, UltDef> = {
 whirl:{n:'狂怒旋风',i:'✺',cd:20,cost:45,kind:'aura',mult:.7,el:'physical'},
 bulwark:{n:'不屈壁垒',i:'⬡',cd:24,cost:45,kind:'buff',mult:0,el:'physical'},
 inferno:{n:'末日焚域',i:'☄',cd:22,cost:55,kind:'meteor',mult:3,el:'fire'},
 meteors:{n:'陨火坠落',i:'✹',cd:22,cost:55,kind:'meteors',mult:2,el:'fire'},
 piercer:{n:'千钧一射',i:'➳',cd:18,cost:45,kind:'beam',mult:5,el:'physical'},
 arrowRain:{n:'箭雨',i:'➶',cd:22,cost:55,kind:'meteor',mult:2.4,el:'physical'},
 zero:{n:'绝对零度',i:'❄',cd:24,cost:55,kind:'nova',mult:2,el:'ice'},
 permafrost:{n:'永冻领域',i:'◉',cd:24,cost:55,kind:'aura',mult:.6,el:'ice'},
 thunderStorm:{n:'雷霆风暴',i:'ϟ',cd:22,cost:58,kind:'aura',mult:.8,el:'lightning'},
 thunderBolt:{n:'天雷陨落',i:'⚡',cd:20,cost:55,kind:'meteor',mult:4,el:'lightning'},
 execute:{n:'暗影绝杀',i:'🗡',cd:18,cost:45,kind:'charge',mult:5,el:'physical'},
 venom:{n:'蚀骨剧毒',i:'☣',cd:22,cost:50,kind:'aura',mult:.9,el:'poison'},
 cavalry:{n:'雷霆冲锋',i:'♞',cd:20,cost:50,kind:'charge',mult:3,el:'physical'},
 storm:{n:'源能风暴',i:'❈',cd:24,cost:55,kind:'aura',mult:.7,el:'arcane'},
 orbital:{n:'天基轨道炮',i:'⌖',cd:24,cost:55,kind:'beam',mult:5.2,el:'tech'}
};

/* ------------------------------------------------------------------ */
/* 技能表现与参数（combat 代理新增）                                      */
/* 不改 SkillDef/UltDef 类型：按“技能名 / 奥义 id”独立映射。                */
/* 融合职业的技能是基础技能的拷贝（同名），自动共用同一条配置。              */
/* ------------------------------------------------------------------ */

/** buff 类技能按“技能”分支（legacy 按职业 cid 分支 → 甲士“潜行”给护盾、风暴刺客“过载”给潜行） */
export type BuffKind = 'ironwall' | 'iceShield' | 'overload' | 'stealth';
/** 投射物外形（ProjectileKind 子集） */
export type ProjShape = 'arrow' | 'orb' | 'bolt' | 'fireball' | 'iceShard' | 'shuriken';

/** 持续地面区域（陨石落地后留下的火海等） */
export interface ZoneSpec {
  style: string;
  r: number;
  life: number;
  tick: number;
  /** 每跳伤害 = 本次施法伤害 × mul */
  mul: number;
  slow?: number;
}

export interface SkillFx {
  /** 视觉 key（生成的 hazard.style；无 hazard 的技能仅作说明） */
  style?: string;
  proj?: ProjShape;
  /** 投射物速度（世界单位/秒；legacy v×60） */
  speed?: number;
  /** 追踪转向速度（弧度/秒） */
  homing?: number;
  /** 溅射半径（溅射伤害 45%） */
  splash?: number;
  /** 额外暴击率（掷骰未暴击时再判一次） */
  critBonus?: number;
  buff?: BuffKind;
  /** 落地后生成的持续区域 */
  zone?: ZoneSpec;
}

export const SKILL_FX: Record<string, SkillFx> = {
  // 战士
  '猛击': { style: 'cleave' },
  '突进': { style: 'charge' },
  '铁壁': { buff: 'ironwall' },
  // 火焰魔法师
  '火球术': { proj: 'fireball', speed: 420, homing: 2.4, splash: 45 },
  '火焰风暴': { style: 'firestorm', zone: { style: 'firefield', r: 80, life: 3, tick: 0.5, mul: 0.15 } },
  '火焰爆裂': { style: 'fireNova' },
  // 游侠
  '精准射击': { proj: 'arrow', speed: 640, homing: 3.2, splash: 0, critBonus: 0.25 },
  '连珠箭': { proj: 'arrow', speed: 480 },
  '荆棘陷阱': { style: 'thorns' },
  // 冰霜魔法师
  '冰箭': { proj: 'iceShard', speed: 450, homing: 2.4, splash: 35 },
  '冰环': { style: 'frostNova' },
  '寒冰护盾': { buff: 'iceShield' },
  // 雷电魔法师
  '雷击': { style: 'chain' },
  '雷霆冲击': { style: 'thunderBeam' },
  '过载': { buff: 'overload' },
  // 刺客
  '匕首突袭': { style: 'shadowStep', critBonus: 0.25 },
  '潜行': { buff: 'stealth' },
  '毒雾': { style: 'poisonCloud' },
};

/**
 * 奥义独立表现（改版意见 #6 / R23）。style 即 hazard.style，渲染层据此选特效；
 * 每个奥义施放时都会生成至少一个 style === 奥义 id 的 hazard（纯视觉的 dmg=0）。
 * 数值字段的含义见各条 desc，未用到的字段省略。
 */
export interface UltFx {
  style: string;
  desc: string;
  /** 主半径（会乘“范围 +%”） */
  r?: number;
  life?: number;
  tick?: number;
  /** 伤害系数（相对一次 rollDmg） */
  mul?: number;
  /** 数量（陨石/箭/目标/落雷） */
  n?: number;
  delay?: number;
  /** 依次落下的间隔 */
  gap?: number;
  /** 散布半径 */
  spread?: number;
  stun?: number;
  slow?: number;
  /** 击退（>0 外推）/ 拉拽（<0 吸入）初速度 */
  knock?: number;
  /** 光束长度 / 冲锋距离 */
  len?: number;
  /** 光束 / 冲锋宽度 */
  w?: number;
  /** 冲锋时长 */
  dur?: number;
  /** 余波区域 */
  zoneR?: number;
  zoneLife?: number;
  zoneTick?: number;
  zoneMul?: number;
  /** 其它系数（护盾比例 / 次要伤害 / 冻结几率…） */
  extra?: number;
}

export const ULT_FX: Record<string, UltFx> = {
  whirl: { style: 'whirl', desc: '跟随施法者的旋风刀刃：高频挥砍并把敌人向外推开', r: 130, life: 4, tick: 0.25, mul: 0.4, knock: 60 },
  bulwark: { style: 'bulwark', desc: '巨额护盾 + 双重减伤 6 秒，展开瞬间震退身边敌人（护盾穹顶）', r: 120, life: 6, knock: 300, extra: 0.6 },
  inferno: { style: 'inferno', desc: '巨型陨星坠落，随后留下大范围火海', r: 120, delay: 0.9, stun: 0.5, zoneR: 160, zoneLife: 5, zoneTick: 0.4, zoneMul: 0.18 },
  meteors: { style: 'meteors', desc: '多颗陨石依次轰炸目标区域', n: 6, r: 70, delay: 0.7, gap: 0.18, spread: 80, mul: 0.625, stun: 0.4 },
  piercer: { style: 'piercer', desc: '贯穿直线的巨型箭矢光束（撞墙截断），终点爆出冲击', len: 1100, w: 16, knock: 300, stun: 0.3 },
  arrowRain: { style: 'arrowRain', desc: '目标区域内连续落下多支箭（六成箭矢会追着区域内的敌人落下）', n: 16, r: 30, delay: 0.3, gap: 0.1, spread: 110, mul: 0.35, extra: 0.6 },
  zero: { style: 'zero', desc: '极寒爆发：冻结周围全部敌人，并留下减速冰原', r: 230, stun: 1.6, slow: 0.55, zoneR: 200, zoneLife: 4, zoneTick: 0.6, zoneMul: 0.12 },
  permafrost: { style: 'permafrost', desc: '原地展开的永冻领域：持续冰伤、强减速、几率冻结（元素法师为冰火交替）', r: 180, life: 6, tick: 0.5, mul: 0.35, slow: 0.6, extra: 0.2 },
  thunderStorm: { style: 'thunderStorm', desc: '跟随施法者的雷暴：每跳在周围随机落雷', r: 210, life: 5, tick: 0.35, mul: 0.9, n: 2, stun: 0.15 },
  thunderBolt: { style: 'thunderBolt', desc: '天降巨型雷柱单点轰击', r: 70, delay: 0.6, stun: 1 },
  execute: { style: 'execute', desc: '连续闪烁到多个目标背后背刺（必定暴击，首个目标全额、其余 60%），结束后潜行', n: 5, len: 340, mul: 0.6, dur: 0.07, extra: 2 },
  venom: { style: 'venom', desc: '在目标区域展开剧毒领域：每跳叠 2 层中毒并减速', r: 150, life: 6, tick: 0.5, mul: 0.35, slow: 0.3, n: 2, len: 360 },
  cavalry: { style: 'cavalry', desc: '长距离骑枪冲锋：践踏沿途敌人，终点震地', len: 320, dur: 0.42, w: 34, stun: 0.8, knock: 420, zoneR: 110, zoneMul: 0.5 },
  storm: { style: 'storm', desc: '跟随施法者的源能漩涡：持续伤害并把敌人卷向中心', r: 190, life: 5, tick: 0.3, mul: 0.45, knock: -160 },
  orbital: { style: 'orbital', desc: '天基轨道炮：天降光柱轰击目标点，随后周围落下余波光柱', r: 90, delay: 0.6, n: 4, spread: 95, extra: 0.35, zoneR: 50 },
};

/** 镜像对手技能伤害系数（相对 e.atk × mult），以及基础暴击率 */
export const RIVAL_SKILL_MUL = 0.7;
export const RIVAL_CRIT = 0.08;
