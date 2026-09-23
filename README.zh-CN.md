# PigMemory（猪猪记忆）

[![npm](https://img.shields.io/npm/v/@memtensor%2Fpigmemory)](https://www.npmjs.com/package/@memtensor/pigmemory)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-green)](./package.json)

[English](./README.md)

> **会自我进化的智能体记忆——而且第一次有了"私密的定位记忆"。**
> 一套算法核心，多个智能体适配器（OpenClaw、Hermes Agent）。

PigMemory 是一个本地优先、文件落盘的记忆系统：它记录智能体做过的每一步，
反思每步的效果，把价值沿轨迹回传，并把高价值模式结晶成可直接调用的技能。
推理时由三级检索器（Skill → 轨迹/情节 → 世界模型）在合适的时机注入合适
的上下文。

**PigMemory 是 [MemTensor/MemOS](https://github.com/MemTensor/MemOS) 仓库中
[`memos-local-plugin`](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin)
的独立深度改版分支**：同样的 Reflect2Evolve 核心，在此之上新增了六大子系
统、整体重写的中文优先 viewer，以及一系列运行时加固。已有的
`memos-local-plugin` 安装可以**原地升级**——数据、技能、配置全部复用，无
需迁移。

## 相比 memos-local-plugin 改了什么

相对上游 **v2.0.12**，PigMemory 共改动 **232 个文件（+27,288 / −1,111 行）**，
数据库 schema 从 012 演进到 **019**（7 个新迁移），**viewer 整体重写为中文
优先**，并附带 **35 个全新单元测试文件**。完整改动清单（由源码 diff 归纳）
见 [CHANGELOG.md](./CHANGELOG.md)，核心架构见
[ARCHITECTURE.md](./ARCHITECTURE.md)。

| 能力 | memos-local-plugin（上游） | PigMemory |
| --- | --- | --- |
| 定位记忆 | — | OwnTracks + Cloudflare Worker 中继，端到端加密 |
| 用户画像记忆 | — | 长期画像层，独立收件箱 + 保留期策略 |
| 复审访谈（飞书） | — | 定时访谈卡片，把日常使用转化为显式反馈 |
| 监控与可观测性 | 滚动日志 | 持久化可观测存储、API 日志、健康路由、日志页面 |
| 检索血缘图 | — | 可视化每次检索是如何组装出来的 |
| 进化版本化 | — | 策略置信度/来源/观测增益迁移 + 预演/应用脚本 |
| Viewer | 48 文件双语应用 | 重写为约 20 文件的 Preact 应用，**中文优先**，新增图集/日志/画像页面 |
| Turn Start | 普通召回 | 回合计时、检索审计、`hermes.turn_start` 确认 |
| 模型重试 | 重试配置被忽略 | 最大重试次数端到端生效 |
| 进程探测 | 脆弱的 shell 表达式 | 宽范围列候选 + 程序内匹配 |
| 文档 | 英文 | 深度中文文档 + 16 张原理图 + 整库审计报告 |
| 测试 | 27 个 unit + integration/e2e | 35 个全新 unit 文件 |
| 身份 | `@memtensor/memos-local-plugin` | `@memtensor/pigmemory`，原地升级 |

### 旗舰新能力：私密定位记忆

让智能体知道你在哪——同时**任何第三方都无法知道**。

- **手机上的 OwnTracks → Cloudflare Worker（免费额度）→ 你的本机。**
  Worker 在 D1 里最多暂存 7 天的只有*加密信封*；它永远拿不到解密密钥、
  用户名、设备名或明文坐标。
- 解密和地点判定**只发生在你的本机**。定位走独立的 `userProfile` 旁路：
  不写入 L1/L2/L3、Reward 或 Skill，坐标永远不会交给大模型或任何通知
  渠道。
- 长期存储只保留**语义地点**（名称、城市、geohash-7 邻域的 HMAC）和到离
  时间——不存坐标。
- 到达、离开和每日摘要通过飞书卡片送达。新地点稳定停留后会收到一次命名
  卡片，按 `地点名｜城市` 回复即可命名。
- 任一开关关闭即停止收集、删除未处理密文，并**撤销 Worker 收集租约**
  （即使进程异常退出，租约也会在十分钟后自动失效）。
- 部署只需一次 `wrangler deploy`，不需要自有域名。完整指南见
  [`docs/location-memory.zh-CN.md`](./docs/location-memory.zh-CN.md)。

### 另外五个新子系统

- **用户画像记忆**——带独立收件箱与 `inboxRetentionDays` 保留期的长期画
  像层，在 viewer 与检索中呈现。
- **复审访谈与主动交互（飞书）**——`reviewInterview` / `proactiveInteraction`
  / `schedule` 配置驱动的定时访谈卡片，把日常使用转化为显式的任务级反馈。
- **监控与可观测性**——持久化可观测性仓库、API 日志、系统错误捕获、健康
  /监控路由和 viewer 日志页面。
- **检索血缘图**——可视化每次检索的候选来源与融合过程
  （`core/retrieval/lineage-graph.ts` + viewer 图组件）。
- **进化版本化**——策略置信度/来源与观测增益的 schema 迁移，配套
  `preview-evolution-migration.ts` / `apply-evolution-migration.ts` 脚本。

### Viewer 整体重写，中文优先

上游 48 文件的 viewer 被替换为约 20 文件的紧凑 Preact 应用：界面全面中文
化，带统一术语表（`terms.ts`，如 `turn_start → 回合开始（Turn Start）`），
新增页面：总览、实体、**原理图集（16 张公式/流程图）**、检索 + 混合检索
图、日志、设置、今日变更、用户画像。

### 运行时加固（相对 2.0.x 基线）

- 两个通信桥入口（脚本式 `bridge.cts` 与纯模块 `bridge.mts`）现在共享
  启动/关闭防护、运行域参数、动态档案、配置化日志、进程探测和限时关闭，
  并由入口一致性测试验证。
- 进程探测不再向系统命令注入复杂表达式：兼容地宽范围列出候选进程，
  再在程序内解析命令行。
- 每个模型的最大重试次数真正生效（配置 → 默认值 → 客户端）。
- **Turn Start 成为一等公民**：orchestrator 增加回合开始检索候选审计；
  Hermes 适配器记录回合计时并在 `hermes.turn_start` 上做检索确认；
  可观测性事件纳入 turn_start。

## Reflect2Evolve 记忆闭环

![PigMemory 完整记忆闭环](viewer/public/assets/pigmemory-guide/01-system-overview.png)

四层协同记忆：

- **L1 轨迹（trace）**——步骤级的落地记录（行动 + 观察 + 反思 + 价值）。
- **L2 策略（policy）**——从大量轨迹中归纳出的子任务策略。
- **L3 世界模型（world model）**——由 L2 + L1 压缩出的环境认知。
- **技能（Skill）**——结晶成的、智能体可直接调用的能力。

插件从两条反馈通道学习：

- **步骤级**——模型 ↔ 环境（工具结果、观察增量）。
- **任务级**——人 ↔ 模型（显式评分 + 隐式信号）。

反思加权后的奖励沿每条轨迹回传，高价值模式结晶为可复用技能；推理时由
三级检索器在合适的时机注入合适的上下文。

## 快速开始

> [!IMPORTANT]
> **不要执行 `npm install -g @memtensor/pigmemory`。**
> 本包是 Hermes / OpenClaw 插件，不是独立 CLI。请使用下面的安装器，
> 这是唯一受支持的安装方式。

在本仓库根目录：

```bash
bash install.sh --version 2.0.12
```

或直接安装最新发布版本：

```bash
bash install.sh
```

安装器会从 npm 下载包、部署到对应智能体目录、安装生产依赖、写入初始
`config.yaml`，并在需要时重启智能体运行时。安装器会自动探测 OpenClaw 和
Hermes；交互式终端下会询问装给哪个智能体。Windows 下请在 PowerShell 中
运行 `install.ps1`（参数与行为一致）。

发布前想先测本地包：

```bash
npm pack
bash install.sh --version ./memtensor-pigmemory-2.0.12.tgz
```

## 数据放在哪

源码不会直接写你的用户主目录。安装时 `install.sh` 为每个智能体创建独立的
运行时目录：

| 智能体  | 代码安装到                            | 运行时数据 + 配置           |
| ------- | ------------------------------------- | --------------------------- |
| OpenClaw | `~/.openclaw/plugins/pigmemory/`      | `~/.openclaw/memos-plugin/` |
| Hermes  | `~/.hermes/plugins/pigmemory/`        | `~/.hermes/memos-plugin/`   |

```
config.yaml      # 唯一的配置文件（含 API key；chmod 600）
data/memos.db    # SQLite（L1/L2/L3/Skill/Episode/Feedback/…）
skills/          # 结晶出的技能包
logs/            # 滚动日志
daemon/          # 通信桥 pid/port 文件
```

升级或卸载插件**绝不会**触碰 `data/`、`skills/`、`logs/`、`config.yaml`。

## 配置

插件按以下优先级解析运行时目录中的 `config.yaml`：

1. `MEMOS_HOME`——运行时根目录
2. `MEMOS_CONFIG_FILE`——直接指向配置文件
3. `--home` 命令行参数（仅通信桥）
4. 各智能体默认路径

PigMemory 新增配置包括 `userProfile`（含 `location` 与
`inboxRetentionDays`）、`schedule`、`proactiveInteraction`、
`reviewInterview`，以及每模型最大重试等，注释模板见
[`templates/`](./templates)。

Docker 部署时请显式设置 `MEMOS_HOME`：

```dockerfile
FROM nousresearch/hermes-agent:latest
RUN bash install.sh
ENV MEMOS_HOME=/opt/data/.hermes/memos-plugin
CMD node /opt/data/.hermes/plugins/pigmemory/bridge.cts --agent=hermes --daemon && hermes chat
```

配置缺失时回退到默认值（本地 embedding、无 LLM provider）：轨迹记忆可用，
但摘要与反思能力会降级。

## 与 memos-local-plugin 的兼容性

已有安装会保留以下旧协议名，升级时数据和宿主集成直接复用、无需迁移：

- 工具名，如 `memos_search`、`memos_skill_get`；
- 环境变量 `MEMOS_HOME`、`MEMOS_CONFIG_FILE` 及相关标志；
- 运行时数据目录名 `memos-plugin/` 与 SQLite 文件 `data/memos.db`。

安装器会把 `memos-local-plugin` 视为旧插件 id，在注册新的 `pigmemory`
id 时将其禁用，且**绝不删除**旧运行时数据目录。

## 文档

- [CHANGELOG.md](./CHANGELOG.md)——相对上游 v2.0.12 的完整改动清单（源码
  diff 归纳）。
- [ARCHITECTURE.md](./ARCHITECTURE.md)——核心架构说明（自上游恢复）。
- [`docs/memos-detailed-flow.zh-CN.md`](./docs/memos-detailed-flow.zh-CN.md)
  ——完整系统流程与整库审计报告。
- [`docs/pigmemory-visual-guide.zh-CN.md`](./docs/pigmemory-visual-guide.zh-CN.md)
  ——4 张核心公式图 + 12 张流程图。
- [`docs/location-memory.zh-CN.md`](./docs/location-memory.zh-CN.md)
  ——定位记忆部署与隐私指南。

## 反馈与参与

欢迎通过 Issue 和 Pull Request 参与贡献；较大的改动建议先开 Issue 讨论
方向。想了解 PigMemory 相对上游 `memos-local-plugin` 的全部差异，可以从
[CHANGELOG.md](./CHANGELOG.md) 读起。

## 致谢与许可

PigMemory 基于 [MemTensor/MemOS](https://github.com/MemTensor/MemOS) 仓库的
[`apps/memos-local-plugin`](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin)
修改而来。感谢 MemOS 团队开创的 Reflect2Evolve 架构。

本项目以 [Apache License 2.0](./LICENSE) 授权，归属说明见 [NOTICE](./NOTICE)。
