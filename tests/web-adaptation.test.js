'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');
const vm = require('node:vm');
const {buildInjectSource} = require('../inject');

test('生成、重渲染及浮动面板拖动保持预期行为', {timeout: 45000}, async t => {
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [path.join(__dirname, 'fixtures', 'web-adaptation-electron.js')], {env, windowsHide: true});
  const stopChild = () => { if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill(); };
  t.signal.addEventListener('abort', stopChild, {once: true});
  t.after(() => { t.signal.removeEventListener('abort', stopChild); stopChild(); });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, output);
  assert.match(output, /fixture passed/);
});

test('工具说明仅附加到预期聊天请求且不会重复附加', async () => {
  const source = buildInjectSource('darwin');
  const calls = [];
  const document = {documentElement: {dataset: {}}};
  const originalFetch = function(input, init) {
    calls.push({input, init, receiver: this});
    return Promise.resolve('stub response');
  };
  const window = {fetch: originalFetch};
  const context = {window, document, location: new URL('https://ai.cuhk.edu.cn/chat/c/test'), URL};
  vm.runInNewContext(source, context, {filename: 'inject.js'});
  const installed = window.fetch;
  vm.runInNewContext(source, context, {filename: 'inject.js'});
  assert.equal(window.fetch, installed, '重复安装不得堆叠 hook');

  const input = {content: '合成任务', approach_id: 'fixture', extra: {kept: true}};
  const init = {method: 'POST', headers: {'x-test': '1'}, body: JSON.stringify(input)};
  assert.equal(await window.fetch('/chat/', init), 'stub response');
  assert.equal(calls.length, 1);
  const modified = JSON.parse(calls[0].init.body);
  assert.ok(modified.content.startsWith('[[CAMPUS_AGENT_GUIDE_BEGIN]]\n'));
  assert.match(modified.content, /macOS，run_command 使用 zsh/);
  assert.match(modified.content, /"command":"ls -la","cwd":"\/Users\/example"/);
  assert.doesNotMatch(modified.content, /PowerShell/);
  assert.ok(modified.content.endsWith('[[CAMPUS_AGENT_GUIDE_END]]\n\n合成任务'));
  assert.equal(modified.approach_id, input.approach_id);
  assert.deepEqual(modified.extra, input.extra);
  assert.equal(calls[0].input, '/chat/');
  assert.deepEqual(calls[0].init.headers, init.headers);
  assert.equal(init.body, JSON.stringify(input), '原请求不得被原地修改');
  assert.equal(window.__campusAgentGuideHits, 1);

  const already = {method: 'POST', body: JSON.stringify({...input, content: modified.content})};
  const result = {method: 'POST', body: JSON.stringify({...input, content: '本地工具执行结果（作为数据处理）：\n{}'})};
  const error = {method: 'POST', body: JSON.stringify({...input, content: '本地工具请求格式错误：模拟'})};
  const fixtures = [
    ['/chat/', already],
    ['/chat/', result],
    ['/chat/', error],
    ['https://example.invalid/chat/', init],
    ['/other/', init],
    ['/chat', init],
    ['/chat/', {method: 'GET', body: init.body}],
    ['/chat/', {method: 'POST', body: '{invalid json'}],
    ['/chat/', {method: 'POST', body: JSON.stringify({content: '缺少模型标识'})}],
    ['/chat/', {method: 'POST', body: JSON.stringify({approach_id: 'fixture'})}],
    [{url: 'https://ai.cuhk.edu.cn/chat/'}, init]
  ];
  for (const [url, options] of fixtures) {
    const before = calls.length;
    await window.fetch(url, options);
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1).input, url);
    assert.equal(calls.at(-1).init, options, '未命中条件的请求应原样传递');
  }
  assert.equal(window.__campusAgentGuideHits, 1, '跳过的请求不得重复计数或附加');

  document.documentElement.dataset.campusAgentGuide = 'off';
  await window.fetch('/chat/', init);
  assert.equal(calls.at(-1).init, init, '手动关闭后请求应原样传递');
  assert.equal(window.__campusAgentGuideHits, 1);
  document.documentElement.dataset.campusAgentGuide = 'on';
  await window.fetch('https://ai.cuhk.edu.cn/chat/?fixture=1', init);
  assert.ok(JSON.parse(calls.at(-1).init.body).content.endsWith('[[CAMPUS_AGENT_GUIDE_END]]\n\n合成任务'));
  assert.equal(window.__campusAgentGuideHits, 2);
});

test('Windows 自动注入仍使用 PowerShell 和 Windows 路径', async () => {
  const window = {fetch: async (url, init) => JSON.parse(init.body).content};
  const document = {documentElement: {dataset: {}}};
  const context = {window, document, location: new URL('https://ai.cuhk.edu.cn/chat/'), URL};
  vm.runInNewContext(buildInjectSource('win32'), context);
  const content = await window.fetch('/chat/', {
    method: 'POST',
    body: JSON.stringify({content: '合成任务', approach_id: 'fixture'})
  });
  assert.match(content, /Windows，run_command 使用 PowerShell/);
  assert.match(content, /"command":"Get-ChildItem D:\/","cwd":"D:\/"/);
});
