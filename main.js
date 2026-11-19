'use strict';

const {app, BrowserWindow, ipcMain, session, shell, dialog} = require('electron');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const tools = require('./tools');
const {validateRequest} = require('./protocol');
const {Ledger} = require('./ledger');
const {TaskStore} = require('./task-store');
const {scopeFor} = require('./access-policy');
const {resultText} = require('./result-format');
const {buildInjectSource} = require('./inject');

const BASE = __dirname;
const USER_DATA = path.join(BASE, 'user-data');
const LEDGER_DIR = path.join(BASE, 'state', 'ledger');
const TASK_DIR = path.join(BASE, 'state', 'tasks');
const CHAT_ORIGIN = 'https://ai.cuhk.edu.cn';
const CHAT_URL = `${CHAT_ORIGIN}/chat/`;
const PARTITION = 'persist:campus-web-agent';
const RUN_ID = crypto.randomUUID();
const MAX_KEY_LENGTH = 4096;

let workspace = null;
let extraRoots = [];
let scopeVersion = 0;
function currentScope(request) {
  return scopeFor(request, {workspace, extraRoots, defaultCwd: BASE});
}

// 独立且持久的浏览器数据目录：登录状态只存在这里，不读取系统浏览器资料。
app.setPath('userData', USER_DATA);
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();

const ledger = new Ledger({dir: LEDGER_DIR, runId: RUN_ID});
const taskStore = new TaskStore({dir: TASK_DIR, runId: RUN_ID});
let activeCancel = null;
const injectSource = buildInjectSource(process.platform);
let mainWindow = null;
let executionEpoch = 0;

function isChatUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === CHAT_ORIGIN && /^\/chat(\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

// 只有学校 AI 对话页面所在的渲染进程可以调用本地工具。
function senderIsChat(event) {
  const frame = event.senderFrame;
  return Boolean(frame) && isChatUrl(frame.url);
}

const webPreferences = {
  preload: path.join(BASE, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,
  webviewTag: false,
  spellcheck: false
};

function createWindow(url = CHAT_URL) {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: '校园 AI 本地 Agent 原型',
    backgroundColor: '#f8fafc',
    webPreferences: {...webPreferences, partition: PARTITION}
  });
  win.setMenuBarVisibility(false);
  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.webContents.on('did-start-navigation', (event, url, isInPlace, isMainFrame) => {
    if (isMainFrame) { extraRoots = []; scopeVersion++; executionEpoch++; }
  });
  win.webContents.on('destroyed', () => { executionEpoch++; });
  win.webContents.setWindowOpenHandler(({url: target}) => {
    // 登录流程可能需要弹窗；弹窗沿用同一套受限配置，桥接仍按页面地址判断。
    if (!/^https?:\/\//i.test(target)) return {action: 'deny'};
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {width: 1000, height: 800, webPreferences: {...webPreferences, partition: PARTITION}}
    };
  });
  // 页面主世界脚本：在每条消息正文前自动附加工具说明（需在 preload 之外的页面上下文执行）。
  win.webContents.on('dom-ready', () => {
    if (!isChatUrl(win.webContents.getURL())) return;
    win.webContents.executeJavaScript(injectSource, true).catch(error => {
      console.error('工具说明注入失败：', error && error.message);
    });
  });
  win.webContents.on('preload-error', (event, preloadPath, error) => {
    console.error('preload 加载失败：', preloadPath, error && error.message);
  });
  win.webContents.on('did-fail-load', (event, code, description) => {
    console.error('页面加载失败：', code, description);
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (/^https?:\/\//i.test(target)) return;
    event.preventDefault();
    shell.openExternal(target).catch(() => {});
  });
  win.loadURL(url);
  return win;
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

function readIdentity(event, payload) {
  if (!senderIsChat(event)) throw new Error('当前页面不允许调用本地工具。');
  const {key, conversationId, replyIndex} = payload || {};
  if (typeof key !== 'string' || key.length < 8 || key.length > MAX_KEY_LENGTH) throw new Error('请求标识无效。');
  if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 512) throw new Error('对话标识无效。');
  if (!Number.isInteger(replyIndex) || replyIndex < 0) throw new Error('回复序号无效。');
  return {key, conversationId, replyIndex};
}

function readPayload(event, payload) {
  const identity = readIdentity(event, payload);
  const {request} = payload;
  const check = validateRequest(request);
  if (!check.ok) throw new Error(check.error);
  return {...identity, request: check.request};
}

ipcMain.handle('agent:info', event => {
  if (!senderIsChat(event)) throw new Error('当前页面不允许访问本地工具。');
  return {workspace, extraRoots: [...extraRoots], scopeVersion, runId: RUN_ID, defaultCwd: BASE};
});

ipcMain.handle('agent:chooseDirectory', async (event, kind) => {
  if (!senderIsChat(event) || !['workspace', 'extra'].includes(kind)) throw new Error('目录选择无效。');
  const selection = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {properties: ['openDirectory']});
  if (selection.canceled || !selection.filePaths.length) return null;
  const selected = await fs.realpath(selection.filePaths[0]);
  if (kind === 'workspace') { workspace = selected; extraRoots = []; }
  else { if (!extraRoots.includes(selected)) extraRoots.push(selected); }
  scopeVersion++;
  return {workspace, extraRoots: [...extraRoots], scopeVersion};
});

