const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(__dirname + '/web/app.js', 'utf8');
const html = fs.readFileSync(__dirname + '/web/index.html', 'utf8');
function element(tag = 'div') {
  return {tagName:tag,value:'',textContent:'',className:'',disabled:false,checked:false,hidden:false,open:true,children:[],handlers:{},
    showModal(){this.modal=true},close(){this.modal=false},
    append(...children){this.children.push(...children)},replaceChildren(...children){this.children=children},
    addEventListener(name,fn){this.handlers[name]=fn},setAttribute(name,value){this[name]=value},get options(){return this.children}};
}
const folder = {id:'xc-123',label:'alice 的空间',path:'/private/alice',state:'idle',needBytes:0,needItems:0,localFiles:2,globalFiles:2,globalBytes:1048580,errors:0,error:'',connected:true,paused:false,remoteNeedItems:0,remoteNeedBytes:0};
function snapshot(account = {}) { return {version:'v1',home:'/private/profile',connected:true,caFingerprint:'public-fingerprint',serverHint:'192.0.2.1:18443',folders:[{...folder}],account:{server:'',username:'',hasPassword:false,autoLogin:false,...account}}; }
function harness(state) {
  const elements = {}, commands = [], timers = [];
  for (const id of html.matchAll(/id="([^"]+)"/g)) { assert(!elements[id[1]], 'duplicate HTML id'); elements[id[1]]=element(); }
  const self = {state, elements, commands, timers, errors:{}, confirmations:0};
  const invoke = async (command,args) => {
    commands.push({command,args});
    if (self.errors[command]) throw self.errors[command];
    if (command === 'snapshot') return self.state;
    if (command === 'list_files') return {folderId:args.id,path:args.path,total:2,nextOffset:null,warning:'',entries:[
      {name:'目录 # &',path:'目录 # &',kind:'directory',size:0,modified:'2026-11-15T11:00:00Z',status:'directory'},
      {name:'<img src=x onerror=alert(1)>.txt',path:'<img src=x onerror=alert(1)>.txt',kind:'file',size:1048576,modified:'2026-11-15T11:00:00Z',status:'synced'}]};
    if (command === 'join_account') {
      self.state.account={server:args.server,username:args.username,hasPassword:args.rememberPassword,autoLogin:args.autoLogin}; return {path:'/private/alice'};
    }
    if (command === 'forget_account') { self.state.account={}; return null; }
    return {path:'/private/alice'};
  };
  const context = {document:{getElementById:id=>{assert(elements[id], `missing HTML id ${id}`);return elements[id]},createElement:element},
    window:{__TAURI__:{core:{invoke}},confirm:()=>{self.confirmations++;return true}},setTimeout:fn=>timers.push(fn)};
  vm.runInNewContext(source,context); self.context=context; return self;
}
const tick = () => new Promise(setImmediate);
const content = el => [el.textContent,...el.children.map(content)].join(' ');
(async () => {
  const h=harness(snapshot()); await tick();
  assert.equal(h.elements.server.value,'192.0.2.1:18443'); assert.equal(h.elements.health.textContent,'服务器已连接');
  assert.equal(h.elements['stat-pending'].textContent,'0');
  assert.equal(h.commands.filter(c=>c.command==='list_files').length,1);
  assert(content(h.elements['file-rows']).includes('<img src=x onerror=alert(1)>.txt'));
  assert(content(h.elements['file-rows']).includes('与服务器一致'));
  h.elements['file-filter'].value='does-not-exist';h.elements['file-filter'].handlers.input();assert(content(h.elements['file-rows']).includes('没有匹配'));
  h.elements['file-filter'].value='';h.elements['file-filter'].handlers.input();
  await h.elements['file-rows'].children[0].children[0].children[1].onclick();
  assert.equal(h.commands.at(-1).args.path,'目录 # &'); assert(h.elements.breadcrumbs.textContent.includes('目录 # &'));
  await h.elements['parent-folder'].onclick(); assert.equal(h.commands.at(-1).args.path,'');
  h.elements['auto-login'].checked=true;h.elements['auto-login'].handlers.change();assert(h.elements['remember-password'].checked);
  h.elements['remember-password'].checked=false;h.elements['remember-password'].handlers.change();assert(!h.elements['auto-login'].checked);
  h.elements.username.value='alice';h.elements.password.value='secret-only-for-test';h.elements['remember-password'].checked=true;h.elements['auto-login'].checked=true;
  await h.elements.login.handlers.submit({preventDefault(){}});
  const call=h.commands.find(c=>c.command==='join_account');assert.equal(call.args.password,'secret-only-for-test');assert(call.args.rememberPassword&&call.args.autoLogin);
  assert.equal(h.elements.password.value,'');assert(!h.elements['saved-login'].hidden);
  h.errors.join_account='<script>unsafe server error</script>';
  h.elements.password.value='wrong';await h.elements.login.handlers.submit({preventDefault(){}});
  assert.equal(h.elements.password.value,'');assert.equal(h.elements.message.textContent,h.errors.join_account);assert(!h.elements.join.disabled);
  h.elements.username.handlers.input();assert(h.elements['saved-login'].disabled);
  h.elements['forget-account'].onclick();assert(h.elements['forget-dialog'].modal);
  h.elements['cancel-forget'].onclick();assert(!h.elements['forget-dialog'].modal);assert(!h.commands.some(c=>c.command==='forget_account'));
  h.elements['forget-account'].onclick();await h.elements['confirm-forget'].onclick();assert(!h.elements['forget-dialog'].modal);assert(h.elements['saved-login'].hidden);assert(h.elements.message.textContent.includes('设备授权与同步文件保留'));
  h.state.connected=false;h.state.folders[0].connected=false;h.state.folders[0].remoteNeedItems=null;
  await h.elements.refresh.onclick();assert.equal(h.elements['stat-pending'].textContent,'—');assert.equal(h.elements.health.textContent,'服务器未连接');assert(!h.elements['sync-summary'].textContent.includes('已与服务器同步'));
  const auto=harness(snapshot({server:'https://cloud.example:443',username:'alice',hasPassword:true,autoLogin:true}));await tick();
  assert.equal(auto.commands.filter(c=>c.command==='login_saved').length,1);assert.equal(auto.elements.username.value,'alice');assert.equal(auto.elements.password.value,'');
  await auto.elements.refresh.onclick();assert.equal(auto.commands.filter(c=>c.command==='login_saved').length,1);
  const failed=harness(snapshot({username:'alice',hasPassword:true,autoLogin:true}));failed.errors.login_saved='server offline';await tick();
  assert(failed.elements.message.textContent.includes('自动登录未完成'));await failed.elements.refresh.onclick();assert.equal(failed.commands.filter(c=>c.command==='login_saved').length,1);
  const noAuto=harness(snapshot({username:'alice',hasPassword:true,autoLogin:false}));await tick();assert(!noAuto.commands.some(c=>c.command==='login_saved'));
  const loading=harness(snapshot({loading:true}));await tick();assert(loading.elements.join.disabled);assert(loading.commands.some(c=>c.command==='list_files'));
  loading.state.account={username:'alice',hasPassword:true,autoLogin:true,loading:false};await loading.elements.refresh.onclick();assert.equal(loading.commands.filter(c=>c.command==='login_saved').length,1);assert(!loading.elements.join.disabled);
  for (const forbidden of ['innerHTML','localStorage','sessionStorage','document.cookie','eval(']) assert(!source.includes(forbidden));
  assert(!/测试版|测试内核|密码不保存|TAURI|无 Qt/.test(html));
  console.log('PASS desktop web: real contract, saved-login gating, secret clearing, failure handling, navigation, offline status, safe filenames and no browser persistence');
})().catch(error=>{console.error(error);process.exitCode=1});
