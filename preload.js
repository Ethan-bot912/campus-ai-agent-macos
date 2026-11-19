'use strict';

const {ipcRenderer} = require('electron');
const crypto = require('node:crypto');
const {parseToolRequest, MUTATING_TOOLS} = require('./protocol');
const {isCurrentTask} = require('./task-guard');
const {parseModelProgress, summarizeLocalEvidence, trackFailure} = require('./task-report');
const {buildToolGuide} = require('./inject');

const CHAT_ORIGIN = 'https://ai.cuhk.edu.cn';
const GUIDE_BEGIN = '[[CAMPUS_AGENT_GUIDE_BEGIN]]';
const GUIDE_END = '[[CAMPUS_AGENT_GUIDE_END]]';
const IS_MAC = process.platform === 'darwin';
const OS_NAME = IS_MAC ? 'macOS' : 'Windows';
const COMMAND_SHELL = IS_MAC ? 'zsh' : 'PowerShell';

// 页面元素的候选选择器。真实页面尚未登录核对，因此保留多种可能并可用“诊断页面元素”查看实际匹配。
const SELECTORS = {
  replies: ['.prose-code-custom'],
  input: [
    'textarea[data-testid="chat-input"]',
    '[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea'
  ],
  send: [
    'button[data-testid="chat-send-button"]',
    'button[aria-label="发送消息"]',
    'button[aria-label="Send message"]'
  ],
  busy: [
    'button[aria-label="停止生成"]',
    'button[aria-label="Stop generating"]',
    '[data-testid="stop-button"]'
  ]
};

