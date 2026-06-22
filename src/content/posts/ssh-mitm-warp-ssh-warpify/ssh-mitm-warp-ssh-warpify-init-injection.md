---
author: Robin
pubDatetime: 2026-06-07T22:16:00+08:00
modDatetime: 2026-06-07T22:16:00+08:00
title: 用 SSH MITM 拆解 Warp：它如何给 ssh 会话注入初始化脚本
slug: ssh-mitm-warp-ssh-warpify/init-injection
featured: true
draft: false
tags:
  - SSH
  - Warp
  - 安全分析
  - 终端
ogImage: ./images/ssh-mitm-warp-hero.png
description: 通过授权环境下的 SSH MITM 观测，拆解 Warp SSH Warpify 如何用远程 exec、bash/zsh 启动文件和 OSC 私有序列完成初始化注入。
---

> 说明：本文只讨论授权环境下的调试、审计和协议分析。SSH MITM 会让代理侧看到认证、命令和终端字节流，不应被用于未授权系统。

这篇文章的背景，是 Warp 相关实现开源之前，对它的 `ssh warpify` 特性做的一次黑盒分析。

我为什么做这件事？说"安全审计"有点太正式了。其实很简单：我在用 Warp 连远程服务器，发现它居然能识别我的命令块、提示符和当前目录，而远端根本没有装 Warp agent。我当时就很好奇——它是怎么做到的？SSH 协议里没有这些字段，远端没有 Warp 的进程在跑，这些信息是怎么从服务器传回本地的？

于是搭了一个 SSH MITM 代理来抓包看。这篇文章就是那次"围观"的结果。

所谓 `warpify`，可以理解为 Warp 把一条普通 SSH 会话"Warp 化"的过程：不要求远端预装 agent，却能让本地 Warp 终端识别远端命令块、提示符、目录、shell 状态和命令生命周期。由于当时没有官方源码可直接阅读，本文主要依据 SSH MITM 代理捕获到的协议行为、远端 bootstrap payload 以及当前项目中的代理实现来还原它的技术路径。

Warp 的远程 SSH 体验看起来像普通 `ssh user@host`：用户输入命令，远端返回输出。但从终端能力上看又不像普通 SSH——Warp 能识别命令块，知道当前目录、用户名、主机名、shell 类型，甚至能在嵌套 SSH 会话里继续接管提示符和命令生命周期。

这些能力不是 SSH 协议原生提供的。SSH 只负责加密传输、认证、打开 channel、申请 PTY、启动 shell 或执行一条远程命令。Warp 真正做的是两件事：

![授权环境下，Warp SSH 会话经过中间观测代理再连接远端服务器的题图](./images/ssh-mitm-warp-hero.png)

_图 1：题图里的透明节点代表授权调试环境中的观测代理；它终止一侧 SSH 会话，再向真实服务器建立另一侧 SSH 会话。_

1. 在本地把交互式 `ssh` 包装成一个可控的远程启动过程
2. 在远端 shell 启动阶段注入一段初始化脚本，再通过终端控制序列把结构化事件发回本地 Warp

我这个项目 `ssh-mitm-proxy` 的价值，是把这条链路放在中间观察：伪装成 SSH 服务端接住 Warp 的连接，再用真实凭据连到目标 SSH 服务端。于是能看到 Warp 发出的 `pty-req`、`exec`、`shell` 请求，也能在原始输入输出里捕获 Warp 的初始化 payload 和后续 hook 消息。

## 项目里的 MITM 观测点

项目启动后有两个入口：

- `cmd/server.go` 同时启动 SSH MITM 服务和 HTTP CONNECT 代理。SSH 服务监听 `2022`，HTTP 代理监听 `2080`
- `pkg/proxy/sshserver.go` 的 SSH 入口支持把目标信息塞进 SSH 用户名：用户名是 base64 JSON，格式类似 `{"account":"root","ip":"1.2.3.4","port":"22"}`。代理在认证阶段解析出真实用户名和目标地址

