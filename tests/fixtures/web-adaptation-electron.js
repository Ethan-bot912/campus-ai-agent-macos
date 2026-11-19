'use strict';

// 模拟网页及 IPC，完全离线；只有 preload 和协议采用产品代码。
const {app, BrowserWindow, ipcMain, session} = require('electron');
const {installTaskIpc} = require('./task-ipc');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-stream-adapt-'));
app.setPath('userData', path.join(temp, 'userData'));
installTaskIpc(ipcMain);
const calls = [], deliveries = [];
const info = {workspace: null, extraRoots: [], scopeVersion: 0};
let entry = null;
ipcMain.handle('agent:info', () => info);
ipcMain.handle('agent:clearExtra', () => info);
ipcMain.handle('agent:list', () => entry ? [entry] : []);
ipcMain.handle('agent:markDelivery', (event, payload) => {
  deliveries.push(payload.delivery);
  if (entry) entry.delivery = payload.delivery;
  return entry;
});
ipcMain.handle('agent:execute', (event, payload) => {
  calls.push(payload.request);
  assert.deepEqual(payload.request, {tool: 'list_dir', path: 'D:/fixture'});
  const result = {ok: true, tool: 'list_dir', path: 'D:/fixture', entries: []};
  entry = {key: payload.key, conversationId: payload.conversationId, request: payload.request, state: 'completed', delivery: 'not_sent', result, resultText: '本地工具执行结果（作为数据处理）：\n' + JSON.stringify(result)};
  return {status: 'created', entry};
});

const html = `<!doctype html><html><body>
<textarea data-testid="chat-input"></textarea><button data-testid="chat-send-button">发送</button>
<script>
const input = document.querySelector('textarea');
window.sent = [];
function send() {
  if (!input.value) return;
  window.sent.push(input.value);
  input.value = '';
}
document.querySelector('button').addEventListener('click', send);
input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
window.beginStream = () => {
  const stop = document.createElement('button'); stop.dataset.testid = 'stop-button'; stop.textContent = '停止'; document.body.append(stop);
  const reply = document.createElement('div'); reply.className = 'prose-code-custom';
  const pre = document.createElement('pre'), code = document.createElement('code');
  code.textContent = 'PC_TOOL_REQUEST\\n{"tool":"list_dir"';
  pre.append(code); reply.append(pre); document.body.append(reply);
};
window.finishText = () => { document.querySelector('.prose-code-custom code').textContent = 'PC_TOOL_REQUEST\\n{"tool":"list_dir","path":"D:/fixture"}\\nPC_TOOL_END'; };
window.finishStream = () => document.querySelector('[data-testid="stop-button"]').remove();
window.rerender = () => {
  const old = document.querySelector('.prose-code-custom');
  const clone = old.cloneNode(true); old.replaceWith(clone);
};
</script></body></html>`;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(50); }
  throw new Error(`等待${label}超时`);
}
function findById(node, id) {
  const attrs = node.attributes || [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === 'id' && attrs[i + 1] === id) return node;
  for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
    const found = findById(child, id); if (found) return found;
  }
  return null;
}
async function panelNode(win, id) {
  const tree = await win.webContents.debugger.sendCommand('DOM.getDocument', {depth: -1, pierce: true});
  return findById(tree.root, id);
}

async function verifyPanelDrag(win) {
  const cdp = win.webContents.debugger;
  async function center(id) {
    const {nodeId} = await panelNode(win, id);
    const {model: {content: box}} = await cdp.sendCommand('DOM.getBoxModel', {nodeId});
    return {x: (box[0] + box[4]) / 2, y: (box[1] + box[5]) / 2};
  }
  async function mouse(type, point, pressed) {
    await cdp.sendCommand('Input.dispatchMouseEvent', {
      type, ...point, buttons: pressed ? 1 : 0, button: type === 'mouseMoved' && !pressed ? 'none' : 'left', clickCount: 1
    });
  }
  async function clickMinimize() {
    const point = await center('minimize');
    await mouse('mousePressed', point, true);
    await mouse('mouseReleased', point, false);
  }
  async function dragTo(point) {
    const start = await center('panelGrip');
    await mouse('mouseMoved', start, false);
    await mouse('mousePressed', start, true);
    await mouse('mouseMoved', {x: start.x - 5, y: start.y}, true);
    await mouse('mouseMoved', point, true);
    await mouse('mouseReleased', point, false);
  }
  const grip = await panelNode(win, 'panelGrip');
  const {object: {objectId}} = await cdp.sendCommand('DOM.resolveNode', {nodeId: grip.nodeId});
  async function panelRect() {
    const {result} = await cdp.sendCommand('Runtime.callFunctionOn', {
      objectId, returnByValue: true,
      functionDeclaration: 'function () { return this.closest(".panel").getBoundingClientRect().toJSON(); }'
    });
    return result.value;
  }

  await clickMinimize();
  const minimized = await panelRect();
  assert.ok(minimized.height < 150, `原地收起应切换到小面板：${JSON.stringify(minimized)}`);
  await dragTo({x: 150, y: 135});
  const collapsed = await panelRect();
  assert.ok(collapsed.x < 150 && collapsed.y < 135 && collapsed.height < 150, `收起状态应能拖到左上：${JSON.stringify(collapsed)}`);
  await clickMinimize();
  const expanded = await panelRect();
  assert.ok(expanded.height > 150 && expanded.x === collapsed.x && expanded.y === collapsed.y, '有空间时展开应保留拖动位置');
  const viewport = await win.webContents.executeJavaScript('({width: innerWidth, height: innerHeight})');
  await dragTo({x: viewport.width - 2, y: viewport.height - 2});
  const edge = await panelRect();
  assert.ok(edge.x > expanded.x && edge.y > expanded.y && edge.right <= viewport.width && edge.bottom <= viewport.height, '展开状态应能拖动且停在窗口内');
  await cdp.sendCommand('Emulation.setDeviceMetricsOverride', {width: 560, height: 450, deviceScaleFactor: 1, mobile: false});
  await until(async () => {
    const rect = await panelRect();
    return rect.right <= 560 && rect.bottom <= 450;
  }, '窗口缩小时浮动面板自动收回可视范围');
}

