// 数据移植自 legacy index(1).html（源能斗士 II），行号见各段注释。改数值请保持 id 不变以兼容存档。
import type { ClassDef, FusionDef } from './types';

// L354-389
export const CLASSES: ClassDef[] = [
 {id:'warrior',name:'战士',en:'WARRIOR',icon:'⚔',tag:'近战·重甲',core:'力量/体质',element:'physical',
  weapon:'sword',hp:200,mp:70,atk:20,armor:13,spd:1.5,crit:.05,range:56,atkCd:.5,color:'#e0954f',hair:'#5a3a22',
  desc:'重武器与厚甲，抗伤、范围劈砍与突进压制。'},
 {id:'pyro',name:'火焰魔法师',en:'PYROMANCER',icon:'✹',tag:'远程·爆发',core:'智力',element:'fire',
  weapon:'staff',hp:112,mp:140,atk:24,armor:4,spd:1.42,crit:.08,range:270,atkCd:.52,color:'#f0804a',hair:'#c46a3a',
  desc:'火焰与灼烧，大范围持续伤害，身板脆弱。'},
 {id:'ranger',name:'游侠',en:'RANGER',icon:'➶',tag:'远程·机动',core:'敏捷',element:'physical',
  weapon:'bow',hp:138,mp:105,atk:17,armor:6,spd:1.72,crit:.18,range:290,atkCd:.32,color:'#9fc46a',hair:'#3d5c36',
  desc:'弓箭拉扯、陷阱控制、物理暴击与中远距离持续输出。'},
 {id:'cryo',name:'冰霜魔法师',en:'CRYOMANCER',icon:'❄',tag:'远程·控制',core:'智力',element:'ice',
  weapon:'staff',hp:120,mp:135,atk:19,armor:6,spd:1.4,crit:.07,range:265,atkCd:.5,color:'#7fc4dd',hair:'#b9dcec',
  desc:'冰霜减速与冻结，群体限制敌人，输出偏持续。'},
 {id:'storm',name:'雷电魔法师',en:'STORMCALLER',icon:'ϟ',tag:'远程·连锁',core:'智力',element:'lightning',
  weapon:'staff',hp:108,mp:165,atk:26,armor:3,spd:1.43,crit:.1,range:255,atkCd:.55,color:'#e9c75e',hair:'#d8c878',
  desc:'雷电在多个目标间弹跳，瞬间爆发极高，源能消耗也极高。'},
 {id:'assassin',name:'刺客',en:'ASSASSIN',icon:'🗡',tag:'近战·爆发',core:'敏捷',element:'poison',
  weapon:'dagger',hp:115,mp:95,atk:22,armor:4,spd:1.78,crit:.28,range:50,atkCd:.3,color:'#a97bc4',hair:'#3a2c48',
  desc:'匕首、潜行与背刺，高暴击高闪避，瞬间秒杀但极脆。'}
];
// 融合职业：tag/core 为新版补充的展示字段（legacy 缺失）；数值与 id 不变
export const FUSIONS: FusionDef[] = [
 {id:'knight',name:'骑士',from:['warrior','ranger'],icon:'♞',en:'KNIGHT',tag:'近战·均衡',core:'力量/体质',element:'physical',
  desc:'重甲骑射，攻防均衡，可近战劈砍也能远程狙击。',color:'#d8a45c',weapon:'sword',hp:215,mp:100,atk:23,armor:14,spd:1.58,crit:.12,range:120,atkCd:.42},
 {id:'armored',name:'甲士',from:['warrior','assassin'],icon:'⬢',en:'ARMORED',tag:'近战·破甲',core:'力量/敏捷',element:'physical',
  desc:'披甲暗杀者，高容错突进与破甲背刺。',color:'#b07a58',weapon:'sword',hp:200,mp:90,atk:26,armor:13,spd:1.62,crit:.22,range:62,atkCd:.36},
 {id:'elemage',name:'元素法师',from:['pyro','cryo'],icon:'❈',en:'ELEMAGE',tag:'远程·双元素',core:'智力',element:'fire',
  desc:'掌控冰火双元素，自由切换灼烧与冻结。',color:'#e8956a',weapon:'staff',hp:118,mp:170,atk:28,armor:5,spd:1.45,crit:.1,range:285,atkCd:.46},
 {id:'ninja',name:'忍者',from:['ranger','assassin'],icon:'✧',en:'NINJA',tag:'中程·游击',core:'敏捷',element:'poison',
  desc:'高速游走，潜行、陷阱与暗器的游击专家。',color:'#8fb98a',weapon:'dagger',hp:130,mp:120,atk:24,armor:6,spd:1.86,crit:.3,range:180,atkCd:.26},
 {id:'stormblade',name:'风暴刺客',from:['storm','assassin'],icon:'⚡',en:'STORMBLADE',tag:'近战·法术混合',core:'敏捷/智力',element:'lightning',
  desc:'潜行近身释放连锁雷电，法术近战混合。',color:'#d8b45e',weapon:'dagger',hp:120,mp:160,atk:30,armor:4,spd:1.8,crit:.28,range:150,atkCd:.3},
 {id:'stormguard',name:'风暴守卫',from:['storm','warrior'],icon:'⬡',en:'STORMGUARD',tag:'近战·坦克',core:'体质/智力',element:'lightning',
  desc:'重甲雷霆坦克，承伤同时释放大范围雷电。',color:'#c9a25e',weapon:'sword',hp:225,mp:150,atk:25,armor:16,spd:1.48,crit:.09,range:110,atkCd:.46}
];
export const ALL_CLASSES: ClassDef[] = [...CLASSES, ...FUSIONS];
/** 按 id 查职业；未知 id 回落到战士（注意：参数必须是 id 字符串，legacy L604 传了玩家对象） */
export const clsOf = (id: string): ClassDef => ALL_CLASSES.find(c => c.id === id) || CLASSES[0];
export const isClassId = (id: unknown): id is string => typeof id === 'string' && ALL_CLASSES.some(c => c.id === id);
export const isBaseClass = (id: unknown): boolean => typeof id === 'string' && CLASSES.some(c => c.id === id);
export const fusionOf = (id: string): FusionDef | undefined => FUSIONS.find(f => f.id === id);
