// 启动场景：像素风加载进度条 → 加载并加工全部素材 → 初始化 DOM UI → 进入游戏场景。
import * as Phaser from 'phaser';
import { preloadAssets, registerAssets } from '../view/assets';

export class BootScene extends Phaser.Scene {
  constructor() { super('boot'); }

  preload(): void {
    const { width, height } = this.scale;
    const s = Math.max(1, Math.round(height / 360));
    const bw = 160 * s, bh = 8 * s;
    const x = (width - bw) / 2, y = height / 2;
    const g = this.add.graphics();
    const title = this.add.text(width / 2, y - 26 * s, '源能斗士 · AETHER VANGUARD', {
      fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif', fontSize: `${12 * s}px`, color: '#f0c96b',
    }).setOrigin(0.5);
    this.load.on('progress', (v: number) => {
      g.clear();
      g.fillStyle(0x2a1d14, 1).fillRect(x - s, y - s, bw + 2 * s, bh + 2 * s);
      g.fillStyle(0x140c08, 1).fillRect(x, y, bw, bh);
      const steps = 20;
      const filled = Math.round(v * steps);
      for (let i = 0; i < filled; i++) g.fillStyle(i % 2 ? 0xf0c96b : 0xe0954f, 1).fillRect(x + (i * bw) / steps + s, y + s, bw / steps - 2 * s, bh - 2 * s);
    });
    this.load.once('complete', () => { g.destroy(); title.destroy(); });
    preloadAssets(this);
  }

  create(): void {
    registerAssets(this);
    this.scene.start('game');
  }
}