这一步很关键，因为 SSH 握手前拿不到用户名。项目把"目标解析"放进服务端配置的 `BannerCallback` 中：一旦客户端元数据里出现 `conn.User()`，就调用 `parseAccountCallback` 得到 `targetHost` 和 `realUsername`，然后把真实用户名交给后端连接。

认证阶段是典型 MITM 转发：

- 面向 Warp 时，本项目是一个 SSH server，使用自己的 host key
- 面向目标机器时，本项目是一个 SSH client，调用 `ssh.Dial("tcp", targetHost, clientConfig)`
- 密码认证时，`PasswordCallback` 从 Warp 收到密码，通过 channel 交给后端 SSH client
- keyboard-interactive 时，后端服务端的问题被转发给 Warp，Warp 的回答再转回后端

连接建立后，`ConnectionWithParser.Start()` 调用 `ssh.NewServerConn()` 接受 Warp 的 SSH 连接，然后等待后端 `ssh.Client`。日志里能同时记录两段 session id：一段属于 Warp 到 MITM，一段属于 MITM 到真实服务器。MITM 不是简单转发 TCP，而是终止并重建了两条 SSH 会话。

![MITM 代理把客户端侧 SSH 会话和服务端侧 SSH 会话分开观测的示意图](./images/ssh-mitm-dual-session.png)

_图 2：MITM 代理不是原样转发 TCP，而是在两侧分别建立 SSH 会话，因此能看到 session channel、pty、exec、shell 和原始终端字节流。_

真正有意思的部分在 `handleChannel()`。项目只接受 `session` channel，然后为后端创建一个 `ssh.Session`，把三条流接起来：

```go
clientSession.Stdout = &TestWrite{target: serverChannel, log: chanCtx.Logger}
clientSession.Stderr = &TestWrite{target: serverChannel, log: chanCtx.Logger}
clientSession.Stdin = &TestRead{t: serverChannel, log: chanCtx.Logger}
```

`TestRead` 记录 `【input-raw】`——Warp 发往远端的数据；`TestWrite` 记录 `【output-raw】`——远端返回给 Warp 的数据。Warp 的私有消息本质上也是终端字节流，所以会自然出现在这些 raw log 里。

channel 请求处理覆盖了 SSH 交互的几个核心动作：`pty-req` 解析终端类型和尺寸；`env` 记录并尝试转发环境变量；`exec` 解析远程命令字符串；`shell` 启动普通交互式 shell。

项目目前主要是"解析和观测器"，不是一个完整的 Warp 注入器。它不会主动生成 Warp 初始化脚本，但能捕获 Warp 自己注入的脚本。

## Warp 注入从哪里进入 SSH

在捕获样本 `test.sh` 中，文件开头带有少量非文本字节，说明它更像从 SSH/终端原始流里截出来的 payload，而不是一份干净的 shell 文件。真正的 bootstrap 脚本从 `export TERM_PROGRAM='WarpTerminal'` 开始，主体大致是这样的结构：

```sh
export TERM_PROGRAM='WarpTerminal'
hook=$(printf '{"hook":"SSH", ...}' | command -p od -An -v -tx1 | command -p tr -d " \n")
printf '\e]9278;d;%s\a' $hook

case ${SHELL##*/} in
  bash)
    exec -a bash bash --rcfile <(echo '...')
    ;;
  zsh)
    WARP_TMP_DIR=$(command -p mktemp -d warptmp.XXXXXX)
    # 解码十六进制脚本到 $WARP_TMP_DIR/.zshenv
    ZDOTDIR=$WARP_TMP_DIR exec -l zsh -g
    ;;
esac
```

这里有一个容易误解的地方：Warp 不是等普通 shell 完全启动后，再像用户一样敲入一堆初始化命令。它更早介入——对交互式 SSH，Warp 把远端启动命令改造成一段 bootstrap command，通过 SSH `exec` 请求发过去。远端执行这段 command 后，再 `exec` 成真正的 bash 或 zsh。由于最后用的是 `exec`，bootstrap 进程会被目标 shell 替换掉，不会额外留一个父 shell 挂在那里。

