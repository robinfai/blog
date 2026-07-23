---
author: Robin
pubDatetime: 2026-07-23T09:00:00+08:00
title: Terminal 为什么能显示彩色文字？
featured: false
draft: false
tags:
  - 五彩斑斓的黑
  - Terminal
  - ANSI
  - 控制序列
  - CSI
ogImage: ./images/03-color-byte-stream-hero.svg
description: 《五彩斑斓的黑》第三篇：从 ESC[31m 拆开终端控制序列，理解普通文字和终端命令如何共用一条字节流，以及 CSI、OSC 与 DCS 为什么采用不同的结构。
---

![同一条字节流经过 Terminal Parser 后显示为彩色文字](./images/03-color-byte-stream-hero.svg)

_题图：同一条字节流里既有要显示的文字，也有改变终端状态的控制序列。_

> 本文是《五彩斑斓的黑》系列第三篇。上一篇解释了 [TTY 与 PTY 为什么还存在](/blog/posts/terminal-series/why-tty-still-exists/)；这一篇接着看 PTY Master 读到的字节，Terminal 怎样区分需要显示的文字和需要执行的控制序列。

在终端里运行：

```bash
printf '\033[31mred\033[0m\n'
```

屏幕上会出现红色的 `red`。用十六进制工具查看同一段输出，可以看到：

```text
1b 5b 33 31 6d 72 65 64 1b 5b 30 6d 0a
```

这串数据里没有图片、CSS，也没有单独的“颜色通道”。其中的 `72 65 64` 对应字母 `red`，前后的控制字节用来修改终端状态。PTY 不解释这些字节的颜色语义，Shell 也不负责上色；Terminal Emulator 解析控制序列，再把结果绘制到屏幕上。

## PTY 传来的只有字节

程序把内容写入 stdout。stdout 连接 PTY Slave 时，数据经过内核到达 Master，再被终端模拟器读取。到这里为止，数据仍然只是一串字节。

![程序输出经过 PTY、Terminal Parser、Screen Buffer 和 Renderer 的处理流程](./images/03-output-pipeline.svg)

_图 1：PTY 在程序与终端模拟器之间传输字节；解析器修改终端状态后，Renderer 才会绘制出颜色。_

“命令有颜色”并不等于“命令运行在 PTY 中”。程序通常先用 `isatty()` 判断 stdout 是否连接终端，再决定是否输出颜色序列。PTY 提供终端接口；程序决定是否输出颜色序列，终端决定具体怎样显示。

## 视频终端需要在文字之外控制屏幕

电传打字机把字符打印到纸上，打印过程基本只向前推进。回车、换行、退格和响铃可以分别使用 `CR`、`LF`、`BS`、`BEL` 这样的单字节控制字符表示。

到了视频终端，屏幕内容可以反复改写。主机除了发送文字，还要告诉终端把光标移动到第几行第几列、擦除哪一块区域、是否反色、滚动范围在哪里。操作数量增多以后，无法再为每个动作分配一个单独字节，还要解决参数的表示问题。

终端协议把可变长度的控制指令直接嵌入字符数据。[ECMA-48](https://ecma-international.org/publications-and-standards/standards/ecma-48/) 规定了这类控制功能在字符编码数据中的表示方式。数据仍通过同一条通道传输，接收端读到特定字节后切换解析状态。

![终端控制能力从单字节控制字符演进为 CSI、OSC 与 DCS](./images/03-control-evolution.svg)

_图 2：控制能力从少量单字节动作，扩展成可以携带参数和字符串的序列。_

这是一种带内控制协议：文字和命令走同一条链路。它不需要额外连接，可以和普通文本一起通过串口、PTY、SSH 或日志管道传输；代价是接收端必须持续解析，不能把输出简单地当作普通字符串。

## ESC 改变后续字节的解析方式

`ESC` 的字节值是十六进制 `1B`。解析器在 Ground 状态读到它时，不会将它写入屏幕，而是切换到 Escape 状态，继续读取后续字节，以确定控制序列的类型。

以设置红色前景为例：

```text
ESC  [  31  m
 │   │   │  └─ 执行 SGR
 │   │   └──── 参数：红色前景色
 │   └──────── 进入 CSI
 └──────────── 控制序列开始
```

`ESC [` 是 CSI（Control Sequence Introducer）的常用 7-bit 写法。`31` 是颜色参数，最后的 `m` 是最终字节（final byte），用来选择 SGR（Select Graphic Rendition）操作并结束这条 CSI。只有 `m` 到达后，`31` 才会被按 SGR 参数解释，解析器随后把前景色切换为红色。

![Terminal Parser 从 Ground 进入 Escape 和 CSI 再返回 Ground 的状态转换](./images/03-parser-state.svg)

_图 3：简化后的状态转换。真实解析器还要处理取消、忽略、字符串和错误恢复等分支。_

一次读取不一定能拿到完整的控制序列。PTY 的两次读取可能分别得到 `ESC [` 和 `31m`，SSH 数据包或 WebSocket 消息的边界也可能落在序列中间。Parser 必须跨数据块保存状态。逐块使用正则表达式删除 ANSI 序列，可能漏掉被拆开的部分。

[XTerm Control Sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html) 使用更完整的状态机描述这类边界：解析器根据当前状态把每个字节归为控制、参数、结束或普通字符；序列结束或发生错误后，再回到 Ground 状态。

## 颜色是终端状态，不是字符的一部分

SGR 不会修改后面的字符编码。它更新的是“当前显示属性”：前景色、背景色、粗体、下划线等。解析器随后遇到普通字符时，把字符和当前属性一起写入 Screen Buffer。

![SGR 修改当前显示状态并让后续字符单元继承前景色](./images/03-sgr-state.svg)

_图 4：SGR 先修改当前状态，之后写入的字符单元继承这些显示属性。_

`31` 表示基础调色板中的红色前景，并不对应固定的 RGB 值。深色主题可以把它显示成偏亮的红色，浅色主题也可以使用更深的红色。256 色通常使用 `38;5;n`，True Color 常见写法是 `38;2;r;g;b`，具体色值仍由终端主题和实现决定。

颜色会“串到下一行”，是因为程序输出 `ESC[31m` 后没有再输出 `ESC[0m`。此时终端的当前属性仍然是红色，后续文字也会继续显示为红色。Reset 不会修改已经写入的字符单元，只会把当前显示属性恢复为默认值。

## CSI、OSC 与 DCS 解决不同类型的控制

有些控制操作可以使用“若干数字参数加一个结束字节”，有些则需要携带字符串或设备数据。因此，ECMA-48 和后续终端实现采用了多种控制序列结构。

![CSI、OSC 和 DCS 的结构、用途与常见示例](./images/03-control-families.svg)

_图 5：CSI 适合参数有限的控制操作；OSC 与 DCS 可以继续读取字符串，直到遇到 ST 等终止符。_

### CSI：参数化的屏幕控制

CSI 常用于光标、屏幕区域和终端模式：

- `m` 设置显示属性；
- `H` 移动光标；
- `J` 擦除屏幕；
- `h`、`l` 设置或重置模式。

CSI 携带有限数量的参数，最终字节决定具体操作，适合表示“移动到第几行”或“启用哪个模式”。

### OSC：面向终端宿主的字符串指令

OSC（Operating System Command）通常携带命令编号和一段字符串，用于修改窗口标题、声明超链接或请求剪贴板操作。这些操作不再局限于字符网格，还会影响终端窗口和桌面环境。

OSC 经常以 ST（String Terminator）结束。出于兼容性，很多终端也接受 `BEL`，所以不能只靠固定长度判断一条 OSC 的边界。

### DCS：承载设备控制数据

DCS（Device Control String）可以承载设备状态查询、用户定义键和 Sixel 等图形数据。解析器识别 DCS 的头部后，会继续读取数据，直到收到字符串终止符。

CSI、OSC 和 DCS 不是三个协议版本，也不是由低到高的能力等级。它们解决的是不同的封装问题。

## 标准统一了结构，没有统一所有终端

日常所说的“ANSI 转义码”包含多种来源。ECMA-48 定义了控制功能和编码结构；DEC 终端实现了一组标准能力，也增加了私有模式；xterm、aixterm 和现代终端模拟器又加入了颜色、鼠标、超链接、图片和宿主集成。

VT100 推动了 ANSI 兼容序列的普及，但它不是今天这套 256 色或 True Color 能力的完整来源。VT100 主要使用单色屏幕，SGR 可以改变反色、强调等显示属性；后来的终端和扩展补充了更多颜色能力。[VT100 Programmer Information](https://vt100.net/docs/vt100-ug/chapter3.html) 同时列出了 ANSI 模式与 DEC Private Mode。

ECMA-48 本身也明确允许设备只实现适合自己的子集。因此，“语法正确”不等于“当前终端支持”。应用可以通过 `$TERM` 和 terminfo 查询能力，也可以针对明确的终端协议协商扩展。如果把所有序列直接硬编码成固定表，仍然会遇到兼容性问题。

> **一个实用判断**
>
> PTY 解决“程序是否面对终端”，控制序列解决“程序怎样要求终端改变状态”，`$TERM` 与 terminfo 解决“这个终端声称支持哪些能力”。三者不要混在一起。

## 控制序列也需要安全边界

Terminal 接收的是一套会改变显示和宿主状态的协议，不是纯文本。可信程序用它绘制 TUI；未经处理的文件、日志和远端输出同样可以携带控制序列。

这些序列可以清屏或修改标题，也可能涉及超链接、剪贴板和终端特有扩展。终端实现通常会限制敏感能力，日志系统和 Web Terminal 也需要明确哪些序列允许执行、哪些只记录、哪些必须过滤。

对 Terminal Agent 来说，只保存最终屏幕上的文字还不够。控制序列可能覆盖旧内容、移动光标，或者让显示结果与原始输出不同。需要审计时，应根据用途分别保留原始字节流、解析后的事件和最终屏幕状态，三者不能相互替代。

## 在本机看见这些字节

### 实验一：比较渲染结果和原始内容

```bash
printf '\033[31mred\033[0m\n' > /tmp/color.txt
od -An -tx1 /tmp/color.txt
cat -v /tmp/color.txt
cat /tmp/color.txt
```

`od` 显示十六进制字节，`cat -v` 尝试把不可见控制字符表示出来，最后一条命令让当前终端解析同一个文件。文件没有“红色格式”，其中保存的仍是控制序列和普通字符。

### 实验二：观察没有 Reset 的结果

```bash
printf '\033[31mred'
printf ' still red?\n'
printf '\033[0m'
```

第二次 `printf` 没有设置颜色，却会继续显示为红色，因为终端的当前属性还没有恢复。第三条命令再执行 Reset。

### 实验三：把序列拆成两次写入

```bash
printf '\033['
printf '31mred\033[0m\n'
```

两次写入仍能组成一条完整 CSI。解析器保存的是协议状态，不要求控制序列与某一次系统调用、PTY 读取或网络消息对齐。

## 颜色只是终端协议最容易看到的一部分

程序输出 `ESC[31m`，PTY 原样传输，Terminal Parser 把它识别为 CSI SGR，并修改当前显示属性。接下来的字符进入 Screen Buffer 时继承这项属性，Renderer 按当前主题把它绘制成红色。

同一套机制还能移动光标、擦除区域、切换模式、设置标题和承载图形。颜色只是最简单的例子。这套协议支持增量解析和扩展，同时兼容历史实现，使 Terminal 可以在一条字节流上构建完整的交互界面。

> **下一篇：《Terminal 为什么可以原地更新屏幕？》**
>
> 下一篇继续介绍 CSI、光标移动、擦除区域与滚动范围，以及 TUI 如何维护一块持续变化的字符屏幕。

## 资料参考

- [ECMA-48：Control Functions for Coded Character Sets](https://ecma-international.org/publications-and-standards/standards/ecma-48/)：控制功能、7-bit/8-bit 表示与开放式结构。
- [Digital VT100 User Guide：Programmer Information](https://vt100.net/docs/vt100-ug/chapter3.html)：VT100 的 ANSI 模式、光标、屏幕和私有模式。
- [VT510 Programmer Information：SGR](https://vt100.net/docs/vt510-rm/SGR.html)：显示属性及参数定义。
- [XTerm Control Sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)：现代 xterm 支持的 CSI、OSC、DCS 与扩展行为。
- [xterm.js](https://github.com/xtermjs/xterm.js)：浏览器终端中 PTY、解析、屏幕状态与渲染的工程实现入口。