ipcMain.handle('agent:clearExtra', event => {
  if (!senderIsChat(event)) throw new Error('当前页面不允许操作。');
  extraRoots = []; scopeVersion++;
  return {workspace, extraRoots: [], scopeVersion};
});

ipcMain.handle('agent:clearWorkspace', event => {
  if (!senderIsChat(event)) throw new Error('当前页面不允许操作。');
  workspace = null; extraRoots = []; scopeVersion++;
  return {workspace, extraRoots: [], scopeVersion};
});

ipcMain.handle('agent:previewWrite', async (event, request) => {
  if (!senderIsChat(event) || request?.tool !== 'write_file') throw new Error('请求无效。');
  const checked = validateRequest(request);
  if (!checked.ok) throw new Error(checked.error);
  const target = await tools.resolvePath(currentScope(request), request.path);
  try {
    const info = await fs.stat(target.path);
    if (!info.isFile() || info.size > tools.MAX_FILE_BYTES) return {exists: true, old: null, warning: '原文件不是普通文本或超过 200 KB，无法预览。'};
    return {exists: true, old: (await tools.readFile(currentScope(request), request.path)).content};
  } catch (error) {
    if (error.code === 'ENOENT') return {exists: false, old: ''};
    throw error;
  }
});

function taskPayload(event, payload) {
  if (!senderIsChat(event)) throw new Error('当前页面不允许访问任务。');
  if (!payload || typeof payload !== 'object') throw new Error('任务请求无效。');
  return payload;
}

ipcMain.on('agent:invalidate', event => {
  if (senderIsChat(event)) executionEpoch++;
});

ipcMain.handle('agent:taskCreate', (event, payload) => taskStore.create(taskPayload(event, payload)));
ipcMain.handle('agent:taskList', (event, payload) => taskStore.list(taskPayload(event, payload)));
ipcMain.handle('agent:taskRecover', async (event, payload) => {
  const {conversationId} = taskPayload(event, payload);
  const tasks = await taskStore.list({conversationId});
  for (const task of tasks) {
    if (task.status !== 'unknown' && (!['completed', 'failed'].includes(task.status) || task.steps.some(step => ['requested', 'waiting_approval', 'executing'].includes(step.state)))) {
      await taskStore.setStatus({taskId: task.taskId, conversationId, status: 'unknown'});
    }
  }
  return taskStore.list({conversationId});
});
ipcMain.handle('agent:taskStatus', (event, payload) => taskStore.setStatus(taskPayload(event, payload)));
ipcMain.handle('agent:taskStep', (event, payload) => taskStore.recordStep(taskPayload(event, payload)));
ipcMain.handle('agent:taskAdopt', (event, payload) => taskStore.adoptConversation(taskPayload(event, payload)));
ipcMain.handle('agent:taskRecords', async (event, payload) => {
  const task = await taskStore.get(taskPayload(event, payload));
  if (!task) return [];
  const entries = await Promise.all(task.steps.map(step => ledger.read(step.key)));
  return task.steps.map((step, index) => {
    const entry = entries[index];
    if (entry && entry.conversationId === task.conversationId) return entry;
    return {key: step.key, conversationId: task.conversationId, request: {tool: step.tool}, state: step.state,
      startedAt: step.startedAt, finishedAt: step.updatedAt, result: null};
  });
});

async function saveTaskStep(payload, state, tool) {
  return taskStore.recordStep({taskId: payload.taskId, conversationId: payload.conversationId, step: {key: payload.key, state, purpose: 'tool', tool}});
}

