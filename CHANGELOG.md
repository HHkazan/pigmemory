# 变更日志（CHANGELOG）

## PigMemory 2.0.12

基线：上游 `@memtensor/memos-local-plugin` v2.0.12（MemOS 仓库 tag
`memos-local-plugin-v2.0.12`）。

与基线的全量差异：**232 个文件改动，+27,288 / −1,111 行**；数据库 schema
自 012 演进至 **019**（7 个新迁移）；**35 个全新单元测试文件**（未沿用上游
测试套件）；**viewer 整体重写**。本清单由源码级 diff 归纳，按主题分组。

### 新增子系统（各含 core 模块、存储层、迁移、路由、viewer 页面与测试）

1. **定位记忆（Location Memory）** — `core/location/`（crypto / geo /
   service / types）、`core/storage/repos/location.ts`、迁移 `019`、
   `location-worker/`（Cloudflare Worker：OwnTracks 加密信封中继 + D1 +
   租约撤销）、配置 `userProfile.location`、viewer 无专门页面（旁路设计）、
   测试 `location-memory` / `location-worker`、文档
   `docs/location-memory.zh-CN.md`。端到端加密，坐标不出本机。
2. **用户画像记忆（User Profile Memory）** — `core/user-profile/`（service /
   types / time）、`core/storage/repos/user_profile.ts`、迁移 `018`、
   `server/routes/user-profile.ts`、viewer `UserProfilePage`、测试
   `user-profile-memory` / `user-profile-inbox-retention`、配置
   `userProfile` 与 `inboxRetentionDays`。
3. **复审访谈与主动交互（Review Interview / Proactive Interaction）** —
   `core/review/`（trigger / index）、Hermes 适配器
   `feishu_interview.py`（飞书访谈卡片）、配置 `reviewInterview` /
   `proactiveInteraction` / `schedule`、测试 `review-trigger*` /
   `test_hermes_feishu_interview.py`。把日常使用转化为显式反馈。
4. **监控与可观测性（Monitoring & Observability）** —
   `core/storage/repos/observability.ts`、迁移 `015`、
   `server/routes/monitor.ts`、viewer `LogsPage`、memory-core 的
   `writeApiLog` / `recordSystemError` / `wireDurableObservability`、测试
   `monitoring-observability` / `monitor-health-status` /
   `pipeline-observability-events`。
5. **检索血缘图（Retrieval Lineage Graph）** —
   `core/retrieval/lineage-graph.ts`、viewer `HybridRetrievalGraph` +
   `retrieval-graph.ts`、测试 `lineage-graph-retrieval` /
   `viewer-retrieval-graph`。可视化每次检索的候选来源与融合过程。
6. **进化版本化（Evolution Versioning）** — 迁移 `014 evolution-versioning`
   / `016 policy-confidence-provenance` / `017 policy-observed-gain`、
   `scripts/apply-evolution-migration.ts` 与 `preview-evolution-migration.ts`
   （含预演与校验）、测试 `evolution-*` / `policy-*`。

### Viewer 整体重写（中文优先）

- 上游 48 文件的 views/stores/hooks 结构重写为约 20 文件的扁平 Preact
  应用；界面全面中文化，并带 `terms.ts` 统一术语表（如
  `turn_start → 回合开始（Turn Start）`）。
- 新页面：总览（Overview）、实体（Entity）、**原理图集（Guide，16 张
  公式/流程图）**、检索（Retrieval + 混合检索图）、日志（Logs）、设置
  （Settings）、今日变更（TodayChanges）、用户画像（UserProfile）。
- 新增 `conversation-flow.ts` / `scoring.ts` / `styles.css`（908 行）。

### 核心管线与 Turn 行为

- `core/pipeline/memory-core.ts` **+1,477 行**：`appendLifecycleSafe`、
  `emitPolicyUpdate`、`logCandidateSkillExposures`、`ensureLive`、可观测性
  接线等。
- **Turn Start 强化**：orchestrator 新增 `turnStartRetrievalAudit`（回合
  开始检索候选审计）；Hermes 适配器记录 `_turn_started_at_ms` 回合计时，
  并在 `hermes.turn_start` 上做检索确认（ack）；可观测性事件纳入
  turn_start。

### Hermes 适配器（`__init__.py` +1,457 行）

回合计时与检索确认、新增 `shared_bridge_runtime.py`、`bridge_client.py`
改造、飞书访谈集成、`plugin.yaml` 更新。

