---
author: Robin
pubDatetime: 2026-06-07T23:28:00+08:00
modDatetime: 2026-06-07T23:28:00+08:00
title: SSH HostKey 校验为什么重要：一次 Docker MITM 实验
slug: ssh-hostkey-check/docker-mitm
featured: true
draft: false
tags:
  - SSH
  - 安全分析
  - 工程实践
ogImage: ./images/ssh-hostkey-check-hero.png
description: 通过一个 Docker MITM 实验，说明 SSH hostkey 校验保护的不是连接有没有加密，而是你连接的是不是原来的那台服务器。
---

> 说明：本文只讨论授权环境下的安全实验和防护验证。实验里的 MITM 代理、路由改写和密码转发都只应在自己的测试环境中使用。

SSH 很容易给人一种直觉：只要连接是加密的，就安全了。

这个直觉只对了一半。SSH 的确会加密传输，但它还要先回答另一个问题：我现在加密通信的对象，真的是我要连的那台服务器吗？

这个问题靠 hostkey 校验来守住。hostkey 是 SSH 服务端的长期身份标识。客户端第一次连接服务器时，会看到服务端公钥指纹；确认后，这个公钥会写入 `known_hosts`。以后再连接同一个主机名或 IP，客户端会拿服务端这次给出的 hostkey 和本地记录对一下。

如果对不上，OpenSSH 会给出那条很多人都见过的警告：

```text
WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!
```

这不是一条可以随手跳过的提示。它真正想说的是：你现在连到的，可能不是原来的那台服务器。

![SSH 客户端先用 known_hosts 校验服务端身份，再建立安全连接的示意图](./images/ssh-hostkey-check-hero.png)

*图 1：hostkey 校验做的是身份确认。只有服务端给出的公钥和 `known_hosts` 里的记录一致，客户端才应该继续认证和登录。*

为了把这件事讲清楚，我做了一个很小的 Docker 实验。实验不追求复杂攻击，而是故意把路径改写出来，看 hostkey 校验到底挡住了哪一步。

## 1. 实验先搭一个看得见的现场

实验目录是 `lab/hostkey-demo`。里面有 4 个容器：

- A 是 SSH 客户端，它只知道目标是 `lab@10.88.0.20`。
- B 是真实 SSH 服务端，用户是 `lab`，密码是 `labpass`。
- C 是软路由，它用 iptables 把 A 发往 B:22 的 TCP 流量改到本机端口 `10022`，再用 GOST 转发到 D。
- D 是当前项目里的 SSH MITM 服务。它先伪装成 SSH 服务端接住 A，再作为 SSH 客户端连接真实的 B。

实验里 A 不使用容器服务名访问 B，而是像真实用户一样执行：

```sh
ssh lab@10.88.0.20
```

从 A 的视角看，目标一直是 `10.88.0.20:22`。但 C 已经把真实路径改成了：

```text
A -> C -> D -> B
```

![Docker 实验里 A 以为直连 B，但实际路径经过 C 和 D 的拓扑图](./images/docker-mitm-topology.png)

*图 2：虚线代表 A 以为自己在直连 B；亮色路径代表实验中被 C 改写后的真实流量路径：A 先到 C，再到 D，最后才到 B。*

GOST 在这里只做一件事：把 C 上的本地端口转发到 D。命令是：

```sh
gost -L tcp://:10022/mitm:2022
```

C 上的 iptables 规则则负责把原本去 B:22 的连接重定向到本机 `10022`：

```sh
iptables -t nat -A PREROUTING \
  -p tcp -d 10.88.0.20 --dport 22 \
  -j REDIRECT --to-ports 10022
```

这样一来，A 没有改命令，也没有改目标地址，但连接路径已经被放到了 D 面前。

## 2. 先让客户端认识真正的服务器

在项目根目录执行：

```sh
cd lab/hostkey-demo
./scripts/run-demo.sh
```

脚本会先生成两套测试 hostkey：

- `server_ed25519_key`：B 的真实 hostkey。
- `mitm_ed25519_key`：D 的伪造服务端 hostkey。

同时，脚本会把 B 的公钥写入 A 使用的 `known_hosts`：

```text
10.88.0.20 ssh-ed25519 ...
```

这一步很关键。它表示 A 已经“认识”真实的 B。之后只要有人拿另一个 hostkey 来冒充 `10.88.0.20`，A 就应该拦下来。

