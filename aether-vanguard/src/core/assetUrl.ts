// 素材路径解析。
// - 普通构建（npm run dev / npm run build）：原样返回相对路径（public/assets/ 下的文件）。
// - 单文件离线版（npm run package → tools/package.mjs）：HTML 里预先注入 window.__AV_ASSETS = { 路径: data: URL }，
//   这里返回内嵌数据，因此双击 HTML 就能离线游玩，不需要服务器。

declare global {
  interface Window { __AV_ASSETS?: Record<string, string> }
}

function embedded(): Record<string, string> | undefined {
  return typeof window !== 'undefined' ? window.__AV_ASSETS : undefined;
}

/** 给 Phaser 加载器 / @font-face 用：单文件版返回 data: URL，否则原路径 */
export function assetUrl(path: string): string {
  return embedded()?.[path] ?? path;
}

const blobCache = new Map<string, string>();

/**
 * 给 CSS 背景等“会被大量重复引用”的场合用：单文件版把内嵌 data: 转成短的 blob: URL（只转一次），
 * 避免每个 UI 图标的 style 里都复制一份几十 KB 的 base64。
 */
export function assetCssUrl(path: string): string {
  const u = assetUrl(path);
  if (!u.startsWith('data:') || typeof URL === 'undefined' || typeof Blob === 'undefined') return u;
  const hit = blobCache.get(path);
  if (hit) return hit;
  try {
    const comma = u.indexOf(',');
    const mime = u.slice(5, u.indexOf(';'));
    const bin = atob(u.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    blobCache.set(path, url);
    return url;
  } catch {
    return u;
  }
}