### 检索层

`retrieve.ts`（+291）、`llm-filter.ts`（296）、`ranker.ts`（101）、
`injector.ts`（64）、`query-builder.ts`、tier1/tier2/tier3 全部调整、
`types.ts`（+141）。新增候选策略检索通道（`candidate-policy-retrieval`
测试）。

### L2 / L3 策略与世界模型

`l2.ts`（263）、`l2/gain.ts`（95，观测增益）、`induce.ts`、`subscriber.ts`；
`l3.ts`（124）、`l3/subscriber.ts`；`repos/policies.ts`（+213）、
`repos/world_model.ts`（+88）、`repos/trace-policy-links.ts`（+51）。

### 存储与迁移（schema 012 → 019）

- `013` 安全 upsert 后重建 FTS 全文索引（`storage-safe-upsert` 测试）。
- `014`–`019` 见"新增子系统"与"进化版本化"。
- `migrator.ts`（+309）、`tx.ts`、`repos/api_logs.ts`、`repos/skills.ts`、
  `repos/skill_trials.ts`、`repos/traces.ts` 等扩展。

### LLM 层

`client.ts`（+195，**最大重试次数贯通**）、`json-mode.ts`（148）、
`types.ts`（+49）、`openai.ts`；`dedicated-llm-config` 测试。

### 通信桥与运行时加固

- 双入口（`bridge.cts` / `bridge.mts`）能力一致性：启动/关闭防护、运行域
  参数、动态档案、配置化日志、进程探测、限时关闭，`bridge-entry-parity`
  测试保障。
- `bridge/methods.ts`（+161）、`bridge/hermes-process.ts`（55）。
- 进程探测改为"宽范围列候选 + 程序内匹配"，兼容各系统 shell。

### 配置

`config/schema.ts`（+130）、`config/defaults.ts`（+155）：新增
`userProfile`、`location`、`schedule`、`proactiveInteraction`、
`reviewInterview`、`inboxRetentionDays`、模型最大重试等选项；模板同步更新。

### 测试

35 个全新 unit 测试文件（约 5,000+ 行断言），与上游 27 个测试文件无一
重名，按新子系统与修复点独立编写。

### 文档与资产

- `docs/memos-detailed-flow.zh-CN.md`（569 行，完整流程 + 整库审计报告）。
- `docs/pigmemory-visual-guide.zh-CN.md` + 16 张原理图（4 公式 + 12 流程，
  SVG/PNG 双格式）与生成脚本 `generate-pigmemory-visual-guide.cjs`。
- `docs/location-memory.zh-CN.md`（95 行部署与隐私指南）。
- 双语 `README.md` / `README.zh-CN.md`；恢复上游 `ARCHITECTURE.md`。

### 工具脚本

`reembed_skipped_traces.py`（跳过轨迹重嵌入）、`location-rollback.mjs`
（定位功能四级回退）、`start-memos-daemon.sh`、`copy-runtime-assets.cjs`
扩展。

### 产品化

品牌更名为 PigMemory（npm `@memtensor/pigmemory`、插件 id `pigmemory`）、
安装器更新并兼容禁用旧 id `memos-local-plugin`、`AGENTS.md`、
`LICENSE`（Apache-2.0）+ `NOTICE` 归属声明。

### 未从上游仓库携带的资产

上游 git 仓库中的 `website/`、英文 `docs/` 全集、原测试套件
（unit/integration/e2e/helpers/fixtures）、`.claude/`、`pnpm-lock.yaml`
等未包含在本仓库（本仓库谱系始于 npm 包并独立演进）；`ARCHITECTURE.md`
与上游变更历史已恢复并在此续写。

---

## 上游历史（保留自 MemOS 仓库）

> 以下为上游 `@memtensor/memos-local-plugin` 在基线前的变更索引，原文保留。

Notable changes to `@memtensor/memos-local-plugin`. Maintained by hand;
for the full per-commit history use `git log` or the GitHub releases page.

### Index

- `2.0.6` (unreleased) — Documentation fix: clarify install path and stale
  directory names (#1540).
- `2.0.0-beta.1` — Complete end-to-end implementation: L1/L2/L3/Skill layers,
  three-tier retrieval, decision repair, crystallization, dual adapters,
  HTTP/SSE server, Vite viewer.
- `2.0.0-alpha.1` — Project skeleton, agent-contract layer, install.sh
  entrypoint, viewer directory layout.