const ARM_LABEL = '开启本次工具执行';
const PAUSE_LABEL = '暂停后续执行';
const RESUME_LABEL = '继续后续执行';
const TOOL_LABEL = {
  list_dir: '查看目录',
  read_file: '读取文件',
  write_file: '写入文件',
  delete: '删除',
  move: '移动/重命名',
  run_command: '运行命令',
  open_terminal: '打开终端'
};
const STATE_LABEL = {executing: '执行中', completed: '已完成', failed: '失败', denied: '已拒绝', cancelled: '已取消，未执行', unknown: '状态未知', not_started: '未执行', format_error: '格式错误，未执行'};
const DELIVERY_LABEL = {not_sent: '结果待发送', sending: '发送状态未知', submitted: '已交给网页', unknown: '发送状态未知'};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const visible = element => Boolean(element) && element.getClientRects().length > 0;
const normalizeText = value => String(value || '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();

(function boot() {
  // 仅在学校 AI 对话页面启用桥接；其他来源的页面得不到本地工具能力。
  if (location.origin !== CHAT_ORIGIN || !/^\/chat(\/|$)/.test(location.pathname)) return;
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', () => document.documentElement && start());
})();

function start() {
  if (document.getElementById('campus-web-agent-panel')) return;

  const host = document.createElement('div');
  host.id = 'campus-web-agent-panel';
  const shadow = host.attachShadow({mode: 'closed'});
  shadow.innerHTML = `
    <style>
      :host{all:initial;--bg-canvas:#0c0c0e;--bg-panel:#141417;--bg-surface:#1b1b1f;--bg-surface-elevated:#232329;--bg-code:#0f0f12;--border-subtle:rgba(255,255,255,.07);--border-default:rgba(255,255,255,.13);--border-strong:rgba(255,255,255,.24);--text-primary:#f4f4f6;--text-secondary:#9a9aa2;--text-muted:#63636b;--status-success:#34d399;--status-warning:#f59e0b;--status-danger:#f87171;--font-sans:Inter,-apple-system,BlinkMacSystemFont,'Microsoft YaHei',sans-serif;--font-mono:'JetBrains Mono','Cascadia Code',Consolas,monospace}
      *,*::before,*::after{box-sizing:border-box}
      .panel{position:fixed;z-index:2147483646;right:0;top:0;bottom:0;width:min(420px,calc(100vw - 16px));display:flex;flex-direction:column;overflow:hidden;border-left:1px solid var(--border-default);background:var(--bg-panel);color:var(--text-primary);box-shadow:-8px 0 32px #0005;font:13px/1.5 var(--font-sans);color-scheme:dark}
      .panel.minimized{top:auto;bottom:16px;right:16px;width:min(320px,calc(100vw - 32px));max-height:calc(100vh - 32px);border:1px solid var(--border-default);border-radius:10px}
      .panel.floating{right:auto;bottom:auto;border:1px solid var(--border-default);border-radius:10px}
      .panel.floating:not(.minimized){height:min(680px,80vh)}
      button.panel-grip{flex:none;width:20px;height:28px;padding:0;border-color:transparent;background:transparent;color:var(--text-secondary);font-size:17px;cursor:grab;touch-action:none;user-select:none}
      button.panel-grip:hover{background:var(--bg-surface-elevated)}
      button.panel-grip:active{cursor:grabbing}
      .head{height:46px;min-height:46px;display:flex;align-items:center;gap:8px;padding:0 14px;border-bottom:1px solid var(--border-subtle);background:var(--bg-panel)}
      .status-pill{display:flex;align-items:center;gap:7px;white-space:nowrap;border:1px solid var(--border-default);border-radius:999px;padding:4px 10px;background:#ffffff0a;font-size:11.5px}
      .status-dot{width:6px;height:6px;border-radius:50%;background:var(--status-success);box-shadow:0 0 6px #34d39999;animation:breathe 2.2s infinite ease-in-out}
      @keyframes breathe{50%{opacity:.4;transform:scale(.85)}}@media(prefers-reduced-motion:reduce){.status-dot{animation:none}}
      .status-pill[data-tone="attention"] .status-dot{background:var(--status-warning);box-shadow:0 0 6px #f59e0b99}.status-pill[data-paused="true"] .status-dot{background:var(--text-muted);box-shadow:none;animation:none}
      .scope-trigger{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;border-color:transparent;background:transparent;color:var(--text-secondary);padding:5px 7px}
      .icon-btn{flex:none;width:28px;height:28px;display:grid;place-items:center;padding:0;border-color:transparent;background:transparent;color:var(--text-secondary);font-size:16px}
      .timeline{flex:1;min-height:0;overflow-y:auto;padding:14px 16px;scrollbar-width:thin;scrollbar-color:#ffffff33 transparent}
      .panel.minimized .timeline{display:none}.minimized [data-expanded]{display:none}
      [hidden]{display:none!important}p{margin:0}.eyebrow{font-size:11px;font-weight:500;color:var(--text-muted);letter-spacing:.04em}
      .status-card{margin:0 0 10px;color:var(--text-secondary)}#status{font-size:11.5px;overflow-wrap:anywhere}.status-card[data-tone="attention"] #status{color:#fcd09a}
      .task-card{margin:0 0 12px;padding:10px 12px;border:1px solid var(--border-subtle);border-radius:10px;background:var(--bg-surface)}
      #task{margin-top:4px;font-size:12.5px;color:var(--text-primary);overflow-wrap:anywhere;max-height:68px;overflow:auto}
      .row{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
      button{padding:6px 9px;border:1px solid var(--border-default);border-radius:6px;background:var(--bg-surface);color:var(--text-primary);cursor:pointer;font:500 11.5px/1.4 var(--font-sans)}
      button:hover{background:var(--bg-surface-elevated);border-color:var(--border-strong)}button:focus-visible,summary:focus-visible{outline:2px solid #f4f4f6;outline-offset:2px}button:disabled{opacity:.5;cursor:default}
      button.primary{background:#f4f4f6;border-color:#f4f4f6;color:#0c0c0e}button.primary:hover{background:#fff}button.danger{background:#261c1c;border-color:#f8717142;color:#fca5a5}
      details{border-top:1px solid var(--border-subtle)}details details{border:0}summary{cursor:pointer;font-size:12px;font-weight:500;color:var(--text-secondary);padding:11px 2px;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:8px}
      summary::-webkit-details-marker{display:none}summary::after{content:'›';font-size:17px;color:var(--text-muted);transition:transform .14s}details[open]>summary::after{transform:rotate(90deg)}
      pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;background:var(--bg-code);color:#d4d4d8;padding:10px;border:1px solid var(--border-subtle);border-radius:6px;font:11px/1.6 var(--font-mono);margin:6px 0 10px}
      .record-list{display:flex;flex-direction:column;gap:8px;padding-bottom:10px}.record{display:flex;gap:9px;padding:10px 12px;border:1px solid var(--border-subtle);border-radius:10px;background:var(--bg-surface)}
      .record-dot{width:24px;height:24px;border-radius:6px;display:grid;place-items:center;flex:none;background:#ffffff0a;border:1px solid var(--border-subtle);color:#d4d4d8;font:12px/1 var(--font-mono)}.record-content{min-width:0;flex:1}.record-title{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:500;color:var(--text-primary);overflow-wrap:anywhere}.record-meta{font:11px/1.5 var(--font-mono);color:var(--text-secondary);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .badge{display:inline-flex;align-items:center;margin-left:auto;flex:none;padding:1px 7px;border:1px solid var(--border-default);border-radius:999px;color:var(--text-secondary);font:500 10.5px/1.6 var(--font-sans);vertical-align:middle}.badge[data-state="success"]{color:var(--status-success);background:#34d3991a;border-color:#34d3993d}.badge[data-state="failure"]{color:var(--status-danger);background:#f871711a;border-color:#f8717142}.badge[data-state="pending"]{color:#fbbf24;background:#f59e0b14;border-color:#f59e0b52}
      .file-tree{margin:9px 0;padding:6px;background:var(--bg-code);border:1px solid var(--border-subtle);border-radius:6px;max-height:180px;overflow:auto}.tree-row{display:flex;justify-content:space-between;gap:10px;padding:4px 6px;color:var(--text-secondary);font:11px/1.4 var(--font-mono);overflow-wrap:anywhere}.tree-row span:first-child{min-width:0}.tree-kind{color:var(--text-muted);flex:none}
      .record-content details>summary{padding:8px 0 0;color:var(--text-secondary);font-size:11px;font-weight:500}.empty{color:var(--text-muted);font-size:12px;padding:4px 2px 10px;line-height:1.6}.scope{font-size:11px;color:var(--text-secondary);overflow-wrap:anywhere;padding:2px 0}
      .hint{font-size:11px;color:var(--text-secondary);margin:10px 0 12px;line-height:1.6}.drawer{padding:0 2px}.drawer>details{border-top:1px solid var(--border-subtle)}
      #approval{flex:none;padding:12px 14px;border-top:1px solid var(--border-subtle);background:var(--bg-panel)}.approval-card{border:1px solid #f59e0b52;border-radius:10px;padding:12px;background:#1a1917}
      #approvalTitle{font-weight:600;color:#fbbf24;margin:0 0 8px;overflow-wrap:anywhere;font-size:11.5px}#approvalBody{max-height:min(160px,24vh);background:var(--bg-code);margin:0;color:#e4e4e7;border-color:var(--border-subtle);white-space:pre-wrap}
      .diff-add{color:#86efac;background:#4ade801f}.diff-del{color:#fca5a5;background:#f871711f}.approval-actions{display:grid;grid-template-columns:1.05fr 1.25fr .75fr;gap:7px;margin-top:10px}.approval-actions button{min-width:0;padding:7px 4px}
      .footer{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 14px;border-top:1px solid var(--border-subtle);background:var(--bg-panel)}.footer-note{font-size:10.5px;color:var(--text-muted)}.footer-controls{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
      @media(max-height:460px){#approvalBody{max-height:70px}.approval-actions button{font-size:10px}.timeline{padding:8px 12px}}
    </style>
    <div class="panel" role="region" aria-label="校园 AI 本地 Agent 原型">
      <header class="head">
        <button id="panelGrip" class="panel-grip" type="button" aria-label="移动面板" title="拖动面板，也可用方向键移动">⠿</button>
        <div class="status-pill" id="statusPill"><span class="status-dot" aria-hidden="true"></span><span id="listenLabel">等待消息</span></div>
        <button id="scopeTrigger" class="scope-trigger" title="查看目录访问范围">▱ <span id="scopeLabel">无工作区限制</span> ▾</button>
        <button id="settingsToggle" class="icon-btn" aria-label="设置、目录范围与诊断" title="设置、目录范围与诊断">⚙</button>
        <button id="minimize" class="icon-btn" aria-label="最小化面板" title="最小化面板">−</button>
      </header>
      <main class="timeline" data-expanded>
        <div class="status-card"><p id="status" role="status">直接在网页发送问题即可；本地读取结果会发送给学校 AI。</p></div>
        <div class="task-card"><div class="eyebrow">当前任务 · <span id="taskState">等待消息</span></div><p id="task">等待你发送问题</p><p class="hint" id="taskEvidence">模型报告与本机验证分别显示。</p><div class="row"><button id="newTask">结束并开始新任务</button></div></div>
        <details id="modelReportGroup"><summary>模型计划与报告</summary><div id="modelProgress" class="empty">暂无模型计划。</div><details><summary>模型报告原文</summary><pre id="modelReport">暂无模型报告。</pre></details></details>
        <details id="evidenceGroup" open><summary>本机成果与验证</summary><p class="hint" id="verificationSummary">未验证：模型结论尚无独立的本机验证。</p><div id="evidenceList" class="record-list"><div class="empty">当前任务暂无本机成果。</div></div></details>
        <details id="toolGroup" open><summary>工具调用记录</summary><div id="liveActivity" class="record-list" hidden></div><div id="activity" class="record-list"><div class="empty">暂无操作，在网页中发送问题即可开始。</div></div></details>
        <details><summary>本对话任务历史</summary><div id="taskHistory" class="empty">暂无任务记录。</div></details>
        <div class="drawer" id="settingsDrawer" hidden>
          <details id="scopeSettings" open><summary>目录访问范围</summary>
            <p class="scope" id="workspace">工作空间：未选择</p><p class="scope" id="extraRoots">额外目录：无</p>
            <div class="row"><button id="chooseWorkspace">选择工作空间</button><button id="chooseExtra">授权额外目录</button><button id="clearExtra">撤销额外目录</button><button id="clearWorkspace">不使用工作空间</button></div>
            <div class="row"><button id="arm">${ARM_LABEL}</button><button id="endTask">结束任务</button></div>
            <p class="hint">可直接读取本机文件，读取结果会发送给学校 AI。未选目录时，写入等操作可访问当前账户有权限的位置，仍需授权；${COMMAND_SHELL} 不受目录沙箱限制。</p>
          </details>
          <details><summary>文件记录</summary><pre id="artifacts">（无）</pre></details>
          <details><summary>原始记录与诊断</summary>
            <details><summary>本次请求与结果</summary><pre id="detail">（无）</pre></details>
            <details><summary>本次对话的本地记录</summary><pre id="recordList">（无）</pre></details>
            <details><summary>页面元素诊断</summary><pre id="diagOut">点“诊断页面元素”查看。</pre></details>
            <div class="row"><button id="diag">诊断页面元素</button><button id="guide">填入工具请求说明</button><button id="guideToggle">自动附加说明：开</button></div><p class="hint">工具说明和诊断仅在遇到页面兼容问题时使用。</p>
          </details>
        </div>
      </main>
      <section id="approval" hidden aria-label="操作授权"><div class="approval-card">
        <p id="approvalTitle"></p><pre id="approvalBody"></pre>
        <div class="approval-actions"><button id="allowOnce" class="primary">允许一次</button><button id="allowTool">本对话允许同类</button><button id="deny" class="danger">拒绝</button></div>
      </div></section>
      <footer class="footer"><span class="footer-note" data-expanded>校园 AI · 本地工具</span><div class="footer-controls"><button id="send" hidden>发送待处理结果</button><button id="stop" hidden class="danger">停止当前命令</button><button id="pause">${PAUSE_LABEL}</button></div></footer>
    </div>`;
  document.documentElement.append(host);

  const statusEl = shadow.getElementById('status');
  const detailEl = shadow.getElementById('detail');
  const recordListEl = shadow.getElementById('recordList');
  const diagOutEl = shadow.getElementById('diagOut');
  const armBtn = shadow.getElementById('arm');
  const pauseBtn = shadow.getElementById('pause');
  const sendBtn = shadow.getElementById('send');
  const guideBtn = shadow.getElementById('guide');
  const guideToggleBtn = shadow.getElementById('guideToggle');
  const stopBtn = shadow.getElementById('stop');
  const diagBtn = shadow.getElementById('diag');
  const minimizeBtn = shadow.getElementById('minimize');
  const approvalBox = shadow.getElementById('approval');
  const approvalTitle = shadow.getElementById('approvalTitle');
  const approvalBody = shadow.getElementById('approvalBody');
  const allowOnceBtn = shadow.getElementById('allowOnce');
  const allowToolBtn = shadow.getElementById('allowTool');
  const denyBtn = shadow.getElementById('deny');
  const panel = shadow.querySelector('.panel');
  const panelGrip = shadow.getElementById('panelGrip');
  let panelPosition = null;
  let drag = null;

  function placePanel() {
    if (!panelPosition) return;
    const {width, height} = panel.getBoundingClientRect();
    const left = Math.max(0, Math.min(panelPosition.left, window.innerWidth - width));
    const top = Math.max(0, Math.min(panelPosition.top, window.innerHeight - height));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function movePanel(left, top) {
    panelPosition = {left, top};
    panel.classList.add('floating');
    placePanel();
  }

  panelGrip.addEventListener('pointerdown', event => {
    if (!event.isTrusted || !event.isPrimary || event.button !== 0) return;
    const {left, top} = panel.getBoundingClientRect();
    drag = {id: event.pointerId, x: event.clientX, y: event.clientY, left, top, moved: false};
    panelGrip.setPointerCapture(event.pointerId);
  });
  window.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    movePanel(drag.left + dx, drag.top + dy);
  });
  panelGrip.addEventListener('lostpointercapture', event => {
    if (event.pointerId === drag?.id) drag = null;
  });
  panelGrip.addEventListener('keydown', event => {
    if (!event.isTrusted) return;
    const offset = {ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16]}[event.key];
    if (!offset) return;
    event.preventDefault();
    const {left, top} = panel.getBoundingClientRect();
    movePanel(left + offset[0], top + offset[1]);
  });
  window.addEventListener('resize', placePanel);
  new ResizeObserver(placePanel).observe(panel);

  let armed = false;
  let paused = false;
  let pauseCount = 0;
  let busy = false;
  let delivering = false;
  let baseline = 0;
  let candidate = null;
  let pending = null;
  let lastStatus = null;
  let liveKey = null;
  let scopeInfo = {workspace: null, extraRoots: [], scopeVersion: 0};
  let generation = 0;
  let cancelApproval = null;
  let awaitingNewConversation = false;
  let changingConversation = false;
  let liveStartedAt = null;
  let deliveryErrorWatch = null;
  let deliveryErrorMessage = null;
  let formatStopMessage = null;
  let consecutiveFormatErrors = 0;
  let taskSlot = null;
  let endingTask = Promise.resolve();
  let activeOperation = null;
  let waitingApproval = null;
  let reportedReply = null;
  const toolGrants = new Set();
  const handled = new Set();

  const conversationAt = () => `${location.pathname}${location.search}`;
  let conversationId = conversationAt();
  const recoveries = new Map();
  function recoverTasksFor(id) {
    if (!recoveries.has(id)) recoveries.set(id, ipcRenderer.invoke('agent:taskRecover', {conversationId: id}));
    return recoveries.get(id);
  }
  recoverTasksFor(conversationId).catch(error => setStatus(`恢复任务失败：${error.message}`));
  const TASK_LABEL = {active: '执行中', waiting_model: '等待模型', waiting_approval: '等待授权', waiting_verification: '等待验证', paused: '已暂停', completed: '已结束', failed: '已失败', unknown: '状态未知'};
  function clearModelReport() {
    shadow.getElementById('modelProgress').textContent = '暂无模型计划。';
    shadow.getElementById('modelReport').textContent = '暂无模型报告。';
  }
  function showModelReport(text) {
    const parsed = parseModelProgress(text);
    const progress = shadow.getElementById('modelProgress');
    if (parsed.status === 'ok') {
      const labels = {goal: '目标', next: '下一步', blockers: '待解决'};
      progress.textContent = Object.entries(parsed.report).map(([key, value]) => `${labels[key]}：${Array.isArray(value) ? value.join('；') : value}`).join('\n');
      progress.style.whiteSpace = 'pre-wrap';
    } else {
      progress.textContent = parsed.status === 'invalid' ? `模型计划格式错误：${parsed.error} 原文保留在网页和下方。` : '模型未提供结构化计划。';
    }
    shadow.getElementById('modelReport').textContent = text;
  }
  function drawTask(task) {
    if (!task) return;
    shadow.getElementById('task').textContent = task.goal;
    shadow.getElementById('taskState').textContent = TASK_LABEL[task.status] || task.status;
    shadow.getElementById('taskEvidence').textContent = task.status === 'unknown' ? '上次状态不明，请检查记录；开始新任务后继续。' : task.status === 'completed' ? '用户已结束；未验证的内容不能视为已验证。' : '模型报告与本机验证分别显示；尚无验证时为未验证。';
  }
  async function refreshTaskHistory(id = conversationId) {
    const tasks = await ipcRenderer.invoke('agent:taskList', {conversationId: id});
    if (conversationAt() !== id || conversationId !== id) return;
    const out = shadow.getElementById('taskHistory');
    out.replaceChildren();
    if (!tasks.length) { out.textContent = '暂无任务记录。'; return; }
    for (const task of tasks) {
      const row = document.createElement('details');
      const heading = document.createElement('summary');
      heading.textContent = `${TASK_LABEL[task.status] || task.status} · ${task.goal}`;
      const evidence = document.createElement('pre'); evidence.textContent = '展开查看本机步骤；模型结论未自动验证。';
      row.append(heading, evidence);
      row.addEventListener('toggle', async () => {
        if (!row.open) return;
        try {
          const records = await ipcRenderer.invoke('agent:taskRecords', {taskId: task.taskId, conversationId: id});
          evidence.textContent = records.length ? records.map(entry => `${describe(entry)}\n${JSON.stringify(entry.result, null, 2)}`).join('\n\n') : '暂无已记录的本机工具结果。';
        } catch (error) { evidence.textContent = `读取任务步骤失败：${error.message}`; }
      });
      out.append(row);
    }
  }
  function beginTask(goal) {
    clearModelReport();
    clearCurrentResults();
    const slot = {conversationId, task: null, promise: null, ready: null, failureRun: null};
    slot.promise = Promise.all([recoverTasksFor(slot.conversationId), endingTask]).then(() => ipcRenderer.invoke('agent:taskCreate', {conversationId: slot.conversationId, goal})).then(task => {
      slot.task = task;
      if (taskSlot === slot) { drawTask(task); refreshTaskHistory().catch(error => setStatus(`读取任务失败：${error.message}`)); }
      return task;
    });
    taskSlot = slot;
    return slot;
  }
  async function setTaskStatus(slot, status, expectedGeneration = generation) {
    if (!slot) return;
    await slot.promise;
    if (taskSlot !== slot || generation !== expectedGeneration || conversationAt() !== slot.conversationId) return;
    const task = await ipcRenderer.invoke('agent:taskStatus', {taskId: slot.task.taskId, conversationId: slot.conversationId, status});
    slot.task = task;
    if (taskSlot === slot && generation === expectedGeneration && conversationAt() === slot.conversationId) drawTask(task);
  }
  async function finishTask(slot, wasExecuting, approval) {
    if (!slot) return;
    const task = await slot.promise;
    const status = wasExecuting ? 'unknown' : 'completed';
    if (approval && approval.slot === slot) {
      const step = approval;
      await ipcRenderer.invoke('agent:taskStep', {taskId: task.taskId, conversationId: slot.conversationId, step: {key: step.key, state: 'cancelled', purpose: 'tool', tool: step.tool}});
    }
    const finished = await ipcRenderer.invoke('agent:taskStatus', {taskId: task.taskId, conversationId: slot.conversationId, status});
    if (!taskSlot && conversationAt() === slot.conversationId) drawTask(finished);
    await refreshTaskHistory(slot.conversationId);
  }
  function detachTask(slot) {
    if (!slot) return;
    slot.promise.then(task => ipcRenderer.invoke('agent:taskStatus', {taskId: task.taskId, conversationId: slot.conversationId, status: 'unknown'}))
      .catch(error => { if (taskSlot === slot) setStatus(`保存中断状态失败：${error.message}`); });
  }
  async function stopUnknownTask(slot, message) {
    if (!slot || taskSlot !== slot || conversationAt() !== slot.conversationId) return;
    paused = true;
    armed = false;
    pauseBtn.textContent = RESUME_LABEL;
    invalidate();
    deliveryErrorMessage = message;
    setStatus(message);
    try { await setTaskStatus(slot, 'unknown'); }
    catch (error) { if (taskSlot === slot) setStatus(`${message} 本地任务记录失败：${error.message}`); }
  }
  function noteUserSend() {
    const text = inputText().trim();
    if (!text) return;
    stopDeliveryErrorWatch();
    const current = conversationAt();
    const changedConversation = conversationId !== current;
    if (changedConversation) {
      detachTask(taskSlot);
      taskSlot = null;
      clearModelReport();
      clearCurrentResults();
      invalidate();
    }
    if (taskSlot?.task?.status === 'unknown') {
      armed = false;
      setStatus('当前任务状态未知，请先结束并开始新任务；不会自动执行。');
      return;
    }
    conversationId = current;
    if (!taskSlot) beginTask(text);
    shadow.getElementById('liveActivity').hidden = true;
    liveKey = null;
    pending = null;
    sendBtn.hidden = true;
    consecutiveFormatErrors = 0;
    formatStopMessage = null;
    invalidate(false);
    conversationId = conversationAt();
    const slot = taskSlot;
    const scopeReady = changedConversation ? ipcRenderer.invoke('agent:clearExtra').then(showScope) : Promise.resolve();
    slot.ready = Promise.all([scopeReady, setTaskStatus(slot, 'waiting_model')]).catch(error => { armed = false; setStatus(`任务状态保存失败，已停止：${error.message}`); throw error; });
    reportedReply = null;
    renderRecords().catch(error => setStatus(`读取本地记录失败：${error.message}`));
    awaitingNewConversation = /^\/chat\/?$/.test(location.pathname);
    baseline = replyNodes().length;
    candidate = null;
    handled.clear();
    armed = true;
    armBtn.textContent = '已开启（本次执行）';
    setStatus(paused ? '已暂停；新消息不会自动解除暂停。' : '已收到你的消息，等待模型回复。');
  }
  document.addEventListener('click', event => {
    if (event.isTrusted && event.target instanceof Element && event.target.closest(SELECTORS.send.join(',')) && !event.target.closest(SELECTORS.send.join(',')).disabled) {
      noteUserSend();
    }
  }, true);
  document.addEventListener('keydown', event => {
    if (event.isTrusted && event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.target === inputNode() && inputText().trim()) {
      noteUserSend();
    }
  }, true);

  function invalidate(clearGrants = true) {
    generation++;
    ipcRenderer.send('agent:invalidate');
    if (clearGrants) toolGrants.clear();
    if (cancelApproval) cancelApproval();
  }

  // 只观察工具结果发送之后新出现的网页错误；历史错误与聊天正文不作为本次拒绝。
  function visibleRequestErrors() {
    const result = [];
    if (!document.body) return result;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!/\brequest\.invalid\b/i.test(node.nodeValue || '')) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest('pre,code,textarea,script,style,.prose-code-custom,.justify-end,[contenteditable]') || !visible(parent)) continue;
      result.push(node);
    }
    return result;
  }

  function stopDeliveryErrorWatch() {
    if (!deliveryErrorWatch) return;
    deliveryErrorWatch.observer.disconnect();
    if (deliveryErrorWatch.timer) clearTimeout(deliveryErrorWatch.timer);
    deliveryErrorWatch = null;
  }

  function checkDeliveryError(watch) {
    if (deliveryErrorWatch !== watch || watch.rejected || conversationAt() !== watch.conversationId) return;
    const errors = visibleRequestErrors();
    // 节点重渲染时，已有错误数未增加不能证明是本次请求被拒绝。
    if (errors.length <= watch.baselineCount || !errors.some(node => !watch.baselineNodes.has(node))) return;
    watch.rejected = true;
    watch.observer.disconnect();
    paused = true;
    pauseBtn.textContent = RESUME_LABEL;
    invalidate();
    pending = null;
    sendBtn.hidden = true;
    deliveryErrorMessage = '学校服务拒绝了工具结果消息（request.invalid）；工具请求已处理，不会自动重跑或重发。请检查网页对话和本地记录。';
    setStatus(deliveryErrorMessage);
    stopUnknownTask(watch.slot, deliveryErrorMessage);
    ipcRenderer.invoke('agent:markDelivery', {key: watch.key, delivery: 'unknown'})
      .then(() => renderRecords())
      .catch(error => setStatus(`${deliveryErrorMessage} 本地发送状态记录失败：${error.message}`));
  }

  function startDeliveryErrorWatch(key, currentConversation) {
    stopDeliveryErrorWatch();
    const baseline = visibleRequestErrors();
    const watch = {key, slot: taskSlot, conversationId: currentConversation, baselineNodes: new Set(baseline), baselineCount: baseline.length, replyCount: replyNodes().length, rejected: false, timer: null, observer: null};
    watch.observer = new MutationObserver(() => {
      if (watch.timer || watch.rejected) return;
      watch.timer = setTimeout(() => { watch.timer = null; checkDeliveryError(watch); }, 100);
    });
    deliveryErrorWatch = watch;
    watch.observer.observe(document.body, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden']});
    return watch;
  }

  function showScope(info) {
    scopeInfo = info;
    shadow.getElementById('workspace').textContent = `工作空间：${info.workspace || '未选择'}`;
    shadow.getElementById('extraRoots').textContent = `额外目录：${info.extraRoots.join('、') || '无'}`;
    const scopeLabel = shadow.getElementById('scopeLabel');
    const selected = [info.workspace, ...info.extraRoots].filter(Boolean);
    scopeLabel.textContent = selected.length ? `修改范围：${selected.join('、')}` : '无工作区限制';
    scopeLabel.title = selected.length ? `文件修改范围：${selected.join('、')}；读取不受目录限制` : '文件操作按当前账户权限，修改操作需要确认';
  }

  function toggleSettings() {
    if (panel.classList.contains('minimized')) {
      panel.classList.remove('minimized');
      minimizeBtn.textContent = '−';
      minimizeBtn.setAttribute('aria-label', '最小化面板');
    }
    const drawer = shadow.getElementById('settingsDrawer');
    drawer.hidden = !drawer.hidden;
    if (!drawer.hidden) drawer.scrollIntoView({block: 'nearest'});
  }
  for (const id of ['settingsToggle', 'scopeTrigger']) shadow.getElementById(id).addEventListener('click', event => { if (event.isTrusted) toggleSettings(); });

  async function changeScope(kind) {
    invalidate();
    const info = kind === 'clear' ? await ipcRenderer.invoke('agent:clearExtra') : kind === 'clearWorkspace' ? await ipcRenderer.invoke('agent:clearWorkspace') : await ipcRenderer.invoke('agent:chooseDirectory', kind);
    if (info) showScope(info);
  }
  for (const [id, kind] of [['chooseWorkspace', 'workspace'], ['chooseExtra', 'extra'], ['clearExtra', 'clear'], ['clearWorkspace', 'clearWorkspace']]) {
    shadow.getElementById(id).addEventListener('click', event => {
      if (!event.isTrusted) return;
      changeScope(kind).catch(error => setStatus(error.message));
    });
  }

  function setStatus(text) {
    if (text === lastStatus) return;
    lastStatus = text;
    statusEl.textContent = text;
    statusEl.parentElement.dataset.tone = /错误|失败|未知|未执行|待发送|等待你确认|请先|已暂停/.test(text) ? 'attention' : 'normal';
    const pill = shadow.getElementById('statusPill');
    const waitingApproval = !approvalBox.hidden;
    pill.dataset.tone = waitingApproval ? 'attention' : 'normal';
    pill.dataset.paused = String(paused);
    shadow.getElementById('listenLabel').textContent = paused ? '已暂停' : waitingApproval ? '等待确认' : armed ? '监听中' : '等待消息';
  }

  function replyNodes() {
    return Array.from(document.querySelectorAll(SELECTORS.replies.join(',')));
  }

  function replyCodeBlocks(node) {
    return Array.from(node.querySelectorAll('pre')).map(pre => (pre.querySelector('code') || pre).textContent || '');
  }

  function appendResult(content, result) {
    if (!result) return;
    const more = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = '查看工具结果';
    const pre = document.createElement('pre');
    if (Array.isArray(result.entries)) {
      const tree = document.createElement('div'); tree.className = 'file-tree';
      for (const item of result.entries) {
        const row = document.createElement('div'); row.className = 'tree-row';
        const name = document.createElement('span'); name.textContent = `${item.type === 'directory' ? '▱' : '▤'}  ${item.name}`;
        const kind = document.createElement('span'); kind.className = 'tree-kind'; kind.textContent = item.type === 'directory' ? '目录' : item.type === 'file' ? '文件' : item.type === 'symlink' ? '链接' : '其他';
        row.append(name, kind); tree.append(row);
      }
      if (!result.entries.length) tree.textContent = '目录为空';
      more.append(summary, tree); content.append(more); return;
    } else if (typeof result.content === 'string') {
      pre.textContent = result.content;
    } else if (typeof result.stdout === 'string' || typeof result.stderr === 'string') {
      pre.textContent = [result.stdout, result.stderr].filter(Boolean).join('\n') || '命令没有输出';
    } else {
      pre.textContent = result.error || result.message || (result.ok ? '操作已完成。' : '操作未成功。');
    }
    more.append(summary, pre); content.append(more);
  }

  function toolIcon(tool) {
    return ({list_dir: '▱', read_file: '▤', write_file: '✎', delete: '×', move: '↗', run_command: '>_', open_terminal: '>_'})[tool] || '·';
  }

  function showLiveActivity(request, stage, detail = '', result = null) {
    const container = shadow.getElementById('liveActivity');
    container.hidden = false;
    container.replaceChildren();
    const row = document.createElement('div'); row.className = 'record';
    const dot = document.createElement('span'); dot.className = 'record-dot';
    dot.textContent = toolIcon(request?.tool); dot.setAttribute('aria-hidden', 'true');
    const content = document.createElement('div'); content.className = 'record-content';
    const title = document.createElement('div'); title.className = 'record-title';
    title.textContent = request ? (TOOL_LABEL[request.tool] || request.tool) : '工具请求';
    const badge = document.createElement('span'); badge.className = 'badge'; badge.dataset.state = /失败|错误|拒绝|未执行|未知/.test(stage) ? 'failure' : stage === '已完成' ? 'success' : 'pending'; badge.textContent = stage;
    title.append(' ', badge);
    const meta = document.createElement('div'); meta.className = 'record-meta';
    const target = request && (request.path || (request.from ? `${request.from} → ${request.to}` : request.cwd || ''));
    const duration = result && liveStartedAt ? `${Date.now() - liveStartedAt}ms` : '';
    meta.textContent = [target, duration, detail].filter(Boolean).join(' · ');
    meta.title = meta.textContent;
    content.append(title, meta);
    appendResult(content, result);
    row.append(dot, content); container.append(row);
    const group = container.closest('details');
    if (group) group.open = true;
  }

  function firstVisible(selectors) {
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (visible(element)) return element;
      }
    }
    return null;
  }

  const inputNode = () => firstVisible(SELECTORS.input);
  const sendNode = () => firstVisible(SELECTORS.send);
  const generating = () => Boolean(firstVisible(SELECTORS.busy));

  function inputText() {
    const element = inputNode();
    if (!element) return '';
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') return element.value;
    return element.innerText || '';
  }

  function setInputText(element, text) {
    if (!element) throw new Error('找不到聊天输入框。');
    element.focus();
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
      const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
      setter.call(element, text);
      element.dispatchEvent(new Event('input', {bubbles: true}));
      return;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, text);
  }

  const keyFor = (index, text) =>
    crypto.createHash('sha256').update(`${conversationId}\n${index}\n${text}`, 'utf8').digest('hex');

  function describe(entry) {
    const state = STATE_LABEL[entry.state] || entry.state || '状态未知';
    const delivery = entry.delivery ? ` · ${DELIVERY_LABEL[entry.delivery] || entry.delivery}` : '';
    const where = entry.request ? ` · ${TOOL_LABEL[entry.request.tool] || entry.request.tool}` : '';
    return `${state}${delivery}${where}`;
  }

  function renderEvidence(entries) {
    const report = summarizeLocalEvidence(entries);
    const container = shadow.getElementById('evidenceList');
    container.replaceChildren();
    shadow.getElementById('verificationSummary').textContent = `${report.verification.message}：模型结论尚无独立的本机验证。`;
    for (const check of report.verification.checks) {
      const p = document.createElement('p');
      p.className = 'hint';
      const status = {match: '相同路径的写入与读取记录内容一致', mismatch: '相同路径的写入与读取记录内容不一致', unavailable: '无法比较写后读内容'}[check.status];
      p.textContent = `${status}：${check.path}。无法确认两次访问的文件身份，也不能证明此后文件未变化或任务整体正确。`;
      container.append(p);
    }
    for (const file of report.files) {
      const entry = entries.find(item => item.key === file.key);
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `${file.operation} · ${file.path || `${file.from} → ${file.to}`}`;
      details.append(summary);
      if (entry.request.tool === 'write_file') {
        const pre = document.createElement('pre');
        pre.textContent = `本机记录的写入内容：\n${entry.request.content}\n\n覆盖前内容未保存，无法提供历史差异。`;
        details.append(pre);
      } else {
        const body = document.createElement('div');
        appendResult(body, entry.result);
        details.append(body);
      }
      container.append(details);
    }
    for (const command of report.commands) {
      const entry = entries.find(item => item.key === command.key);
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `命令记录 · 退出码 ${command.exitCode ?? '未知'}`;
      const pre = document.createElement('pre');
      const flag = value => value === null ? '未知' : value ? '是' : '否';
      pre.textContent = `退出码：${command.exitCode ?? '未知'}\n标准错误有输出：${flag(command.stderrHasOutput)}\n输出截断：${flag(command.truncated)}\n超时：${flag(command.timedOut)}\n取消：${flag(command.cancelled)}`;
      details.append(summary, pre);
      const body = document.createElement('div');
      appendResult(body, entry.result);
      details.append(body);
      container.append(details);
    }
    if (!container.children.length) container.textContent = '当前任务暂无本机成果。';
  }

  function clearCurrentResults() {
    renderEvidence([]);
    shadow.getElementById('liveActivity').hidden = true;
    const activity = shadow.getElementById('activity');
    activity.hidden = false;
    activity.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '当前任务暂无操作。';
    activity.append(empty);
    shadow.getElementById('artifacts').textContent = '（无）';
    detailEl.textContent = '（无）';
  }

  async function renderRecords(entries) {
    let list = entries;
    if (!list) {
      try {
        const slot = taskSlot;
        const id = conversationId;
        if (slot) {
          const task = await slot.promise;
          list = await ipcRenderer.invoke('agent:taskRecords', {taskId: task.taskId, conversationId: id});
          if (taskSlot !== slot || conversationId !== id || conversationAt() !== id) return;
        } else list = [];
      } catch (error) {
        recordListEl.textContent = `读取本地记录失败：${error.message}`;
        return;
      }
    }
    renderEvidence(list);
    if (!list.length) {
      shadow.getElementById('artifacts').textContent = '（无）';
      const activity = shadow.getElementById('activity');
      activity.hidden = !shadow.getElementById('liveActivity').hidden;
      activity.innerHTML = '<div class="empty">暂无操作，直接在对话中告诉我你想做什么。</div>';
      return;
    }
    const activity = shadow.getElementById('activity');
    activity.hidden = false;
    activity.replaceChildren();
    for (const entry of list.filter(entry => entry.key !== liveKey).slice(0, 5)) {
      const row = document.createElement('div');
      row.className = 'record';
      const dot = document.createElement('span');
      dot.className = 'record-dot';
      dot.textContent = toolIcon(entry.request?.tool); dot.setAttribute('aria-hidden', 'true');
      const content = document.createElement('div');
      content.className = 'record-content';
      const title = document.createElement('div');
      title.className = 'record-title';
      const request = entry.request || {};
      title.textContent = entry.kind === 'format_error' ? '工具请求格式错误' : TOOL_LABEL[request.tool] || request.tool || '本地操作';
      const meta = document.createElement('div');
      meta.className = 'record-meta';
      const target = request.path || (request.from ? `${request.from} → ${request.to}` : '');
      const state = STATE_LABEL[entry.state] || entry.state || '状态未知';
      const badge = document.createElement('span'); badge.className = 'badge'; badge.dataset.state = entry.state === 'completed' ? 'success' : ['failed', 'denied', 'cancelled', 'unknown', 'format_error'].includes(entry.state) ? 'failure' : 'pending'; badge.textContent = state;
      title.append(' ', badge);
      const duration = Number.isFinite(entry.startedAt) && Number.isFinite(entry.finishedAt) && entry.finishedAt >= entry.startedAt ? `${entry.finishedAt - entry.startedAt}ms` : '';
      meta.textContent = [target, duration, entry.error].filter(Boolean).join(' · ');
      meta.title = meta.textContent;
      content.append(title, meta);
      appendResult(content, entry.result);
      row.append(dot, content);
      activity.append(row);
    }
    shadow.getElementById('artifacts').textContent = list.filter(entry => entry.state === 'completed' && entry.result?.ok && entry.request && ['read_file', 'list_dir', 'write_file', 'delete', 'move'].includes(entry.request.tool)).map(entry => `${describe(entry)} · ${entry.request.path || `${entry.request.from} → ${entry.request.to}`}`).join('\n') || '（无）';
  }

  async function recover() {
    let entries;
    try {
      entries = await ipcRenderer.invoke('agent:list', {conversationId});
    } catch (error) {
      setStatus(`读取本地记录失败：${error.message}`);
      return;
    }
    recordListEl.textContent = entries.slice(0, 10).map(entry => {
      const time = new Date(entry.startedAt || Date.now()).toLocaleString();
      return `${time} · ${describe(entry)}${entry.error ? ` · ${entry.error}` : ''}`;
    }).join('\n') || '（本对话还没有本地记录）';
    await renderRecords();
    const unknown = entries.filter(entry => entry.state === 'unknown' || entry.state === 'executing');
    if (unknown.length) {
      setStatus('上次操作状态未知，请先检查本地记录和聊天记录；不会自动重跑或重发。');
      return;
    }
    const sending = entries.filter(entry => entry.delivery === 'sending' || entry.delivery === 'unknown');
    if (sending.length) {
      setStatus('上次结果的发送状态未知，请检查聊天记录；不会自动重发。');
      return;
    }
    const notSent = entries.filter(entry => entry.resultText && entry.delivery === 'not_sent');
    if (notSent.length) {
      pending = {entry: notSent[0], text: notSent[0].resultText};
      sendBtn.hidden = false;
      setStatus('有尚未发送的工具结果；点击“发送待处理结果”继续，不会重新执行工具。');
      return;
    }
    if (!armed) setStatus('准备就绪，直接在网页发送问题即可。');
  }

  async function deliver() {
    if (!pending || delivering) return 'not_sent';
    delivering = true;
    try {
      return await deliverPending();
    } finally {
      delivering = false;
    }
  }

  async function deliverPending() {
    if (!pending) return 'not_sent';
    if (conversationAt() !== conversationId || pending.entry.conversationId !== conversationId) {
      setStatus('对话已变化，结果未发送；请检查本地记录。');
      return 'not_sent';
    }
    if (paused) {
      sendBtn.hidden = false;
      setStatus('已暂停；工具结果待发送。');
      return 'not_sent';
    }
    if (inputText().trim()) {
      sendBtn.hidden = false;
      setStatus('聊天框里有未发送的草稿，工具结果待发送；请先处理草稿。');
      return 'not_sent';
    }
    const item = pending;
    const text = item.text;
    const key = item.entry.key;
    const sendConversation = conversationId;
    const sendGeneration = generation;
    const sendPauseCount = pauseCount;
    const sendSlot = taskSlot;
    await ipcRenderer.invoke('agent:markDelivery', {key, delivery: 'sending'});
    const sameItem = () => pending === item && conversationId === sendConversation && conversationAt() === sendConversation;
    const sameContext = () => sameItem() && generation === sendGeneration;
    const canSend = () => sameContext() && !paused;
    const samePausedAttempt = () => sameItem() && generation === sendGeneration + 1 && pauseCount === sendPauseCount + 1;
    const showNotSent = message => {
      if (!sameContext() && !samePausedAttempt()) return;
      sendBtn.hidden = false;
      setStatus(samePausedAttempt() && paused ? '已暂停；工具结果待发送。' : message);
    };
    const markSendUnknown = async () => {
      let taskStop = Promise.resolve();
      if (sameItem() && taskSlot === sendSlot) {
        pending = null;
        sendBtn.hidden = true;
        taskStop = stopUnknownTask(sendSlot, '已触发发送，但发送状态未知；不会自动重发，请检查聊天记录。');
      }
      try { await ipcRenderer.invoke('agent:markDelivery', {key, delivery: 'unknown'}); }
      catch (error) {
        if (taskSlot === sendSlot && conversationAt() === sendConversation) setStatus(`发送状态未知，本地发送记录失败：${error.message}；请检查聊天记录。`);
      }
      await taskStop;
    };
    if (!canSend() || inputText().trim()) {
      await ipcRenderer.invoke('agent:markDelivery', {key, delivery: 'not_sent'});
      showNotSent(inputText().trim() ? '聊天框里有未发送的草稿，工具结果待发送；请先处理草稿。' : '任务状态已变化；工具结果待发送。');
      return 'not_sent';
    }
    try {
      setInputText(inputNode(), text);
    } catch (error) {
      await ipcRenderer.invoke('agent:markDelivery', {key, delivery: 'not_sent'});
      showNotSent(`${error.message} 结果待发送。`);
      return 'not_sent';
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (!canSend()) {
        await ipcRenderer.invoke('agent:markDelivery', {key, delivery: 'not_sent'});
        showNotSent('任务状态已变化；工具结果待发送。');
        return 'not_sent';
      }
      if (normalizeText(inputText()) !== normalizeText(text)) {
        await ipcRenderer.invoke('agent:markDelivery', {key, delivery: 'not_sent'});
        showNotSent('聊天框内容已变化，结果未发送。');
        return 'not_sent';
      }
      const button = sendNode();
      if (button && !button.disabled) {
        const watch = startDeliveryErrorWatch(key, conversationId);
        button.click();
        for (let wait = 0; wait < 40; wait += 1) {
          await sleep(50);
          if (watch.rejected) return 'unknown';
          if (!canSend()) {
            if (deliveryErrorWatch === watch) stopDeliveryErrorWatch();
            await markSendUnknown();
            return 'unknown';
          }
          if (!inputText().trim()) {
            try { await ipcRenderer.invoke('agent:markDelivery', {key, delivery: 'submitted'}); }
            catch { await markSendUnknown(); return 'unknown'; }
            if (watch.rejected) {
              await ipcRenderer.invoke('agent:markDelivery', {key, delivery: 'unknown'});
              return 'unknown';
            }
            if (!canSend()) {
              await markSendUnknown();
              return 'unknown';
            }
            pending = null;
            sendBtn.hidden = true;
            setStatus('结果已交给网页，等待模型继续。');
            await renderRecords();
            return 'submitted';
          }
        }
        await markSendUnknown();
        if (generation === sendGeneration && conversationId === sendConversation && conversationAt() === sendConversation) await renderRecords();
        return 'unknown';
      }
      await sleep(50);
    }
    await ipcRenderer.invoke('agent:markDelivery', {key, delivery: 'not_sent'});
    showNotSent('发送按钮未就绪，结果留在聊天框里。');
    return 'not_sent';
  }

  function approvalSummary(request) {
    const label = TOOL_LABEL[request.tool] || request.tool;
    if (request.tool === 'write_file') return `${label}：${request.path}`;
    if (request.tool === 'delete') return `${label}：${request.path}${request.recursive ? '（递归删除整个目录）' : ''}`;
    if (request.tool === 'move') return `${label}：${request.from} → ${request.to}`;
    if (request.tool === 'run_command') return `${label}：${request.command.slice(0, 80)}`;
    return `${label}`;
  }

  function approvalDetail(request) {
    if (request.tool === 'write_file') {
      const bytes = new TextEncoder().encode(request.content).length;
      return `路径：${request.path}\n字节数：${bytes}\n\n完整新内容：\n${request.content}`;
    }
    if (request.tool === 'run_command') {
      return `命令：\n${request.command}\n\n工作目录：${request.cwd || scopeInfo.workspace || scopeInfo.extraRoots[0] || scopeInfo.defaultCwd || '程序目录'}\n超时：${request.timeout_sec || 120} 秒\n${COMMAND_SHELL} 以当前 ${OS_NAME} 用户权限运行，可访问工作空间外的文件和网络；不是沙箱。`;
    }
    if (request.tool === 'delete') {
      return `目标：${request.path}\n递归：${request.recursive ? '是（会删除整个目录）' : '否'}\n\n删除后本原型无法撤销。`;
    }
    if (request.tool === 'move') return `从：${request.from}\n到：${request.to}`;
    if (IS_MAC) return '会用系统自带的 Terminal 打开工作目录，以当前 macOS 用户权限运行，不受工作空间限制。';
    return '会启动一个新的 PowerShell 窗口，以当前 Windows 用户权限运行，不受工作空间限制。';
  }

  function askApproval(request, preview = '') {
    approvalTitle.textContent = approvalSummary(request);
    const scopeNotice = !scopeInfo.workspace && !scopeInfo.extraRoots.length && ['write_file', 'delete', 'move'].includes(request.tool)
      ? `\n\n未选择工作空间；本次操作可访问当前 ${OS_NAME} 账户有权限的路径。` : '';
    const body = approvalDetail(request) + preview + scopeNotice + (request.tool === 'write_file' ? '\n\n写入文件每次仍需确认。' : '');
    approvalBody.replaceChildren();
    let inDiff = false;
    for (const line of body.split(/(?<=\n)/)) {
      if (line.startsWith('变更（')) inDiff = true;
      const span = document.createElement('span'); span.textContent = line;
      if (inDiff && line.startsWith('+ ')) span.className = 'diff-add';
      else if (inDiff && line.startsWith('- ')) span.className = 'diff-del';
      approvalBody.append(span);
    }
    allowToolBtn.title = request.tool === 'write_file' ? '写入文件每次都需要确认' : '仅本对话、本次会话及当前目录范围有效';
    approvalBox.hidden = false;
    setStatus('等待你确认这个操作…');
    return new Promise(resolve => {
      const finish = choice => {
        approvalBox.hidden = true;
        cancelApproval = null;
        allowOnceBtn.onclick = allowToolBtn.onclick = denyBtn.onclick = null;
        resolve(choice);
      };
      cancelApproval = () => finish('cancel');
      allowOnceBtn.onclick = event => { if (event.isTrusted) finish('once'); };
      allowToolBtn.onclick = event => { if (event.isTrusted) finish('tool'); };
      denyBtn.onclick = event => { if (event.isTrusted) finish('deny'); };
    });
  }

  async function handleFormatError(index, text, error) {
    if (inputText().trim()) {
      setStatus('聊天框里有未发送的草稿，未处理工具请求；请先处理草稿。');
      return;
    }
    const slot = taskSlot;
    const context = {generation, conversationId, scopeVersion: scopeInfo.scopeVersion};
    const valid = () => taskSlot === slot && isCurrentTask(context, {generation, armed, paused, conversationId: conversationAt(), scopeVersion: scopeInfo.scopeVersion, replyText: replyNodes()[index]?.innerText}, text);
    const key = keyFor(index, text);
    handled.add(key);
    busy = true;
    const stop = ++consecutiveFormatErrors >= 3;
    showLiveActivity(null, '格式错误，未执行', error);
    try {
      const saved = await ipcRenderer.invoke('agent:formatError', {taskId: slot.task.taskId, key, conversationId: context.conversationId, replyIndex: index, error: error.slice(0, 1024), stop});
      if (!valid()) return;
      await renderRecords();
      if (!valid()) return;
      if (stop) {
        paused = true;
        pauseBtn.textContent = RESUME_LABEL;
        invalidate();
        await setTaskStatus(slot, 'failed');
        formatStopMessage = '连续三次工具请求格式错误，已暂停；没有执行错误请求，请检查模型回复。';
        setStatus(formatStopMessage);
        return;
      }
      if (saved.status === 'exists') {
        setStatus('这条格式错误已有本地记录，不会自动重发。');
        return;
      }
      pending = {entry: saved.entry, text: saved.entry.resultText};
      setStatus('工具请求格式错误，未执行；正在把错误反馈给模型。');
      const delivery = await deliver();
      if (valid() && delivery === 'submitted') await setTaskStatus(slot, 'waiting_model', context.generation);
    } catch (failure) {
      if (valid()) setStatus(`格式错误记录或反馈失败：${failure.message}`);
    } finally {
      busy = false;
    }
  }

  async function handleRequest(index, text, request) {
    awaitingNewConversation = false;
    liveStartedAt = null;
    const slot = taskSlot;
    const context = {generation, conversationId, scopeVersion: scopeInfo.scopeVersion};
    const valid = () => taskSlot === slot && isCurrentTask(context, {generation, armed, paused, conversationId: conversationAt(), scopeVersion: scopeInfo.scopeVersion, replyText: replyNodes()[index]?.innerText}, text);
    const key = keyFor(index, text);
    liveKey = key;
    if (inputText().trim()) {
      setStatus('聊天框里有未发送的草稿，未执行工具请求；请先处理草稿。');
      return;
    }
    handled.add(key);
    busy = true;
    try {
      const label = TOOL_LABEL[request.tool] || request.tool;
      if (MUTATING_TOOLS.includes(request.tool) && (!toolGrants.has(request.tool) || request.tool === 'write_file')) {
        waitingApproval = {slot, key, tool: request.tool};
        await ipcRenderer.invoke('agent:taskStep', {taskId: slot.task.taskId, conversationId: context.conversationId, step: {key, state: 'waiting_approval', purpose: 'tool', tool: request.tool}});
        if (!valid()) {
          await ipcRenderer.invoke('agent:taskStep', {taskId: slot.task.taskId, conversationId: context.conversationId, step: {key, state: 'cancelled', purpose: 'tool', tool: request.tool}});
          return;
        }
        await setTaskStatus(slot, 'waiting_approval', context.generation);
        if (!valid()) return;
        showLiveActivity(request, '等待授权');
        let preview = '';
        if (request.tool === 'write_file') {
          const old = await ipcRenderer.invoke('agent:previewWrite', request);
          if (old.exists && old.old !== null) {
            const before = old.old.split('\n'), after = request.content.split('\n');
            let prefix = 0, suffix = 0;
            while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
            while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
            const removed = before.slice(prefix, before.length - suffix).map(line => `- ${line}`);
            const added = after.slice(prefix, after.length - suffix).map(line => `+ ${line}`);
            preview = `\n\n变更（- 原内容 / + 新内容，保留不变的首尾行未列出）：\n${[...removed, ...added].join('\n') || '无变化'}`;
          } else preview = old.exists ? `\n\n${old.warning}` : '\n\n目标文件不存在，将新建。';
        }
        if (!valid()) return;
        const choice = await askApproval(request, preview);
        if (!valid() || choice === 'cancel') {
          await ipcRenderer.invoke('agent:taskStep', {taskId: slot.task.taskId, conversationId: context.conversationId, step: {key, state: 'cancelled', purpose: 'tool', tool: request.tool}});
          if (taskSlot === slot) { showLiveActivity(request, '未执行', '任务状态已变化'); setStatus('任务状态已变化，未执行请求。'); }
          return;
        }
        if (choice === 'deny') {
          showLiveActivity(request, '已拒绝');
          const denied = await ipcRenderer.invoke('agent:deny', {taskId: slot.task.taskId, key, conversationId: context.conversationId, replyIndex: index, request});
          waitingApproval = null;
          if (!valid()) return;
          await renderRecords();
          if (!valid()) return;
          paused = true;
          pauseBtn.textContent = RESUME_LABEL;
          invalidate();
          const denyGeneration = generation;
          await setTaskStatus(slot, 'paused');
          if (taskSlot !== slot || generation !== denyGeneration || conversationAt() !== context.conversationId) return;
          setStatus('你拒绝了这个操作；任务已暂停，未执行后续请求。');
          return;
        }
        waitingApproval = null;
        if (choice === 'tool') toolGrants.add(request.tool);
      }

      await setTaskStatus(slot, 'active', context.generation);
      if (!valid()) return;
      setStatus(`执行中：${label}`);
      liveStartedAt = Date.now();
      showLiveActivity(request, '执行中');
      detailEl.textContent = JSON.stringify(request, null, 2);
      if (request.tool === 'run_command') stopBtn.hidden = false;
      if (!valid()) { setStatus('任务状态已变化，未执行请求。'); return; }
      activeOperation = {slot, key};
      const result = await ipcRenderer.invoke('agent:execute', {taskId: slot.task.taskId, key, conversationId: context.conversationId, replyIndex: index, request, scopeVersion: context.scopeVersion});
      if (!valid()) return;
      if (result.status === 'task_record_unknown') {
        await stopUnknownTask(slot, '工具可能已执行，但任务记录未保存完整；请检查本机结果，不会自动重跑。');
        return;
      }
      stopBtn.hidden = true;
      if (result.status === 'exists') {
        const entry = result.entry;
        if (['executing', 'running', 'unknown'].includes(entry.state) || ['sending', 'unknown'].includes(entry.delivery)) {
          await stopUnknownTask(slot, '这条请求已有状态不明的本地记录；请检查本机结果与聊天记录，不会自动重跑或重发。');
          return;
        }
        showLiveActivity(request, STATE_LABEL[entry.state] || '状态未知', '已有记录，不会重复执行', entry.result);
        setStatus(`这条请求已有本地记录（${describe(entry)}），不会再次执行。`);
        if (entry.resultText && (!entry.delivery || entry.delivery === 'not_sent')) {
          pending = {entry, text: entry.resultText};
          sendBtn.hidden = false;
        }
        await renderRecords();
        return;
      }
      const entry = result.entry;
      const detail = entry.result?.entries ? `找到 ${entry.result.entries.length} 项` : entry.result?.tool === 'run_command' && entry.result.stderr ? `命令退出码 ${entry.result.exitCode}；标准错误有输出${entry.result.truncated ? '（采集已截断）' : ''}` : entry.error || entry.result?.error || '';
      showLiveActivity(request, STATE_LABEL[entry.state] || '状态未知', detail, entry.result);
      detailEl.textContent = JSON.stringify({request, state: entry.state, result: entry.result}, null, 2);
      await renderRecords();
      if (!valid()) return;
      if (entry.state === 'unknown') {
        setStatus('操作状态未知，请检查本地记录与系统实际状态；不会自动重跑。');
        return;
      }
      slot.failureRun = trackFailure(slot.failureRun, request, entry);
      if (slot.failureRun && (slot.failureRun.operationCount >= 3 || (slot.failureRun.error && slot.failureRun.errorCount >= 3))) {
        paused = true;
        pauseBtn.textContent = RESUME_LABEL;
        invalidate();
        const stopGeneration = generation;
        await setTaskStatus(slot, 'failed');
        if (taskSlot !== slot || generation !== stopGeneration || conversationAt() !== context.conversationId) return;
        formatStopMessage = `同一操作或同类错误连续失败三次，已停止。最后错误：${entry.error || entry.result?.error || `退出码 ${entry.result?.exitCode ?? '未知'}`}；请检查本机步骤记录。`;
        setStatus(formatStopMessage);
        return;
      }
      if (!entry.resultText) {
        setStatus(describe(entry));
        return;
      }
      if (!valid()) { setStatus('任务状态已变化，结果未自动发送，请检查记录。'); return; }
      pending = {entry, text: entry.resultText};
      setStatus(entry.state === 'completed' ? '结果待发送。' : `操作未成功（${STATE_LABEL[entry.state] || entry.state}），把结果告诉模型。`);
      const delivery = await deliver();
      if (valid() && delivery === 'submitted') await setTaskStatus(slot, 'waiting_model', context.generation);
    } catch (error) {
      if (valid()) { showLiveActivity(request, '失败', error.message); setStatus(`调用本地工具失败：${error.message}`); }
    } finally {
      if (waitingApproval?.slot === slot && waitingApproval.key === key) {
        waitingApproval = null;
        try { await ipcRenderer.invoke('agent:taskStep', {taskId: slot.task.taskId, conversationId: context.conversationId, step: {key, state: 'cancelled', purpose: 'tool', tool: request.tool}}); }
        catch (error) { if (taskSlot === slot) setStatus(`保存取消状态失败：${error.message}`); }
      }
      if (activeOperation?.slot === slot && activeOperation.key === key) activeOperation = null;
      if (taskSlot === slot) stopBtn.hidden = true;
      busy = false;
    }
  }

  function chipFor(label, text) {
    const details = document.createElement('details');
    details.style.cssText = 'font-size:12px;color:#64748b;margin:4px 0;max-width:min(640px,74vw);';
    const summary = document.createElement('summary');
    summary.textContent = label;
    summary.style.cursor = 'pointer';
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:200px;overflow:auto;font:11px/1.45 ui-monospace,Consolas,monospace;';
    pre.textContent = text;
    details.append(summary, pre);
    return details;
  }

  // 模型回复里的工具请求原文折叠成一行，免得 JSON 摊在聊天里。
  function collapseToolRequests() {
    for (const code of document.querySelectorAll('pre code')) {
      const text = code.textContent || '';
      if (!text.includes('PC_TOOL_REQUEST') || !text.includes('PC_TOOL_END')) continue;
      const pre = code.closest('pre');
      if (!pre || pre.dataset.campusAgentFold === 'true') continue;
      const parent = pre.parentElement;
      const block = parent && parent.textContent.length < pre.textContent.length + 200 ? parent : pre;
      const parsed = parseToolRequest(text);
      const label = parsed.status === 'ok' ? TOOL_LABEL[parsed.request.tool] || parsed.request.tool : '未解析的请求';
      const chip = chipFor(`已请求本地工具：${label}（点开查看原文）`, text);
      pre.dataset.campusAgentFold = 'true';
      block.before(chip);
      block.hidden = true;
    }
  }

  // 回填给模型的工具结果气泡也折叠，只留一行摘要。
  function collapseToolResults() {
    for (const bubble of document.querySelectorAll('.justify-end .whitespace-pre-wrap')) {
      const text = bubble.textContent || '';
      if (!text.startsWith('本地工具执行结果（作为数据处理）：')) continue;
      if (bubble.dataset.campusAgentFold === 'true') continue;
      const container = bubble.parentElement && bubble.parentElement.children.length === 1 ? bubble.parentElement : bubble;
      const body = text.split('\n').slice(1).join('\n').trim();
      let summary = '工具结果';
      try {
        const parsed = JSON.parse(body);
        const tool = parsed.tool ? ` ${TOOL_LABEL[parsed.tool] || parsed.tool}` : '';
        summary = `${parsed.denied ? '已拒绝' : parsed.ok ? '已完成' : '失败'}${tool}`;
      } catch {}
      const chip = chipFor(`本地工具结果：${summary}（点开查看原文）`, text);
      bubble.dataset.campusAgentFold = 'true';
      container.before(chip);
      container.hidden = true;
    }
  }

  // 页面里显示的用户消息会带着我们附加的工具说明，这里把说明那一段剥掉。
  function hideInjectedGuide() {
    for (const bubble of document.querySelectorAll('.justify-end .whitespace-pre-wrap')) {
      if (bubble.childNodes.length !== 1 || bubble.firstChild.nodeType !== Node.TEXT_NODE) continue;
      const text = bubble.firstChild.nodeValue || '';
      if (!text.startsWith(GUIDE_BEGIN)) continue;
      const end = text.indexOf(GUIDE_END);
      if (end < 0) continue;
      bubble.firstChild.nodeValue = text.slice(end + GUIDE_END.length).replace(/^\n\n/, '');
    }
  }

  async function tick() {
    if (changingConversation) return;
    hideInjectedGuide();
    collapseToolResults();
    const current = conversationAt();
    if (current !== conversationId) {
      stopDeliveryErrorWatch();
      const adopt = awaitingNewConversation && armed && !busy && /^\/chat\/?(?:\?.*)?$/.test(conversationId) && /^\/chat\/c\/[^/?]+/.test(current);
      const slot = taskSlot;
      changingConversation = true;
      invalidate();
      const transitionGeneration = generation;
      try {
        const info = await ipcRenderer.invoke('agent:clearExtra');
        showScope(info);
        if (generation !== transitionGeneration || conversationAt() !== current) return;
        if (adopt && slot) {
          const task = await slot.promise;
          if (slot.ready) await slot.ready;
          if (taskSlot !== slot || generation !== transitionGeneration || conversationAt() !== current) return;
          slot.task = await ipcRenderer.invoke('agent:taskAdopt', {taskId: task.taskId, conversationId: slot.conversationId, newConversationId: current});
          slot.conversationId = current;
          if (taskSlot !== slot || generation !== transitionGeneration || conversationAt() !== current) return;
        } else {
          detachTask(slot);
          taskSlot = null;
          clearModelReport();
          clearCurrentResults();
          await recoverTasksFor(current);
          if (generation !== transitionGeneration || conversationAt() !== current) return;
        }
        conversationId = current;
        consecutiveFormatErrors = 0;
        formatStopMessage = null;
        awaitingNewConversation = false;
        candidate = null;
        pending = null;
        sendBtn.hidden = true;
        if (adopt) {
          if (slot?.task) drawTask(slot.task);
          setStatus('已进入新对话，等待模型回复。');
        } else {
          clearModelReport();
          renderEvidence([]);
          shadow.getElementById('task').textContent = '等待你发送问题';
          shadow.getElementById('taskState').textContent = '等待消息';
          shadow.getElementById('taskEvidence').textContent = '模型报告与本机验证分别显示。';
          shadow.getElementById('liveActivity').hidden = true;
          liveKey = null;
          armed = false;
          armBtn.textContent = ARM_LABEL;
          setStatus('对话已切换；发送新消息后开始。');
          await recover();
        }
        await refreshTaskHistory(current);
      } finally { changingConversation = false; }
      return;
    }
    if (busy) return;
    if (!armed) return;
    if (paused) {
      setStatus(deliveryErrorMessage || formatStopMessage || '已暂停：不会执行新的工具请求。');
      return;
    }
    const slot = taskSlot;
    if (!slot) return;
    await slot.promise;
    if (slot.ready) await slot.ready;
    if (taskSlot !== slot || paused || !armed || conversationAt() !== conversationId) return;
    if (!inputNode() || !sendNode()) {
      setStatus('聊天界面元素未就绪，等待页面加载。');
      return;
    }
    const nodes = replyNodes();
    const index = nodes.length - 1;
    if (index < baseline || index < 0) {
      setStatus('等待模型回复…');
      return;
    }
    const text = nodes[index].innerText || '';
    if (!text.trim()) {
      setStatus('等待模型回复…');
      return;
    }
    if (generating()) {
      candidate = null;
      setStatus('模型正在生成，等待完成。');
      return;
    }
    if (!candidate || candidate.index !== index || candidate.text !== text) {
      candidate = {index, text, since: Date.now()};
      setStatus('等待模型回复完成…');
      return;
    }
    if (Date.now() - candidate.since < 1200) {
      setStatus('等待模型回复完成…');
      return;
    }
    if (deliveryErrorWatch && nodes.length > deliveryErrorWatch.replyCount) {
      checkDeliveryError(deliveryErrorWatch);
      if (deliveryErrorWatch?.rejected) return;
      stopDeliveryErrorWatch();
    }
    const key = keyFor(index, text);
    if (handled.has(key)) {
      return;
    }
    const parsed = parseToolRequest(text, replyCodeBlocks(nodes[index]));
    const progress = parseModelProgress(text);
    if (progress.status === 'invalid') {
      handled.add(key);
      showModelReport(text);
      showLiveActivity(null, '格式错误，未执行', progress.error);
      setStatus(`模型计划格式错误，未执行请求：${progress.error}`);
      return;
    }
    if (parsed.status === 'none') {
      if (reportedReply !== key) {
        reportedReply = key;
        showModelReport(text);
        await setTaskStatus(slot, 'waiting_verification');
      }
      setStatus('本回复没有工具请求，未执行任何操作。');
      return;
    }
    if (parsed.status === 'invalid') {
      await handleFormatError(index, text, parsed.error);
      return;
    }
    consecutiveFormatErrors = 0;
    await handleRequest(index, text, parsed.request);
  }

  armBtn.addEventListener('click', event => {
    if (!event.isTrusted) return;
    stopDeliveryErrorWatch();
    deliveryErrorMessage = null;
    formatStopMessage = null;
    consecutiveFormatErrors = 0;
    armed = true;
    paused = false;
    pauseBtn.textContent = PAUSE_LABEL;
    candidate = null;
    handled.clear();
    invalidate();
    toolGrants.clear();
    const nodes = replyNodes();
    baseline = generating() && nodes.length ? nodes.length - 1 : nodes.length;
    armBtn.textContent = '已开启（本次执行）';
    setStatus('已开启本次工具执行。现在请在网页发送你的问题。');
  });

  pauseBtn.addEventListener('click', event => {
    if (!event.isTrusted) return;
    if (paused && taskSlot?.task?.status === 'unknown') {
      setStatus('当前任务状态未知，请先结束并开始新任务；不会自动执行。');
      return;
    }
    paused = !paused;
    if (!paused) { deliveryErrorMessage = null; formatStopMessage = null; }
    if (paused) {
      pauseCount++;
      invalidate();
      const approval = waitingApproval;
      const slot = taskSlot;
      if (slot) {
        slot.ready = (async () => {
          await slot.promise;
          if (approval && approval.slot === slot) await ipcRenderer.invoke('agent:taskStep', {taskId: slot.task.taskId, conversationId: slot.conversationId, step: {key: approval.key, state: 'cancelled', purpose: 'tool', tool: approval.tool}});
          await setTaskStatus(slot, 'paused');
        })().catch(error => setStatus(`保存暂停状态失败：${error.message}`));
      }
    } else if (taskSlot) {
      const slot = taskSlot;
      slot.ready = Promise.resolve(slot.ready).then(() => setTaskStatus(slot, 'waiting_model')).catch(error => setStatus(`恢复任务状态失败：${error.message}`));
    }
    pauseBtn.textContent = paused ? RESUME_LABEL : PAUSE_LABEL;
    setStatus(paused ? '已暂停后续工具执行；已发生的操作不会被撤销。' : '已继续后续工具执行。');
  });

  async function endCurrentTask(event) {
    if (!event.isTrusted) return;
    const slot = taskSlot;
    const wasExecuting = Boolean(activeOperation && activeOperation.slot === slot);
    const approval = waitingApproval;
    stopDeliveryErrorWatch();
    deliveryErrorMessage = null;
    formatStopMessage = null;
    consecutiveFormatErrors = 0;
    armed = false;
    paused = false;
    invalidate();
    const endGeneration = generation;
    const endConversation = conversationId;
    taskSlot = null;
    clearModelReport();
    clearCurrentResults();
    pending = null;
    sendBtn.hidden = true;
    armBtn.textContent = ARM_LABEL;
    pauseBtn.textContent = PAUSE_LABEL;
    try {
      if (slot?.task?.status !== 'unknown') await finishTask(slot, wasExecuting, approval);
      else { drawTask(slot.task); await refreshTaskHistory(slot.conversationId); }
    }
    catch (error) { if (!taskSlot && generation === endGeneration && conversationAt() === endConversation) setStatus(`结束任务记录失败：${error.message}`); return; }
    try {
      const info = await ipcRenderer.invoke('agent:clearExtra');
      if (generation === endGeneration && conversationAt() === endConversation) showScope(info);
    } catch (error) {
      if (!taskSlot && generation === endGeneration && conversationAt() === endConversation) setStatus(`任务已结束，清除额外目录失败：${error.message}`);
      return;
    }
    if (!taskSlot && generation === endGeneration && conversationAt() === endConversation) setStatus(wasExecuting || slot?.task?.status === 'unknown' ? '任务执行状态未知，请检查本机结果；不会自动重跑。' : '任务已结束；待处理授权已取消，已发生的操作不会撤销。');
  }
  function queueEndTask(event) {
    if (!event.isTrusted) return;
    endingTask = endCurrentTask(event);
  }
  shadow.getElementById('endTask').addEventListener('click', queueEndTask);
  shadow.getElementById('newTask').addEventListener('click', queueEndTask);

  stopBtn.addEventListener('click', event => {
    if (!event.isTrusted) return;
    stopBtn.disabled = true;
    setStatus('正在停止当前命令…');
    ipcRenderer.invoke('agent:cancel').then(result => {
      if (!result.cancelled) setStatus('当前没有可停止的命令。');
    }).catch(error => setStatus(`停止命令失败：${error.message}`)).finally(() => {
      stopBtn.disabled = false;
    });
  });

  sendBtn.addEventListener('click', event => {
    if (!event.isTrusted) return;
    deliver().catch(error => setStatus(`发送结果失败：${error.message}`));
  });

  guideBtn.addEventListener('click', event => {
    if (!event.isTrusted) return;
    const input = inputNode();
    if (!input) {
      setStatus('找不到聊天输入框，无法填入说明。');
      return;
    }
    if (inputText().trim()) {
      setStatus('聊天框已有内容，未覆盖；请先处理草稿后再点“填入工具请求说明”。');
      return;
    }
    try {
      setInputText(input, buildToolGuide(process.platform));
      setStatus('工具请求说明已填入聊天框（未自动发送）；请检查后自己按发送。');
    } catch (error) {
      setStatus(`填入说明失败：${error.message}`);
    }
  });

  guideToggleBtn.addEventListener('click', event => {
    if (!event.isTrusted) return;
    const turningOff = document.documentElement.dataset.campusAgentGuide !== 'off';
    document.documentElement.dataset.campusAgentGuide = turningOff ? 'off' : 'on';
    guideToggleBtn.textContent = turningOff ? '自动附加说明：关' : '自动附加说明：开';
    setStatus(turningOff ? '已关闭自动附加；模型将不知道工具协议。' : '已恢复自动附加工具说明。');
  });

  diagBtn.addEventListener('click', async event => {
    if (!event.isTrusted) return;
    const describeElement = element => {
      if (!element) return '未找到';
      const attrs = ['data-testid', 'aria-label', 'role', 'contenteditable', 'placeholder']
        .filter(name => element.getAttribute(name))
        .map(name => `${name}="${element.getAttribute(name)}"`);
      return `<${element.tagName.toLowerCase()}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
    };
    const report = {
      回复节点数量: replyNodes().length,
      输入框: describeElement(inputNode()),
      输入框类型: (() => {
        const element = inputNode();
        if (!element) return '未找到';
        return element.tagName === 'TEXTAREA' ? 'textarea' : element.isContentEditable ? 'contenteditable' : element.tagName;
      })(),
      发送按钮: describeElement(sendNode()),
      生成中指示: generating() ? '存在停止按钮' : '未检测到',
      当前地址: location.href,
      本次基线回复序号: baseline,
      已开启执行: armed ? '是' : '否',
      授权范围: toolGrants.size ? `已允许：${Array.from(toolGrants).join('、')}` : '每次询问'
    };
    try {
      report.自动附加说明 = await ipcRenderer.invoke('agent:injectStatus');
    } catch (error) {
      report.自动附加说明 = `读取失败：${error.message}`;
    }
    diagOutEl.textContent = JSON.stringify(report, null, 2);
  });

  minimizeBtn.addEventListener('click', event => {
    if (!event.isTrusted) return;
    const minimized = panel.classList.toggle('minimized');
    minimizeBtn.textContent = minimized ? '+' : '−';
    minimizeBtn.setAttribute('aria-label', minimized ? '展开面板' : '最小化面板');
    minimizeBtn.title = minimized ? '展开面板' : '最小化面板';
  });

  ipcRenderer.invoke('agent:info').then(showScope).catch(error => setStatus(error.message));
  recoverTasksFor(conversationId).then(() => refreshTaskHistory()).catch(error => setStatus(`读取任务历史失败：${error.message}`));
  window.addEventListener('beforeunload', () => { stopDeliveryErrorWatch(); invalidate(); });
  renderRecords().catch(() => {});
  setTimeout(() => {
    recover().catch(error => setStatus(`恢复本地记录失败：${error.message}`));
  }, 1200);
  setInterval(() => {
    tick().catch(error => setStatus(`巡检失败：${error.message}`));
  }, 500);
}
