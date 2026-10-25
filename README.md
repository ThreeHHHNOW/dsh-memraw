# dsh-memraw · 原文全量记忆

给 DSH 用的「外部记忆大脑」：**只追加的原文库 + 坐标索引 + 按需召回 + 一键备份**。
与 meow-memory（蒸馏/自动记忆）互补：meow 管「记住了什么」，本插件管「原话在哪、能不能原样取回」。

- 版本：**v0.1.0（正式版）**
- 数据：`$DSH_HOME/memraw/raw.db`（SQLite，WAL）
- 本机当前规模：35 会话 / 2.1 万事件 / 2200+ 切片 / 摘要若干

## 安装

**依赖**：无运行时 npm 依赖（只用 `node:fs` / `node:sqlite` / `node:zlib` / `node:crypto`）。
要求 DSH 桌面端（Electron 内置 Node ≥ 22.5，提供 `node:sqlite`）。已在 Windows + DSH 0.2.1-rc.2 验证。

```powershell
# 已发布到 npm：dsh-memraw@0.1.0（官方源发布，国内镜像已同步）
dsh plugin add dsh-memraw
```

装完确认：

- `cordis_inspect_query` 查 `Tool.listTools`，应看到 11 个 `mem_*`
- 或直接在对话里调 `mem_status`，返回 `errors: 0`

### 重启与热重载

- **首次安装 / 换版本**：重启桌面客户端（或 `dsh web`），让 Loader 重新解析包。
- **只改代码（link 到工作区）**：不用重启。`plugin_manager set_plugin` 对 `include:memraw` 先 `enabled:false` 再 `true`，会重新导入改动过的文件。
- 改完代码建议先跑一次本地 harness 脚本（开发用，不在发布包内），再热重载。

## 工具（11 个）

| 工具 | 作用 |
|---|---|
| `mem_status` | 库状态：路径、会话/事件/切片/摘要数、错误、最近补全与摘要 |
| `mem_search` | 检索原文；**默认全局**，`scope:"workspace"` 只查本区，`workspace` 指定区；返回带 `ref`、工作区标签、路径、时间的片段 |
| `mem_read` | 按坐标回读单条事件；`offset`/`length` 分页；超 100KB 的事件从会话日志现读拼回 |
| `mem_list_sessions` | 最近会话、覆盖水位、缺口起点 |
| `mem_note` | 把一条事实/结论落盘（可带原文坐标） |
| `mem_hot` | 写/改常驻热记忆（soul / user / rules / criteria），进系统提示词 |
| `mem_digest` | 为任意区间生成带坐标摘要；`list:true` 列出现有摘要 |
| `mem_synonym` | 查看/扩充近义词词典 |
| `mem_policy` | 查看/扩充条件触发的安全约束 |
| `mem_export` | 一键备份（VACUUM INTO + manifest + sha256） |
| `mem_import` | 合并式导入备份（绝不覆盖本地，校验校验和） |

## 工作区与“换区不失忆”

原文库是全局一份，检索**默认跨工作区**（换到新工作区也能问以前的事），需要隔离时显式指定：

- `mem_search(query)`：全局检索（默认）；
- `mem_search(query, scope:"workspace")`：只查当前工作区；
- `mem_search(query, workspace:"D:\\projects\\my-app")`：只查某个工作区。

每条结果和每个摘要标题都带工作区标签：`【压缩摘要｜默认工作区】`、`【压缩摘要｜鱼鱼】`。

**新会话首轮自动引导**（`bootstrap: true`）：

- 当前工作区有旧记录 → 注入一条「【近期上下文｜标签】」+ 最近 3 条摘要；
- 当前工作区是全新的 → 注入「【新工作区】这里还没有历史，过去的记录在：工作区A(31 会话)、工作区B(2 会话)…」，并提示用 `mem_search` 找回。

标签来源优先级：`config.workspaceLabels`（路径 → 名字）> 宿主工作区标题（侧边栏里起的名字）> 目录名；`default-workspace` 目录自动显示为「默认工作区」。工作区改名后会随下一次检索自动刷新，不用重启。

## 安全约束（policy）

约束不塞进常驻人格，而是按条件触发，每条命中后**每个会话只注入一次**（压缩改写历史后重置）。

内置 6 条：

| kind | 触发示例 | 注入的一句话 |
|---|---|---|
| privacy | 身份证/密码/银行卡/api_key… | 涉及凭据/身份信息：只做必要引用，不完整复述、不写日志、不外发 |
| link | http(s):// / 打开链接 | 外部链接：不自行打开或抓取未验证链接 |
| danger | 删库/格式化/rm -rf/关机 | 危险操作：先确认目标与后果，给出可回滚方案 |
| readonly | 只读/不要修改 | 只读模式：本轮不改文件、不写数据 |
| forward | 转发/分享给 | 转发前确认范围，不泄露第三方内容 |
| leak | 保密/别告诉 | 隐私信息先脱敏，不主动扩散 |

维护方式：

```js
mem_policy({ list: true })
mem_policy({ add: [{ kind: 'custom', trigger: '合同|报价', text: '涉及合同/报价：不复述具体数字，先确认对方身份。', priority: 15 }] })
```

