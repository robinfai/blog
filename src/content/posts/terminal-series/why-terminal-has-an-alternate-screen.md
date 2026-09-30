---
author: Robin
pubDatetime: 2026-09-12T11:30:00+08:00
modDatetime: 2026-09-30T10:45:00+08:00
title: Terminal 为什么会有第二块屏幕？
featured: false
draft: false
tags:
  - 五彩斑斓的黑
  - Terminal
  - Alternate Screen
  - TUI
  - terminfo
ogImage: ./images/05-alternate-screen-hero.svg
description: 《五彩斑斓的黑》第五篇：从 Vim 退出后恢复 Shell 内容开始，理解 Normal Buffer、Alternate Buffer、1049 模式与 terminfo 如何协同工作。
---

![Vim 使用备用屏幕，退出后 Terminal 恢复原来的 Shell 内容](./images/05-alternate-screen-hero.svg)

_题图：Vim 与 Shell 使用同一个 PTY。变化发生在 Terminal
内部：全屏程序运行时，当前显示的 Buffer 从 Normal 切换为 Alternate。_

Vim 运行时占满窗口，退出后却恢复了之前的命令输出。这些内容保存在哪里？

## Shell 内容保存在 Normal Buffer 中

Terminal Emulator 通常维护两份 Screen Buffer：

- **Normal Buffer**：Shell 平时使用的主缓冲区，通常还连接着 scrollback；
- **Alternate Buffer**：供 Vim、less、top、k9s
  等全屏程序临时使用，通常只有当前窗口大小，不把滚出顶部的内容加入普通
  scrollback。

进入 Alternate Screen 后，普通字符写入、光标移动和擦除作用于 Alternate
Buffer，主屏内容不会被这些操作覆盖。不过，窗口 resize
仍可能影响主缓冲区的尺寸与布局，“保留内容”不代表全部状态冻结。

![Terminal 在 Normal Buffer 和 Alternate Buffer 之间切换活动缓冲区](./images/05-buffer-switch.svg)

_图 1：切换的是 Terminal 当前显示和修改的 Buffer。Shell、Vim 与 Terminal
仍通过原来的 PTY 交换字节。_

