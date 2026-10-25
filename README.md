# dsh-memraw

> **给 AI 一个不会遗忘的大脑：原文全量、坐标可溯、按需取回。**

[![npm](https://img.shields.io/npm/v/dsh-memraw?color=3b82f6)](https://www.npmjs.com/package/dsh-memraw)
[![license](https://img.shields.io/npm/l/dsh-memraw?color=22c55e)](./LICENSE)
[![node](https://img.shields.io/node/v/dsh-memraw?color=84cc16)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/DSH-0.2.1--rc.2-8b5cf6)](https://github.com/ThreeHHHNOW/dsh-memraw)

`dsh-memraw` 是给 [DeepSeek Harness](https://github.com/ThreeHHHNOW/dsh-memraw) 用的**原文全量记忆引擎**。
它把每一轮对话**一字不改**地写进本地 SQLite，用坐标索引让 AI 随时回读原话——不是"它记得大概"，而是"它能翻到那一句"。

---

## 为什么需要它（Why）

主流记忆方案走的是「压缩 → 摘要 → 遗忘曲线」：把长对话揉成几百字，然后丢掉原文。
代价很直接：

| 粗暴压缩 | dsh-memraw |
|---|---|
| 细节被摘要吃掉，答"具体是哪天、哪句话"就只能编 | 原文全量落盘，`session#seq` 精确回读 |
| 摘要与事实都是黑盒，错了无法验证 | 摘要/切片/索引全是派生数据，可由原文重建 |
| 靠"降权/淡忘"控制体积，旧事会真消失 | 只冷归档，**永不遗忘**，只按需取回 |
| 每轮把记忆硬塞进上下文，token 随轮次膨胀 | **不注入**，需要时用工具检索，上下文零增长 |

一句话：**别的方案在替 AI 做减法，这个插件替 AI 保存底稿。**

---

## 安装

**要求**：DSH 桌面端（Electron 内置 Node ≥ 22.5，提供 `node:sqlite`）。无任何 npm 运行时依赖。
**已验证**：Windows 11 + DSH 0.2.1-rc.2。

```powershell
dsh plugin add dsh-memraw
```

装完确认：

```text
mem_status()        → { errors: 0, sessions: N, events: M, ... }
Tool.listTools      → 应看到 11 个 mem_* 工具
```

数据目录：`%USERPROFILE%\.dsh\memraw\raw.db`（Windows）／`$DSH_HOME/memraw/raw.db`（通用）。

> **升级 / 卸载**：`dsh plugin add` 指定版本即可；数据目录独立于代码，重装不丢记忆。
> **本地开发**：`plugin_manager set_plugin` 对 `include:memraw` 先 `false` 再 `true` 可热重载 link 安装的代码。

---

## 核心特性（Features）

### 1. 全量原文底座 + 坐标溯源

每个 `session/event` 原样写入 `raw_event`（只 INSERT，永不 UPDATE/DELETE）。
每条切片、摘要都携带 `[start_seq, end_seq]`，指回原始事件：

```text
s=c69568d4#267-267   →   会话 c69568d4，第 267 条事件
```

`mem_read` 按坐标取回原文，引用历史时可以带上"哪场会话、哪一刻、第几条"，不靠印象。

### 2. 动态上下文组装

不做"每轮全量注入"，而是分层、按事件触发：

| 层 | 内容 | 时机 |
|---|---|---|
| 常驻 | 检索指引 + 热记忆（我是谁/用户是谁/准则） | 每个会话，内容稳定，命中缓存 |
| 首轮 | 本工作区近期摘要，或"新工作区"提示 | 新会话第一轮，仅 1 次 |
| 缺口 | 被压缩区间的原文 | `/compact` 后，仅 1 次 |
| 按需 | 检索到的原文片段 | 调用 `mem_search` 时 |

### 3. 跨工作区检索，隔离与全局自由切换

- 默认**全局检索**：换了工作区也能问"上个月那个项目"；
- `scope: "workspace"`：只看当前工作区，避免聊天区搜到代码、代码区搜到闲聊；
- `workspace: "<路径>"`：指定某个工作区。

每条结果带 `workspace` 标签与来源时间，跨区也不会混淆。

### 4. 超大事件截断 + 指针读取

单条事件超过 100KB 时只保存**头 4000 字 + 原文指针**，不把垃圾塞进上下文；
需要全文时 `mem_read(session, seq, offset, length)` 会回到会话日志**分页拼回**，逐段读完。

### 5. 压缩摘要，坐标绑定

`/compact` 发生时后台异步生成摘要（本地抽取，不调模型），标题带工作区标签：

```text
【压缩摘要｜默认工作区】s=c69568d4#2400-2420（12 条消息）
诉求：…
结果：…
工具：edit×3、read×2
```

异步、幂等、失败静默降级——**绝不阻塞或影响合并动作本身**。

### 6. 条件触发的安全约束

隐私、外链、危险操作、只读、转发、保密 6 条内置规则，只在命中用户输入时注入一句极短约束，每个会话每条只注入一次。约束不塞进常驻人格。

### 7. 一键备份 / 恢复

`mem_export` 生成一致性快照（`VACUUM INTO` + `integrity_check` + sha256 + 原子改名），`mem_import` 校验后**合并式**导入，绝不覆盖本地数据。

---

## Token 开销（重要）

本插件的设计目标之一是**不吞 token**。它不做逐轮注入，所以上下文不会随对话变长而膨胀：

| 场景 | 频率 | 量级 |
|---|---|---|
| 常驻检索指引 | 每会话常驻 | ≈ 450 字符（约 300 token），稳定命中缓存 |
| 热记忆 | 仅你主动写入 | 几十 ~ 几百字 |
| 新会话引导 | 每会话 1 次 | ≤ 150 字 |
| 压缩缺口补全 | 每次压缩 1 次 | ≤ 4000 字符（`gapChars` 可配） |
| 压缩摘要 | 压缩时后台 | **0**（本地抽取，不调模型） |
| 检索结果 | 仅调用工具时 | 默认 top 8，每条截断 900 字 |
| 每轮注入 | **无** | 0 |

对比：若每轮硬塞 3000 token 记忆，100 轮就是 **30 万 token** 的冗余；本插件常态只多出一次性引导和按需检索，**聊多久都不会自己涨**。

---

## 工具（11 个）

| 工具 | 类别 | 作用 |
|---|---|---|
| `mem_search` | 核心 | 检索原文；默认全局，`scope:"workspace"` 限本区，`workspace` 指定区；返回带坐标、工作区、时间的片段 |
| `mem_read` | 核心 | 按坐标回读事件；`offset`/`length` 分页；超大事件从会话日志现读拼回 |
| `mem_status` | 核心 | 库状态：路径、会话/事件/切片数、错误、最近补全与摘要 |
| `mem_list_sessions` | 核心 | 最近会话列表、覆盖水位、缺口起点 |
| `mem_note` | 核心 | 把一条事实/结论落盘（可带原文坐标） |
| `mem_hot` | 核心 | 写/改常驻热记忆（soul / user / rules / criteria） |
| `mem_export` | 核心 | 一键备份（快照 + manifest + sha256） |
| `mem_import` | 管理 | 合并式导入备份，校验校验和，不覆盖本地 |
| `mem_digest` | 管理 | 为任意区间生成/列出带坐标摘要 |
| `mem_synonym` | 管理 | 查看/扩充近义词词典 |
| `mem_policy` | 管理 | 查看/扩充条件触发的安全约束 |

---

## 配置

写在 DSH 的 `cordis.patch.yml` 中 `memraw` 条目的 `config` 下：

| key | 默认 | 说明 |
|---|---|---|
| `dir` | `$DSH_HOME/memraw` | 数据目录 |
| `oversizeBytes` | `102400` | 单事件超过它只留头 + 指针（按字节） |
| `chunkChars` / `chunkCharsMax` | `1600` / `3000` | 切片目标/上限 |
| `backfill` | `true` | 激活时补齐历史会话（按行数判断，允许乱序） |
| `guide` | `true` | 是否挂常驻检索指引 |
| `gapRefill` / `gapChars` | `true` / `4000` | 压缩后补原文、单次补多少字 |
| `autoDigest` | `true` | 压缩时后台生成带坐标摘要 |
| `bootstrap` | `true` | 新会话首轮注入「近期上下文 / 新工作区」提示 |
| `workspaceLabels` | `{}` | 工作区目录 → 标签覆盖（默认用宿主标题/目录名） |

> 没有 token 预算配置：因为不做每轮注入，不需要给记忆块分配比例。

---

## 数据与架构

```text
$DSH_HOME/memraw/
  raw.db                 # 原文 + 切片 + FTS + 摘要 + 热记忆 + 规则
  backup/<timestamp>/    # raw.db + manifest.json（含 sha256）
```

| 表 | 作用 |
|---|---|
| `raw_event` | 原文底座，只追加 |
| `session_meta` | 会话元信息、采集水位、压缩缺口 |
| `chunk` + `chunk_fts` | 按轮切片 + FTS5（中文单字/二元词 + 词典扩展） |
| `digest` | 压缩摘要 / 手工事实（带坐标） |
| `hot` / `policy` / `synonym` | 热记忆、安全约束、近义词 |
| `assembled_log` | 观测：补全与首轮引导记录 |

索引与摘要全部可由 `raw_event` 重建；chunker 升级时自动丢弃切片并重放原文。

---

## 已验证与边界

**已实测**：安装、采集、跨区检索、原文回读（含 171KB 超大事件分页拼回）、压缩摘要、条件约束、备份导出、合并导入、npm 安装。

**尚未实测 / 限制**：

- 压缩缺口补全只在**运行中的会话**触发（压完不再进入的会话只靠摘要 + 检索召回）；
- 换机导入未做端到端验证；
- 与 meow-memory 的去重是规则级（标源 + 提示），不是逐条内容比对；
- 目前仅在 Windows + DSH 0.2.1-rc.2（Electron / Node ≥22.5）验证。

---

## 开发

```text
plugins/dsh-memraw/
  index.js          # 插件入口：钩子、工具、注入策略
  lib/store.mjs     # SQLite 存储、检索、摘要、备份
  lib/text.mjs      # 分词、FTS 表达式、内容抽取
  cordis.patch.yml  # bundle 插桩
```

- 本地 link 安装后用 `set_plugin` 关开热重载，不必重启；
- 改完先跑离线 harness（stub Cordis ctx），再上真机。

---

## License

[MIT](./LICENSE) © 2026 dsh-memraw contributors