注入形态是一条极短的 `【本轮约束】…` 记录（同一轮命中多条会合并成一行），不占常驻 token；实现上走 `agent/pre-step`，因为 DSH 不允许在会话中途插入 system 消息。

## 与 meow-memory 的去重

轻量方案，不做向量比对：

1. `mem_search` 的结果顶层带 `source: "memraw"`，来源可辨；
2. 常驻指引里有一条硬规则：meow 自动召回里已看到的信息不重复 `mem_search`；查重了自行忽略。

## 工作原理（为什么这样设计）

1. **原文是底座**：每个 `session/event` 原样落进 `raw_event`（只 INSERT），超 100KB 只留头 4000 字 + 指针。
2. **索引是派生的**：按轮切片 → `chunk` + FTS5（中文单字 + 二元词），每条切片带 `[start_seq, end_seq]` 指回原文，坏了可全量重建。
3. **每轮不硬塞**：实测 `systemPrompt.context` 是**追加**语义（旧快照不删），所以每轮变化的内容不进上下文；常驻的只有稳定指引 + 热记忆（`section`，吃缓存）。
4. **压缩只补一次**：`compaction/summary` 记录被压掉的区间，下一轮由 `agent/pre-step` 补一次原文（有界、只补一次），同时后台异步生成带坐标摘要。
5. **不做主动遗忘**：只冷归档，不降权、不删除；检索兜底为零命中时明确说「没找到」。

## 配置（`cordis.patch.yml` 的 `config`）

| key | 默认 | 说明 |
|---|---|---|
| `dir` | `$DSH_HOME/memraw` | 数据目录 |
| `oversizeBytes` | 102400 | 单事件超过它只留头 + 指针（按字节） |
| `chunkChars` / `chunkCharsMax` | 1600 / 3000 | 切片目标/上限 |
| `backfill` | true | 激活时补齐历史会话（按行数判断，允许乱序） |
| `guide` | true | 是否挂常驻检索指引 |
| `gapRefill` / `gapChars` | true / 4000 | 压缩后补原文、单次补多少字 |
| `autoDigest` | true | 压缩时后台生成带坐标摘要（本地抽取，无模型调用） |
| `bootstrap` | true | 新会话首轮注入「近期上下文 / 新工作区」提示 |
| `workspaceLabels` | `{}` | 工作区目录 → 标签覆盖；未配置时用宿主工作区标题/目录名 |

> 本插件**没有 token 预算配置**：它不做每轮上下文注入（设计原因见上），常驻的只有一段稳定指引 + 热记忆，其余靠工具按需检索。

## 备份与恢复

- **导出**：`mem_export`，产物在 `$DSH_HOME/memraw/backup/<时间戳>/`，含 `raw.db` + `manifest.json`。
  - 先写 `.tmp` 暂存目录，重开快照做 `PRAGMA integrity_check`，记录字节数与 sha256，最后整体改名——中途失败不会留下半成品。
- **导入**：`mem_import(dir)`，合并式：
  - 先校验 `manifest.format` 与 `dbSha256`；
  - 只追加本地没有的事件（`INSERT OR IGNORE`），按行数/坐标水位续传；
  - 导入后从 `raw_event` 重建切片；
  - 二次导入同一份备份应为 `events: 0`（幂等）。
- **换机**：把整个 `backup/<时间戳>/` 拷过去，`mem_import` 一次即可；`raw.db` 里带 `session/workspace` 字段，可按会话或工作区过滤。

## 近义词维护

词典在 `synonym` 表（首次启动自动灌 25 组基础词）。

```js
// 新增一组（同义/近义互换）
mem_synonym({ add: [["猫", "猫咪", "喵", "小猫"], ["备份", "导出", "backup"]] })
// 查看全部
mem_synonym({ list: true })
```

规则：一组至少 2 个词；查询时只用词典扩展，不会把任意单字塞进 FTS，避免噪音。

## 目录与表

```
$DSH_HOME/memraw/
  raw.db            # 原文 + 切片 + FTS + 摘要 + 热记忆 + 规则
  backup/<ts>/      # 一键备份
```

`raw_event` / `session_meta` / `chunk` + `chunk_fts` / `digest` / `hot` / `policy` / `synonym` / `assembled_log` / `meta`

## 已知边界

- 压缩缺口补全只在**运行中的会话**触发；压完不再进入的会话只靠摘要 + 检索召回。
- 摘要默认抽取式（不调模型）；模型润色版尚未实现。
- 与 meow-memory 的去重是规则级（标源 + 提示），不是逐条内容比对。

## 变更记录

- **v0.1.0（正式版）**：原文入库、按轮切片 + FTS、11 个工具、压缩缺口补回、后台带坐标摘要、备份/恢复（含 sha256 校验）、近义词词典、条件触发安全约束、默认全局检索 + 工作区标签与首轮引导。
- chunker v4：中文单字 + 二元词 + 词典扩展；升级时自动丢弃切片并从 `raw_event` 重放。

## License

MIT，见 [LICENSE](./LICENSE)。