[xterm.js 的 Buffer
API](https://xtermjs.org/docs/api/terminal/interfaces/ibuffernamespace/)
直接暴露了 `normal`、`alternate` 和 `active` 三个入口。`active`
只是指向当前使用的那一份，收到切换序列时会发生变化。

常见的 `1049`
进入方式会清空备用缓冲区。应用可以在其中自由重画，不必读取或保存 Shell
屏幕；退出时，备用缓冲区内容也不会自动合并到主屏。

## `ESC[?1049h` 如何切换屏幕

xterm 兼容终端中常见的进入序列是：

```text
ESC [ ? 1049 h
```

退出时把最后的 `h` 换成 `l`：

```text
ESC [ ? 1049 l
```

![DECSET 1049 保存光标、清空备用缓冲区并完成切换](./images/05-decset-1049.svg)

_图 2：`h` 设置模式，`l` 重置模式。`1049` 不只是选择另一份
Buffer，还组合了光标保存与恢复。_

这条 CSI 可以拆成四部分：

```text
ESC [       CSI 的 7-bit 开头
?           DEC Private Mode 参数前缀
1049        xterm 定义的私有模式编号
h / l       最终字节：选择设置 / 重置模式，并结束这条 CSI
```

执行 `CSI ? 1049 h` 时，xterm 保存当前光标状态，清空 Alternate
Buffer，再切换过去；执行 `CSI ? 1049 l` 时，xterm 切回 Normal
Buffer，并恢复此前保存的光标状态。[XTerm Control
Sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)
将它描述为 `1047` 与 `1048` 两项能力的组合。

`?` 使用了 DEC Private Mode 的语法，但 `1049` 这个模式编号来自 xterm
扩展，不是 VT100 原始能力。xterm 为兼容旧应用还保留了几种相关模式：

| 模式   | 设置与重置时的主要行为                                    |
| ------ | --------------------------------------------------------- |
| `47`   | 在 Alternate 与 Normal 之间切换，较早的 xterm 兼容方式    |
| `1047` | 设置时切到 Alternate；重置时清空 Alternate，再返回 Normal |
| `1048` | 设置时保存光标状态，重置时恢复，不切换 Buffer             |
| `1049` | 保存光标并清空、进入 Alternate；返回 Normal 时恢复光标    |

对应的重置操作使用 `l`。其中 `1049`
把全屏程序常用的进入与退出步骤配成了一组，因此现代 xterm 类型的 terminfo
通常优先使用它。不同终端对旧模式和边界行为的兼容程度仍可能不同。

## 应用通常通过 terminfo 进入备用屏幕

应用可以直接写死 `ESC[?1049h`，但这样等于假设当前终端实现了 xterm
的这项扩展。Unix 早已存在另一层适配：termcap 中的 `ti/te`，以及 terminfo
中对应的 `smcup/rmcup`。

- `smcup`：进入终端使用光标寻址所需的模式；
- `rmcup`：退出该模式，本身不保证恢复原来的屏幕内容。

这些名字来自不同年代的硬件能力，不保证它们展开后只包含一条“切换
Buffer”的序列。[terminfo
文档](https://man7.org/linux/man-pages/man5/terminfo.5.html)
提到，有些早期终端拥有多页显示内存，有些终端则需要先固定一个与屏幕等大的窗口，才能正确使用光标寻址。

在今天常见的 `xterm-256color` 描述中，`smcup/rmcup` 往往会展开为 `1049` 的设置与重置。基于 curses/terminfo 的应用查询当前 `$TERM` 对应的能力字符串，再把这些字节发送给 Terminal。

![应用通过 terminfo 把统一能力名转换为当前终端的控制序列](./images/05-terminfo-bridge.svg)

_图 3：基于 terminfo 的常见路径。应用查询 `smcup/rmcup`，数据库按 `$TERM` 返回具体字节，Terminal 收到后执行切换。_

Vim 还会使用内建的终端能力，优先顺序受 `ttybuiltin` 等设置影响，实际字符串也可由用户配置覆盖。排查 Vim 时，除了系统的 terminfo，还要检查它的 `t_ti`、`t_te` 等选项。[Vim 的终端帮助](https://vimhelp.org/term.txt.html#builtin-terms)说明了这些来源之间的关系。

可以在本机查看当前配置：

```text
infocmp -1 "$TERM" | grep -E '^[[:space:]]*(smcup|rmcup)='
tput smcup | od -An -tx1
tput rmcup | od -An -tx1
```

这里把 `tput` 的输出交给
`od`，所以控制序列只会以十六进制显示，不会真的切换当前 Terminal。不同
`$TERM` 得到的结果可能不同；能力也可能不存在。

终端支持备用屏幕，程序也可能没有用上它：`$TERM` 对应错了，或者切换被配置禁用，都可能让程序直接画在主屏。`less -X` 则是主动跳过终端初始化与退出字符串，退出后浏览过的内容可能留在主屏。

## 为什么 Alternate Screen 通常没有普通 scrollback

Normal Buffer 保存 Shell 的连续输出，滚出窗口顶部的行可以进入
scrollback。全屏程序则不断在固定的行列范围内改写内容，屏幕上的上下关系并不等于时间顺序。

例如 Vim
向下滚动文件时，可能只是把若干行移出区域，再在底部写入新的文本；top
每次刷新也会覆盖上一帧。如果把这些中间画面逐行追加到 Normal Buffer 的
scrollback，很快会得到大量重复、错序且脱离界面结构的内容。

xterm
的备用缓冲区与可见区域同样大小，并在该模式下停止把滚出顶部的行保存到普通
scrollback。很多终端沿用了这种行为，也有终端提供自己的配置或查看方式，所以它不是所有实现都必须完全一致的界面规则。

Vim 退出后，主屏里看不到刚才的编辑过程。要保留这一段，得[记录运行期间的输出和窗口变化](/blog/posts/terminal-series/why-terminal-can-update-screen-in-place/#最后一屏留下了什么)；只截退出后的屏幕会漏掉它。

## 嵌套全屏程序会有第三块屏幕吗

在同一个终端实例中，Normal/Alternate
是两种缓冲区，不是按进程分配的屏幕栈。已经处于 Alternate Screen
时，再启动一个全屏程序，不会自动获得第三份缓冲区。内层程序可能清空外层画面，退出时还可能切回主屏；外层程序需要协调暂停、恢复与重画。

通过 SSH 运行时，切换序列使用原来的输出通道传输。tmux 则为每个 pane
维护虚拟终端状态，再生成外层终端的显示更新；内外层的 Buffer
不应看成同一份。进入备用屏幕本身不会额外创建 PTY。

## 退出时要分别恢复哪些状态

全屏程序启动时，往往同时进入 Raw 或 cbreak 模式、切换备用屏幕、隐藏光标，再打开需要的鼠标、粘贴或焦点报告。退出时也要分别恢复：`1049l` 能切回主屏，不能替它把 TTY 输入设置和其他模式一起收拾好。

![TTY 输入模式、Screen Buffer 与终端交互模式是需要分别恢复的状态](./images/05-state-layers.svg)

_图 4：缓冲区切换发生在 Terminal 内部；Raw Mode 属于内核 TTY，光标显示、鼠标和粘贴模式则由各自的控制序列管理。_

少恢复一项，就可能留下对应的故障：

- 仍停在 Alternate Buffer：Shell 内容没有重新显示；
- TTY 仍处于 Raw Mode：按键立即到达程序，输入不回显，`Ctrl-C`
  也可能不再由 Line Discipline 转成 `SIGINT`；
- 光标仍被隐藏：Shell 可以正常输入，但看不到光标；
- 鼠标报告仍开启：点击或滚轮操作变成类似控制序列的字符输入。

应用应在正常返回、错误和可处理的信号路径上执行清理；使用 TUI
库也要遵循它的退出流程。`SIGKILL`
无法被捕获，程序没有机会发送恢复序列。交互式 Shell 可能恢复部分 TTY
设置，但不能指望它撤销应用启用的全部终端模式。

遇到这类问题，可以先尝试：

```text
reset
```

或者针对已知状态执行
`stty sane`、`tput cnorm`、`tput rmcup`。它们分别处理不同层次的问题，不是完全等价的修复命令。

## 在本机观察 Buffer 切换

在普通 Shell 中运行下面的实验，不要在已有全屏 TUI 中嵌套测试。先确认
Terminal 支持并允许备用屏幕：terminfo
能力存在只代表配置声明支持，不是终端执行成功的确认。

### 通过 terminfo 进入和退出

```bash
(
  [ -t 1 ] || exit 1
  tput smcup >/dev/null && tput rmcup >/dev/null || {
    printf '当前 terminfo 缺少进入或退出能力。\n' >&2
    exit 1
  }
  cleanup() { tput rmcup; }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  tput smcup || exit 1
  tput clear || exit 1
  printf 'This is the alternate screen.\n'
  printf 'The normal screen will return in 3 seconds.\n'
  sleep 3
)
```

清理函数先注册，再进入备用屏幕。三秒后子 Shell 退出，`EXIT` trap 调用 `rmcup`，原来的 Shell 内容重新出现。示例处理了 `INT` 和 `TERM`，但未处理的终止信号或 `SIGKILL` 仍可能跳过清理。

### 直接发送 `1049`

```bash
(
  [ -t 1 ] || exit 1
  cleanup() { printf '\033[?1049l'; }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  printf '\033[?1049h'
  printf 'alternate buffer\n'
  sleep 2
)
```

这个实验绕过 terminfo，适合确认当前 xterm 兼容终端如何处理
`1049`。如果环境不支持该模式，序列可能被忽略；日常程序仍应通过 terminfo
或终端库使用能力。

### 比较 less 的初始化行为

```bash
man less | less
man less | less -X
```

在支持并配置了 Alternate Screen 的环境中，第一条命令退出后通常恢复进入前的屏幕；加上 `-X` 后，最后浏览到的内容则可能留在 Normal Buffer 中。

## 资料参考

- [XTerm Control
  Sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)：`47`、`1047`、`1048`
  与 `1049` 的设置和重置行为。
- [XTerm FAQ：alternate
  screen](https://invisible-island.net/xterm/xterm.faq.html#xterm_tite)：`ti/te`、`smcup/rmcup`
  与 xterm Alternate Screen 扩展的历史和兼容关系。
- [terminfo(5)](https://man7.org/linux/man-pages/man5/terminfo.5.html)：`smcup/rmcup`
  的定义，以及多页显示内存和光标寻址模式的历史背景。
- [xterm.js
  `IBufferNamespace`](https://xtermjs.org/docs/api/terminal/interfaces/ibuffernamespace/)：`normal`、`alternate`、`active`
  Buffer 与切换事件。
- [less
  官方手册](https://github.com/gwsw/less/blob/master/less.man)：`-X`
  与终端初始化、退出字符串的定义。