## 第一条消息：SSH hook

payload 开头先声明 `export TERM_PROGRAM='WarpTerminal'`，然后构造一个 JSON：

```json
{
  "hook": "SSH",
  "value": {
    "socket_path": "~/.ssh/175380264210224",
    "remote_shell": "bash"
  }
}
```

这段 JSON 不直接明文输出，而是先转成十六进制（`command -p od -An -v -tx1 | command -p tr -d " \n"`），再包装成 OSC 控制序列：

```text
ESC ] 9278 ; d ; <hex-json> BEL
```

也就是样本中的 `printf '\e]9278;d;%s\a' $hook`。

终端显示层不会把这串内容当普通文本渲染。Warp 作为终端应用能识别 `9278;d` 这个私有通道，取出后面的十六进制 JSON，解码成结构化事件。对普通终端或不了解该协议的程序来说，它只是一个 OSC 序列。

这个设计很聪明——SSH 不需要新增扩展，远端也不需要安装 agent。只要远端 shell 能执行 `printf`、`od`、`tr`，Warp 就能把元数据藏在终端输出流里送回本地。我第一次看到这个方案的时候觉得很取巧，但想了一下又觉得确实务实：在 SSH 协议上做扩展是件很重的事情，走终端控制序列虽然不太"正统"，但胜在零依赖、零配置。

## bash 分支：用 --rcfile 注入初始化

如果远端默认 shell 是 bash，样本使用：

```sh
exec -a bash bash --rcfile <(echo '...')
```

`--rcfile` 是关键。bash 启动交互式 shell 时会读取指定 rcfile，Warp 通过进程替换 `<(echo '...')` 临时生成 rcfile 内容，让新 bash 在启动阶段执行初始化代码。

![远端 shell bootstrap 通过 bash 和 zsh 两条路径发送结构化事件的示意图](./images/warp-bootstrap-hooks.png)

_图 3：bash 和 zsh 的注入入口不同，但最终都会把结构化事件编码进终端输出流，交给本地 Warp 解析。_

样本里的 rcfile 做了几件事：

```sh
command -p stty raw
HISTCONTROL=ignorespace
HISTIGNORE=" *"
WARP_SESSION_ID="$(command -p date +%s)$RANDOM"
WARP_HONOR_PS1="0"
```

然后采集远端身份（`hostname`、`whoami`），发送第二条结构化消息 `{"hook": "InitShell", "value": {"session_id": ..., "shell": "bash", "user": "root", "hostname": "server"}}`。同样 hex 编码后通过 `ESC ] 9278 ; d ; ... BEL` 发回 Warp。

几个实现细节：`command -p` 绕过 shell function、alias 和用户 PATH，尽量调用系统基础命令；`HISTCONTROL=ignorespace` 和 `HISTIGNORE=" *"` 避免 Warp 内部命令污染用户历史；`WARP_HONOR_PS1=0` 表示默认由 Warp 接管提示符表现而不是完全信任远端 PS1；`stty raw` 把终端切到 raw 模式，方便 Warp 自己处理输入编辑。

## zsh 分支：用临时 .zshenv 注入初始化

zsh 没有 bash 那样的 `--rcfile` 参数，Warp 换了一个入口：`ZDOTDIR`。

流程是：创建临时目录 `mktemp -d warptmp.XXXXXX`，把一段 hex 脚本解码到 `$WARP_TMP_DIR/.zshenv`，设置 `ZDOTDIR=$WARP_TMP_DIR`，执行 `exec -l zsh -g`。

解码出来的 `.zshenv` 内容和 bash 分支目标一致——在 zsh 启动最早阶段发送 `InitShell`。不同点在于 zsh 的启动文件加载顺序给了一个更稳定的注入点：通过把 `ZDOTDIR` 指向临时目录，让 zsh 读取自己生成的 `.zshenv`，同时用 `WARP_SSH_RCFILES=${ZDOTDIR:-$HOME}` 记住用户原始 rcfile 位置，后续再决定如何加载或模拟用户配置。

