const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(__dirname + '/web/app.js', 'utf8');
const html = fs.readFileSync(__dirname + '/web/index.html', 'utf8');
const css = fs.readFileSync(__dirname + '/web/style.css', 'utf8');
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const descendants = node => [node, ...node.children.flatMap(descendants)];
function element(tag, document) {
  const node = {tagName: tag.toLowerCase(), value: '', className: '', disabled: false, checked: false, hidden: false, open: false,
    children: [], attributes: {}, handlers: {}, parentElement: null, _text: '',
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); },
    set textContent(value) { this.replaceChildren(); this._text = String(value); },
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } },
    replaceChildren(...children) {
      if (this.children.some(child => descendants(child).includes(document.activeElement))) document.activeElement = document.body;
      for (const child of this.children) child.parentElement = null;
      this.children = []; this._text = ''; this.append(...children);
    },
    addEventListener(name, fn) { this.handlers[name] = fn; },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === 'class') this.className = String(value);
      if (['hidden', 'disabled', 'checked', 'open'].includes(name)) this[name] = true;
    },
    getAttribute(name) { return this.attributes[name] ?? null; },
    removeAttribute(name) { delete this.attributes[name]; if (['hidden', 'disabled', 'checked', 'open'].includes(name)) this[name] = false; },
    focus() { document.activeElement = this; },
    showModal() { this.modal = true; this.previousFocus = document.activeElement; },
    close() { this.modal = false; this.previousFocus?.focus(); },
    get options() { return this.children; }
  };
  return node;
}
function documentFromHTML() {
  const elements = {}, document = {activeElement: null};
  const root = element('root', document), stack = [root];
  const voidTags = new Set(['meta', 'link', 'input', 'col', 'br', 'hr']);
  let previous = 0;
  for (const match of html.matchAll(/<![^>]*>|<\/?[a-z][^>]*>/gi)) {
    stack.at(-1)._text += html.slice(previous, match.index); previous = match.index + match[0].length;
    if (match[0].startsWith('<!')) continue;
    if (match[0].startsWith('</')) { stack.pop(); continue; }
    const tag = match[0].match(/^<([\w-]+)/)[1].toLowerCase(), node = element(tag, document);
    for (const attr of match[0].slice(tag.length + 1).matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attr[1], attr[2] ?? '');
    if (node.attributes.id) { assert(!elements[node.attributes.id], 'duplicate HTML id'); elements[node.attributes.id] = node; }
    if (tag === 'body') document.body = node;
    stack.at(-1).append(node);
    if (!voidTags.has(tag) && !match[0].endsWith('/>')) stack.push(node);
  }
  document.activeElement = document.body;
  document.getElementById = id => { assert(elements[id], `missing HTML id ${id}`); return elements[id]; };
  document.createElement = tag => element(tag, document);
  document.createElementNS = (_, tag) => element(tag, document);
  return {document, elements, root};
}
const folder = {id: 'xc-123', label: 'alice 的空间', path: '/private/alice', state: 'idle', needBytes: 0, needItems: 0,
  localFiles: 2, globalFiles: 2, globalBytes: 1048580, errors: 0, error: '', connected: true, paused: false, remoteNeedItems: 0, remoteNeedBytes: 0};
