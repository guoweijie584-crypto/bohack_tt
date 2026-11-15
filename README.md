# bohack_tt

黑客松小游戏作品集：「源能斗士」的单文件原型、基于 Phaser 4 引擎的重制版，以及另一款小游戏和改版意见素材包。

## 文件说明

| 文件 | 说明 |
| --- | --- |
| `aether-vanguard/` | **源能斗士 · 引擎重制版**（Phaser 4 + TypeScript，像素 2.5D、动态光照、开源 CC0 美术）。详见 [`aether-vanguard/README.md`](aether-vanguard/README.md) |
| `index(1).html` | 源能斗士 · AETHER VANGUARD II（单文件 Canvas 版，重制版的数值与玩法基准） |
| `index.html` | 源能斗士 · AETHER VANGUARD（v1） |
| `index(2).html` | 源能斗士 · AETHER VANGUARD（v1 的迭代分支） |
| `blade.html` | **百刃 · BLADE ORBIT 500**（打碎木栅栏得刀片，消耗刀片击杀怪物换金币） |
| `游戏改版意见.zip` | 改版意见素材：boss 参考图、人物参考图等 |

## 运行方式

**引擎重制版**（需要 Node 20+）：

```bash
cd aether-vanguard
npm install
npm run dev      # 浏览器打开 http://localhost:5173
```

**单文件原型**：都是独立的 HTML 文件，无需安装依赖、无需构建，直接用浏览器打开即可：

```bash
open "index(1).html"   # macOS
# 或者双击文件，用 Chrome / Edge / Safari 打开
```

## 操作说明

- **源能斗士（重制版）**：`WASD` 移动，鼠标瞄准、按住左键攻击，右键奥义，`Q/E/R` 技能，`空格` 冲刺，`F` 交互，`1/2` 药水，`Tab/B/K/M` 角色/背包/技能/地图，`Esc` 关闭面板/暂停
- **源能斗士（单文件原型）**：`WASD` 移动，鼠标左键攻击，`空格` 冲刺，`F` 交互，`Esc` 暂停 / 继续
- **百刃**：`WASD` 移动，`空格` 释放技能；支持触屏虚拟摇杆（手机 / 平板）

> 具体按键以游戏内提示为准。
