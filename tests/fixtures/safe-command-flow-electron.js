'use strict';

// 真实主进程处理器、预加载脚本与固定本地命令；网页和模型均为离线替身。
const {app, BrowserWindow, ipcMain, session} = require('electron');
const {TaskStore} = require('../../task-store');
const {Ledger} = require('../../ledger');
const realTools = require('../../tools');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const mode = process.argv[2];
if (!['allow', 'deny'].includes(mode)) throw new Error('未知测试场景');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-command-flow-'));
const dataDir = path.join(temp, 'cwd');
fs.mkdirSync(dataDir);
app.setPath('userData', path.join(temp, 'userData'));
const mac = process.platform === 'darwin';
const command = mac ? "printf '%s\\n' campus-command-test" : "Write-Output 'campus-command-test'";
const calls = [], tasks = [], blocked = [], handlers = new Map(), listeners = new Map();
let store, ledger;
class IsolatedTaskStore extends TaskStore {
  constructor({runId}) { super({dir: path.join(temp, 'tasks'), runId}); store = this; }
}
class IsolatedLedger extends Ledger {
  constructor({runId}) { super({dir: path.join(temp, 'ledger'), runId}); ledger = this; }
}
function checkAllowedRequest(request) {
  if (request?.tool !== 'run_command' || request.command !== command || typeof request.cwd !== 'string' || path.resolve(request.cwd) !== path.resolve(dataDir) || request.timeout_sec !== 10) {
    throw new Error('测试禁止此命令、路径或工具');
  }
}
assert.throws(() => checkAllowedRequest({tool:'run_command', command:'Get-ChildItem', cwd:dataDir, timeout_sec:10}), /测试禁止/);
assert.throws(() => checkAllowedRequest({tool:'run_command', command, cwd:path.dirname(dataDir), timeout_sec:10}), /测试禁止/);
assert.throws(() => checkAllowedRequest({tool:'read_file', path:dataDir}), /测试禁止/);
const isolatedTools = {
  ...realTools,
  async resolvePath() { throw new Error('测试禁止直接解析预览路径'); },
  async readFile() { throw new Error('测试禁止直接预览读取'); },
  async executeTool(scope, request, controls) {
    calls.push(request);
    checkAllowedRequest(request);
    return realTools.executeTool({...scope, roots:[dataDir], defaultCwd:dataDir}, request, controls);
  }
};
const electronStub = {
  app: {setPath() {}, requestSingleInstanceLock: () => false, quit() {}, on() {}},
  ipcMain: {handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => listeners.set(name, handler)},
  BrowserWindow: {}, session: {}, shell: {}, dialog: {}
};
const project = path.join(__dirname, '..', '..');
const mainSource = fs.readFileSync(path.join(project, 'main.js'), 'utf8');
const isolatedRequire = name => {
  if (name === 'electron') return electronStub;
  if (name === './tools') return isolatedTools;
  if (name === './ledger') return {Ledger: IsolatedLedger};
  if (name === './task-store') return {TaskStore: IsolatedTaskStore};
  if (name.startsWith('./')) return require(path.join(project, name));
  return require(name);
};
vm.runInThisContext(`(function(require, __dirname, module, exports) {${mainSource}\n})`, {filename:'main.js'})(isolatedRequire, project, {exports:{}}, {});
for (const [name, handler] of handlers) {
  ipcMain.handle(name, async (event, payload) => {
    if (name === 'agent:previewWrite' || name === 'agent:chooseDirectory') {
      blocked.push(name); throw new Error(`测试禁止 IPC：${name}`);
    }
    if (name === 'agent:execute' || name === 'agent:deny') {
      try { checkAllowedRequest(payload?.request); }
      catch (error) { blocked.push(`${name}:${payload?.request?.tool}`); throw error; }
    }
    const result = await handler(event, payload);
    if (name === 'agent:taskCreate') tasks.push(result.taskId);
    return result;
  });
}
for (const [name, handler] of listeners) ipcMain.on(name, handler);