const file = (name, overrides = {}) => ({name, path: name, kind: 'file', size: 1048576, modified: '2026-11-15T11:00:00Z', status: 'synced', localAvailable: true, ...overrides});
const unsafeName = '<img src=x onerror=alert(1)>.txt';
const directoryName = '目录 # &';
const defaultFiles = [file(directoryName, {kind: 'directory', size: 0, status: 'directory'}), file(unsafeName)];
function snapshot(account = {}, changes = {}) {
  return {version: 'v1', home: '/private/profile', connected: true, platform: 'macos', caFingerprint: 'public-fingerprint', serverHint: '192.0.2.1:18443',
    folders: [{...folder}], account: {server: '', username: '', hasPassword: false, autoLogin: false, loading: false, storageError: '', ...account}, ...changes};
}
function harness(state = snapshot(), options = {}) {
  const {document, elements, root} = documentFromHTML(), commands = [], timers = new Map(); let timerId = 0;
  const self = {state, elements, document, root, commands, timers, errors: {}, overrides: {}, files: defaultFiles, filesByPath: {}, fileWarning: '',
    activities: [], activitiesByFolder: {}, warnings: [], ...options};
  const invoke = async (command, args) => {
    commands.push({command, args});
    if (self.errors[command]) throw self.errors[command];
    if (self.overrides[command]) return self.overrides[command](args, self);
    if (command === 'snapshot') return self.state;
    if (command === 'list_files') {
      let rows = self.filesByPath[args.path] || (args.path ? [file('子文件.txt', {path: args.path + '/子文件.txt'})] : self.files);
      rows = rows.filter(row => row.name.toLowerCase().includes(args.filter.toLowerCase())).sort((a, b) => {
        const folderFirst = Number(b.kind === 'directory') - Number(a.kind === 'directory'); if (folderFirst) return folderFirst;
        const key = args.sortBy, compared = key === 'size' ? a.size - b.size : String(a[key]).localeCompare(String(b[key]));
        return args.descending ? -compared : compared;
      });
      return {folderId: args.id, path: args.path, total: rows.length, nextOffset: args.offset + 100 < rows.length ? args.offset + 100 : null,
        warning: self.fileWarning, entries: rows.slice(args.offset, args.offset + 100)};
    }
    if (command === 'sync_activity') {
      const rows = self.activitiesByFolder[args.id] || self.activities, start = (args.page - 1) * 100;
      return {folderId: args.id, page: args.page, entries: rows.slice(start, start + 100), hasMore: start + 100 < rows.length, warnings: self.warnings};
    }
    if (command === 'join_account') {
      self.state.account = {server: args.server, username: args.username, hasPassword: args.rememberPassword, autoLogin: args.autoLogin}; return {path: '/private/alice'};
    }
    if (command === 'forget_account') { self.state.account = {}; return null; }
    if (command === 'login_saved' || command === 'reveal_file') return {path: '/private/alice'};
    throw new Error('unexpected native command: ' + command);
  };
  const context = {document, window: {__TAURI__: {core: {invoke}}},
    setTimeout: (fn, delay) => { timers.set(++timerId, {fn, delay}); return timerId; }, clearTimeout: id => timers.delete(id)};
  self.runTimer = async delay => {
    const match = [...timers].find(([, timer]) => timer.delay === delay); assert(match, `missing ${delay}ms timer`);
    timers.delete(match[0]); await match[1].fn(); await tick();
  };
  vm.runInNewContext(source, context); return self;
}
const calls = (h, command) => h.commands.filter(call => call.command === command);
const textOf = (h, id) => h.elements[id].textContent;
const rows = h => h.elements['file-rows'].children;
const click = async node => { assert(!node.disabled, 'cannot click disabled control'); await node.onclick(); };
const input = (h, id, value) => { h.elements[id].value = value; h.elements[id].handlers.input(); };
const directoryButton = h => rows(h)[0].children[0].children[0].children[1];
const statusOf = row => row.children[3].textContent;
const pageResult = (args, entries) => ({folderId: args.id, path: args.path, entries, total: entries.length, nextOffset: null, warning: ''});
let checks = 0;
async function check(name, test) { await test(); checks++; console.log('PASS ' + name); }
(async () => {
  await check('three separate pages, file-first layout, no home account form or filler', async () => {
    const h = harness(); await tick();
    assert.equal(h.elements['page-files'].hidden, false); assert(h.elements['page-settings'].hidden); assert(h.elements['page-sync'].hidden);
    assert(descendants(h.elements['page-settings']).includes(h.elements.login)); assert(!descendants(h.elements['page-files']).includes(h.elements.login));
    const nav = descendants(h.root).find(node => node.attributes['aria-label'] === '主导航');
    assert.deepEqual(nav.children.map(node => node.textContent.trim()), ['文件', '同步', '设置']); assert(!nav.textContent.includes('alice'));
    for (const id of ['stat-files', 'stat-bytes', 'stat-pending', 'folders', 'account-panel']) assert(!h.elements[id]);
    assert(!/你的私人|私人空间|文件属于|自然同步|同步索引|显示已被|已完成/.test(html));
    assert.equal(textOf(h, 'page-title'), '文件'); assert.equal(textOf(h, 'health'), '已同步');
    assert.equal(calls(h, 'list_files').length, 1); assert.equal(calls(h, 'sync_activity').length, 0); assert(h.elements['folder-control'].hidden);
    assert(textOf(h, 'file-rows').includes(unsafeName)); assert(!descendants(h.elements['file-rows']).some(node => node.tagName === 'img'));
    assert.equal(statusOf(rows(h)[0]), '文件夹'); assert.equal(statusOf(rows(h)[1]), '已同步');
    assert.equal(textOf(h, 'reveal-label'), '在访达中显示');
    await click(h.elements['nav-settings']); assert.equal(h.document.activeElement, h.elements['page-title']);
    assert.equal(h.elements['nav-settings'].attributes['aria-current'], 'page'); assert.equal(h.elements['nav-files'].attributes['aria-current'], undefined);
    assert(h.elements['page-files'].hidden); assert(!h.elements['page-settings'].hidden);
  });
  await check('nested navigation, each breadcrumb, parent, meaningful keyboard focus', async () => {
    const nested = directoryName + '/下一层', h = harness(snapshot(), {filesByPath: {[directoryName]: [file('下一层', {path: nested, kind: 'directory', status: 'directory'})]}}); await tick();
    await click(directoryButton(h)); assert.equal(calls(h, 'list_files').at(-1).args.path, directoryName);
    await click(directoryButton(h)); assert.equal(calls(h, 'list_files').at(-1).args.path, nested);
    let crumbs = h.elements.breadcrumbs.children.filter(node => node.tagName === 'button'); assert.equal(crumbs.length, 2);
    await click(crumbs[1]); assert.equal(calls(h, 'list_files').at(-1).args.path, directoryName);
    assert.equal(h.document.activeElement.attributes['aria-current'], 'page');
    await click(h.elements['parent-folder']); assert.equal(calls(h, 'list_files').at(-1).args.path, ''); assert(h.elements['parent-folder'].disabled);
    await click(directoryButton(h)); crumbs = h.elements.breadcrumbs.children.filter(node => node.tagName === 'button');
    await click(crumbs[0]); assert.equal(calls(h, 'list_files').at(-1).args.path, '');
    const focused = directoryButton(h); focused.focus(); await click(h.elements.refresh);
    assert.equal(h.document.activeElement.attributes['data-file-focus'], 'browse:' + directoryName);
  });
  await check('platform-specific reveal, current relative path, unavailable/link restrictions, clear errors', async () => {
    const h = harness(); await tick(); await click(h.elements['open-current']);
    assert.equal(calls(h, 'reveal_file').at(-1).args.path, '');
    await click(rows(h)[1].children[4].children[0]); assert.equal(calls(h, 'reveal_file').at(-1).args.path, unsafeName);
    await click(directoryButton(h)); await click(h.elements['open-current']); assert.equal(calls(h, 'reveal_file').at(-1).args.path, directoryName);
    h.errors.reveal_file = '<script>not local</script>'; await click(h.elements['open-current']);
    assert(textOf(h, 'notice-text').includes(h.errors.reveal_file)); assert(!h.elements.notice.hidden);
    assert(!h.commands.some(call => /open_folder|shell|execute|read_file/.test(call.command)));
    const unavailable = harness(snapshot({}, {platform: 'windows'}), {files: [file('remote.txt', {localAvailable: false, status: 'downloading'}), file('link', {kind: 'symlink', localAvailable: false, status: 'unknown'})]}); await tick();
    assert.equal(textOf(unavailable, 'reveal-label'), '在资源管理器中显示');
    for (const row of rows(unavailable)) { const button = row.children[4].children[0]; assert(button.disabled); assert(/尚未下载|符号链接/.test(button.title)); assert(button.attributes['aria-label'].includes(row.children[0].textContent)); }
    const linux = harness(snapshot({}, {platform: 'linux'})); await tick(); assert.equal(textOf(linux, 'reveal-label'), '在文件管理器中显示');
  });
  await check('whole-directory native filtering, debounce, native sorting and pagination refresh', async () => {
    const many = Array.from({length: 204}, (_, i) => file(`item-${String(i).padStart(3, '0')}.txt`, {size: i})); many.push(file('唯一.txt'));
    const h = harness(snapshot(), {files: many}); await tick(); assert.equal(rows(h).length, 100); assert.equal(textOf(h, 'files-count'), '205 项');
    await click(h.elements['load-more']); assert.equal(rows(h).length, 200);
    const before = calls(h, 'list_files').length; await click(h.elements.refresh);
    assert.deepEqual(calls(h, 'list_files').slice(before).map(call => call.args.offset), [0, 100]); assert.equal(rows(h).length, 200);
    const count = calls(h, 'list_files').length;
    input(h, 'file-filter', '不匹配'); input(h, 'file-filter', '唯一'); assert.equal(calls(h, 'list_files').length, count);
    assert.equal([...h.timers.values()].filter(timer => timer.delay === 250).length, 1);
    await h.runTimer(250); assert.equal(calls(h, 'list_files').at(-1).args.filter, '唯一'); assert.equal(rows(h).length, 1); assert.equal(textOf(h, 'files-count'), '1 项');
    assert(textOf(h, 'file-rows').includes('唯一.txt')); assert(h.elements['load-more'].hidden);
    await click(h.elements['sort-size']); let args = calls(h, 'list_files').at(-1).args;
    assert.equal(args.sortBy, 'size'); assert.equal(args.descending, false); assert.equal(args.filter, '唯一');
    assert.equal(h.elements['heading-size'].attributes['aria-sort'], 'ascending'); assert.equal(h.elements['heading-name'].attributes['aria-sort'], 'none');
    await click(h.elements['sort-size']); assert.equal(calls(h, 'list_files').at(-1).args.descending, true);
    await click(h.elements['sort-modified']); assert.equal(calls(h, 'list_files').at(-1).args.sortBy, 'modified'); assert.equal(calls(h, 'list_files').at(-1).args.descending, false);
    input(h, 'file-filter', 'none'); await click(h.elements.refresh); assert.equal([...h.timers.values()].filter(timer => timer.delay === 250).length, 0); assert(textOf(h, 'file-rows').includes('没有匹配'));
  });
  await check('late file requests cannot overwrite new filters, folder selections or errors', async () => {
    const old = deferred(); let n = 0;
    const h = harness(snapshot(), {overrides: {list_files: args => ++n === 1 ? old.promise : pageResult(args, [file('新结果.txt')])}}); await tick();
    input(h, 'file-filter', '新'); await h.runTimer(250); assert(textOf(h, 'file-rows').includes('新结果'));
    old.resolve(pageResult({id: folder.id, path: ''}, [file('旧结果.txt')])); await tick(); assert(!textOf(h, 'file-rows').includes('旧结果'));
    const late = deferred(), folders = [{...folder}, {...folder, id: 'xc-456', label: '第二空间'}]; let first = true;
    const switched = harness(snapshot({}, {folders}), {overrides: {list_files: args => { if (first) { first = false; return late.promise; } return pageResult(args, [file('第二空间.txt')]); }}}); await tick();
    assert(!switched.elements['folder-control'].hidden); switched.elements['folder-select'].value = 'xc-456'; await switched.elements['folder-select'].handlers.change();
    late.reject('old folder failed'); await tick(); assert(textOf(switched, 'file-rows').includes('第二空间')); assert(!textOf(switched, 'files-message').includes('old folder')); assert.equal(textOf(switched, 'health'), '已同步');
  });
  await check('global aggregation does not overwrite individual file evidence; root blockers still apply', async () => {
    for (const patch of [{state: 'scanning'}, {error: 'disk error', errors: 1}, {state: 'error'}, {connected: false}, {paused: true}]) {
      const h = harness(snapshot({}, {folders: [{...folder, ...patch}]})); await tick();
      assert.notEqual(textOf(h, 'health'), '已同步'); assert(!rows(h).some(row => statusOf(row) === '已同步'), JSON.stringify(patch));
    }
    for (const patch of [{errors: 1}, {state: ''}, {remoteNeedItems: null}]) {
      const h = harness(snapshot({}, {folders: [{...folder, ...patch}]})); await tick();
      assert.notEqual(textOf(h, 'health'), '已同步'); assert.equal(statusOf(rows(h)[1]), '已同步', JSON.stringify(patch));
    }
    const expected = {unknown: '状态待确认', scanning: '等待扫描', error: '同步异常', offline_pending: '离线 · 待同步', paused: '已暂停', 'new-native-state': '状态待确认'};
    for (const [status, label] of Object.entries(expected)) {
      const h = harness(snapshot(), {files: [file('problem', {status}), file('otherwise-current')]}); await tick();
      const problem = rows(h).find(row => row.children[0].textContent.includes('problem'));
      const normal = rows(h).find(row => row.children[0].textContent.includes('otherwise-current'));
      assert.notEqual(textOf(h, 'health'), '已同步'); assert.equal(statusOf(problem), label, status); assert.equal(statusOf(normal), '已同步', status);
    }
    const counted = harness(snapshot({}, {folders: [{...folder, errors: 1}]}), {files: [file('problem', {status: 'error'}), file('otherwise-current')]}); await tick();
    assert.equal(textOf(counted, 'health'), '同步异常'); assert.equal(statusOf(rows(counted)[0]), '已同步'); assert.equal(statusOf(rows(counted)[1]), '同步异常');
    const directory = harness(snapshot(), {files: [file('folder', {kind: 'directory', status: 'synced'})]}); await tick(); assert.equal(statusOf(rows(directory)[0]), '文件夹');
    const pending = harness(snapshot({}, {folders: [{...folder, remoteNeedItems: 1, remoteNeedBytes: 10}]})); await tick(); assert.equal(textOf(pending, 'health'), '待对方接收'); assert(!textOf(pending, 'health').includes('发送中'));
  });
  await check('failed/stale reads retain data but never retain synced claims, warnings are visible', async () => {
    const h = harness(); await tick(); h.errors.list_files = '<error> unavailable'; await click(h.elements.refresh);
    assert(textOf(h, 'files-message').includes('保留上次结果')); assert(textOf(h, 'file-rows').includes(unsafeName)); assert(!rows(h).some(row => statusOf(row) === '已同步'));
    delete h.errors.list_files; h.errors.snapshot = 'engine down'; await click(h.elements.refresh);
    assert.equal(textOf(h, 'health'), '状态读取失败'); assert(textOf(h, 'notice-text').includes('engine down')); assert(!rows(h).some(row => statusOf(row) === '已同步'));
    delete h.errors.snapshot; await click(h.elements.refresh); assert.equal(textOf(h, 'health'), '已同步'); assert(h.elements.notice.hidden);
    h.fileWarning = '服务器未连接，显示最后一次索引'; await click(h.elements.refresh); assert(textOf(h, 'files-message').includes('最后一次索引')); assert.notEqual(textOf(h, 'health'), '已同步');
  });
  await check('real sync queue only, progress-only receiving, pending-send wording, errors and deletions', async () => {
    const item = (name, overrides = {}) => ({name, path: name, kind: 'file', size: 20, direction: 'receive', status: 'pending', deleted: false, error: '', ...overrides});
    const h = harness(snapshot(), {activities: [item('progress', {status: 'receiving'}), item('queued'), item('server-needs', {direction: 'send', status: 'receiving'}), item('bad', {direction: 'error', status: 'error', error: '<script>native error</script>'}), item('deleted', {deleted: true})]}); await tick();
    assert.equal(calls(h, 'sync_activity').length, 0); await click(h.elements['nav-sync']);
    const activity = h.elements['activity-rows'].children; assert.equal(activity.length, 5);
    assert.equal(statusOf(activity[0]), '接收中'); assert.equal(statusOf(activity[1]), '待接收'); assert.equal(statusOf(activity[2]), '待对方接收'); assert.equal(statusOf(activity[3]), '同步异常');
    assert(textOf(h, 'activity-rows').includes('<script>native error</script>')); assert(!descendants(h.elements['activity-rows']).some(node => node.tagName === 'script'));
    assert(textOf(h, 'activity-rows').includes('删除')); assert(!/发送中|%|已完成|MB\/s/.test(textOf(h, 'page-sync'))); assert.equal(textOf(h, 'health'), '同步异常');
    for (const [patch, expected] of [[{connected: false}, '离线'], [{paused: true}, '已暂停'], [{state: 'scanning'}, '正在扫描']]) {
      h.state.folders = [{...folder, ...patch}]; await click(h.elements['sync-refresh']); assert(statusOf(h.elements['activity-rows'].children[0]).includes(expected));
    }
  });
  await check('queue pagination, full refresh, warnings and late folder results', async () => {
    const activities = Array.from({length: 135}, (_, i) => ({name: 'queued-' + i, path: 'queued-' + i, kind: 'file', size: 1, direction: 'send', status: 'pending', deleted: false, error: ''}));
    const h = harness(snapshot(), {activities}); await tick(); await click(h.elements['nav-sync']); assert.equal(h.elements['activity-rows'].children.length, 100);
    await click(h.elements['activity-more']); assert.equal(h.elements['activity-rows'].children.length, 135);
    const before = calls(h, 'sync_activity').length; await click(h.elements['sync-refresh']); assert.deepEqual(calls(h, 'sync_activity').slice(before).map(call => call.args.page), [1, 2]);
    h.activities = []; h.warnings = ['队列信息不完整']; await click(h.elements['sync-refresh']); assert(textOf(h, 'sync-message').includes('队列信息不完整'));
    assert(textOf(h, 'activity-rows').includes('暂无可显示的任务')); assert.notEqual(textOf(h, 'health'), '已同步');
    h.warnings = []; h.errors.sync_activity = 'queue unavailable'; await click(h.elements['sync-refresh']); assert(textOf(h, 'sync-message').includes('queue unavailable')); assert.notEqual(textOf(h, 'health'), '已同步');
    const late = deferred(); let first = true;
    const switched = harness(snapshot({}, {folders: [{...folder}, {...folder, id: 'xc-456', label: '第二空间'}]}), {overrides: {sync_activity: args => {
      if (first) { first = false; return late.promise; }
      return {folderId: args.id, page: 1, entries: [activities[0]], hasMore: false, warnings: []};
    }}}); await tick();
    const pending = switched.elements['nav-sync'].onclick(); await tick(); switched.elements['folder-select'].value = 'xc-456'; await switched.elements['folder-select'].handlers.change();
    late.resolve({folderId: folder.id, page: 1, entries: [{...activities[1], name: 'old-queue'}], hasMore: true, warnings: ['old warning']}); await pending;
    assert(!textOf(switched, 'activity-rows').includes('old-queue')); assert(!textOf(switched, 'sync-message').includes('old warning')); assert(switched.elements['activity-more'].hidden);
  });
  await check('first connection uses a short empty-state action, account saving and secret clearing', async () => {
    const empty = harness(snapshot({}, {folders: [], connected: false})); await tick();
    const connect = descendants(empty.elements['file-rows']).find(node => node.tagName === 'button'); assert(connect); await click(connect); assert(!empty.elements['page-settings'].hidden);
    assert.equal(empty.elements.server.value, '192.0.2.1:18443');
    const h = harness(); await tick(); await click(h.elements['nav-settings']);
    h.elements['auto-login'].checked = true; h.elements['auto-login'].handlers.change(); assert(h.elements['remember-password'].checked);
    h.elements['remember-password'].checked = false; h.elements['remember-password'].handlers.change(); assert(!h.elements['auto-login'].checked);
    input(h, 'username', 'alice'); input(h, 'password', 'secret-only-in-test'); h.elements['remember-password'].checked = true; h.elements['auto-login'].checked = true;
    const hold = deferred(); h.overrides.join_account = async (args, self) => { await hold.promise; self.state.account = {server: args.server, username: args.username, hasPassword: true, autoLogin: true}; return {}; };
    const submission = h.elements.login.handlers.submit({preventDefault() {}}); assert.equal(h.elements.password.value, ''); assert(h.elements.join.disabled);
    const call = calls(h, 'join_account').at(-1); assert.equal(call.args.password, 'secret-only-in-test'); assert(call.args.rememberPassword && call.args.autoLogin);
    hold.resolve(); await submission; assert.equal(h.elements.password.value, ''); assert(!h.elements['saved-login'].hidden); assert(!h.elements['page-files'].hidden);
    await click(h.elements['nav-settings']); h.errors.join_account = '<script>unsafe server error</script>'; input(h, 'password', 'wrong'); await h.elements.login.handlers.submit({preventDefault() {}});
    assert.equal(h.elements.password.value, ''); assert.equal(textOf(h, 'message'), h.errors.join_account); assert(!h.elements.join.disabled);
    await click(h.elements['nav-files']); assert(!h.elements.notice.hidden); assert(textOf(h, 'notice-text').includes(h.errors.join_account));
    await click(h.elements['notice-settings']); assert(!h.elements['page-settings'].hidden);
    input(h, 'username', 'different'); assert(h.elements['saved-login'].disabled); const savedBefore = calls(h, 'login_saved').length; await h.elements['saved-login'].onclick(); assert.equal(calls(h, 'login_saved').length, savedBefore);
  });
  await check('once-per-launch auto login, credential-loading gate, explicit storage errors, dirty edits', async () => {
    const account = {server: 'https://cloud.example:443', username: 'alice', hasPassword: true, autoLogin: true};
    const automatic = harness(snapshot(account)); await tick(); assert.equal(calls(automatic, 'login_saved').length, 1); assert.equal(calls(automatic, 'login_saved')[0].args.automatic, true);
    assert.equal(automatic.elements.password.value, ''); await automatic.runTimer(10000); assert.equal(calls(automatic, 'login_saved').length, 1);
    const failed = harness(snapshot(account), {errors: {login_saved: 'server offline'}}); await tick(); assert(textOf(failed, 'message').includes('自动登录未完成')); assert(!failed.elements.notice.hidden);
    await failed.runTimer(10000); assert.equal(calls(failed, 'login_saved').length, 1);
    delete failed.errors.login_saved; await click(failed.elements['nav-settings']); await click(failed.elements['saved-login']); assert.equal(calls(failed, 'login_saved').length, 2); assert.equal(calls(failed, 'login_saved').at(-1).args.automatic, false);
    const noAuto = harness(snapshot({...account, autoLogin: false})); await tick(); assert.equal(calls(noAuto, 'login_saved').length, 0);
    const loading = harness(snapshot({loading: true})); await tick(); assert(loading.elements.join.disabled); assert.equal(calls(loading, 'list_files').length, 1);
    loading.state.account = {...account, loading: false}; await click(loading.elements.refresh); assert.equal(calls(loading, 'login_saved').length, 1); assert(!loading.elements.join.disabled);
    const storage = harness(snapshot({...account, storageError: '系统凭据库访问被拒绝'})); await tick(); assert.equal(calls(storage, 'login_saved').length, 0); assert(textOf(storage, 'notice-text').includes('凭据库'));
    const dirty = harness(snapshot({loading: true})); await tick(); input(dirty, 'server', 'new.example'); input(dirty, 'username', 'typed'); dirty.state.account = account;
    await click(dirty.elements.refresh); assert.equal(dirty.elements.server.value, 'new.example'); assert.equal(dirty.elements.username.value, 'typed'); assert.equal(calls(dirty, 'login_saved').length, 0);
    const warning = harness(snapshot(), {overrides: {join_account: (_, self) => { self.state.account = {username: 'alice', hasPassword: false, autoLogin: false, storageError: '安全保存失败'}; return {warning: '安全保存失败'}; }}}); await tick(); await click(warning.elements['nav-settings']);
    warning.elements.password.value = 'test-only'; await warning.elements.login.handlers.submit({preventDefault() {}}); assert(!warning.elements['page-settings'].hidden); assert(textOf(warning, 'message').includes('保存失败')); assert(warning.elements['saved-login'].hidden);
  });
  await check('Mac local storage disclosure, Windows credential behavior unchanged', async () => {
    const mac = harness(snapshot({loading: true})); await tick();
    assert(textOf(mac, 'storage-note').includes('本机文件'));
    assert(textOf(mac, 'storage-note').includes('未加密'));
    assert.equal(textOf(mac, 'account-summary'), '正在读取登录信息');
    assert(!textOf(mac, 'storage-note').includes('凭据库'));
    const win = harness(snapshot({loading: true}, {platform: 'windows'})); await tick();
    assert(textOf(win, 'storage-note').includes('系统凭据库'));
    assert.equal(textOf(win, 'account-summary'), '正在读取系统凭据库');
  });
  await check('forget confirmation/cancel, retained device/files, visible failure', async () => {
    const h = harness(snapshot({username: 'alice', hasPassword: true})); await tick(); await click(h.elements['nav-settings']);
    h.elements['forget-account'].focus(); await click(h.elements['forget-account']); assert(h.elements['forget-dialog'].modal);
    await click(h.elements['cancel-forget']); assert(!h.elements['forget-dialog'].modal); assert.equal(calls(h, 'forget_account').length, 0); assert.equal(h.document.activeElement, h.elements['forget-account']);
    await click(h.elements['forget-account']); h.errors.forget_account = 'vault locked'; await click(h.elements['confirm-forget']); assert(textOf(h, 'message').includes('vault locked')); assert(!h.elements['saved-login'].hidden);
    delete h.errors.forget_account; await click(h.elements['forget-account']); await click(h.elements['confirm-forget']);
    assert(h.elements['saved-login'].hidden); assert.equal(h.elements.password.value, ''); assert(textOf(h, 'message').includes('设备授权与同步文件保留')); assert.equal(h.state.folders.length, 1);
    await click(h.elements['nav-files']); assert(textOf(h, 'file-rows').includes(unsafeName)); assert.equal(calls(h, 'login_saved').length, 0);
  });
  await check('static security, native contract, local assets and responsive/focus styles', async () => {
    new vm.Script(source);
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'localStorage', 'sessionStorage', 'document.cookie', 'eval(', 'fetch(']) assert(!source.includes(forbidden), forbidden);
    assert(!/测试版|测试内核|密码不保存|TAURI|无 Qt/.test(html)); assert(!/已完成|发送中|MB\/s/.test(html + source));
    assert(!/secret-only-in-test|queued-\d|<img src=x/.test(source + html));
    const commands = [...new Set([...source.matchAll(/invoke\('([^']+)'/g)].map(match => match[1]))].sort();
    assert.deepEqual(commands, ['forget_account', 'join_account', 'list_files', 'login_saved', 'reveal_file', 'snapshot', 'sync_activity']);
    assert(!/@import|url\(/.test(css)); assert(!/<(?:script|link)[^>]+(?:src|href)="https?:/.test(html));
    assert(css.includes('@media (max-width: 950px)')); assert(css.includes('@media (max-width: 700px)')); assert(css.includes(':focus-visible')); assert(css.includes('overflow: auto'));
    assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length); assert.equal((css.match(/\(/g) || []).length, (css.match(/\)/g) || []).length);
    assert(html.includes('aria-sort="ascending"')); assert(html.includes('aria-describedby="forget-description"'));
  });
  console.log(`PASS desktop web: ${checks} groups; native filtering/sorting/reveal/queue, stale-result protection, truthful statuses, saved-login security and static checks`);
})().catch(error => { console.error(error); process.exitCode = 1; });
