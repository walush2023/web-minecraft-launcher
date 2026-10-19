import { loadSettings, saveSettings, PRESETS } from './settings.js';

const $ = (id) => document.getElementById(id);
const settings = loadSettings();
let me = null;
let versions = [];

const SUPPORT_BADGES = {
  tested: { cls: 'ok', text: '已測試' },
  experimental: { cls: 'warn', text: '實驗性' },
  unsupported: { cls: 'bad', text: '無法執行' },
};

const TYPE_LABELS = { release: '正式版', snapshot: '快照', old_beta: 'Beta', old_alpha: 'Alpha' };

const AUTH_ERRORS = {
  'not-configured': '伺服器尚未設定 Microsoft 登入（缺少 AZURE_CLIENT_ID），請參考 README 完成 Azure 應用程式註冊。',
  'not-owned': '此 Microsoft 帳號沒有 Minecraft: Java 版的授權（或尚未建立玩家名稱）。請購買遊戲或於 minecraft.net 設定玩家名稱後再試。',
  'app-not-approved': 'Minecraft 服務拒絕了這個 Azure 應用程式。新的應用程式 ID 必須先通過 Mojang 審核才能使用 Minecraft API。',
  state: '登入流程逾時或驗證失敗，請重新登入。',
  access_denied: '你取消了 Microsoft 登入。',
};

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function badge(level) {
  const b = SUPPORT_BADGES[level] || SUPPORT_BADGES.experimental;
  return el('span', { class: `badge ${b.cls}` }, b.text);
}