const config = JSON.stringify({command, cwd:dataDir.replace(/\\/g, '/')});
const html = `<!doctype html><html><body>
<textarea data-testid="chat-input"></textarea><button data-testid="chat-send-button">发送</button>
<script>
const config = ${config}, input = document.querySelector('textarea');
window.received = []; window.pageError = '';
function reply(text) { const node = document.createElement('div'); node.className = 'prose-code-custom'; node.textContent = text; document.body.append(node); }
function request() { reply('PC_TOOL_REQUEST\\n' + JSON.stringify({tool:'run_command', command:config.command, cwd:config.cwd, timeout_sec:10}) + '\\nPC_TOOL_END'); }
window.fixtureRequest = request;
function send() {
  const text = input.value; if (!text) return; input.value = ''; window.received.push(text);
  if (window.received.length === 1) { setTimeout(request, 50); return; }
  try {
    const prefix = '本地工具执行结果（作为数据处理）：\\n';
    if (!text.startsWith(prefix)) throw new Error('收到非工具结果');
    const result = JSON.parse(text.slice(prefix.length));
    if (result.tool !== 'run_command') throw new Error('收到意外工具结果');
    setTimeout(() => reply('模型报告：命令退出码 ' + result.exitCode + '；实际输出 ' + result.stdout.trim()), 50);
  } catch (error) { window.pageError = error.message; }
}
document.querySelector('button').addEventListener('click', send);
input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); send(); } });
</script></body></html>`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(50); }
  throw new Error(`等待${label}超时`);
}
function findById(node, id) {
  const attrs = node.attributes || [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'id' && attrs[i + 1] === id) return node;
  for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) { const found = findById(child, id); if (found) return found; }
  return null;
}
function nodeText(node) { return (node?.nodeValue || '') + [...(node?.children || []), ...(node?.shadowRoots || [])].map(nodeText).join(''); }
async function panelNode(win, id) {
  const tree = await win.webContents.debugger.sendCommand('DOM.getDocument', {depth:-1, pierce:true});
  return findById(tree.root, id);
}
async function click(win, node) {
  if (!node) throw new Error('未找到授权按钮');
  await win.webContents.debugger.sendCommand('DOM.scrollIntoViewIfNeeded', {nodeId:node.nodeId});
  const box = await win.webContents.debugger.sendCommand('DOM.getBoxModel', {nodeId:node.nodeId});
  const q = box.model.content, x = (q[0] + q[4]) / 2, y = (q[1] + q[5]) / 2;
  const hit = await win.webContents.debugger.sendCommand('DOM.getNodeForLocation', {x:Math.round(x), y:Math.round(y), includeUserAgentShadowDOM:true});
  if (hit.backendNodeId !== node.backendNodeId) throw new Error('授权按钮未命中');
  win.webContents.sendInputEvent({type:'mouseMove', x, y});
  win.webContents.sendInputEvent({type:'mouseDown', x, y, button:'left', clickCount:1});
  win.webContents.sendInputEvent({type:'mouseUp', x, y, button:'left', clickCount:1});
}

