// 职业隐藏被动（改版意见：加入职业隐藏被动/固有特性）。
// 数值参数集中在这里：progression 负责展示文本，combat 负责在伤害结算中生效。

export interface PassiveDef {
  id: string;
  name: string;
  desc: string;
  /** 效果参数（含义见各条注释） */
  p: Record<string, number>;
}

export const PASSIVES: Record<string, PassiveDef> = {
  // 生命低于 hpPct 时受到伤害 ×(1-dr)
  warrior: { id: 'warrior', name: '不屈', desc: '生命低于 30% 时，受到的伤害降低 25%。', p: { hpPct: 0.3, dr: 0.25 } },
  // 对灼烧中的敌人伤害 ×(1+amp)
  pyro: { id: 'pyro', name: '余烬', desc: '对灼烧中的敌人伤害提高 15%。', p: { amp: 0.15 } },
  // 目标距离超过 dist 时暴击率 +crit
  ranger: { id: 'ranger', name: '鹰眼', desc: '攻击 200 距离外的目标时，暴击率提高 12%。', p: { dist: 200, crit: 0.12 } },
  // 对迟缓/冻结目标伤害 ×(1+amp)
  cryo: { id: 'cryo', name: '寒心', desc: '对迟缓或冻结的敌人伤害提高 15%。', p: { amp: 0.15 } },
  // 每 n 次命中额外弹射一道 mult×攻击 的电弧
  storm: { id: 'storm', name: '静电', desc: '每第 5 次命中会额外弹射一道小电弧（60% 攻击力）。', p: { n: 5, mult: 0.6 } },
  // 从敌人背后命中（与其朝向夹角 > 90°）伤害 ×(1+amp)
  assassin: { id: 'assassin', name: '背袭', desc: '从背后命中敌人时伤害提高 40%。', p: { amp: 0.4 } },
  // 身边 radius 内每个敌人护甲 +per（最多 max 层）
  knight: { id: 'knight', name: '骑士道', desc: '身边每有 1 个敌人，护甲提高 8%（最多 3 层）。', p: { radius: 140, per: 0.08, max: 3 } },
  // 每损失 1% 生命，伤害 +per（上限 cap）
  armored: { id: 'armored', name: '铁血', desc: '每损失 2% 生命，伤害提高 1%（最多 +40%）。', p: { per: 0.5, cap: 0.4 } },
  // 普攻在火/冰之间交替，交替命中时 +amp
  elemage: { id: 'elemage', name: '元素共鸣', desc: '普攻在火焰与冰霜之间交替，交替命中时伤害提高 20%。', p: { amp: 0.2 } },
  // 冲刺后 dur 秒内下一次攻击必定暴击
  ninja: { id: 'ninja', name: '影步', desc: '冲刺后 1.5 秒内的下一次攻击必定暴击。', p: { dur: 1.5 } },
  // 潜行状态下的攻击会连锁 n 个额外目标（mult×伤害）
  stormblade: { id: 'stormblade', name: '雷影', desc: '潜行时的攻击会额外连锁 2 个敌人（50% 伤害）。', p: { n: 2, mult: 0.5 } },
  // 护盾吸收伤害时，对 radius 内敌人造成 mult×吸收量 的雷电伤害
  stormguard: { id: 'stormguard', name: '电磁壁垒', desc: '护盾吸收伤害时，向周围释放吸收量 50% 的雷电反击。', p: { radius: 120, mult: 0.5 } },
};
