# 开源方案调研结论（2026-11-15）

> 调研方式：8 个子代理并行，用 `npm view` / `gh api` / `curl` 实测版本、许可证与下载可用性，不凭记忆。
> 详细报告（引擎 38KB、2D 素材 44KB、3D 素材、开源库 53KB、legacy 代码拆解 3 份、版本与需求对照）存于调研工作目录，结论汇总如下。

## 1. 渲染引擎

| 候选 | 版本（实测） | 结论 |
|---|---|---|
| **Phaser 4.2.1**（MIT） | 2026-07-09；4.0.0 于 2026-04 正式发布 | **选用**。像素渲染最完整（`smoothPixelArt`、`vertexRoundMode`、整数缩放）、统一 Filters（辉光/暗角/调色）、`setLighting` 动态光照 + 锥光、粒子、Tilemap、相机特效，学生团队补代码最少。需规避的 open issue：#7414（频繁打断批次掉帧 → 世界物体统一开灯、用图集）、#7392（老 iOS Text 黑底 → 中文 HUD 走 DOM）、#7352（相机 lerp 依赖帧率 → 相机由我们自己按 `1-e^(-kdt)` 驱动）。 |
| Phaser 3.90.0 | 2025-05，已冻结 | 不选（不再维护）。若 v4 卡死可回退，sim/view 分离保证只影响渲染层。 |
| PixiJS 8.23.0 | 维护最活跃 | 只是渲染器：场景、相机、动画状态机、粒子发射器（官方发射器不兼容 v8）、光照都要自建。 |
| Excalibur 1.0 / KAPLAY | — | 前者 1.0 刚发布、资料少；后者适合原型。 |
| Three.js 0.187（HD-2D / 全 3D） | — | HD-2D 需自建精灵阴影、像素消抖、墙体遮挡，工作量约为 2D 的 1.6 倍；全 3D（KayKit CC0 骨骼角色）背离团队定下的像素风。 |
| lottie-web 5.13.0 | 2025-05 后停更，862 open issues | **不进战斗层**：矢量抗锯齿与像素规范冲突、无法与 WebGL 合批。改用像素序列帧 + 引擎粒子 + Filters。 |

## 2. 美术素材（全部 CC0，可随开源仓库分发）

- **主包：0x72 16x16 DungeonTileset II v1.7** —— 最接近元气骑士：3/4 墙体、10 个 Q 版英雄、20 种怪、3 个首领、27 把独立武器（元气骑士式手持旋转）、宝箱开箱动画。
- **补充：Ninja Adventure** —— 30+ 种特效序列帧（刀光、爆炸、火冰雷、魔法阵、烟雾）、投射物、粒子、4 向怪物、城镇建筑与植物、红蓝血量球 UI。
- **下载渠道**：GitHub `series-ai/jam-ready-assets` 镜像（Git LFS，用 `media.githubusercontent.com` 直链），每包附 License.txt。
- **中文字体：缝合像素字体 Fusion Pixel（OFL-1.1）**。Zpix 为专有许可（禁止修改/拆分、商用收费）已排除。
- 已排除禁止再分发的素材：Tiny Swords、Cainos、Mystic Woods、Pimen、BDragon1727 等。
- 缺口与对策：英雄没有攻击/死亡帧 → 元气骑士式“身体不动、武器做挥砍/突刺补间 + 刀光序列帧”；12 职业只有 10 个英雄底图 → 同模板换色（改版文档“融合职业换色复用”）；盾牌、装备图标、城镇小品 → 程序化像素绘制。

## 3. 可复用的开源代码与做法

| 需求 | 方案 |
|---|---|
| 怪物卡墙、寻路单一 | 自写流场（多源 Dijkstra，80×58 图重建约 0.04ms，与怪数无关）+ 圆形贴墙滑动碰撞 + 视线判定；参考 The-Ninth-Vigil 的分离/环位做法。PathFinding.js（2016 后未发版）、phaser-navmesh（只支持 Phaser 3）不选。 |
| 地图生成 / 视野 | 自写房间 + 3 格宽走廊生成器、Amanatides-Woo 网格射线做视野；rot-js 可备用（注意其 RNG 为全局单例）。 |
| ECS | 不值得（几十只怪 + 几百个弹体），保持纯数据实体 + 按 id 同步视图。 |
| 音效 | 原生 Web Audio 合成（改版意见要求不引外部库）；zzfx 会在 import 时创建 AudioContext，不选。 |
| UI | 面板走 DOM（大量中文、滚动、表单、输入法），像素字体 + 9-slice 风格 CSS；随世界坐标的血条/飘字/名字在引擎内。 |
| 联机（后置） | 现有中继在 https 页面会被混合内容拦截，需改 wss；先保持 sim/view 分离与固定步长，为后续同步预留。 |

## 4. 参考过的同类开源项目（均为 MIT）

ourcade/phaser3-dungeon-crawler-starter、iamlukethedev/The-Ninth-Vigil、VictorZakharov/last-stand、JohnVonDrashek/dungeon-crawler-now、nusr/wukong-survivors —— 借鉴了场景结构、怪物分离/环位、Link 式联机接口与固定步长循环的组织方式。
