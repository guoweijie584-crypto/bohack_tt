// 数据移植自 legacy index(1).html（源能斗士 II），行号见各段注释。改数值请保持 id 不变以兼容存档。
// 新增：按武器类型/外观的名字表、护甲与饰品类型、武器外观（0x72 帧名，按品质 0..4 分档）。
import type { RarityDef, SlotId, AffixDef, AffixKey, WeaponType } from './types';

// L529-537
export const RARITY: RarityDef[] = [{n:'粗制',c:'#c9b9a2',mul:1},{n:'精良',c:'#a3c979',mul:1.3},
 {n:'稀有',c:'#7fb6d8',mul:1.65},{n:'史诗',c:'#c9a2f0',mul:2.1},{n:'传说',c:'#f0bd7c',mul:2.7}];
export const SLOTS: Record<SlotId, string> = {weapon:'武器',armor:'护甲',trinket:'饰品'};
/** legacy 名字表（只是字符串，与外观无关）。新版生成用下面的按类型名字表，这里保留给旧档名字推断 */
export const ITEM_BASE: Record<SlotId, string[]> = {weapon:['曙光长剑','余烬法杖','猎风长弓','霜晶权杖','雷纹短刃','脉动铳'],
 armor:['暖铁胸甲','织焰斗篷','游猎皮甲','寒霜外袍','动力外骨'],
 trinket:['共鸣指环','超载芯片','猎手徽记','储能核心','疾行护符']};
export const AFFIX: AffixDef[] = [{k:'atk',n:'攻击',min:2,max:10},{k:'armor',n:'护甲',min:1,max:6},
 {k:'hp',n:'生命',min:10,max:36},{k:'crit',n:'暴击',min:.01,max:.05},
 {k:'cdr',n:'冷却',min:.01,max:.04},{k:'spd',n:'移速',min:.02,max:.08}];

/* ---------- 新版：外观与名字（Item.sprite 取 0x72 帧名或渲染层程序化图标 key） ---------- */

/** 武器类型中文名（职业限制提示、面板展示） */
export const WEAPON_TYPE_NAMES: Record<WeaponType, string> = {
  sword: '剑/重武器', staff: '法杖', bow: '弓', dagger: '匕首',
};

/** 一种外观：精灵帧名 + 可用名字 */
export interface ItemLook { sprite: string; names: string[] }

/** 武器外观按品质 0..4 分档（数组长度不足 5 时按比例映射，见 itemgen.weaponLook） */
export const WEAPON_LOOKS: Record<WeaponType, ItemLook[]> = {
  sword: [
    { sprite: 'weapon_rusty_sword', names: ['锈蚀短剑', '旧铁剑', '拾荒者之剑'] },
    { sprite: 'weapon_regular_sword', names: ['制式长剑', '守卫长剑', '曙光长剑'] },
    { sprite: 'weapon_knight_sword', names: ['骑士长剑', '守誓之剑', '议会佩剑'] },
    { sprite: 'weapon_red_gem_sword', names: ['赤晶剑', '熔心剑', '源核之刃'] },
    { sprite: 'weapon_lavish_sword', names: ['王庭华剑', '曙光圣剑', '旧王遗剑'] },
  ],
  dagger: [
    { sprite: 'weapon_knife', names: ['剥皮小刀', '拾荒匕首', '短刀'] },
    { sprite: 'weapon_cleaver', names: ['屠夫砍刀', '厚背刀'] },
    { sprite: 'weapon_machete', names: ['丛林砍刀', '弯月刃'] },
    { sprite: 'weapon_katana', names: ['影月太刀', '无铭太刀'] },
    { sprite: 'weapon_anime_sword', names: ['雷纹影刃', '断空刃'] },
  ],
  staff: [
    { sprite: 'weapon_green_magic_staff', names: ['学徒法杖', '相位法杖', '源能法杖'] },
    { sprite: 'weapon_red_magic_staff', names: ['秘法权杖', '星轨权杖', '源核权杖'] },
  ],
  bow: [
    { sprite: 'weapon_bow', names: ['猎弓', '猎风长弓', '复合短弓'] },
    { sprite: 'weapon_bow_2', names: ['反曲战弓', '鹰眼长弓', '星落之弓'] },
  ],
};

/** 剑类的重武器变体（随机替换，增加多样性），按品质 0..4 分档 */
export const HEAVY_LOOKS: ItemLook[][] = [
  [{ sprite: 'weapon_mace', names: ['钉头锤', '铁头锤'] }, { sprite: 'weapon_baton_with_spikes', names: ['狼牙棒', '刺棍'] }],
  [{ sprite: 'weapon_hammer', names: ['战锤', '铁匠锤'] }, { sprite: 'weapon_axe', names: ['战斧', '伐木斧'] }],
  [{ sprite: 'weapon_saw_sword', names: ['锯齿剑', '裂齿刃'] }, { sprite: 'weapon_duel_sword', names: ['决斗剑', '刺击细剑'] }],
  [{ sprite: 'weapon_waraxe', names: ['巨战斧', '斩首斧'] }, { sprite: 'weapon_double_axe', names: ['双刃巨斧', '月牙双斧'] }],
  [{ sprite: 'weapon_big_hammer', names: ['碎岩巨锤', '撼地之锤'] }, { sprite: 'weapon_golden_sword', names: ['金辉大剑', '黄金誓约'] }],
];
/** 剑类出现重武器外观的概率 */
export const HEAVY_CHANCE = 0.35;

/** 匕首类的额外变体：飞斧 */
export const DAGGER_EXTRA: ItemLook = { sprite: 'weapon_throwing_axe', names: ['回旋飞斧', '投掷手斧'] };
export const DAGGER_EXTRA_CHANCE = 0.15;

/** 护甲类型：外观 key = `armor_<type>_<品质0-4>`（渲染层程序化生成） */
export type ArmorType = 'plate' | 'robe' | 'leather';
export const ARMOR_TYPES: readonly ArmorType[] = ['plate', 'robe', 'leather'];
export const ARMOR_NAMES: Record<ArmorType, string[]> = {
  plate: ['暖铁胸甲', '守望板甲', '动力外骨', '符文重铠'],
  robe: ['织焰斗篷', '寒霜外袍', '相位斗篷', '星纹法袍'],
  leather: ['游猎皮甲', '夜行软甲', '猎装皮甲', '影织轻甲'],
};

/** 饰品类型：外观 key = `trinket_<type>_<品质0-4>`（渲染层程序化生成） */
export type TrinketType = 'ring' | 'amulet' | 'chip';
export const TRINKET_TYPES: readonly TrinketType[] = ['ring', 'amulet', 'chip'];
export const TRINKET_NAMES: Record<TrinketType, string[]> = {
  ring: ['共鸣指环', '猎手指环', '余烬指环'],
  amulet: ['疾行护符', '守誓吊坠', '猎手徽记'],
  chip: ['超载芯片', '储能核心', '相位芯片'],
};

/** 各部位的主词条（保证“有效词条”：武器必有攻击、护甲必有护甲；饰品按类型） */
export const PRIMARY_AFFIX: { weapon: AffixKey; armor: AffixKey; trinket: Record<TrinketType, AffixKey> } = {
  weapon: 'atk',
  armor: 'armor',
  trinket: { ring: 'crit', amulet: 'hp', chip: 'cdr' },
};

/** 消耗品/掉落图标 key */
export const ICONS = {
  potionHp: 'flask_big_red',
  potionMp: 'flask_big_blue',
  gold: 'coin_anim_f0',
  exp: 'expgem',
  mat: { gem: 'mat_gem', part: 'mat_part', essence: 'mat_essence' },
} as const;
