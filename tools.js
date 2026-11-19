'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile, spawn} = require('node:child_process');
const {promisify} = require('node:util');

const execFileAsync = promisify(execFile);
const IS_MAC = process.platform === 'darwin';

const MAX_FILE_BYTES = 200 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 500;
const MAX_OUTPUT_CHARS = 100 * 1024;
const MAX_TIMEOUT_SEC = 1800;

const TOOL_NAMES = Object.freeze(['list_dir', 'read_file', 'write_file', 'delete', 'move', 'run_command', 'open_terminal']);
const MUTATING_TOOLS = Object.freeze(['write_file', 'delete', 'move', 'run_command', 'open_terminal']);

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// 目标可能还不存在（新建文件）：向上找到最深的已存在祖先解析真实路径，再拼回剩余段。
async function realpathLoose(target) {
  let current = path.resolve(target);
  const missing = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = await fs.realpath(current);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
  throw new ToolError('PATH_TOO_DEEP', '路径层级过深。');
}

// scope.root 为 null 表示当前账户可达的整台电脑；否则限制在该目录内。
async function resolvePath(scope, value, {mustExist = false} = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new ToolError('BAD_PATH', '缺少路径。');
  if (value.includes('\0')) throw new ToolError('BAD_PATH', '路径包含非法字符。');
  const absolute = path.resolve(scope.defaultCwd, value);
  const real = await realpathLoose(absolute);
  if (scope.roots) {
    const roots = await Promise.all(scope.roots.map(root => fs.realpath(root)));
    if (!roots.some(root => isInside(root, real))) throw new ToolError('ESCAPE', '路径超出允许范围。');
  } else if (scope.root) {
    const realRoot = await fs.realpath(scope.root);
    if (!isInside(realRoot, real)) throw new ToolError('ESCAPE', '路径超出允许范围。');
  }
  if (mustExist) {
    try {
      await fs.lstat(absolute);
    } catch (error) {
      if (error.code === 'ENOENT') throw new ToolError('NOT_FOUND', '目标不存在。');
      throw error;
    }
  }
  return {path: absolute, real};
}

async function listDir(scope, relative) {
  const {path: target} = await resolvePath(scope, relative, {mustExist: true});
  const info = await fs.stat(target);
  if (!info.isDirectory()) throw new ToolError('NOT_DIRECTORY', '目标不是目录。');
  const entries = await fs.readdir(target, {withFileTypes: true});
  if (entries.length > MAX_ENTRIES) throw new ToolError('TOO_MANY', `目录项目超过 ${MAX_ENTRIES} 个，请选择更小的目录。`);
  return {
    ok: true,
    tool: 'list_dir',
    path: target,
    entries: entries.map(entry => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : entry.isFile() ? 'file' : 'other'
    }))
  };
}

async function readFile(scope, relative) {
  const {path: target} = await resolvePath(scope, relative, {mustExist: true});
  const info = await fs.stat(target);
  if (!info.isFile()) throw new ToolError('NOT_FILE', '目标不是普通文件。');
  if (info.size > MAX_FILE_BYTES) throw new ToolError('TOO_LARGE', '文件超过 200 KB。');
  const bytes = await fs.readFile(target);
  if (bytes.length > MAX_FILE_BYTES) throw new ToolError('TOO_LARGE', '文件超过 200 KB。');
  if (bytes.includes(0)) throw new ToolError('BINARY', '文件不是文本文件。');
  let content;
  try {
    content = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    throw new ToolError('ENCODING', '文件不是有效的 UTF-8 文本。');
  }
  return {ok: true, tool: 'read_file', path: target, bytes: bytes.length, content};
}

async function writeFile(scope, request) {
  if (typeof request.content !== 'string') throw new ToolError('BAD_CONTENT', '写入内容必须是文本。');
  const bytes = Buffer.byteLength(request.content, 'utf8');
  if (bytes > MAX_WRITE_BYTES) throw new ToolError('TOO_LARGE', '写入内容超过 1 MB。');
  const {path: target} = await resolvePath(scope, request.path);
  await fs.mkdir(path.dirname(target), {recursive: true});
  await fs.writeFile(target, request.content, 'utf8');
  return {ok: true, tool: 'write_file', path: target, bytes};
}

async function deletePath(scope, request) {
  const {path: target} = await resolvePath(scope, request.path, {mustExist: true});
  const info = await fs.lstat(target);
  const type = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : info.isSymbolicLink() ? 'symlink' : 'other';
  if (type === 'directory') {
    if (request.recursive === true) {
      await fs.rm(target, {recursive: true, force: false});
      return {ok: true, tool: 'delete', path: target, type, recursive: true};
    }
    const entries = await fs.readdir(target);
    if (entries.length) throw new ToolError('NOT_EMPTY', '目录非空；如需递归删除，请在请求里设置 recursive: true。');
    await fs.rmdir(target);
    return {ok: true, tool: 'delete', path: target, type, recursive: false};
  }
  await fs.unlink(target);
  return {ok: true, tool: 'delete', path: target, type, recursive: false};
}

async function movePath(scope, request) {
  const from = await resolvePath(scope, request.from, {mustExist: true});
  const to = await resolvePath(scope, request.to);
  await fs.mkdir(path.dirname(to.path), {recursive: true});
  await fs.rename(from.path, to.path);
  return {ok: true, tool: 'move', from: from.path, to: to.path};
}

