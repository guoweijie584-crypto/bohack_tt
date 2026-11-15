import * as Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { GameScene } from './scenes/GameScene';
import { ShowcaseScene } from './scenes/ShowcaseScene';
import { G } from './game/state';
import { continueGame, newGame } from './game/sim';
import { enterArena, enterCity, enterDungeon } from './game/world';
import { spawnEnemy } from './game/enemies';

// 画布分辨率 = 窗口 CSS 尺寸 × DPR（上限 2），FIT 模式下不留黑边，Retina 屏也清晰。
const dpr = Math.min(window.devicePixelRatio || 1, 2);
const size = (): [number, number] => [Math.round(window.innerWidth * dpr), Math.round(window.innerHeight * dpr)];
const [w, h] = size();
const showcase = new URLSearchParams(location.search).has('showcase');

document.body.style.margin = '0';
document.body.style.background = '#0b0907';
document.body.style.overflow = 'hidden';

const game = new Phaser.Game({
  type: Phaser.WEBGL,
  parent: 'game',
  backgroundColor: '#0b0907',
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH, width: w, height: h },
  render: { smoothPixelArt: true, maxLights: 24, powerPreference: 'high-performance' },
  disableContextMenu: true,
  input: { activePointers: 3 },
  scene: showcase ? [ShowcaseScene] : [BootScene, GameScene],
});

window.addEventListener('resize', () => {
  const [nw, nh] = size();
  game.scale.setGameSize(nw, nh);
});

// 调试入口（仅开发模式：浏览器控制台 / tools/shot.mjs 自动化截图用）
if (import.meta.env.DEV) {
  const w = window as unknown as { __game: Phaser.Game; __G: typeof G; __dev: unknown };
  w.__game = game;
  w.__G = G;
  w.__dev = { newGame, continueGame, enterDungeon, enterCity, enterArena, spawnEnemy };
}