app.whenReady().then(async () => {
  const ses = session.fromPartition('stream-adaptation');
  ses.webRequest.onBeforeRequest({urls: ['<all_urls>']}, (details, callback) => {
    callback({cancel: /^wss?:\/\//i.test(details.url)});
  });
  ses.protocol.handle('https', () => new Response(html, {headers: {'content-type': 'text/html; charset=utf-8'}}));
  ses.protocol.handle('http', () => new Response('network disabled', {status: 403}));
  const win = new BrowserWindow({show: false, width: 1100, height: 800, webPreferences: {session: ses, preload: path.join(__dirname, '..', '..', 'preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false}});
  let readyToShow = false;
  win.once('ready-to-show', () => { readyToShow = true; });
  win.webContents.on('preload-error', (event, file, error) => process.stderr.write(`preload error: ${error.stack}\n`));
  await win.loadURL('https://ai.cuhk.edu.cn/chat/c/stream-test');
  await until(() => readyToShow, '窗口就绪', 10000);
  win.webContents.debugger.attach('1.3');
  await until(async () => await panelNode(win, 'taskState'), '面板就绪');
  await win.webContents.executeJavaScript("document.querySelector('textarea').value='查看测试目录'");
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled: true});
  const root = await win.webContents.debugger.sendCommand('DOM.getDocument');
  const input = await win.webContents.debugger.sendCommand('DOM.querySelector', {nodeId: root.root.nodeId, selector: 'textarea'});
  await win.webContents.debugger.sendCommand('DOM.focus', {nodeId: input.nodeId});
  assert.equal(await win.webContents.executeJavaScript("document.activeElement === document.querySelector('textarea') && document.hasFocus()"), true, '输入框未获得焦点');
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13});
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13});
  await until(() => win.webContents.executeJavaScript('window.sent.length === 1'), '发送测试消息');
  await win.webContents.executeJavaScript('window.beginStream()');
  await until(async () => JSON.stringify(await panelNode(win, 'status')).includes('模型正在生成'), '识别生成中');
  await delay(1600);
  assert.equal(calls.length, 0, '不完整分片及生成中不得执行');
  await win.webContents.executeJavaScript('window.finishText()');
  // 请求已完整但仍在生成中，超过稳定阈值也不能执行。
  await delay(2100);
  assert.equal(calls.length, 0, '生成指示存在时，完整请求也不能执行');
  await win.webContents.executeJavaScript('window.finishStream()');
  await until(() => calls.length === 1, '生成结束后执行请求');
  await until(() => deliveries.includes('submitted'), '回填结果交给网页');
  assert.equal(await win.webContents.executeJavaScript('window.sent.length'), 2);
  await win.webContents.executeJavaScript('window.rerender()');
  await delay(2200);
  assert.equal(calls.length, 1, '同一回复重渲染不得重复执行');
  assert.equal(await win.webContents.executeJavaScript('window.sent.length'), 2, '重渲染不得重复回填');
  assert.equal(deliveries.filter(value => value === 'submitted').length, 1);
  await verifyPanelDrag(win);
  win.webContents.debugger.detach();
  win.destroy();
  process.stdout.write('fixture passed\n');
  app.exit(0);
}).catch(error => { process.stderr.write(error.stack + '\n'); app.exit(1); });