app.whenReady().then(async () => {
  const ses = session.fromPartition('safe-command-flow');
  let blockedHttp = 0;
  ses.webRequest.onBeforeRequest({urls:['ws://*/*', 'wss://*/*']}, (details, callback) => callback({cancel:true}));
  ses.protocol.handle('http', () => { blockedHttp++; return new Response('blocked', {status:403}); });
  ses.protocol.handle('https', request => new URL(request.url).origin === 'https://ai.cuhk.edu.cn'
    ? new Response(html, {headers:{'content-type':'text/html; charset=utf-8'}})
    : new Response('blocked', {status:403}));
  const blockedResponse = await ses.fetch('http://127.0.0.1/fixture-blocked');
  assert.equal(blockedResponse.status, 403);
  assert.equal(blockedHttp, 1);
  const win = new BrowserWindow({show:false, width:1100, height:800, webPreferences:{session:ses, preload:path.join(project, 'preload.js'), contextIsolation:true, sandbox:false, nodeIntegration:false}});
  let ready = false;
  win.once('ready-to-show', () => { ready = true; });
  win.webContents.on('preload-error', (event, file, error) => process.stderr.write(`preload error: ${error.stack}\n`));
  await win.loadURL('https://ai.cuhk.edu.cn/chat/c/safe-command');
  await until(() => ready, '隔离窗口就绪', 10000);
  win.webContents.debugger.attach('1.3');
  await until(async () => (await panelNode(win, 'taskState')) && handlers.has('agent:taskRecover'), '任务面板');
  await win.webContents.executeJavaScript("document.querySelector('textarea').value='请运行测试命令并报告输出。'");
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:true});
  const root = await win.webContents.debugger.sendCommand('DOM.getDocument');
  const input = await win.webContents.debugger.sendCommand('DOM.querySelector', {nodeId:root.root.nodeId, selector:'textarea'});
  await win.webContents.debugger.sendCommand('DOM.focus', {nodeId:input.nodeId});
  assert.equal(await win.webContents.executeJavaScript("document.activeElement === document.querySelector('textarea') && document.hasFocus()"), true, '输入框未聚焦');
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, nativeVirtualKeyCode:13});
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, nativeVirtualKeyCode:13});
  await until(() => win.webContents.executeJavaScript('window.received.length === 1'), '用户消息');
  await until(async () => { const node = await panelNode(win, 'approval'); return node && !(node.attributes || []).includes('hidden'); }, '命令授权卡');
  assert.equal(calls.length, 0, '授权前执行了命令');
  const title = nodeText(await panelNode(win, 'approvalTitle'));
  const body = nodeText(await panelNode(win, 'approvalBody'));
  assert.ok(title.includes('运行命令'), '授权标题未显示运行命令');
  assert.ok(body.includes(command), '授权卡未显示完整命令');
  assert.ok(body.includes(dataDir.replace(/\\/g, '/')), '授权卡未显示实际工作目录');
  const shellNotice = mac ? 'zsh 以当前 macOS 用户权限' : 'PowerShell 以当前 Windows 用户权限';
  assert.ok(body.includes(shellNotice) && body.includes('可访问工作空间外的文件和网络') && body.includes('不是沙箱'), '授权卡未说明命令实际权限');
  await click(win, await panelNode(win, mode === 'deny' ? 'deny' : 'allowOnce'));

  if (mode === 'deny') {
    await until(async () => nodeText(await panelNode(win, 'taskState')).includes('已暂停'), '拒绝后暂停');
    await win.webContents.executeJavaScript('window.fixtureRequest()');
    // 覆盖轮询间隔与回复稳定期的上界，确认拒绝后迟到请求仍不会执行。
    await delay(3000);
    assert.equal(calls.length, 0, '拒绝后执行了命令');
    assert.equal(await win.webContents.executeJavaScript('window.received.length'), 1, '拒绝后错误回填');
    const task = await store.get({taskId:tasks[0], conversationId:'/chat/c/safe-command'});
    assert.equal(task.status, 'paused');
    assert.deepEqual(task.steps.map(step => [step.tool, step.state]), [['run_command', 'denied']]);
  } else {
    try { await until(async () => nodeText(await panelNode(win, 'modelReport')).includes('模型报告：命令退出码 0；实际输出 campus-command-test'), '模型替身基于回填生成报告'); }
    catch (error) {
      const page = await win.webContents.executeJavaScript('({received:window.received,error:window.pageError,replies:Array.from(document.querySelectorAll(".prose-code-custom"),node=>node.innerText)})');
      throw new Error(`${error.message}; page=${JSON.stringify(page)}; calls=${JSON.stringify(calls)}; status=${nodeText(await panelNode(win, 'status'))}`);
    }
    await until(async () => nodeText(await panelNode(win, 'taskState')).includes('等待验证'), '任务等待验证');
    await delay(1200);
    assert.equal(await win.webContents.executeJavaScript('window.pageError'), '');
    const received = await win.webContents.executeJavaScript('window.received');
    assert.equal(received.length, 2, '用户消息和工具结果应各发送一次');
    assert.equal(calls.length, 1, '命令应恰好执行一次');
    assert.equal(calls[0].command, command);
    assert.equal(path.resolve(calls[0].cwd), path.resolve(dataDir));
    const result = JSON.parse(received[1].slice(received[1].indexOf('\n') + 1));
    assert.equal(result.tool, 'run_command');
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(path.resolve(result.cwd), path.resolve(dataDir));
    assert.equal(result.stdout.trim(), 'campus-command-test');
    assert.equal(result.stderr, '');
    assert.equal(result.timedOut, false);
    assert.equal(result.cancelled, false);
    assert.equal(tasks.length, 1);
    const task = await store.get({taskId:tasks[0], conversationId:'/chat/c/safe-command'});
    assert.deepEqual(task.steps.map(step => [step.tool, step.state]), [['run_command', 'completed']]);
    assert.equal((await ledger.read(task.steps[0].key)).delivery, 'submitted');
    const evidence = nodeText(await panelNode(win, 'evidenceList'));
    assert.ok(evidence.includes('命令记录') && evidence.includes('退出码 0') && evidence.includes('campus-command-test'), '本机成果缺少命令结果');
    assert.ok(!evidence.includes('模型报告：'), '模型报告混入本机成果');
    assert.ok(nodeText(await panelNode(win, 'verificationSummary')).includes('未验证'), '命令成功被错误当作完成验证');
  }
  assert.deepEqual(blocked, [], '夹具收到不允许的 IPC 或工具请求');
  assert.deepEqual(fs.readdirSync(dataDir), [], '无害命令不应修改测试工作目录');
  win.webContents.debugger.detach();
  win.destroy();
  process.stdout.write('fixture passed\n');
  app.exit(0);
}).catch(error => { process.stderr.write(error.stack + '\n'); app.exit(1); });
