'use strict';
const $ = id => document.getElementById(id);
const invoke = (command, args = {}) => window.__TAURI__.core.invoke(command, args);
const text = (tag, content, className = '') => {
  const element = document.createElement(tag);
  element.textContent = String(content); element.className = className; return element;
};
const iconPaths = {
  folder: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z',
  file: 'M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6m-6 4h6',
  symlink: 'M10 14 20 4m-6 0h6v6M8 5H4v15h15v-5',
  reveal: 'M13 4h7v7m0-7L10 14M9 5H4v15h15v-5',
  sync: 'M4 10a8 8 0 0 1 14-3l2 3m0-6v6h-6M20 14A8 8 0 0 1 6 17l-2-3m0 6v-6h6'
};
function icon(kind, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', className);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', iconPaths[kind] || iconPaths.file); svg.append(path); return svg;
}
const bytes = value => {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  let n = Number(value), i = 0;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString('zh-CN', {maximumFractionDigits: i ? 1 : 0})} ${units[i]}`;
};
let view = 'files', current = null, snapshotFailed = false, refreshing = false;
let busy = false, initialized = false, autoAttempted = false, accountDirty = false, pendingAccountFill = false, lastStorageError = '';
let selectedId = '', directory = '', breadcrumbKey = '';
let entries = [], total = 0, nextOffset = null, fileEpoch = 0, fileBusy = false, fileLoaded = false;
let fileWarning = '', fileFailure = '', filterTimer = null, sortBy = 'name', descending = false;
let activity = [], activityPage = 0, activityMore = false, activityEpoch = 0, activityBusy = false, activityLoaded = false;
let activityWarnings = [], activityFailure = '';
const notices = new Map();
let noticeKey = '';
const selectedFolder = () => current?.folders?.find(folder => folder.id === selectedId);
const revealLabel = () => current?.platform === 'macos' ? '在访达中显示' : current?.platform === 'windows' ? '在资源管理器中显示' : '在文件管理器中显示';
function renderNotice() {
  const visible = [...notices].filter(([key]) => key !== 'account' || view !== 'settings');
  const latest = visible.at(-1); noticeKey = latest?.[0] || '';
  $('notice').hidden = !latest; $('notice-text').textContent = latest?.[1].content || '';
  $('notice-settings').hidden = latest?.[1].target !== 'settings';
}
function notice(key, content, target = '') {
  if (content) notices.set(key, {content: String(content), target}); else notices.delete(key);
  renderNotice();
}
function message(content, error = false) {
  $('message').textContent = String(content); $('message').className = error ? 'message error' : 'message';
  notice('account', error ? content : '', 'settings');
}
const state = (code, label, tone, rank) => ({code, label, tone, rank});
function folderState(folder) {
  if (snapshotFailed) return state('unknown', '状态读取失败', 'bad', 0);
  if (!folder) return state('empty', '未连接账号', 'neutral', 7);
  if (folder.error || folder.errors || folder.state === 'error') return state('error', '同步异常', 'bad', 0);
  if (!current.connected || !folder.connected) return state('offline', '离线', 'neutral', 1);
  if (folder.paused) return state('paused', '已暂停', 'neutral', 2);
  if (['scanning', 'scan-waiting', 'scan-preparing'].includes(folder.state)) return state('scanning', '正在扫描', 'warn', 3);
  if (!['idle', 'syncing', 'sync-waiting', 'sync-preparing'].includes(folder.state)) return state('unknown', '状态待确认', 'neutral', 4);
  if (['needItems', 'needBytes', 'remoteNeedItems', 'remoteNeedBytes'].some(key => folder[key] == null)) return state('unknown', '状态待确认', 'neutral', 4);
  if (folder.needItems || folder.needBytes) return state('receive', '待接收', 'warn', 5);
  if (folder.remoteNeedItems || folder.remoteNeedBytes) return state('send', '待对方接收', 'warn', 5);
  if (folder.state !== 'idle') return state('unknown', '同步待确认', 'warn', 4);
  return state('synced', '已同步', 'good', 6);
}
const worst = states => states.reduce((a, b) => b.rank < a.rank ? b : a);
function selectedState() {
  const states = [folderState(selectedFolder())];
  if (view === 'files') {
    if (fileFailure) states.push(state('unknown', '文件状态读取失败', 'bad', 0));
    if (fileWarning) states.push(state('unknown', '有同步警告', 'warn', 4));
    for (const file of entries) {
      if (file.status === 'error') states.push(state('error', '同步异常', 'bad', 0));
      else if (file.status === 'scanning') states.push(state('scanning', '正在扫描', 'warn', 3));
      else if (file.status === 'offline_pending' || file.status === 'local_current') states.push(state('unknown', '状态待确认', 'neutral', 4));
      else if (file.status === 'paused') states.push(state('paused', '已暂停', 'neutral', 2));
      else if (file.status === 'unknown' || !fileStatuses[file.status]) states.push(state('unknown', '状态待确认', 'neutral', 4));
      else if (['downloading', 'uploading', 'pending_delete'].includes(file.status) || (file.status === 'synced' && !file.localAvailable)) states.push(state('pending', '待同步', 'warn', 5));
    }
  } else if (view === 'sync') {
    if (activityFailure) states.push(state('unknown', '队列读取失败', 'bad', 0));
    if (activityWarnings.length) states.push(state('unknown', '有同步警告', 'warn', 4));
    for (const item of activity) {
      if (item.error || item.status === 'error' || item.direction === 'error') states.push(state('error', '同步异常', 'bad', 0));
      else if (item.status === 'offline') states.push(state('offline', '离线', 'neutral', 1));
      else if (item.status === 'paused') states.push(state('paused', '已暂停', 'neutral', 2));
      else if (!['pending', 'receiving'].includes(item.status)) states.push(state('unknown', '状态待确认', 'neutral', 4));
      else states.push(state('pending', item.status === 'receiving' && item.direction === 'receive' ? '正在接收' : '待同步', 'warn', 5));
    }
  }
  return worst(states);
}
function renderHealth() {
  const states = (current?.folders || []).map(folderState);
  if (selectedId) states.push(selectedState());
  let result = states.length ? worst(states) : folderState(null);
  if (snapshotFailed) result = state('unknown', '状态读取失败', 'bad', 0);
  $('health').textContent = result.label; $('health').className = 'health ' + result.tone;
}
const fileStatuses = {
  synced: ['已同步', 'good'], downloading: ['待接收', 'warn'], uploading: ['待对方接收', 'warn'],
  offline_pending: ['离线 · 待同步', 'neutral'], local_current: ['本地索引', 'neutral'],
  scanning: ['等待扫描', 'warn'], ignored: ['已忽略', 'neutral'], error: ['同步异常', 'bad'],
  pending_delete: ['待删除同步', 'warn'], paused: ['已暂停', 'neutral'], directory: ['文件夹', 'neutral'], unknown: ['状态待确认', 'neutral']
};
function fileScope() {
  const folder = selectedFolder();
  if (snapshotFailed || fileFailure || !folder) return state('unknown', '状态待确认', 'neutral', 4);
  // A folder's item-error count is aggregate; only root/lifecycle blockers apply to every row.
  if (folder.error || folder.state === 'error') return state('error', '同步异常', 'bad', 0);
  if (!current.connected || !folder.connected) return state('offline', '离线', 'neutral', 1);
  if (folder.paused) return state('paused', '已暂停', 'neutral', 2);
  if (['scanning', 'scan-waiting', 'scan-preparing'].includes(folder.state)) return state('scanning', '正在扫描', 'warn', 3);
  return null;
}
function fileState(file, scope) {
  if (file.status === 'error') return fileStatuses.error;
  if (file.status === 'ignored') return fileStatuses.ignored;
  if (scope) return [scope.label, scope.tone];
  if (file.kind === 'directory' && ['synced', 'directory'].includes(file.status)) return fileStatuses.directory;
  if (file.status === 'synced' && !file.localAvailable) return ['待下载', 'warn'];
  return fileStatuses[file.status] || fileStatuses.unknown;
}
function resetFiles() {
  fileEpoch++; fileBusy = false; fileLoaded = false; entries = []; total = 0; nextOffset = null; fileWarning = ''; fileFailure = '';
}
function resetActivity() {
  activityEpoch++; activityBusy = false; activityLoaded = false; activity = []; activityPage = 0; activityMore = false; activityWarnings = []; activityFailure = '';
}
function cancelFilter() { if (filterTimer != null) clearTimeout(filterTimer); filterTimer = null; }
function renderBreadcrumbs() {
  const key = selectedId + '/' + directory;
  $('parent-folder').disabled = !directory;
  if (key === breadcrumbKey) return;
  breadcrumbKey = key;
  const parts = directory ? directory.split('/') : [], crumbs = [];
  ['全部文件', ...parts].forEach((part, index) => {
    if (index) { const separator = text('span', '/', 'breadcrumb-separator'); separator.setAttribute('aria-hidden', 'true'); crumbs.push(separator); }
    const isCurrent = index === parts.length;
    const crumb = text(isCurrent ? 'span' : 'button', part, isCurrent ? 'breadcrumb-current' : 'breadcrumb-button');
    if (isCurrent) { crumb.setAttribute('aria-current', 'page'); crumb.setAttribute('tabindex', '-1'); }
    else { crumb.type = 'button'; crumb.onclick = () => navigate(selectedId, parts.slice(0, index).join('/')); }
    crumbs.push(crumb);
  });
  $('breadcrumbs').replaceChildren(...crumbs);
}
function emptyRow(columns, content, kind = 'folder', connect = false) {
  const row = document.createElement('tr'); row.className = 'empty-row';
  const cell = document.createElement('td'); cell.colSpan = columns;
  const wrapper = document.createElement('div'); wrapper.className = 'empty-content';
  wrapper.append(icon(kind, 'empty-icon'), text('p', content));
  if (connect) { const button = text('button', '连接账号'); button.type = 'button'; button.onclick = () => showView('settings'); wrapper.append(button); }
  cell.append(wrapper); row.append(cell); return row;
}
function renderFiles() {
  renderBreadcrumbs();
  $('file-filter').disabled = !selectedId; $('open-current').disabled = !selectedId;
  $('reveal-label').textContent = revealLabel();
  for (const key of ['name', 'size', 'modified']) {
    $('heading-' + key).setAttribute('aria-sort', key === sortBy ? descending ? 'descending' : 'ascending' : 'none');
    $('sort-' + key + '-mark').textContent = key === sortBy ? descending ? '↓' : '↑' : '↕';
    $('sort-' + key).disabled = !selectedId;
  }
  $('files-count').textContent = fileLoaded ? `${total.toLocaleString('zh-CN')} 项` : '—';
  $('load-more').hidden = nextOffset == null; $('load-more').disabled = fileBusy;
  $('file-rows').setAttribute('aria-busy', String(fileBusy));
  $('files-message').textContent = fileFailure || fileWarning;
  $('files-message').className = 'inline-message' + (fileFailure ? ' error' : '');
  const focusKey = document.activeElement?.getAttribute('data-file-focus'), focusables = new Map();
  const scope = fileScope();
  const rows = entries.map(file => {
    const row = document.createElement('tr'), nameCell = document.createElement('td');
    const nameContent = document.createElement('div'); nameContent.className = 'name-content';
    const name = text(file.kind === 'directory' ? 'button' : 'span', file.name, 'file-name'); name.title = file.name;
    if (file.kind === 'directory') {
      name.type = 'button'; name.onclick = () => navigate(selectedId, file.path);
      name.setAttribute('data-file-focus', 'browse:' + file.path); focusables.set('browse:' + file.path, name);
    }
    nameContent.append(icon(file.kind === 'directory' ? 'folder' : file.kind, 'file-icon ' + file.kind), name); nameCell.append(nameContent);
    const size = text('td', file.kind === 'file' ? bytes(file.size) : '—');
    const date = new Date(file.modified);
    const modified = text('td', Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString('zh-CN', {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}));
    const status = document.createElement('td'), [label, tone] = fileState(file, scope); status.append(text('span', label, 'badge ' + tone));
    const actionCell = document.createElement('td'), reveal = document.createElement('button'); reveal.type = 'button'; reveal.className = 'icon-button row-reveal';
    const unavailable = file.kind === 'symlink' ? '不支持显示符号链接' : !file.localAvailable ? '尚未下载到本机' : '';
    reveal.title = unavailable || revealLabel(); reveal.setAttribute('aria-label', `${file.name}：${unavailable || revealLabel()}`);
    reveal.disabled = !!unavailable; reveal.append(icon('reveal'));
    reveal.onclick = () => revealFile(file.path); reveal.setAttribute('data-file-focus', 'reveal:' + file.path); focusables.set('reveal:' + file.path, reveal);
    actionCell.append(reveal); row.append(nameCell, size, modified, status, actionCell); return row;
  });
  if (!rows.length) rows.push(emptyRow(5, !selectedId ? '连接账号后浏览文件' : fileBusy || filterTimer != null ? '正在读取文件' : fileFailure ? '读取失败，请刷新重试' : $('file-filter').value.trim() ? '没有匹配的文件' : '此目录为空', 'folder', !selectedId));
  $('file-rows').replaceChildren(...rows);
  if (focusKey && !focusables.get(focusKey)?.disabled) focusables.get(focusKey)?.focus({preventScroll: true});
  renderHealth();
}
async function loadFiles(append = false, quiet = false) {
  if (!selectedId || (append && nextOffset == null)) { renderFiles(); return; }
  const epoch = ++fileEpoch, id = selectedId, path = directory, filter = $('file-filter').value.trim();
  const wanted = append ? 1 : Math.max(1, Math.ceil(entries.length / 100));
  let offset = append ? nextOffset : 0;
  fileBusy = true; if (!quiet) renderFiles();
  else { $('load-more').disabled = true; $('file-rows').setAttribute('aria-busy', 'true'); }
  try {
    let collected = [], page, warnings = [];
    for (let i = 0; i < wanted; i++) {
      page = await invoke('list_files', {id, path, offset, filter, sortBy, descending});
      if (epoch !== fileEpoch) return;
      collected.push(...page.entries); if (page.warning) warnings.push(page.warning);
      if (page.nextOffset == null) break;
      offset = page.nextOffset;
    }
    entries = append ? entries.concat(collected) : collected; total = page.total; nextOffset = page.nextOffset;
    fileWarning = [...new Set(append ? [fileWarning, ...warnings].filter(Boolean) : warnings)].join('；'); fileFailure = ''; fileLoaded = true;
  } catch (error) {
    if (epoch !== fileEpoch) return;
    fileFailure = '文件读取失败：' + String(error) + (entries.length ? '（保留上次结果）' : '');
  } finally {
    if (epoch === fileEpoch) { fileBusy = false; renderFiles(); }
  }
}
async function navigate(id, path) {
  cancelFilter(); selectedId = id; directory = path; $('file-filter').value = ''; resetFiles();
  renderFiles(); await loadFiles();
  if (selectedId === id && directory === path) $('breadcrumbs').children[$('breadcrumbs').children.length - 1]?.focus({preventScroll: true});
}
async function revealFile(path) {
  const id = selectedId;
  try { await invoke('reveal_file', {id, path}); notice('reveal', ''); }
  catch (error) { notice('reveal', revealLabel() + '失败：' + String(error)); }
}
function activityState(item) {
  if (item.error || item.status === 'error' || item.direction === 'error') return ['同步异常', 'bad'];
  const folder = folderState(selectedFolder());
  if (snapshotFailed || activityFailure) return ['状态待确认', 'neutral'];
  if (folder.code === 'offline' || item.status === 'offline') return ['离线 · 待同步', 'neutral'];
  if (folder.code === 'paused' || item.status === 'paused') return ['已暂停', 'neutral'];
  if (folder.code === 'scanning') return ['正在扫描', 'warn'];
  if (!['pending', 'receiving'].includes(item.status)) return ['状态待确认', 'neutral'];
  if (item.direction === 'send') return ['待对方接收', 'warn'];
  if (item.direction === 'receive') return item.status === 'receiving' ? ['接收中', 'warn'] : ['待接收', 'warn'];
  return ['状态待确认', 'neutral'];
}
function renderActivity() {
  const folder = selectedFolder();
  $('sync-summary').textContent = !folder ? '尚未连接账号' : `待接收 ${folder.needItems ?? '—'} 项 · ${bytes(folder.needBytes)}　待发送 ${folder.remoteNeedItems ?? '—'} 项 · ${bytes(folder.remoteNeedBytes)}`;
  $('sync-message').textContent = [activityFailure, folder?.error, ...activityWarnings].filter(Boolean).join('；');
  $('sync-message').className = 'inline-message' + (activityFailure || folder?.error ? ' error' : '');
  $('activity-count').textContent = activityLoaded ? `${activity.length.toLocaleString('zh-CN')} 项${activityMore ? '已载入' : ''}` : '—';
  $('activity-more').hidden = !activityMore; $('activity-more').disabled = activityBusy;
  $('activity-rows').setAttribute('aria-busy', String(activityBusy));
  const rows = activity.map(item => {
    const row = document.createElement('tr'), nameCell = document.createElement('td'), nameContent = document.createElement('div'); nameContent.className = 'name-content';
    const info = document.createElement('div'); info.className = 'activity-name';
    const name = text('span', item.name, 'file-name'); name.title = item.path; info.append(name);
    if (item.deleted) name.append(text('span', '删除', 'delete-label'));
    if (item.path !== item.name) info.append(text('p', item.path, 'activity-path'));
    if (item.error) info.append(text('p', item.error, 'activity-error'));
    nameContent.append(icon(item.kind === 'directory' ? 'folder' : item.kind, 'file-icon ' + item.kind), info); nameCell.append(nameContent);
    const direction = text('td', item.direction === 'receive' ? '↓ 接收' : item.direction === 'send' ? '↑ 发送' : '异常');
    const size = text('td', item.kind === 'file' && !item.deleted ? bytes(item.size) : '—');
    const status = document.createElement('td'), [label, tone] = activityState(item); status.append(text('span', label, 'badge ' + tone));
    row.append(nameCell, direction, size, status); return row;
  });
  if (!rows.length) rows.push(emptyRow(4, !selectedId ? '连接账号后查看同步' : activityBusy ? '正在读取队列' : activityFailure ? '读取失败，请刷新重试' : activityWarnings.length || folderState(folder).code !== 'synced' ? '暂无可显示的任务' : '暂无待同步任务', 'sync', !selectedId));
  $('activity-rows').replaceChildren(...rows); renderHealth();
}
async function loadActivity(append = false, quiet = false) {
  if (!selectedId || (append && !activityMore)) { renderActivity(); return; }
  const epoch = ++activityEpoch, id = selectedId, wanted = append ? 1 : Math.max(1, activityPage);
  const first = append ? activityPage + 1 : 1;
  activityBusy = true; if (!quiet) renderActivity(); else { $('activity-more').disabled = true; $('activity-rows').setAttribute('aria-busy', 'true'); }
  try {
    let collected = [], warnings = [], result, page = first;
    for (let i = 0; i < wanted; i++, page++) {
      result = await invoke('sync_activity', {id, page});
      if (epoch !== activityEpoch) return;
      collected.push(...result.entries); warnings.push(...result.warnings);
      if (!result.hasMore) break;
    }
    activity = append ? activity.concat(collected) : collected;
    activityPage = result.page; activityMore = result.hasMore; activityLoaded = true; activityFailure = '';
    activityWarnings = [...new Set(append ? activityWarnings.concat(warnings) : warnings)];
  } catch (error) {
    if (epoch !== activityEpoch) return;
    activityFailure = '同步队列读取失败：' + String(error) + (activity.length ? '（保留上次结果）' : '');
  } finally {
    if (epoch === activityEpoch) { activityBusy = false; renderActivity(); }
  }
}
async function showView(next, focus = true) {
  view = next;
  for (const key of ['files', 'sync', 'settings']) {
    $('page-' + key).hidden = key !== view; $('nav-' + key).className = 'nav-item' + (key === view ? ' active' : '');
    if (key === view) $('nav-' + key).setAttribute('aria-current', 'page'); else $('nav-' + key).removeAttribute('aria-current');
  }
  $('page-title').textContent = {files: '文件', sync: '同步', settings: '设置'}[view];
  $('folder-control').hidden = view === 'settings' || (current?.folders?.length || 0) < 2;
  renderNotice(); renderHealth();
  if (focus) $('page-title').focus({preventScroll: true});
  if (view === 'files') { renderFiles(); if (!fileBusy && filterTimer == null) await loadFiles(false, fileLoaded); }
  if (view === 'sync') { renderActivity(); if (!activityBusy) await loadActivity(false, activityLoaded); }
}
function accountReady() { return !!current && !current.account?.loading; }
function setBusy(value) {
  busy = value; const blocked = busy || !accountReady();
  $('join').disabled = blocked; $('saved-login').disabled = blocked || accountDirty; $('forget-account').disabled = blocked;
}
function updateAccount(info, fill) {
  const account = info || {};
  $('storage-note').textContent = current?.platform === 'macos'
    ? '密码保存在本机文件，仅当前用户可读写，未加密。'
    : current?.platform === 'windows' ? '密码仅保存在系统凭据库，选项在登录成功后生效。' : '选项在登录成功后生效。';
  if (account.loading) { $('account-summary').textContent = current?.platform === 'macos' ? '正在读取登录信息' : '正在读取系统凭据库'; setBusy(busy); return; }
  if (fill) {
    $('server').value = account.server || current.serverHint || ''; $('username').value = account.username || '';
    $('remember-password').checked = !!account.hasPassword; $('auto-login').checked = !!account.autoLogin; accountDirty = false;
  }
  $('saved-login').hidden = !account.hasPassword; $('forget-account').hidden = !account.username && !account.storageError;
  $('account-summary').textContent = account.username ? `${account.username} · ${account.autoLogin ? '自动登录已开启' : account.hasPassword ? '密码已保存' : '账号已记住'}` : current.folders.length ? '设备已授权' : '尚未连接账号';
  if (account.storageError && account.storageError !== lastStorageError) message(account.storageError, true);
  lastStorageError = account.storageError || ''; setBusy(busy);
}
function renderSnapshot(snapshot, fill = false) {
  current = snapshot; snapshotFailed = false;
  const folders = snapshot.folders || [];
  if (!folders.some(folder => folder.id === selectedId)) {
    cancelFilter(); selectedId = folders[0]?.id || ''; directory = ''; $('file-filter').value = ''; resetFiles(); resetActivity();
  }
  const optionKey = folders.map(folder => JSON.stringify([folder.id, folder.label])).join('|');
  if ($('folder-select').getAttribute('data-options') !== optionKey) {
    $('folder-select').replaceChildren(...folders.map(folder => { const option = text('option', folder.label); option.value = folder.id; return option; }));
    $('folder-select').setAttribute('data-options', optionKey);
  }
  $('folder-select').value = selectedId; $('folder-control').hidden = view === 'settings' || folders.length < 2;
  $('version').textContent = snapshot.version; $('home').textContent = snapshot.home; $('fingerprint').textContent = snapshot.caFingerprint || '使用系统公信 CA';
  updateAccount(snapshot.account, fill || (!initialized && !snapshot.account?.loading && !accountDirty));
  renderFiles(); renderActivity(); renderHealth();
}
async function savedLogin(automatic = false) {
  if (busy || !accountReady() || (!automatic && accountDirty)) return;
  setBusy(true); message(automatic ? '正在自动登录…' : '正在登录…');
  try {
    await invoke('login_saved', {automatic}); message('登录成功。'); await refresh(false, true);
    if (!automatic) await showView('files');
  } catch (error) { message((automatic ? '自动登录未完成：' : '') + String(error), true); }
  finally { setBusy(false); }
}
async function refresh(allowAutomatic = true, forceAccountFill = false) {
  if (refreshing) { pendingAccountFill ||= forceAccountFill; return; }
  refreshing = true; $('refresh').disabled = true; $('sync-refresh').disabled = true;
  let shouldAuto = false;
  try {
    const snapshot = await invoke('snapshot'); renderSnapshot(snapshot, forceAccountFill); notice('snapshot', '');
    if (!initialized && !snapshot.account?.loading) {
      initialized = true;
      shouldAuto = allowAutomatic && snapshot.account?.autoLogin && snapshot.account?.hasPassword && !snapshot.account?.storageError && !autoAttempted && !busy && !accountDirty;
      if (shouldAuto) autoAttempted = true;
    }
    if (view === 'files' && !fileBusy && filterTimer == null) await loadFiles(false, fileLoaded);
    if (view === 'sync' && !activityBusy) await loadActivity(false, activityLoaded);
  } catch (error) {
    snapshotFailed = true; notice('snapshot', '同步状态读取失败：' + String(error)); renderFiles(); renderActivity(); renderHealth();
  } finally { refreshing = false; $('refresh').disabled = false; $('sync-refresh').disabled = false; }
  if (pendingAccountFill) { pendingAccountFill = false; await refresh(false, true); }
  else if (shouldAuto) await savedLogin(true);
}
$('login').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !accountReady()) return;
  setBusy(true); autoAttempted = true; message('正在验证账号…');
  let password = $('password').value; $('password').value = '';
  try {
    const result = await invoke('join_account', {server: $('server').value.trim(), username: $('username').value.trim(), password,
      rememberPassword: $('remember-password').checked, autoLogin: $('auto-login').checked});
    password = ''; message(result.warning ? '登录成功，但登录信息未保存：' + result.warning : '登录成功。', !!result.warning);
    await refresh(false, true); if (!result.warning) await showView('files');
  } catch (error) { message(error, true); }
  finally { password = ''; setBusy(false); }
});
function dirtyAccount() { accountDirty = true; $('saved-login').disabled = true; }
for (const id of ['server', 'username', 'password']) $(id).addEventListener('input', dirtyAccount);
$('remember-password').addEventListener('change', () => { if (!$('remember-password').checked) $('auto-login').checked = false; dirtyAccount(); });
$('auto-login').addEventListener('change', () => { if ($('auto-login').checked) $('remember-password').checked = true; dirtyAccount(); });
$('saved-login').onclick = () => savedLogin(false);
$('forget-account').onclick = () => { if (!busy && accountReady()) $('forget-dialog').showModal(); };
$('cancel-forget').onclick = () => $('forget-dialog').close();
$('confirm-forget').onclick = async () => {
  if (busy || !accountReady()) return;
  $('forget-dialog').close(); setBusy(true); autoAttempted = true;
  try { await invoke('forget_account'); $('password').value = ''; await refresh(false, true); message('已清除登录信息。设备授权与同步文件保留。'); }
  catch (error) { message(error, true); }
  finally { setBusy(false); }
};
for (const key of ['files', 'sync', 'settings']) $('nav-' + key).onclick = () => showView(key);
$('notice-settings').onclick = () => showView('settings');
$('dismiss-notice').onclick = () => notice(noticeKey, '');
$('refresh').onclick = () => { cancelFilter(); return refresh(); };
$('sync-refresh').onclick = () => refresh();
$('folder-select').addEventListener('change', async () => {
  cancelFilter(); selectedId = $('folder-select').value; directory = ''; $('file-filter').value = ''; resetFiles(); resetActivity();
  if (view === 'sync') { renderActivity(); await loadActivity(); } else { renderFiles(); await loadFiles(); }
});
$('parent-folder').onclick = () => navigate(selectedId, directory.split('/').slice(0, -1).join('/'));
$('open-current').onclick = () => selectedId && revealFile(directory);
$('load-more').onclick = () => !fileBusy && loadFiles(true);
$('activity-more').onclick = () => !activityBusy && loadActivity(true);
$('file-filter').addEventListener('input', () => {
  cancelFilter(); resetFiles();
  filterTimer = setTimeout(() => { filterTimer = null; return loadFiles(); }, 250); renderFiles();
});
for (const key of ['name', 'size', 'modified']) $('sort-' + key).onclick = () => {
  cancelFilter(); descending = key === sortBy ? !descending : false; sortBy = key; resetFiles(); renderFiles(); return loadFiles();
};
async function poll() { await refresh(); setTimeout(poll, 10000); }
setBusy(false);
showView('files', false);
poll();
