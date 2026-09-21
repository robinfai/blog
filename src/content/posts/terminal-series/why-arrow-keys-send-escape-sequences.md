---
author: Robin
pubDatetime: 2026-09-21T08:00:00+08:00
title: 方向键为什么会变成 ESC[A？
featured: false
draft: false
tags:
  - 五彩斑斓的黑
  - Terminal
  - 键盘协议
  - terminfo
  - TUI
description: 《五彩斑斓的黑》第六篇：从方向键的三个字节开始，理解 Terminal 如何编码按键、应用光标模式为何改变输入，以及传统键盘协议为什么存在歧义。
---

> 本文是《五彩斑斓的黑》系列第六篇。上一篇解释了 [Terminal 为什么会有第二块屏幕](/blog/posts/terminal-series/why-terminal-has-an-alternate-screen/)；这一篇转向输入侧，看看按下方向键以后，程序实际读到了什么。

在 Shell 中运行：

```bash
od -An -tx1
```

按一次方向键 ↑，再按 Enter 和 `Ctrl-D`，常见输出是：

```text
1b 5b 41 0a
```

最后的 `0a` 来自 Enter：Terminal 通常先发送 `0d`，常见的 TTY 配置再通过 `ICRNL` 把它转换为 `0a`。前面的三个字节是：

```text
1b    ESC
5b    [
41    A
```

程序没有收到一个名为“ArrowUp”的键盘事件，只读到了字节 `ESC[A`。这是因为 Terminal 与运行在 PTY 另一端的程序之间没有 GUI 键盘事件接口。Terminal 必须先把按键编码成字节，程序再按当前终端类型和模式解释这些字节。

## Terminal 接收按键事件，程序读取字节

桌面系统知道用户按下了哪个物理键，也知道 Shift、Control、Option 等修饰键是否同时按下。Terminal Emulator 位于这类平台输入事件与 PTY 字节流之间：

| 位置                      | 处理的内容                               |
| ------------------------- | ---------------------------------------- |
| 桌面系统与输入法          | 按键事件、修饰键和提交的文本             |
| Terminal Emulator         | 根据输入事件与当前模式生成字节           |
| PTY 与 Line Discipline    | 传输字节，并按 termios 配置处理输入      |
| Shell 或 TUI 的输入解析器 | 把接收的字节解释为文本、编辑操作或快捷键 |

按下普通字母 `a` 时，Terminal 通常写入字符 `a` 的编码；按下中文输入法候选词时，写入的是最终文本的 UTF-8 字节。方向键、Home、F1 等按键不直接产生文本，Terminal 便使用控制序列表示它们。

PTY 不会把 `1b 5b 41` 标注成“方向键”。Line Discipline 也不会为它补上事件边界。程序每次 `read()` 可能读到完整序列，也可能只读到其中一部分，因此输入解析器必须跨多次读取保存状态。

这也意味着，同一串字节不一定来自真实键盘。粘贴、宏、测试程序或远端连接都可以写入完全相同的数据。只观察 PTY 输入，无法证明用户按过哪一个物理键。

## `ESC[A` 沿用了视频终端的控制语言

视频终端出现后，键盘与显示器都属于终端设备。主机通过串口发送控制序列移动屏幕光标；终端也要通过同一条串行连接，把方向键等操作送回主机。

方向键没有可直接显示的 ASCII 字符。为它们分配一组以 `ESC` 开始的序列，可以继续使用原有的 7-bit 数据通道，也不必增加独立的键盘连接。

VT100 系列把普通光标键编码为：

| 按键 | 序列                | 十六进制   |
| ---- | ------------------- | ---------- |
| ↑    | `CSI A`，即 `ESC[A` | `1b 5b 41` |
| ↓    | `CSI B`，即 `ESC[B` | `1b 5b 42` |
| →    | `CSI C`，即 `ESC[C` | `1b 5b 43` |
| ←    | `CSI D`，即 `ESC[D` | `1b 5b 44` |

这里的 `A`、`B`、`C`、`D` 与输出侧的光标移动命令相同。程序输出 `CSI A` 是要求 Terminal 把屏幕光标上移；Terminal 向程序发送 `CSI A` 则报告上方向键。[XTerm 控制序列文档](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)分别列出了这两种用途。

Shell 的行编辑器收到上方向键后，通常选择上一条历史命令，再输出擦除、光标移动和新文本来更新命令行。Vim 收到相同按键则可能移动编辑位置。Terminal 负责编码按键，具体执行什么操作由应用决定。

## 上方向键也可能是 `ESCOA`

`ESC[A` 不是上方向键唯一可能的编码。VT100 提供了 Cursor Key Mode，应用可以发送：

```text
CSI ? 1 h    设置 DECCKM，进入 Application Cursor Keys
CSI ? 1 l    重置 DECCKM，回到 Normal Cursor Keys
```

模式改变后，Terminal 会使用另一组前缀：

| 按键 | Normal mode | Application mode    |
| ---- | ----------- | ------------------- |
| ↑    | `CSI A`     | `SS3 A`，即 `ESCOA` |
| ↓    | `CSI B`     | `SS3 B`，即 `ESCOB` |
| →    | `CSI C`     | `SS3 C`，即 `ESCOC` |
| ←    | `CSI D`     | `SS3 D`，即 `ESCOD` |

`ESCOA` 表示 `1b 4f 41`，中间没有空格，`O` 是大写字母。程序发送到 Terminal 的输出序列，可以改变 Terminal 随后如何编码输入。这里的 Normal/Application 是光标键模式，与上一篇的 Normal/Alternate 屏幕缓冲区是两个独立开关。

全屏程序通常不直接写死这些序列。terminfo 使用 `smkx` 和 `rmkx` 表示进入、退出键盘传输模式，使用 `kcuu1`、`kcud1`、`kcuf1`、`kcub1` 描述四个方向键会发送什么。curses 之类的库根据 `$TERM` 查询这些能力，再配置 Terminal 和输入解析器。

因此，调试方向键问题时只问“它是不是 `ESC[A`”还不够，还要确认：

- 当前 `$TERM` 对应哪份 terminfo；
- 应用是否启用了 application cursor mode；
- Terminal 实际发送的字节是否与 terminfo 声明一致；
- 中间是否存在 tmux 这样的虚拟终端层。

SSH 通常传输这些字节，不把方向键转换成另一种编码。tmux 则会解析外层终端输入，再按 pane 内应用使用的模式生成输入，因此需要分别检查内外两层。

## Control 键复用了 ASCII 控制字符

方向键使用多字节序列，很多 `Ctrl` 组合键却只有一个字节。例如：

| 按键     | 字节 | 同一字节的名称           |
| -------- | ---: | ------------------------ |
| `Ctrl-C` | `03` | ETX                      |
| `Ctrl-H` | `08` | BS，也常被当作 Backspace |
| `Ctrl-I` | `09` | HT，也就是 Tab           |
| `Ctrl-J` | `0a` | LF                       |
| `Ctrl-M` | `0d` | CR，也就是 Enter         |
| `Ctrl-[` | `1b` | ESC                      |

这套映射来自 ASCII 控制区。它节省了编码空间，也留下了无法消除的重合：程序只读到 `09` 时，通常无法判断用户按的是 Tab 还是 `Ctrl-I`；读到 `0d` 时，也无法区分 Enter 与 `Ctrl-M`。

Line Discipline 还可能先处理其中一部分字节。当 `ISIG` 开启且 `VINTR` 配置为 `03` 时，内核会把这个字节识别为中断字符，向前台进程组发送 `SIGINT`。这个行为由 `ISIG` 控制，与负责按行缓冲的 `ICANON` 是两个设置；关闭按行输入并不必然关闭信号处理。常见 Raw Mode 会同时关闭它们，让应用直接处理字节。[termios 文档](https://man7.org/linux/man-pages/man3/termios.3.html)列出了这些开关及其作用。

## ESC 既是按键，也是序列开头

传统编码中，单独按 Escape 会产生一个 `1b`。方向键以 `1b` 开头，很多终端还用 `ESC` 前缀表示 Alt 组合键，例如 Alt-x 常被编码为：

```text
1b 78
```

字节流不携带“这次按键到这里结束”的标记。输入解析器读到 `1b` 时，至少存在三种可能：

- 用户只按了 Escape；
- 它是方向键或功能键序列的开头；
- 它是 Alt 组合键的前缀。

程序通常会短暂等待后续字节：很快读到 `[` 和 `A`，就按上方向键处理；超时仍没有新字节，才把它当作单独的 Escape。Vim、tmux、readline 和各类 TUI 库都提供过与这段等待有关的配置。

超时只能缓解歧义，不能从协议上消除它。等待太短时，SSH 抖动或高负载可能把一个序列拆开，应用误判为多个按键；等待太长时，单独按 Escape 会显得迟钝。

## 修饰键让旧编码空间更拥挤

早期终端需要表达的键较少，现代键盘还要处理 Shift、Alt、Ctrl、Super 的组合，以及不同布局、重复和释放事件。传统协议是在多个时期逐步扩展出来的，不同类别的键采用了不同形式：

```text
CSI 1 ; modifier A       带修饰键的方向键
CSI number ; modifier ~  部分编辑键和功能键
SS3 P                    另一组功能键形式
ESC + text               常见的 Alt 前缀形式
```

很多组合仍然重合，按键释放通常不报告，自动重复也常被当成连续的按下事件。终端应用无法像 GUI 应用那样稳定地获得完整 KeyDown / KeyUp 模型。

xterm 的 `modifyOtherKeys` 为普通按键补充了带参数的转义序列，但它仍要兼容既有序列和历史解析器。现代键盘协议进一步把按键值、修饰键、事件类型和关联文本放进结构化的 CSI 序列。

Kitty keyboard protocol 使用的完整形式是：

```text
CSI key-code:alternate-keys ; modifiers:event-type ; text u
```

应用可以按需启用几项增强能力，包括消除 Escape 编码重合、报告 repeat/release、报告不同布局下的按键值，以及把所有键都编码成序列。默认仍保留传统模式，让旧 Shell 和旧程序继续工作；支持新协议的应用进入 TUI 时主动启用，退出时再恢复之前的模式。

这类协议让接收端可以明确区分按键、文本、修饰键和事件阶段；序列变长只是编码这些信息的结果。

## 输入录制无法自动还原成按键事件

终端录制器保存的 PTY 输入字节，并不一定能还原用户的原始操作。重放还需要考虑采集位置、当时的 TTY 配置、终端模式和时序：master 端写入的字节可能被 Line Discipline 转换、消耗或解释为信号，应用最终读到的内容未必相同。

- `09` 可能来自 Tab，也可能来自 `Ctrl-I`；
- `1b` 可能是 Escape，也可能是未读完整的序列开头；
- 同一串字节可能来自按键、粘贴、宏或程序注入；
- 当前终端模式不同，相同物理按键可能生成不同序列。

需要记录真实键盘行为时，应在 Terminal 把平台事件编码为字节之前采集语义事件，并同时记录当时生效的键盘模式。只接入 PTY 的 Agent 也应把输入看作带状态的终端协议，不能把每次 `read()` 直接等同于一次用户操作。

## 在本机观察按键编码

### 实验一：观察短时间内收到的字节

在 macOS 或 Linux 的交互式终端里运行下面的脚本。它通过 `/dev/tty` 读取当前控制终端，临时进入 Raw Mode，并在读取结束后恢复原来的 TTY 设置。启动后按一次键；没有输入时，十秒后也会退出。

```bash
python3 - <<'PY'
import os
import select
import termios
import time
import tty

with open('/dev/tty', 'rb+', buffering=0) as terminal:
    fd = terminal.fileno()
    old = termios.tcgetattr(fd)
    data = b''
    try:
        tty.setraw(fd)
        if select.select([fd], [], [], 10)[0]:
            data = os.read(fd, 32)
            deadline = time.monotonic() + 0.2
            while len(data) < 256:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
                    break
                chunk = os.read(fd, 32)
                if not chunk:
                    break
                data += chunk
    finally:
        termios.tcsetattr(fd, termios.TCSANOW, old)

print(" ".join(f"{b:02x}" for b in data))
PY
```

运行后按一次方向键。常见结果是 `1b 5b 41`，但当前模式和 Terminal 配置可能让结果不同。脚本在首批字节到达后继续收集 200 毫秒；这个时间窗只为方便观察，既可能收进多个按键，也可能漏掉延迟更久的后续字节，不是按键边界。Raw Mode 下按 `Ctrl-C` 会显示 `03`，由脚本结束并恢复设置。

### 实验二：查看 terminfo 中的方向键能力

```bash
infocmp -1 "$TERM" | grep -E '^[[:space:]]*(kcuu1|kcud1|kcuf1|kcub1|smkx|rmkx)='
tput kcuu1 | od -An -tx1
```

`infocmp` 显示当前终端描述；`tput kcuu1` 输出该描述中上方向键对应的字符串，再由 `od` 显示其十六进制字节。它说明 terminfo 声明了什么，不等于已经验证 Terminal 在当前模式下实际发送了同一结果。

### 实验三：比较 Escape 与 Alt 字符

重复运行实验一，分别按 Escape 和 Alt-x。常见结果是：

```text
Escape    1b
Alt-x     1b 78
```

如果 macOS 的 Option-x 输入了字符，先检查 Terminal 是否把 Option 配置为 Alt/Meta。桌面系统或终端快捷键也可能先拦截组合键。读到第一个 `1b` 时，程序无法立即确定输入是否结束；更换终端或键盘配置后，也不能假设 Alt-x 一定产生上述字节。

> **下一篇：《鼠标点击为什么也会变成控制序列？》**
>
> 下一篇继续沿输入侧展开：应用如何启用鼠标跟踪，Terminal 怎样编码按下、释放、移动和滚轮事件，以及为什么日志、录制和 Agent 容易把这些输入误认成乱码。

## 资料参考

- [XTerm Control Sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)：DECCKM、Normal/Application Cursor Keys、修饰键与 `modifyOtherKeys`。
- [terminfo(5)](https://man7.org/linux/man-pages/man5/terminfo.5.html)：`kcuu1`、`smkx/rmkx` 等键盘能力的定义。
- [Comprehensive keyboard handling in terminals](https://sw.kovidgoyal.net/kitty/keyboard-protocol/)：传统键盘编码的歧义、CSI u 结构与渐进增强模式。
- [VT100 User Guide, Chapter 3](https://vt100.net/docs/vt100-ug/chapter3.html)：VT100 键盘与 Cursor Key Mode 的原始说明。
