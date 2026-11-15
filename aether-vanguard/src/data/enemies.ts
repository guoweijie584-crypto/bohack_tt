// 首领经验基数按“推荐等级击杀约升 1–1.5 级”校准（升级曲线 90×1.15^(lv-1) 为指数，怪物经验随等级线性增长）
// 数据移植自 legacy index(1).html（源能斗士 II）L515–528。改数值请保持 id 不变以兼容存档。
// 新版补充字段：sprite（0x72 DungeonTileset II 精灵基名，或程序化精灵 proc_*）/ tint 换色 / scale 显示缩放 /
// flying 飞行（可越过水面、熔岩、深坑）/ summons 召唤表 / shieldPct 护盾比例 / bossKit 首领技能组 / desc 图鉴描述。
// 注意：spd 仍按 legacy “每帧像素” 记录，spawnEnemy 时 ×60 换算为 世界单位/秒；range 为世界单位。
// 外观约定：镜像对手 rival 不在本表，sprite = 'skin_<职业id>'（由 spawnRival 动态构造 def）。
import type { EnemyDef } from './types';

export const ENEMIES: Record<string, EnemyDef> = {
  /* ---------------- legacy 原 12 种（数值不变） ---------------- */
  slime: {
    n: '源泥怪', hp: 60, atk: 14, spd: 0.8, armor: 3, exp: 12, gold: 5, r: 11, el: 'physical', weak: 'fire',
    s: 'slime', c: '#8fbf6a', ai: 'chase', sprite: 'swampy',
    desc: '被源能浸透的沼泥，缓慢蠕行，贴身黏咬。怕火。',
  },
  goblin: {
    n: '荒原掠夺者', hp: 95, atk: 21, spd: 1.15, armor: 6, exp: 20, gold: 10, r: 11, el: 'physical', weak: 'ice',
    s: 'goblin', c: '#d0905a', ai: 'chase', sprite: 'goblin',
    desc: '成群出没的拾荒小鬼，贪婪又敏捷，扑上来就是一刀。',
  },
  bat: {
    n: '蚀能蝠', hp: 72, atk: 18, spd: 1.45, armor: 3, exp: 19, gold: 9, r: 10, el: 'poison', weak: 'fire',
    s: 'bat', c: '#a88ad0', ai: 'shooter', range: 220, sprite: 'imp', flying: true,
    desc: '吞食源能的飞行小魔，绕着猎物盘旋，远远喷吐毒性能量弹。',
  },
  eye: {
    n: '虚空之眼', hp: 120, atk: 26, spd: 0.85, armor: 7, exp: 30, gold: 16, r: 12, el: 'arcane', weak: 'lightning',
    s: 'eye', c: '#c070c0', ai: 'shooter', range: 260, sprite: 'proc_eye', flying: true,
    desc: '悬浮的奥术之眼，凝视之处会射出虚空光弹。',
  },
  golem: {
    n: '遗迹守望者', hp: 340, atk: 36, spd: 0.7, armor: 16, exp: 85, gold: 45, r: 16, el: 'physical', weak: 'lightning',
    s: 'golem', c: '#a89a86', ai: 'charger', elite: true, sprite: 'ogre', tint: 0xb8b0a0,
    desc: '石化的古代守卫。身体发白闪烁时即将冲撞——侧身躲开，它撞墙会短暂眩晕。',
  },
  wisp: {
    n: '熔核游魂', hp: 140, atk: 30, spd: 1.2, armor: 8, exp: 40, gold: 20, r: 11, el: 'fire', weak: 'ice',
    s: 'wisp', c: '#f09050', ai: 'chase', sprite: 'proc_wisp', flying: true,
    desc: '熔核裂隙飘出的火魂，能越过岩浆直扑而来，灼热扑面。',
  },
  frost: {
    n: '霜缚幽魂', hp: 155, atk: 28, spd: 1.0, armor: 10, exp: 42, gold: 21, r: 12, el: 'ice', weak: 'fire',
    s: 'wisp', c: '#8fc8e0', ai: 'shooter', range: 230, sprite: 'ice_zombie',
    desc: '被寒霜禁锢的亡者，投掷冰晶减缓来敌。',
  },
  spark: {
    n: '电弧爬行者', hp: 130, atk: 33, spd: 1.5, armor: 6, exp: 44, gold: 22, r: 11, el: 'lightning', weak: 'poison',
    s: 'bat', c: '#e8d070', ai: 'charger', sprite: 'wogol', tint: 0xffe070,
    desc: '浑身电弧的爬行者，蓄电后猛然突进。',
  },
  brute: {
    n: '源能巨兽', hp: 420, atk: 42, spd: 0.75, armor: 18, exp: 100, gold: 55, r: 18, el: 'physical', weak: 'poison',
    s: 'golem', c: '#c07858', ai: 'charger', elite: true, sprite: 'big_zombie',
    desc: '被源能撑裂的巨兽，冲锋足以撞碎石墙。',
  },
  venom: {
    n: '腐毒蛛', hp: 165, atk: 32, spd: 1.35, armor: 8, exp: 48, gold: 24, r: 12, el: 'poison', weak: 'fire',
    s: 'slime', c: '#8fb060', ai: 'chase', sprite: 'proc_spider',
    desc: '潜伏在暗处的毒蛛，獠牙带有剧毒。',
  },
  shade: {
    n: '影缚者', hp: 190, atk: 38, spd: 1.5, armor: 9, exp: 60, gold: 30, r: 12, el: 'arcane', weak: 'lightning',
    s: 'eye', c: '#8a70a8', ai: 'charger', sprite: 'chort', tint: 0x8a70c8,
    desc: '被暗影束缚的恶魔，蓄势后瞬间扑杀。',
  },
  boss: {
    n: '源核暴君', hp: 2600, atk: 52, spd: 0.85, armor: 22, exp: 280, gold: 500, r: 26, el: 'fire', weak: 'ice',
    s: 'boss', c: '#e06858', ai: 'boss', boss: true, sprite: 'big_demon', scale: 1.6, bossKit: 'tyrant',
    desc: '源核深处的炎魔君主：环形火弹、陨石雨与冲锋；血量过半后狂暴提速，并撕裂空间召来熔核游魂。',
  },

  /* ---------------- 新增普通怪 ---------------- */
  skeleton: {
    n: '骸骨兵', hp: 85, atk: 19, spd: 1.0, armor: 5, exp: 17, gold: 8, r: 11, el: 'physical', weak: 'arcane',
    s: 'skeleton', c: '#d8d0c0', ai: 'chase', sprite: 'skelet',
    desc: '被亡灵术唤起的骸骨战士，不知疲倦。奥术能瓦解其魂火。',
  },
  zombie: {
    n: '行尸', hp: 190, atk: 24, spd: 0.6, armor: 7, exp: 28, gold: 12, r: 12, el: 'poison', weak: 'fire',
    s: 'zombie', c: '#7f9a6a', ai: 'chase', sprite: 'zombie',
    desc: '步履蹒跚却极耐打的腐尸，抓挠带毒。',
  },
  tiny_zombie: {
    n: '腐尸幼体', hp: 38, atk: 11, spd: 1.7, armor: 1, exp: 7, gold: 3, r: 8, el: 'poison', weak: 'fire',
    s: 'zombie', c: '#9ab07a', ai: 'chase', sprite: 'tiny_zombie',
    desc: '弱小却飞快的腐尸幼体，常成群扑来。',
  },
  muddy: {
    n: '泥沼怪', hp: 150, atk: 22, spd: 0.7, armor: 20, exp: 32, gold: 16, r: 12, el: 'physical', weak: 'arcane',
    s: 'slime', c: '#8a7350', ai: 'chase', sprite: 'muddy',
    desc: '裹满淤泥的厚重怪物，护甲极高——用破甲、奥术或持续伤害对付它。',
  },
  orc_warrior: {
    n: '铁颚兽人', hp: 210, atk: 30, spd: 0.95, armor: 12, exp: 55, gold: 26, r: 12, el: 'physical', weak: 'tech',
    s: 'goblin', c: '#7a9a5a', ai: 'shield', shieldPct: 0.35, sprite: 'orc_warrior',
    desc: '举着铁盾的兽人战士，周期性举盾（期间移速减半）：先打破护盾才能伤到本体，破盾后会短暂踉跄。',
  },
  masked_orc: {
    n: '面具刺客', hp: 150, atk: 34, spd: 1.55, armor: 7, exp: 50, gold: 25, r: 11, el: 'poison', weak: 'ice',
    s: 'goblin', c: '#6a8a6a', ai: 'flank', sprite: 'masked_orc',
    desc: '戴骨面具的兽人刺客，不正面硬拼：绕到侧后方突袭，一击即退。',
  },
  orc_shaman: {
    n: '兽人萨满', hp: 130, atk: 24, spd: 0.9, armor: 6, exp: 55, gold: 28, r: 11, el: 'lightning', weak: 'physical',
    s: 'goblin', c: '#8ab060', ai: 'summoner', range: 240, summons: ['tiny_zombie', 'skeleton'], sprite: 'orc_shaman',
    desc: '吟唱亡魂之歌的萨满，保持距离召唤腐尸与骸骨，间或甩出电弧。',
  },
  necromancer: {
    n: '亡灵术士', hp: 300, atk: 34, spd: 0.85, armor: 10, exp: 110, gold: 60, r: 12, el: 'arcane', weak: 'physical',
    s: 'eye', c: '#9a7ad0', ai: 'summoner', range: 260, elite: true, summons: ['skeleton', 'zombie'], sprite: 'necromancer',
    desc: '操纵死者的精英术士，源源不断唤起骸骨与行尸——优先击杀！',
  },

  /* ---------------- 新增首领 ---------------- */
  warden: {
    n: '遗迹执守者', hp: 3000, atk: 56, spd: 0.8, armor: 26, exp: 140, gold: 520, r: 26, el: 'physical', weak: 'lightning',
    s: 'golem', c: '#c8bca8', ai: 'boss', boss: true, sprite: 'ogre', scale: 1.7, tint: 0xc8bca8, bossKit: 'warden',
    desc: '远古遗迹的石之执守者：震地冲击波环、投石与冲锋；二阶段披上岩甲（护盾）并连续震地。',
  },
  lich: {
    n: '霜冠巫妖', hp: 2400, atk: 58, spd: 0.8, armor: 18, exp: 680, gold: 540, r: 22, el: 'ice', weak: 'fire',
    s: 'eye', c: '#9ad8ff', ai: 'boss', boss: true, range: 300, sprite: 'necromancer', scale: 2.2, tint: 0x9ad8ff, bossKit: 'lich',
    desc: '戴着霜冠的不死法师：冰刺螺旋弹幕、冰封地面并唤起骸骨，近身时释放霜爆；二阶段弹幕更密、冰域更广。',
  },
  shadow_lord: {
    n: '幽影君主', hp: 2800, atk: 60, spd: 0.95, armor: 20, exp: 1200, gold: 560, r: 24, el: 'arcane', weak: 'lightning',
    s: 'boss', c: '#9a7ad0', ai: 'boss', boss: true, sprite: 'big_demon', scale: 1.7, tint: 0x9a7ad0, bossKit: 'shadow',
    desc: '暗影的主宰：瞬移到背后斩击、扇形暗影弹与分身；二阶段分身更多、瞬移更频繁。',
  },

  /* ---------------- 首领召唤物（不进刷怪池） ---------------- */
  shadow_clone: {
    n: '幽影分身', hp: 220, atk: 30, spd: 1.6, armor: 6, exp: 0, gold: 0, r: 14, el: 'arcane', weak: 'lightning',
    s: 'boss', c: '#7a5ab0', ai: 'flank', sprite: 'big_demon', scale: 0.9, tint: 0x6a50a0,
    desc: '幽影君主分裂出的残影，脆弱但迅捷，会绕后偷袭。',
  },
};

/** 只能由首领/召唤者产生、不应放进刷怪池的 kind */
export const SUMMON_ONLY_KINDS: ReadonlySet<string> = new Set(['shadow_clone']);

/** 全部首领 kind（world 选副本首领时可用） */
export const BOSS_KINDS: readonly string[] = Object.keys(ENEMIES).filter(k => ENEMIES[k].boss);