## 3. 开启校验时，攻击卡在密码之前

第一轮连接开启严格 hostkey 校验：

```sh
sshpass -p labpass ssh \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/lab-keys/known_hosts \
  lab@10.88.0.20 'hostname; whoami'
```

从网络路径看，这个连接已经被 C 导向 D。也就是说，A 实际收到的不是 B 的 hostkey，而是 D 的 hostkey。

这时 OpenSSH 不会继续问密码，也不会把密码交给 D。它会在认证前终止连接，因为 `known_hosts` 里记录的是 B 的身份，而眼前这个“服务端”拿不出同一把 hostkey。

这就是 hostkey 校验真正守住的地方：攻击者即使能改路由、能接住 TCP 连接、能提供一个可工作的 SSH 服务，也还要先证明“我是原来的那台服务器”。证明不了，连接就应该停在认证之前。

这里容易被忽略的一点是：阻断发生得很早。密码还没有送出去，命令也没有执行，MITM 代理还没有机会进入真正的登录流程。

## 4. 关闭校验时，一切看起来都很正常

第二轮连接故意关闭校验：

```sh
sshpass -p labpass ssh \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  lab@10.88.0.20 'hostname; whoami'
```

这次 A 不再关心服务端 hostkey 是否可信。D 拿出自己的伪造 hostkey，A 接受了，然后继续发送密码。

D 拿到密码后，再去连接真实的 B，把命令转过去，把输出转回来。最终用户看到的结果仍然像一次普通 SSH：

```text
server
lab
```

这也是这个实验最值得警惕的地方：成功输出不等于安全。命令确实执行了，SSH 连接也确实加密了，但加密对象已经变成了两段：

1. A 和 D 加密；
2. D 和 B 再加密。

中间的 D 不需要破解 SSH。它只需要让客户端相信自己就是目标服务器，然后把两边都接起来。

## 5. 这件事对脚本尤其重要

人在终端里看到 hostkey changed 警告时，至少还有机会停下来判断。脚本更危险，因为很多脚本为了“不要卡住”，会直接写：

```sh
-o StrictHostKeyChecking=no
```

或者更进一步，把 known_hosts 丢掉：

```sh
-o UserKnownHostsFile=/dev/null
```

这两个选项一起出现时，基本等于告诉 SSH：不用确认服务端是谁，只要能连上就继续。

在 CI、部署脚本、运维批处理和跳板机链路里，这种写法很常见。它省掉了第一次连接时的交互确认，但也顺手拿掉了 SSH 抵抗 MITM 的第一道门。

更稳妥的做法是预置可信 `known_hosts`。也就是说，自动化环境可以不弹交互确认，但不能跳过身份校验。应该提前通过可信渠道拿到目标服务器 hostkey，把它写进运行环境，再让 SSH 按记录校验。

## 6. 真要遇到警告，先别急着删 known_hosts

hostkey 变化不一定代表攻击。服务器重装、换机、轮换 hostkey、IP 被重新分配，都可能让指纹变化。

但这也正是它值得停下来的原因。遇到：

```text
WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!
```

不要第一反应就是删掉 `known_hosts` 里的旧记录。更好的处理顺序是：

1. 先确认这台机器最近是否重装、换机或轮换 hostkey；
2. 通过云控制台、资产系统、带外管理通道或负责人确认新指纹；
3. 确认无误后，再更新本地或自动化环境里的 `known_hosts`；
4. 如果链路中间有跳板机、代理、软路由或透明代理，更要谨慎确认。

这不是形式主义。hostkey changed 警告保护的是“我连接的是不是那台服务器”，不是“连接有没有加密”。

## 7. 结论

回到这个 Docker 实验，结果其实很直接：

- 开启 hostkey 校验时，MITM 被挡在密码认证前。
- 关闭 hostkey 校验时，命令执行成功，但中间代理已经能观察和转发会话。

所以不要把 `StrictHostKeyChecking=no` 当成一个无害的便利选项，也不要长期把 `UserKnownHostsFile=/dev/null` 写进脚本。

SSH 的加密只能保证你和“对面那一端”的通信不被旁路读取。hostkey 校验负责确认“对面那一端”到底是谁。少了这一步，加密还在，但信任对象已经可能变了。

SSH hostkey 校验不是多余的麻烦。它是 SSH 抵抗中间人攻击的第一道门。