function notice(kind, title, body) {
  $('notices').append(el('div', { class: `notice ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, el('strong', {}, title), body));
}

function avatar(skinUrl) {
  const node = el('div', { class: 'avatar', 'aria-hidden': 'true' });
  if (skinUrl) {
    // Face (8,8) plus hat layer (40,8) of the 64px skin, scaled 7x into a 56px square.
    const url = skinUrl.replace(/^http:/, 'https:');
    node.style.backgroundImage = `url("${url}"), url("${url}")`;
    node.style.backgroundSize = '448px auto, 448px auto';
    node.style.backgroundPosition = '-280px -56px, -56px -56px';
  }
  return node;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------
async function logout() {
  await fetch('/auth/logout', { method: 'POST' });
  location.href = '/';
}

function renderAccount() {
  const box = $('account');
  const top = $('account-top');
  box.replaceChildren();
  top.replaceChildren();

  if (me.signedIn) {
    box.append(
      el('div', { class: 'account' },
        avatar(me.profile?.skin),
        el('div', {},
          el('div', { class: 'account-name' }, me.profile?.name || '（未設定玩家名稱）'),
          me.owned ? el('span', { class: 'badge ok' }, '✓ 擁有 Minecraft: Java 版') : el('span', { class: 'badge bad' }, '未擁有遊戲'),
        ),
      ),
      el('div', { class: 'row' },
        el('small', { class: 'muted' }, 'Microsoft 帳號'),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: logout }, '登出'),
      ),
    );
    top.append(el('span', { class: 'muted' }, me.profile?.name || ''));
    return;
  }

  if (me.authConfigured) {
    box.append(
      el('p', { class: 'muted', style: 'margin:0' }, '使用擁有 Minecraft: Java 版的 Microsoft 帳號登入，即可下載並遊玩。'),
      el('a', { class: 'btn btn-ms', href: '/auth/login', style: 'width:100%' }, msLogo(), '使用 Microsoft 帳號登入'),
      el('small', { class: 'muted' }, '登入在 Microsoft 官方頁面進行，本站不會接觸你的密碼。'),
    );
  } else {
    box.append(el('p', { class: 'muted', style: 'margin:0' }, '伺服器尚未設定 Microsoft 登入。'));
  }

  if (me.devOffline) {
    const input = el('input', { type: 'text', id: 'offline-name', value: settings.offlineName, maxlength: '16', 'aria-label': '離線玩家名稱' });
    input.addEventListener('input', () => {
      settings.offlineName = input.value.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'Player';
      saveSettings(settings);
    });
    box.append(el('div', { class: 'notice warn' },
      el('strong', {}, '開發離線模式'),
      '僅限本機連線、用於測試；正式使用請關閉 DEV_OFFLINE 並以 Microsoft 帳號登入。',
      el('div', { style: 'margin-top:8px' }, input),
    ));
  }
}

function msLogo() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('viewBox', '0 0 21 21');
  svg.setAttribute('aria-hidden', 'true');
  for (const [x, y, color] of [[1, 1, '#f25022'], [11, 1, '#7fba00'], [1, 11, '#00a4ef'], [11, 11, '#ffb900']]) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', '9');
    rect.setAttribute('height', '9');
    rect.setAttribute('fill', color);
    svg.append(rect);
  }
  return svg;
}

function canPlay() {
  return Boolean((me?.signedIn && me.owned) || (!me?.signedIn && me?.devOffline));
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------
function visibleVersions() {
  const query = $('search').value.trim().toLowerCase();
  return versions.filter((v) => {
    if (query && !v.id.toLowerCase().includes(query)) return false;
    if (v.type === 'snapshot' && !settings.showSnapshots && !query) return false;
    if ((v.type === 'old_alpha' || v.type === 'old_beta') && !settings.showOld && !query) return false;
    if (v.support.level === 'unsupported' && !settings.showUnsupported && !query) return false;
    return true;
  });
}

function renderVersions() {
  const list = $('versions');
  const items = visibleVersions();
  list.replaceChildren();
  if (items.length === 0) {
    list.append(el('div', { class: 'empty' }, '沒有符合條件的版本'));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const v of items) {
    const disabled = v.support.level === 'unsupported';
    fragment.append(el('button', {
      class: 'version',
      type: 'button',
      role: 'option',
      'aria-selected': String(v.id === settings.version),
      disabled,
      title: v.support.reason,
      onclick: () => selectVersion(v.id),
    },
    el('span', { class: 'version-id' }, v.id),
    badge(v.support.level),
    el('span', { class: 'version-meta' }, `${TYPE_LABELS[v.type] || v.type} · ${new Date(v.releaseTime).toLocaleDateString('zh-TW')}`),
    ));
  }
  list.append(fragment);
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

function selectVersion(id) {
  settings.version = id;
  saveSettings(settings);
  for (const node of $('versions').querySelectorAll('.version')) {
    node.setAttribute('aria-selected', String(node.querySelector('.version-id').textContent === id));
  }
  renderSelection();
}

function renderSelection() {
  const v = versions.find((x) => x.id === settings.version);
  $('selected-id').textContent = v ? v.id : '—';
  $('selected-badge').replaceChildren(v ? badge(v.support.level) : '');
  $('selected-note').textContent = v
    ? `${TYPE_LABELS[v.type] || v.type}，發布於 ${new Date(v.releaseTime).toLocaleDateString('zh-TW')}。${notes(v)}`
    : '從清單中選擇要遊玩的版本。';
  updatePlayButton();
}

// Release dates where the browser runtime changes (see server/mojang.js).
const LWJGL3_SINCE = Date.parse('2017-10-25T00:00:00Z');
const JAVA21_SINCE = Date.parse('2024-04-03T00:00:00Z');

function notes(v) {
  if (v.support.level === 'unsupported') return '此版本需要 Java 25（26.1 以後），目前網頁版最高支援到 1.21.11。';
  const released = Date.parse(v.releaseTime);
  const untested = v.support.level === 'tested' ? '' : '此版本尚未個別測試，可能無法啟動。';
  const lwjgl3 = '建立世界需要數分鐘；怪物越多越慢，和平模式最流暢。';
  if (released >= JAVA21_SINCE) return `1.20.5 以後的版本為 Java 21 編譯，啟動時會在記憶體中轉換為瀏覽器可執行的 Java 17（不修改遊戲檔案）。${lwjgl3}${untested}`;
  if (released >= LWJGL3_SINCE) return `1.13 以後的版本透過 WebGL 2 執行 LWJGL 3。${lwjgl3}${untested}`;
  return untested;
}

function updatePlayButton() {
  const v = versions.find((x) => x.id === settings.version);
  const eula = $('eula').checked;
  let hint = '';
  if (!canPlay()) hint = me?.signedIn ? '此帳號沒有 Minecraft: Java 版授權。' : '請先登入 Microsoft 帳號。';
  else if (!v) hint = '請選擇版本。';
  else if (v.support.level === 'unsupported') hint = '此版本無法在瀏覽器中執行。';
  else if (!eula) hint = '請先同意 Minecraft EULA。';
  $('play').disabled = Boolean(hint);
  $('play-hint').textContent = hint || '首次啟動需下載遊戲檔案與 Java 執行環境，可能需要一到兩分鐘。';
}

// ---------------------------------------------------------------------------
// Performance settings
// ---------------------------------------------------------------------------
function renderPresets() {
  const box = $('presets');
  box.replaceChildren();
  for (const [key, preset] of Object.entries(PRESETS)) {
    box.append(el('button', {
      class: 'preset',
      type: 'button',
      'aria-pressed': String(settings.preset === key),
      onclick: () => {
        settings.preset = key;
        saveSettings(settings);
        renderPresets();
      },
    }, el('strong', {}, preset.label), el('small', {}, preset.hint)));
  }
  $('preset-hint').textContent = '每次啟動時套用';
}

function renderScale() {
  $('render-scale').value = settings.renderScale;
  $('render-scale-value').textContent = `${Math.round(settings.renderScale * 100)}%`;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function showQueryErrors() {
  const params = new URLSearchParams(location.search);
  const error = params.get('error');
  if (!error) return;
  const message = params.get('message');
  notice('error', '登入失敗', AUTH_ERRORS[error] || message || error);
  history.replaceState(null, '', '/');
}

async function main() {
  showQueryErrors();
  renderPresets();
  renderScale();
  $('render-scale').addEventListener('input', (event) => {
    settings.renderScale = Number(event.target.value);
    saveSettings(settings);
    renderScale();
  });

  for (const [id, key] of [['filter-snapshots', 'showSnapshots'], ['filter-old', 'showOld'], ['filter-unsupported', 'showUnsupported']]) {
    $(id).checked = settings[key];
    $(id).addEventListener('change', () => {
      settings[key] = $(id).checked;
      saveSettings(settings);
      renderVersions();
    });
  }
  $('search').addEventListener('input', renderVersions);
  $('eula').checked = Boolean(settings.eulaAccepted);
  $('eula').addEventListener('change', () => {
    settings.eulaAccepted = $('eula').checked;
    saveSettings(settings);
    updatePlayButton();
  });
  $('play').addEventListener('click', () => {
    if (!$('play').disabled) location.href = `/play.html?v=${encodeURIComponent(settings.version)}`;
  });

  try {
    me = await (await fetch('/api/me')).json();
  } catch {
    me = { signedIn: false, authConfigured: false };
    notice('error', '無法連線到伺服器', '請確認啟動器伺服器正在執行。');
  }
  if (me.error) notice('warn', '需要重新登入', me.error);
  if (!me.authConfigured && !me.devOffline) {
    notice('warn', '尚未設定 Microsoft 登入', '請在 .env 設定 AZURE_CLIENT_ID（詳見 README）。');
  }
  renderAccount();

  try {
    const data = await (await fetch('/api/versions')).json();
    if (data.error) throw new Error(data.error);
    versions = data.versions;
    if (!settings.version || !versions.some((v) => v.id === settings.version)) {
      settings.version = versions.find((v) => v.support.level === 'tested')?.id
        || versions.find((v) => v.type === 'release' && v.support.level !== 'unsupported')?.id
        || null;
    }
    renderVersions();
  } catch (error) {
    $('versions').replaceChildren(el('div', { class: 'empty' }, `無法讀取版本清單：${error.message}`));
  }
  renderSelection();
}

main();
