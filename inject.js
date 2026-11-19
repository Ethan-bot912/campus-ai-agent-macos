'use strict';

function buildToolGuide(platform) {
  const mac = platform === 'darwin';
  const root = mac ? '/Users/example' : 'D:';
  const command = mac ? 'ls -la' : 'Get-ChildItem D:/';
  const terminal = mac ? '在工作目录打开 macOS 自带的 Terminal' : '打开一个空白 PowerShell 窗口';
  return [
    mac ? '本机系统是 macOS，run_command 使用 zsh。' : '本机系统是 Windows，run_command 使用 PowerShell。',
    '你可以请求本机工具；查看文件和目录可以直接请求，写入等操作需要用户授权。',
    '查看磁盘或目录时优先使用 list_dir，不要使用 run_command。',
    '需要操作时，只输出一个请求，然后等待结果返回；结果到达前不要声称已经完成。',
    '',
    '可用工具（每次只输出一个）：',
    `list_dir {"tool":"list_dir","path":"${root}/some/dir"}`,
    `read_file {"tool":"read_file","path":"${root}/some/file.txt"}`,
    `write_file {"tool":"write_file","path":"${root}/some/file.txt","content":"文本内容"}`,
    `delete {"tool":"delete","path":"${root}/x.txt"}  删除目录时加 "recursive":true`,
    `move {"tool":"move","from":"${root}/a.txt","to":"${root}/b.txt"}`,
    `run_command {"tool":"run_command","command":"${command}","cwd":"${mac ? root : 'D:/'}","timeout_sec":120}`,
    `open_terminal {"tool":"open_terminal"}  ${terminal}给我自己用`,
    '',
    '每个请求必须把 PC_TOOL_REQUEST、合法 JSON、PC_TOOL_END 放在同一个以三个反引号加 json 开头的代码块里。',
    '标记必须是独立的一行，不是 JSON 的字段。例子：',
    '```json',
    'PC_TOOL_REQUEST',
    '{"tool":"list_dir","path":"."}',
    'PC_TOOL_END',
    '```',
    mac ? '可以使用 / 开头的绝对路径，或相对工作目录的路径。' : '路径可以用绝对路径（Windows 路径写成正斜杠）。',
    'ok 为 false、exitCode 非零、cancelled 或 timedOut 都表示没有成功，不要凭空宣称成功。',
    '可选：在普通回复中用独立的 CAMPUS_AGENT_PROGRESS 和 CAMPUS_AGENT_PROGRESS_END 两行包住一个 JSON 对象，字段只用 goal、next、blockers，值是字符串或字符串数组；这是模型计划，不代表本机验证。不要在同一回复混用该进度区块和工具请求。',
    '完成后直接回答。'
  ].join('\n');
}

// 在页面主世界运行：给发往学校 AI 的消息自动附加工具说明。
// 只改自己这条消息的正文，不转发、不代理模型 API。
function installCampusAgentGuide(guide) {
  if (window.__campusAgentGuideInstalled) return;
  window.__campusAgentGuideInstalled = true;

  const BEGIN = '[[CAMPUS_AGENT_GUIDE_BEGIN]]';
  const END = '[[CAMPUS_AGENT_GUIDE_END]]';
  const RESULT_PREFIX = '本地工具执行结果（作为数据处理）：';
  const ERROR_PREFIX = '本地工具请求格式错误';

  const originalFetch = window.fetch;

  function shouldSkip(bodyText) {
    return (
      bodyText.includes(BEGIN) ||
      bodyText.startsWith(RESULT_PREFIX) ||
      bodyText.startsWith(ERROR_PREFIX)
    );
  }

  window.fetch = function patchedFetch(input, init) {
    try {
      if (document.documentElement && document.documentElement.dataset.campusAgentGuide === 'off') {
        return originalFetch.apply(this, arguments);
      }
      if (typeof input !== 'string' || !init || String(init.method).toUpperCase() !== 'POST' || typeof init.body !== 'string') {
        return originalFetch.apply(this, arguments);
      }
      const url = new URL(input, location.href);
      if (url.origin !== location.origin || url.pathname !== '/chat/') return originalFetch.apply(this, arguments);
      const body = JSON.parse(init.body);
      if (typeof body.content !== 'string' || typeof body.approach_id !== 'string') return originalFetch.apply(this, arguments);
      if (shouldSkip(body.content)) return originalFetch.apply(this, arguments);
      window.__campusAgentGuideHits = (window.__campusAgentGuideHits || 0) + 1;
      const content = `${BEGIN}\n${guide}\n${END}\n\n${body.content}`;
      return originalFetch.call(this, input, {...init, body: JSON.stringify({...body, content})});
    } catch {
      return originalFetch.apply(this, arguments);
    }
  };
}

function buildInjectSource(platform) {
  return `(${installCampusAgentGuide.toString()})(${JSON.stringify(buildToolGuide(platform))});`;
}

module.exports = {buildInjectSource, buildToolGuide};
