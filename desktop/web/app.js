'use strict';
const $ = id => document.getElementById(id);
const invoke = (command, args = {}) => window.__TAURI__.core.invoke(command, args);
let busy = false, refreshing = false, initialized = false, autoAttempted = false;
let current = null, selectedId = '', directory = '', entries = [], total = 0, nextOffset = null;
let fileEpoch = 0, fileBusy = false, accountDirty = false, pendingAccountFill = false;
const bytes = value => {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  let n = Number(value), i = 0;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString('zh-CN', {maximumFractionDigits: i ? 1 : 0})} ${units[i]}`;
};
const text = (tag, content, className = '') => {
  const el = document.createElement(tag); el.textContent = String(content); el.className = className; return el;
};
function message(content, error = false) {
  $('message').textContent = String(content); $('message').className = error ? 'message error' : 'message';
}
function folderState(f) {
  if (f.error || f.errors) return ['同步遇到问题', 'bad'];
  if (f.paused) return ['已暂停', 'neutral'];
  if (['scanning', 'scan-waiting', 'scan-preparing'].includes(f.state)) return ['正在扫描', 'warn'];
  if (!f.connected) return ['等待连接', 'neutral'];
  if (f.needItems || f.needBytes) return ['正在接收更新', 'warn'];
  if (f.remoteNeedItems || f.remoteNeedBytes) return ['正在发送更新', 'warn'];
  if (f.state === 'syncing' || f.state === 'sync-waiting' || f.state === 'sync-preparing') return ['正在同步', 'warn'];
  if (f.state !== 'idle' || f.remoteNeedItems == null || f.remoteNeedBytes == null) return ['正在确认状态', 'neutral'];
  return ['与服务器同步完成', 'good'];
}
function folderRow(folder) {
  const div = document.createElement('div'); div.className = 'folder' + (folder.id === selectedId ? ' selected' : '');
  const info = document.createElement('div'); info.className = 'folder-info';
  info.append(text('strong', folder.label, 'folder-name'), text('p', folder.path, 'folder-path'));
  const [label, tone] = folderState(folder), meta = document.createElement('div'); meta.className = 'folder-meta';
  meta.append(text('span', label, 'status badge ' + tone), text('span', `${folder.localFiles || 0} 个本地文件 · ${bytes(folder.globalBytes)}`));
  if (folder.needBytes || folder.remoteNeedBytes) meta.append(text('span', ` · 待接收 ${bytes(folder.needBytes)} / 待发送 ${bytes(folder.remoteNeedBytes)}`));
  if (folder.error) meta.append(text('p', folder.error, 'message error'));
  info.append(meta);
  const actions = document.createElement('div'); actions.className = 'folder-actions';
  const browse = text('button', '浏览文件', 'secondary'); browse.type = 'button'; browse.onclick = () => navigate(folder.id, '');
  const open = text('button', '打开目录 ↗', 'secondary'); open.type = 'button'; open.onclick = () => openFolder(folder.id);
  actions.append(browse, open); div.append(info, actions); return div;
}
function updateAccount(info, fill) {
  const account = info || {};
  if (account.loading) {
    $('account-summary').textContent = '正在读取系统凭据库；如出现系统授权提示，请确认';
    $('join').disabled = true; $('saved-login').disabled = true; $('forget-account').disabled = true;
    return;
  }
  $('join').disabled = busy; $('forget-account').disabled = busy;
  if (fill) {
    $('server').value = account.server || current.serverHint || '';
    $('username').value = account.username || '';
    $('remember-password').checked = !!account.hasPassword;
    $('auto-login').checked = !!account.autoLogin;
    accountDirty = false;
  }
  $('saved-login').hidden = !account.hasPassword;
  $('forget-account').hidden = !account.username && !account.storageError;
  $('account-summary').textContent = account.username
    ? `${account.username} · ${account.autoLogin ? '已开启自动登录' : account.hasPassword ? '密码已安全保存' : '账号已记住'}`
    : current.folders.length ? '设备已授权 · 可登录并保存账号信息' : '尚未连接账号';
  if (account.storageError) message(account.storageError, true);
  $('saved-login').disabled = busy || accountDirty;
}
function renderSnapshot(s) {
  current = s;
  const folders = s.folders || [], allGood = folders.length && folders.every(f => folderState(f)[1] === 'good');
  $('health').textContent = s.connected ? '服务器已连接' : folders.length ? '服务器未连接' : '准备连接账号';
  $('health').className = 'pill ' + (s.connected ? 'good' : 'neutral');
  $('version').textContent = s.version; $('home').textContent = s.home;
  $('fingerprint').textContent = s.caFingerprint || '使用系统公信 CA';
  $('stat-files').textContent = folders.length ? folders.reduce((sum, f) => sum + (f.globalFiles || 0), 0).toLocaleString('zh-CN') : '—';
  $('stat-bytes').textContent = folders.length ? bytes(folders.reduce((sum, f) => sum + (f.globalBytes || 0), 0)) : '—';
  const pendingKnown = folders.length && folders.every(f => f.connected && f.remoteNeedItems != null && !f.error);
  $('stat-pending').textContent = pendingKnown ? folders.reduce((sum, f) => sum + (f.needItems || 0) + (f.remoteNeedItems || 0), 0).toLocaleString('zh-CN') : '—';
  $('sync-summary').textContent = !folders.length ? '连接账号即可创建个人空间' : allGood ? '所有空间已与服务器同步' : folders.some(f => folderState(f)[1] === 'bad') ? '有空间需要处理，请查看详情' : '文件状态每 10 秒自动更新';
  if (!folders.some(f => f.id === selectedId)) { selectedId = folders[0]?.id || ''; directory = ''; entries = []; }
  const oldOptions = Array.from($('folder-select').options || []).map(o => o.value + ':' + o.textContent).join('|');
  const newOptions = folders.map(f => f.id + ':' + f.label).join('|');
  if (oldOptions !== newOptions) $('folder-select').replaceChildren(...folders.map(f => {
    const option = text('option', f.label); option.value = f.id; return option;
  }));
  $('folder-select').value = selectedId;
  $('folder-select').disabled = !folders.length; $('open-current').disabled = !selectedId;
  $('folders').replaceChildren(...(folders.length ? folders.map(folderRow) : [text('p', '还没有同步空间。连接账号后，这里会显示你的文件目录。', 'empty-state')]));
  if (!initialized && !s.account?.loading && !accountDirty) updateAccount(s.account, true);
  else updateAccount(s.account, false);
}
const statuses = {
  synced: ['与服务器一致', 'good'], downloading: ['待接收 / 同步中', 'warn'], uploading: ['待服务器确认', 'warn'],
  offline_pending: ['离线 · 等待更新', 'neutral'], local_current: ['本地已是最新索引', 'neutral'],
  scanning: ['等待扫描', 'warn'], ignored: ['已忽略', 'neutral'], error: ['同步异常', 'bad'],
  pending_delete: ['等待删除同步', 'warn'], paused: ['已暂停', 'neutral'], directory: ['目录', 'neutral'], unknown: ['状态待确认', 'neutral']
};
function renderFiles() {
  const filter = $('file-filter').value.trim().toLocaleLowerCase();
  const shown = entries.filter(f => f.name.toLocaleLowerCase().includes(filter));
  $('breadcrumbs').textContent = directory ? '全部文件 / ' + directory.split('/').join(' / ') : '全部文件';
  $('parent-folder').disabled = !directory;
  $('files-count').textContent = filter ? `${shown.length} / ${entries.length} 已载入项` : `${total} 项`;
  $('load-more').hidden = nextOffset == null; $('load-more').disabled = fileBusy;
  const rows = shown.map(file => {
    const row = document.createElement('tr'), nameCell = document.createElement('td');
    const icon = text('span', file.kind === 'directory' ? '▰' : file.kind === 'symlink' ? '↗' : '▤', 'file-icon ' + file.kind);
    icon.setAttribute('aria-hidden', 'true');
    const name = text(file.kind === 'directory' ? 'button' : 'span', file.name, 'file-name ' + file.kind);
    if (file.kind === 'directory') { name.type = 'button'; name.onclick = () => navigate(selectedId, file.path); }
    nameCell.append(icon, name);
    const size = text('td', file.kind === 'file' ? bytes(file.size) : '—');
    const date = new Date(file.modified); const modified = text('td', Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}));
    const status = document.createElement('td'), [label, tone] = statuses[file.status] || statuses.unknown;
    status.append(text('span', label, 'file-status badge ' + tone));
    row.append(nameCell, size, modified, status); return row;
  });
  if (!rows.length) {
    const row = document.createElement('tr'); row.className = 'empty-row'; const cell = text('td', filter ? '当前已载入的项目中没有匹配文件' : selectedId ? '此目录还没有已索引的文件' : '连接个人空间后，即可在这里浏览文件'); cell.colSpan = 4; row.append(cell); rows.push(row);
  }
  $('file-rows').replaceChildren(...rows);
}
async function loadFiles(append = false, quiet = false) {
  if (!selectedId) { fileEpoch++; fileBusy = false; entries = []; total = 0; nextOffset = null; renderFiles(); return; }
  const offset = append ? nextOffset : 0;
  if (offset == null) return;
  const epoch = ++fileEpoch, id = selectedId, path = directory;
  fileBusy = true; $('load-more').disabled = true;
  if (!quiet) { $('files-message').textContent = '正在读取文件与同步状态…'; $('files-message').className = 'files-message'; }
  try {
    // Refresh all currently loaded pages rather than jumping back to page one.
    const wanted = append ? 1 : Math.max(1, Math.ceil(entries.length / 100));
    let collected = [], page;
    for (let i = 0; i < wanted; i++) {
      page = await invoke('list_files', {id, path, offset: offset + i * 100});
      if (epoch !== fileEpoch) return;
      collected.push(...page.entries);
      if (page.nextOffset == null) break;
    }
    entries = append ? entries.concat(collected) : collected; total = page.total; nextOffset = page.nextOffset;
    $('files-message').textContent = page.warning || '';
    $('files-message').className = 'files-message'; renderFiles();
  } catch (error) {
    if (epoch !== fileEpoch) return;
    $('files-message').textContent = '文件列表读取失败：' + String(error) + (entries.length ? '（下方保留上次结果）' : '');
    $('files-message').className = 'files-message error';
  } finally {
    if (epoch === fileEpoch) { fileBusy = false; $('load-more').disabled = false; }
  }
}
async function navigate(id, path) {
  selectedId = id; directory = path; entries = []; total = 0; nextOffset = null; $('file-filter').value = '';
  renderSnapshot(current); renderFiles(); await loadFiles();
}
async function openFolder(id) {
  try { await invoke('open_folder', {id}); } catch (error) { message(error, true); }
}
function setBusy(value) {
  busy = value; $('join').disabled = value; $('saved-login').disabled = value || accountDirty; $('forget-account').disabled = value;
}
async function savedLogin(automatic = false) {
  if (busy) return;
  setBusy(true); message(automatic ? '正在使用已保存的账号自动登录…' : '正在安全登录…');
  try {
    await invoke('login_saved', {automatic}); message('账号已连接，正在同步文件。');
    $('account-panel').open = false; await refresh(false, true);
  } catch (error) {
    message((automatic ? '自动登录未完成：' : '') + String(error), true); $('account-panel').open = true;
  } finally { setBusy(false); }
}
async function refresh(allowAutomatic = true, forceAccountFill = false) {
  if (refreshing) { pendingAccountFill ||= forceAccountFill; return; }
  refreshing = true; $('refresh').disabled = true;
  let shouldAuto = false;
  try {
    const s = await invoke('snapshot'); renderSnapshot(s);
    if (forceAccountFill) updateAccount(s.account, true);
    if (!initialized && !s.account?.loading) {
      initialized = true;
      if (s.folders.length) $('account-panel').open = false;
      shouldAuto = allowAutomatic && s.account?.autoLogin && s.account?.hasPassword && !autoAttempted && !busy;
      if (shouldAuto) autoAttempted = true;
    }
    if (!fileBusy) await loadFiles(false, true);
  } catch (error) {
    $('health').textContent = '同步引擎暂不可用'; $('health').className = 'pill bad';
    $('sync-summary').textContent = '状态读取失败，上次结果可能已过期'; message(error, true);
  } finally { refreshing = false; $('refresh').disabled = false; }
  if (pendingAccountFill) { pendingAccountFill = false; await refresh(false, true); }
  else if (shouldAuto) await savedLogin(true);
}
$('login').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  setBusy(true); autoAttempted = true; message('正在验证账号与设备身份…');
  let password = $('password').value; $('password').value = '';
  try {
    const result = await invoke('join_account', {server:$('server').value.trim(), username:$('username').value.trim(), password,
      rememberPassword:$('remember-password').checked, autoLogin:$('auto-login').checked});
    password = '';
    message(result.warning ? '账号已连接，但登录信息未保存：' + result.warning : '账号已连接，正在同步文件。', !!result.warning);
    $('account-panel').open = !!result.warning; await refresh(false, true);
  } catch (error) { message(error, true); }
  finally { password = ''; setBusy(false); }
});
$('remember-password').addEventListener('change', () => { if (!$('remember-password').checked) $('auto-login').checked = false; });
$('auto-login').addEventListener('change', () => { if ($('auto-login').checked) $('remember-password').checked = true; });
for (const id of ['server','username']) $(id).addEventListener('input', () => { accountDirty = true; $('saved-login').disabled = true; });
$('saved-login').onclick = () => savedLogin(false);
$('forget-account').onclick = () => { if (!busy) $('forget-dialog').showModal(); };
$('cancel-forget').onclick = () => $('forget-dialog').close();
$('confirm-forget').onclick = async () => {
  if (busy) return;
  $('forget-dialog').close();
  setBusy(true); autoAttempted = true;
  try {
    await invoke('forget_account'); $('password').value = ''; await refresh(false, true); message('已清除保存的登录信息。现有设备授权与同步文件保留。');
  } catch (error) { message(error, true); }
  finally { setBusy(false); }
};
$('refresh').onclick = () => refresh();
$('folder-select').addEventListener('change', () => navigate($('folder-select').value, ''));
$('parent-folder').onclick = () => navigate(selectedId, directory.split('/').slice(0,-1).join('/'));
$('open-current').onclick = () => selectedId && openFolder(selectedId);
$('load-more').onclick = () => !fileBusy && loadFiles(true);
$('file-filter').addEventListener('input', renderFiles);
async function poll() { await refresh(); setTimeout(poll, 10000); }
poll();