我在分析的时候其实有点惊讶——Warp 同时维护了 bash 和 zsh 两条完全不同的注入路径，每条都针对各自的启动机制做了适配。这不是"顺手支持一下"，是认真做的。

## 不支持的 shell 怎么办

如果远端 shell 既不是 bash 也不是 zsh，Warp 走降级路径：

```sh
if test "${SHELL##*/}" != "bash" -a "${SHELL##*/}" != "zsh"; then
  exec $SHELL
fi
```

仍然会尽量保持普通 SSH 可用，但不会强行安装完整的 shell hook。坦白说这个选择很务实——fish、tcsh 或其他 shell 的启动语义不同，强行注入更容易破坏用户环境。

## 后续 hook：命令块能力从这里来

`SSH` 和 `InitShell` 只是 bootstrap。更完整的初始化脚本会继续注入 bash-preexec 或等价 hook，追踪命令生命周期：

- `Precmd`：提示符显示前上报当前目录、PS1、git 分支、虚拟环境等
- `Preexec`：命令真正执行前上报命令文本
- `CommandFinished`：命令结束后上报退出码
- `InputBuffer`：同步当前输入缓冲区
- `Bootstrapped`：初始化完成后上报环境变量名、alias、function、shell 版本等

这些事件的承载方式仍然是终端控制序列里的 JSON。远端 shell hook 负责发送，Warp 本地终端负责解析。SSH 只看到普通 stdout/stderr 字节流。

这也是为什么 MITM 日志会出现看似奇怪的输出：`\x1b]9278;d;7b22686f6f6b223a...07`。`\x1b]` 是 OSC 开始，`9278;d;` 是 Warp 私有消息标识，后面是 hex JSON，`\x07` 是 BEL 结束符。

## 为什么这种注入方式稳定

几个工程上的考虑：

- **不依赖远端安装组件。** 只借助 shell、`printf`、`od`、`tr`、`hostname`、`whoami` 这类基础命令
- **不修改 SSH 协议。** 初始化脚本通过标准 `exec` 请求进入远端，结构化消息通过标准终端控制序列返回本地
- **尽早接管 shell 初始化。** bash 走 `--rcfile`，zsh 走 `ZDOTDIR/.zshenv`，都发生在用户正式交互前
- **尽量减少环境污染。** 使用 `exec` 替换进程，清理临时变量，用历史规则隐藏内部命令
- **跨平台留有分支。** 初始化里设置了 `WARP_USING_WINDOWS_CON_PTY`、`WARP_IN_MSYS2` 等变量，为 Windows 场景留出口

我其实最欣赏的是第一点：零依赖。很多人做类似的东西会想着"在远端装一个 daemon"或者"用 SSH 的 subsystem 机制"，但 Warp 选择了一条轻得多的路。虽然用终端控制序列传 JSON 这件事在"干净"意义上有点难看，但工程上足够有效。而且从安全角度看，这个方案几乎不增加远端攻击面——没有常驻进程和监听端口，但 shell hook 和环境变量会在当前会话内持续工作，直到用户退出。

## 总结

Warp 的 SSH 初始化注入可以概括成一句话：把交互式 SSH 改造成一次携带 bootstrap command 的远程 `exec`，再用 bash/zsh 的启动文件机制接管新 shell，最后通过 OSC 私有序列把 shell 状态以 JSON 形式传回本地终端。

本项目的 SSH MITM 代理正好站在这条路径中间：入口层解析目标，认证层转发凭据，session 层记录 `pty-req/exec/shell/env` 和原始字节流。借助这些观测点，可以把 Warp 的"远程智能终端"拆开看清楚。

它不神秘，也不玄幻。它只是非常熟练地利用了 SSH `exec`、shell rcfile 和终端控制序列这三个老工具。
