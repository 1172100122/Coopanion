# 匿名使用统计

从 v0.1.10 起，Coopanion 会向项目自己的服务器 `https://survey.palailab.org` 发送匿名使用统计，用来了解有多少人在用、用得多久、哪些功能有人用。本页列出发送的全部字段。客户端代码在 [`core/telemetry.ts`](../core/telemetry.ts)，服务端代码在 [`telemetry-server/`](../telemetry-server/)。

**关掉**：设置窗口「习惯」页最下面，取消勾选「匿名使用统计」。关掉时会发最后一条 `telemetry_disabled`，没发出去的记录随即清空，之后不再计数也不再发送。重新勾上后沿用原来的安装编号。

## 不发送的内容

- 你说的话、打的字、Coo 的回答、屏幕截图、记忆和提示词的内容；
- API Key、文件名、路径；
- 自定义模型端点的地址和模型名（只报 `custom`），以及从本地路径或网址装的扩展的包名（只报 `private`）；
- 你的名字、账号，或任何能认出你这台电脑的硬件编号。

服务器不保存 IP 地址。IP 只在内存里用于限流。

## 安装编号

第一次启动时随机生成一个 UUID，存在数据文件夹的 `home/companion/telemetry.json` 里，和账号、硬件都没有关联。删掉这个文件，下次启动会换一个新编号。统计开着的时候，同目录下还有一个 `telemetry-id`，里面只有这个编号，Windows 卸载程序读它来报告卸载（见下文 `uninstalled`）。

## 每次发送都带的字段

| 字段 | 例子 | 说明 |
|---|---|---|
| `installId` | `945c528f-…` | 安装编号 |
| `version` | `0.1.10` | Coopanion 版本 |
| `os` / `osRelease` / `arch` | `win32` / `10.0.26200` / `x64` | 系统和架构 |
| `locale` / `timeZone` | `zh-CN` / `Asia/Shanghai` | 系统语言和时区 |
| `firstDate` | `2026-09-30` | 第一次启动的日期 |
| `sentAt` | ISO 时间 | 发送时间 |

## 每日记录（`days`）

每个本地日期一条，记录当天的计数和当时的设置。应用开着时每 30 分钟发一次，服务器只留同一天的最新一条。

| 字段 | 说明 |
|---|---|
| `date` | 本地日期 |
| `runningMinutes` | 当天应用开着的分钟数 |
| `interactedMinutes` | 当天你和 Coo 有过互动的分钟数（打字、说话、摸它、回答它的提问） |
| `sessions` | 当天启动次数 |
| `messagesText` / `messagesVoice` | 打字和语音说给 Coo 的条数 |
| `touches` / `answers` | 点、摸、拎 Coo 的次数；回答 Coo 提问的次数 |
| `petReplies` | Coo 在气泡里说话的次数 |
| `cuaActions` | Coo 操作电脑的动作数（截屏、点击、打字等） |
| `cuaAsked` / `cuaGranted` | 电脑操作前问你的次数和你同意的次数 |
| `providerErrors` | 模型调用失败次数 |
| `models` | 按模型分的调用次数、失败次数、输入/输出/缓存命中 token 数；每项带 `vendor`（内置服务的 id，或 `kind:<模块>`）、`model`（内置服务的模型名，其他为 `custom`）、`endpointKind`（`builtin` / `custom-remote` / `custom-local`） |
| `vendor` / `model` / `endpointKind` | 当前使用的模型服务，规则同上 |
| `language` | 界面语言 |
| `autostart` | 是否开机自动启动 |
| `figure` / `scheme` / `roam` | 形象（Coo 或大肥鱼）、配色、走动程度 |
| `voiceInput` | 语音输入是否打开 |
| `cuaEnabled` / `cuaLevel` | 电脑操作是否启用、询问档位 |
| `personaChanged` | Coo 的人设（CONSTITUTION.md）是否和初始版本不同，只报是或否 |
| `memoryFiles` | Coo 工作区（记忆）里的文件个数 |
| `chatDays` | 安装以来和 Coo 说过话的天数 |
| `extensions` | 装了的扩展：包名（本地或网址安装的报 `private`）、版本、类别 |
| `ramGB` / `cpuCores` | 内存大小（取整到 GB）和 CPU 核数 |

## 一次性事件（`events`）

先存在本地，发出去之后删掉。没网的时候不会丢。

| 事件 | 附带字段 | 什么时候发 |
|---|---|---|
| `first_launch` | | 第一次启动 |
| `guide_step` | `step` | 启动引导走到第几步（1–5） |
| `source` | `answer` | 引导里「你是从哪里认识我的？」的回答：`bilibili` / `xiaohongshu` / `douyin` / `github` / `friend` / `other` / `skip` |
| `guide_finished` | | 引导走完 |
| `guide_closed` | `step` | 引导在第几步被关掉 |
| `extension_installed` / `extension_removed` | `name`、`version`、`kind` | 启动时发现扩展比上次多了或少了 |
| `crash` | `where`、`error` | Core 进程未捕获的异常，只有错误类名（如 `TypeError`） |
| `telemetry_disabled` / `telemetry_enabled` | | 关掉或重新打开统计 |
| `uninstalled` | | Windows 上卸载（升级时不算）；由卸载程序发出，统计关着时不发 |
