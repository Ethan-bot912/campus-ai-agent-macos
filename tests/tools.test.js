'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const tools = require('../tools');
const mac = process.platform === 'darwin';

let base;
let scope;
let scoped;

test.before(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'campus-agent-tools-'));
  const root = path.join(base, 'root');
  await fs.mkdir(path.join(root, 'sub'), {recursive: true});
  await fs.writeFile(path.join(root, 'hello.txt'), 'campus-agent-test', 'utf8');
  await fs.writeFile(path.join(root, 'sub', 'inner.txt'), 'inner', 'utf8');
  scope = {root: null, defaultCwd: base};
  scoped = {root, defaultCwd: root};
});

test('写入新文件并读回', async () => {
  const target = path.join(base, 'notes', 'a.txt');
  const written = await tools.writeFile(scope, {path: target, content: '第一行\n第二行'});
  assert.equal(written.ok, true);
  assert.equal(written.bytes > 0, true);
  const read = await tools.readFile(scope, target);
  assert.equal(read.content, '第一行\n第二行');
});

test('覆盖已有文件', async () => {
  const target = path.join(base, 'notes', 'a.txt');
  await tools.writeFile(scope, {path: target, content: 'new'});
  assert.equal((await tools.readFile(scope, target)).content, 'new');
});

test('相对路径按 defaultCwd 解析', async () => {
  await tools.writeFile(scope, {path: 'rel.txt', content: 'rel'});
  const read = await tools.readFile(scope, 'rel.txt');
  assert.equal(read.content, 'rel');
});

test('范围收窄到目录时拒绝越界写入', async () => {
  const outside = path.join(base, 'outside.txt');
  await assert.rejects(() => tools.writeFile(scoped, {path: outside, content: 'x'}), /超出允许范围/);
  await assert.rejects(() => tools.writeFile(scoped, {path: '../escape.txt', content: 'x'}), /超出允许范围/);
  assert.equal(await fs.stat(outside).then(() => true, () => false), false);
});

test('多个授权目录可访问，撤销后立即拒绝额外目录', async () => {
  const extra = path.join(base, 'extra');
  await fs.mkdir(extra);
  await fs.writeFile(path.join(extra, 'test.txt'), 'extra');
  const multi = {roots: [scoped.root, extra], defaultCwd: scoped.root};
  assert.equal((await tools.readFile(multi, path.join(extra, 'test.txt'))).content, 'extra');
  await assert.rejects(() => tools.readFile({...multi, roots: [scoped.root]}, path.join(extra, 'test.txt')), /超出允许范围/);
  await assert.rejects(() => tools.readFile({...multi, roots: []}, path.join(extra, 'test.txt')), /超出允许范围/);
});

test('目录 junction 指向授权范围外时拒绝读取', async () => {
  const outside = path.join(base, 'outside-dir');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  const link = path.join(scoped.root, 'outside-link');
  await fs.symlink(outside, link, 'junction');
  await assert.rejects(() => tools.readFile({roots: [scoped.root], defaultCwd: scoped.root}, path.join(link, 'secret.txt')), /超出允许范围/);
});

test('删除文件；非空目录需要 recursive', async () => {
  const file = path.join(base, 'to-delete.txt');
  await tools.writeFile(scope, {path: file, content: 'x'});
  const removed = await tools.deletePath(scope, {path: file});
  assert.equal(removed.type, 'file');
  await assert.rejects(() => tools.readFile(scope, file), /不存在/);

  const dir = path.join(base, 'dir-with-file');
  await tools.writeFile(scope, {path: path.join(dir, 'x.txt'), content: 'x'});
  await assert.rejects(() => tools.deletePath(scope, {path: dir}), /目录非空/);
  const recursive = await tools.deletePath(scope, {path: dir, recursive: true});
  assert.equal(recursive.recursive, true);
  await assert.rejects(() => tools.listDir(scope, dir), /不存在/);
});

test('移动/重命名并自动创建目标目录', async () => {
  const from = path.join(base, 'move-from.txt');
  const to = path.join(base, 'moved', 'deep', 'move-to.txt');
  await tools.writeFile(scope, {path: from, content: 'moved-content'});
  const moved = await tools.movePath(scope, {from, to});
  assert.equal(moved.to, to);
  assert.equal((await tools.readFile(scope, to)).content, 'moved-content');
  await assert.rejects(() => tools.movePath(scope, {from, to}), /不存在/);
});

test('运行命令取得输出与退出码', async () => {
  const command = mac ? "printf '%s\\n' hello-from-shell" : 'Write-Output "hello-from-shell"';
  const ok = await tools.runCommand(scope, {command}, {setCancel() {}, clearCancel() {}});
  assert.equal(ok.ok, true);
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /hello-from-shell/);

  const bad = await tools.runCommand(scope, {command: 'exit 3'}, {setCancel() {}, clearCancel() {}});
  assert.equal(bad.ok, false);
  assert.equal(bad.exitCode, 3);
});

test('命令超时会被终止并标记 timedOut', async () => {
  const startedAt = Date.now();
  const command = mac ? "sleep 10 & printf 'started\\n'; wait" : 'Start-Sleep -Seconds 30';
  const result = await tools.runCommand(scope, {command, timeout_sec: 1}, {setCancel() {}, clearCancel() {}});
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  if (mac) {
    assert.match(result.stdout, /started/);
    assert.equal(result.terminationConfirmed, true);
  }
  assert.ok(Date.now() - startedAt < (mac ? 5000 : 20000));
});

test('macOS 取消命令会终止整个进程组', {skip: !mac}, async () => {
  let timer;
  const result = await tools.runCommand(scope, {command: 'sleep 10 & wait'}, {
    setCancel(cancel) { timer = setTimeout(cancel, 250); },
    clearCancel() { clearTimeout(timer); }
  });
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.ok, false);
  assert.equal(result.terminationConfirmed, true);
  assert.ok(result.durationMs < 5000);
});

test('macOS 命令从标准输入读取时收到 EOF', {skip: !mac}, async () => {
  const result = await tools.executeTool(scope, {tool: 'run_command', command: 'cat', timeout_sec: 1});
  assert.equal(result.ok, true);
  assert.equal(result.stdout, '');
});

test('命令的工作目录被采用', async () => {
  const result = await tools.runCommand(scope, {command: mac ? 'pwd -P' : '(Get-Location).Path'}, {setCancel() {}, clearCancel() {}});
  assert.equal(result.ok, true);
  if (mac) assert.equal(result.stdout.trim(), await fs.realpath(base));
  else assert.equal(result.stdout.trim().toLowerCase(), base.toLowerCase());
});

test('读取仍然限制 200 KB 并拒绝二进制', async () => {
  const big = path.join(base, 'big.txt');
  await fs.writeFile(big, 'x'.repeat(tools.MAX_FILE_BYTES + 10), 'utf8');
  await assert.rejects(() => tools.readFile(scope, big), /超过 200 KB/);
  const binary = path.join(base, 'bin.dat');
  await fs.writeFile(binary, Buffer.from([0x41, 0x00, 0x42]));
  await assert.rejects(() => tools.readFile(scope, binary), /不是文本文件/);
});

test('executeTool 拒绝未声明的工具', async () => {
  await assert.rejects(() => tools.executeTool(scope, {tool: 'format_disk', path: 'C:/'}), /只允许/);
});
