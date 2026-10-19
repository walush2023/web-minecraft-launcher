// Launcher preferences shared by the launcher and the play page (per browser, best effort).
const KEY = 'web-minecraft:settings';

export const DEFAULT_SETTINGS = {
  version: null,
  preset: 'smooth',
  renderScale: 0.75,
  showSnapshots: false,
  showOld: false,
  showUnsupported: false,
  showFps: true,
  offlineName: 'Player',
};

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private mode); settings then last for this page only.
  }
}

export const PRESETS = {
  smooth: { label: '流暢', hint: '最近視距、快速畫質，畫面最順（1.13+ 另減少生物與環境粒子）' },
  balanced: { label: '平衡', hint: '短視距、快速畫質（1.13+ 生物略少）' },
  quality: { label: '畫質', hint: '一般視距、精緻畫質（較吃效能）' },
  keep: { label: '不修改', hint: '保留遊戲內自己的設定' },
};
