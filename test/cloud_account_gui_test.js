// Run with: node test/cloud_account_gui_test.js
// Tests the actual account controller block with a mocked transport; never logs credentials.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('gui/default/syncthing/core/syncthingController.js', 'utf8');
const start = source.indexOf('        var cloudHost = ');
const end = source.indexOf('        $scope.login = {', start);
assert(start > 0 && end > start);
const block = source.slice(start, end);
function setup(host, response, failed = false) {
    const scope = {};
    const calls = [];
    const pending = [];
    const context = {$scope: scope, $location: {search: () => ({cloud: 'join'})},
        window: {location: {hostname: host}}, urlbase: 'rest',
        $http: {post: (url, body) => {
            calls.push({url, body});
            const promise = failed ? Promise.reject(response) : Promise.resolve(response);
            pending.push(promise);
            return promise;
        }}};
    vm.runInNewContext(block, context);
    return {scope, calls, pending};
}
(async () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.equal(setup(host, {}).scope.cloud.local, true);
    for (const host of ['evil.example', '192.0.2.1']) assert.equal(setup(host, {}).scope.cloud.local, false);
    const test = setup('localhost', {data: {path: '/data/XunCloud/xc-example'}});
    Object.assign(test.scope.cloud, {server: 'server.example:8443', username: 'alice', password: 'test-only-password'});
    test.scope.joinCloud();
    test.scope.joinCloud();
    assert.equal(test.calls.length, 1, 'blocks duplicate submission');
    assert.equal(test.calls[0].url, 'rest/cloud/join');
    assert.equal(test.calls[0].body.password, 'test-only-password');
    assert.equal(test.scope.cloud.password, '', 'clears visible password immediately');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(test.scope.cloud.path, '/data/XunCloud/xc-example');
    assert.equal(test.scope.cloud.busy, false);
    const fail = setup('localhost', {status: 400, data: 'incorrect account or password'}, true);
    fail.scope.joinCloud();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fail.scope.cloud.error, 'incorrect account or password');
    assert.equal(fail.scope.cloud.busy, false);
    const noLeak = setup('localhost', {status: 500, data: {config: {password: 'never-display'}}}, true);
    noLeak.scope.joinCloud();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(noLeak.scope.cloud.error, 'HTTP 500');
    console.log('PASS: GUI loopback gating, account submission, busy state, password clearing, safe failure rendering');
})().catch(error => { console.error(error); process.exitCode = 1; });
