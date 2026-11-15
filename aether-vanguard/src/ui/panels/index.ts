// 面板注册表

import type { PanelName } from '../../game/types';
import type { IconName } from '../icons';
import { bagPanel } from './bag';
import { charPanel } from './char';
import { dialogPanel } from './dialog';
import { fusePanel } from './fuse';
import { helpPanel } from './help';
import { lorePanel } from './lore';
import { mapPanel } from './map';
import { arenaPanel, portalPanel, routePanel, secretPanel } from './portal';
import { potionShopPanel, smithPanel } from './shop';
import { skillPanel } from './skill';
import { stashPanel } from './stash';
import type { PanelDef } from './types';

export const PANELS: Record<PanelName, PanelDef> = {
  char: charPanel,
  bag: bagPanel,
  skill: skillPanel,
  fuse: fusePanel,
  map: mapPanel,
  lore: lorePanel,
  help: helpPanel,
  shop_potion: potionShopPanel,
  shop_smith: smithPanel,
  stash: stashPanel,
  portal: portalPanel,
  route: routePanel,
  arena: arenaPanel,
  secret: secretPanel,
  dialog: dialogPanel,
};

/** 主面板页签（带快捷键提示） */
export const MAIN_TABS: ReadonlyArray<{ name: PanelName; label: string; key: string; icon: IconName }> = [
  { name: 'char', label: '角色', key: 'C', icon: 'person' },
  { name: 'bag', label: '背包', key: 'B', icon: 'bag' },
  { name: 'skill', label: '技能', key: 'K', icon: 'tree' },
  { name: 'fuse', label: '转职', key: 'P', icon: 'merge' },
  { name: 'map', label: '地图', key: 'M', icon: 'map' },
  { name: 'lore', label: '日志', key: 'J', icon: 'scroll' },
  { name: 'help', label: '帮助', key: 'H', icon: 'question' },
];

/** 没有角色时允许打开的面板 */
export const NO_PLAYER_PANELS: ReadonlySet<PanelName> = new Set<PanelName>(['lore', 'help']);

export function isPanelName(s: string): s is PanelName {
  return Object.prototype.hasOwnProperty.call(PANELS, s);
}