async function killTree(child) {
  if (IS_MAC) {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, 'SIGKILL');
      return true;
    } catch (error) {
      if (error.code !== 'ESRCH') console.error('无法终止命令进程组：', error.message);
      return false;
    }
  }
  return new Promise(resolve => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
    killer.on('error', () => {
      try { child.kill(); } catch {}
      resolve(false);
    });
    killer.on('close', code => resolve(code === 0));
  });
}

async function runCommand(scope, request, controls) {
  if (typeof request.command !== 'string' || !request.command.trim()) throw new ToolError('BAD_COMMAND', '缺少要执行的命令。');
  const cwd = request.cwd ? (await resolvePath(scope, request.cwd, {mustExist: true})).path : scope.defaultCwd;
  const cwdInfo = await fs.stat(cwd);
  if (!cwdInfo.isDirectory()) throw new ToolError('NOT_DIRECTORY', '工作目录不是目录。');
  const timeoutSec = Math.min(Math.max(Number(request.timeout_sec) || 120, 1), MAX_TIMEOUT_SEC);
  const startedAt = Date.now();
  let child;
  if (IS_MAC) {
    // 独立进程组让取消和超时能同时停止 shell 和同组子进程。
    child = spawn('/bin/zsh', ['-f', '-c', request.command], {cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  } else {
    const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${request.command}`;
    child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      {cwd, windowsHide: true}
    );
  }

  let stdout = '';
  let stderr = '';
  let truncated = false;
  let timedOut = false;
  let cancelled = false;
  let killPromise = null;
  let settled = false;

  const collect = (chunk, current) => {
    const text = chunk.toString('utf8');
    if (current.length >= MAX_OUTPUT_CHARS) {
      truncated = true;
      return current;
    }
    const room = MAX_OUTPUT_CHARS - current.length;
    if (text.length > room) truncated = true;
    return current + text.slice(0, room);
  };

  child.stdout.on('data', chunk => { stdout = collect(chunk, stdout); });
  child.stderr.on('data', chunk => { stderr = collect(chunk, stderr); });

  const stop = reason => {
    if (killPromise) return;
    if (reason === 'user') cancelled = true;
    else timedOut = true;
    killPromise = killTree(child);
  };

  controls.setCancel(() => stop('user'));
  const timer = setTimeout(() => stop('timeout'), timeoutSec * 1000);

  return new Promise((resolve, reject) => {
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controls.clearCancel();
      reject(error);
    });
    child.on('close', exitCode => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controls.clearCancel();
      Promise.resolve(killPromise).then(terminationConfirmed => resolve({
        ok: exitCode === 0 && !timedOut && !cancelled,
        tool: 'run_command',
        cwd,
        command: request.command,
        exitCode,
        timedOut,
        cancelled,
        terminationConfirmed,
        truncated,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt
      }));
    });
  });
}

async function openTerminal(scope) {
  try {
    if (IS_MAC) {
      await execFileAsync('/usr/bin/open', ['-b', 'com.apple.Terminal', scope.defaultCwd]);
      return {
        ok: true,
        tool: 'open_terminal',
        message: '已请求 Terminal 打开工作目录；请用户确认窗口是否显示，助手看不到窗口里的输入。'
      };
    }
    const child = spawn('powershell.exe', ['-NoLogo', '-NoExit'], {detached: true, stdio: 'ignore', windowsHide: false});
    child.unref();
    return {
      ok: true,
      tool: 'open_terminal',
      processId: child.pid,
      message: '已启动 PowerShell 终端进程；请用户确认窗口是否显示，助手看不到窗口里的输入。'
    };
  } catch (error) {
    return {ok: false, tool: 'open_terminal', launchStatus: 'unknown', error: `无法确认终端是否启动：${error.message}`};
  }
}

function assertRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new ToolError('BAD_REQUEST', '请求必须是对象。');
  if (!TOOL_NAMES.includes(request.tool)) throw new ToolError('BAD_TOOL', `只允许 ${TOOL_NAMES.join('、')}。`);
}

async function executeTool(scope, request, controls = {}) {
  assertRequest(request);
  switch (request.tool) {
    case 'list_dir':
      return listDir(scope, request.path);
    case 'read_file':
      return readFile(scope, request.path);
    case 'write_file':
      return writeFile(scope, request);
    case 'delete':
      return deletePath(scope, request);
    case 'move':
      return movePath(scope, request);
    case 'run_command':
      return runCommand(scope, request, {
        setCancel: controls.setCancel || (() => {}),
        clearCancel: controls.clearCancel || (() => {})
      });
    case 'open_terminal':
      return openTerminal(scope);
    default:
      throw new ToolError('BAD_TOOL', '不支持的工具。');
  }
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_WRITE_BYTES,
  MAX_ENTRIES,
  MAX_OUTPUT_CHARS,
  TOOL_NAMES,
  MUTATING_TOOLS,
  ToolError,
  isInside,
  realpathLoose,
  resolvePath,
  listDir,
  readFile,
  writeFile,
  deletePath,
  movePath,
  runCommand,
  openTerminal,
  executeTool
};
