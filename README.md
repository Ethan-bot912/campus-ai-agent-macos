# 校园 AI Agent 桌面原型

这是校园 AI 本地助手的实验性桌面端：在 Electron 窗口中打开学校 AI 原网页，由用户自行登录和对话。本机工具负责目录、文本文件和经授权的操作；学校网页与学校服务直接通信，没有模型转发服务。该项目是个人原型，非学校官方产品。

## 运行

### macOS

安装 [Node.js](https://nodejs.org/) 22.12.0 或更新版本，并在系统终端用 `git --version` 确认 Git 可用。然后在想保存项目的目录运行：

```sh
git clone https://github.com/Ethan-bot912/campus-ai-agent-desktop.git
cd campus-ai-agent-desktop
npm ci
node node_modules/electron/install.js
npm start
```

首次安装 Electron 会下载对应架构的运行程序。命令工具使用系统自带的 `/bin/zsh`，打开终端会用系统自带的 Terminal 打开工作目录。macOS 可能对桌面、文稿等目录单独要求访问权限。

安装完成后，可以在访达里双击 `启动校园 AI.command` 打开桌面端。

### Windows

需要 Git 和 Node.js 22.12.0 或更新版本。第一次运行请按以下步骤操作：

1. 从 [Node.js 官网](https://nodejs.org/)安装符合版本要求的 LTS 版，从 [Git 官网](https://git-scm.com/downloads/win)安装 Git。安装完成后关闭并重新打开 PowerShell。
2. 检查工具是否可用：

```powershell
git --version
node --version
npm --version
```

三条命令都应显示版本号，且 Node.js 版本不低于 22.12.0。如果提示找不到命令，确认软件已安装并重新打开 PowerShell；仍不行时检查安装目录是否已加入系统 PATH。

3. 选择保存项目的位置，下载并进入项目。例如，以下命令会把项目放到当前用户的“文档”目录：

```powershell
cd ([Environment]::GetFolderPath('MyDocuments'))
git clone https://github.com/Ethan-bot912/campus-ai-agent-desktop.git
cd campus-ai-agent-desktop
```

`cd campus-ai-agent-desktop` 只能在包含该文件夹的目录中使用。如果已经下载或解压过项目，可以在文件资源管理器中打开项目文件夹，在地址栏输入 `powershell` 并回车，直接在该目录打开 PowerShell。确认目录中有 `package.json` 后再继续。

4. 在项目目录中安装依赖并启动：

```powershell
npm ci
node node_modules/electron/install.js
npm start
```

每条命令成功结束后再执行下一条。首次安装 Electron 时会下载桌面运行程序；网络较慢时请等待下载完成。

如果 `cd` 提示找不到路径，请先检查项目是否下载成功、当前目录是否包含项目文件夹；如果提示找不到 `node` 或 `npm`，先完成上面的 Node.js 安装和版本检查。如果 PowerShell 提示禁止运行 `npm.ps1`，可以在上述命令中将 `npm` 换成 `npm.cmd`。

### 使用

在打开的网页内自行登录，然后直接发送任务。默认可以读取当前用户可读的目录和文本，读取结果会发给学校 AI。写入、删除、移动、运行命令和打开终端需要确认；系统 shell 以当前用户权限运行，工作空间不是命令沙箱。

面板会展示任务状态、本机工具步骤、模型报告和文件成果。模型声称完成不代表本机已验证；发送或执行状态未知时请检查实际情况，程序不会自动重跑。
按住面板顶部左侧的六点把手，可以在窗口内拖动面板。把手获得焦点后也可以用方向键移动。

## 测试

```sh
npm test
```

自动测试主要使用临时文件和模拟学校网页、模型，不能代替真实网页或模型能力验收；部分测试会运行固定的无害 zsh 或 PowerShell 命令。

## 当前限制

- 在隔离网页诊断中，同一 URL 内切换对话可能让旧任务处理新对话请求；缺少生成中标识时可能提前处理尚未完成的回复。这些诊断尚未证明学校网页一定出现相同情况，相关两项测试标记为跳过。
- 真实学校网页此前做过一次多轮只读测试，但该测试早于新版任务面板接入。新版面板的真实网页授权写入、命令和异常恢复仍需要单独验收。
- 结果回填会把文件内容或命令输出发送给学校 AI。本地浏览器登录数据、任务记录和执行账本保存在 `user-data/` 与 `state/`，其中可能包含敏感数据；不要提交这些目录。
- 这还是开发原型，没有提供桌面安装包或自动更新，也没有长期记忆功能。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。