ipcMain.handle('agent:execute', async (event, payload) => {
  const {key, conversationId, replyIndex, request} = readPayload(event, payload);
  const scope = currentScope(request);
  const epoch = executionEpoch;
  class RequestCancelled extends Error {}
  const checkCurrent = () => {
    if (payload.scopeVersion !== scopeVersion || epoch !== executionEpoch) throw new RequestCancelled('任务或工作空间已变化，未执行请求。');
  };
  checkCurrent();
  await saveTaskStep(payload, 'requested', request.tool);
  try { checkCurrent(); }
  catch (error) { await saveTaskStep(payload, 'cancelled', request.tool); throw error; }
  const begun = await ledger.begin({key, conversationId, replyIndex, request});
  if (begun.status === 'exists') {
    await saveTaskStep(payload, begun.entry.state === 'executing' ? 'unknown' : begun.entry.state, request.tool);
    return {status: 'exists', entry: begun.entry};
  }

  const controls = {
    setCancel: handler => { activeCancel = handler; },
    clearCancel: () => { activeCancel = null; }
  };
  let result;
  let state;
  try {
    checkCurrent();
    await saveTaskStep(payload, 'executing', request.tool);
    const task = await taskStore.get({taskId: payload.taskId, conversationId});
    checkCurrent();
    if (!task || task.status !== 'active') throw new RequestCancelled('任务当前不可执行，未执行请求。');
    result = await tools.executeTool(scope, request, controls);
    state = result.ok ? 'completed' : 'failed';
  } catch (error) {
    const cancelled = error instanceof RequestCancelled;
    const message = cancelled || error instanceof tools.ToolError ? error.message : `工具执行失败：${error.message}`;
    result = {ok: false, cancelled, code: (error && error.code) || null, error: message};
    state = cancelled ? 'cancelled' : 'failed';
  } finally {
    activeCancel = null;
  }
  let entry;
  try { entry = await ledger.recordResult({key, state, result, resultText: state === 'cancelled' ? null : resultText(result)}); }
  catch (error) { return {status: 'task_record_unknown', error: error.message}; }
  try { await saveTaskStep(payload, entry.state, request.tool); }
  catch (error) { return {status: 'task_record_unknown', entry, error: error.message}; }
  return {status: 'created', entry};
});

// 用户拒绝时也落一条记录，并把“已拒绝”回传给模型，而不是假装执行过。
ipcMain.handle('agent:deny', async (event, payload) => {
  const {key, conversationId, replyIndex, request} = readPayload(event, payload);
  const begun = await ledger.begin({key, conversationId, replyIndex, request});
  if (begun.status === 'exists') {
    const state = begun.entry.state === 'executing' ? 'unknown' : begun.entry.state;
    await saveTaskStep(payload, state, request.tool);
    return {status: 'exists', entry: begun.entry};
  }
  const result = {ok: false, denied: true, error: '用户拒绝了这个操作，没有执行。'};
  const entry = await ledger.recordResult({key, state: 'denied', result, resultText: resultText(result)});
  await saveTaskStep(payload, 'denied', request.tool);
  return {status: 'created', entry};
});

ipcMain.handle('agent:formatError', async (event, payload) => {
  const identity = readIdentity(event, payload);
  if (typeof payload.error !== 'string' || !payload.error || payload.error.length > 1024 || typeof payload.stop !== 'boolean') throw new Error('格式错误记录无效。');
  const entry = await ledger.recordFormatError({...identity, error: payload.error, stop: payload.stop});
  await saveTaskStep(payload, 'format_error', 'format_error');
  return entry;
});

// 读页面主世界里的附加状态，供面板诊断用（不执行任何操作）。
ipcMain.handle('agent:injectStatus', async event => {
  if (!senderIsChat(event)) throw new Error('当前页面不允许访问。');
  return event.sender.executeJavaScript(
    '({installed: !!window.__campusAgentGuideInstalled, hits: window.__campusAgentGuideHits || 0, disabled: document.documentElement.dataset.campusAgentGuide === "off"})',
    true
  );
});

ipcMain.handle('agent:cancel', event => {
  if (!senderIsChat(event)) throw new Error('当前页面不允许停止命令。');
  if (!activeCancel) return {cancelled: false};
  activeCancel();
  return {cancelled: true};
});

ipcMain.handle('agent:markDelivery', async (event, payload) => {
  if (!senderIsChat(event)) throw new Error('当前页面不允许修改本地记录。');
  const {key, delivery} = payload || {};
  if (typeof key !== 'string' || !key) throw new Error('请求标识无效。');
  return ledger.markDelivery({key, delivery});
});

ipcMain.handle('agent:list', async (event, payload) => {
  if (!senderIsChat(event)) throw new Error('当前页面不允许读取本地记录。');
  const conversationId = payload && payload.conversationId;
  if (typeof conversationId !== 'string' || conversationId.length > 512) throw new Error('对话标识无效。');
  return ledger.list(conversationId);
});

if (hasInstanceLock) app.whenReady().then(async () => {
  await ledger.init();
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((webContents, permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(error => {
  console.error('原型启动失败：', error);
  app.quit();
});

app.on('web-contents-created', (event, contents) => {
  contents.on('will-attach-webview', webEvent => webEvent.preventDefault());
});

app.on('window-all-closed', () => app.quit());
