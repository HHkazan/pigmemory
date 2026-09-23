# PigMemory 原理图集

先用 4 张独立公式图理解核心评分，再按当前源码的实际执行顺序阅读 12 张流程图。Viewer 直接展示浅色 SVG，点击图片可无限放大；同目录的 PNG 用于文档预览。

## 核心公式图解

[![任务奖励与 Trace 价值回传](../viewer/public/assets/pigmemory-guide/formula-reward-value.svg)](../viewer/public/assets/pigmemory-guide/formula-reward-value.svg)

[![记忆检索优先级与时间衰减](../viewer/public/assets/pigmemory-guide/formula-priority.svg)](../viewer/public/assets/pigmemory-guide/formula-priority.svg)

[![Policy Gain 与中性先验](../viewer/public/assets/pigmemory-guide/formula-policy-gain.svg)](../viewer/public/assets/pigmemory-guide/formula-policy-gain.svg)

[![多通道融合与 MMR 去重](../viewer/public/assets/pigmemory-guide/formula-retrieval-ranking.svg)](../viewer/public/assets/pigmemory-guide/formula-retrieval-ranking.svg)

## 原理流程图

[![01 PigMemory 完整记忆闭环](../viewer/public/assets/pigmemory-guide/01-system-overview.png)](../viewer/public/assets/pigmemory-guide/01-system-overview.png)

[![02 回合与主题生命周期](../viewer/public/assets/pigmemory-guide/02-turn-topic-lifecycle.png)](../viewer/public/assets/pigmemory-guide/02-turn-topic-lifecycle.png)

[![03 Trace 拆步与字段](../viewer/public/assets/pigmemory-guide/03-trace-extraction.png)](../viewer/public/assets/pigmemory-guide/03-trace-extraction.png)

[![04 Capture 双阶段](../viewer/public/assets/pigmemory-guide/04-capture-two-phase.png)](../viewer/public/assets/pigmemory-guide/04-capture-two-phase.png)

[![05 Trace 评分链](../viewer/public/assets/pigmemory-guide/05-reflection-reward-scoring.png)](../viewer/public/assets/pigmemory-guide/05-reflection-reward-scoring.png)

[![06 检索入口与 Query 编译](../viewer/public/assets/pigmemory-guide/06-retrieval-entry-routing.png)](../viewer/public/assets/pigmemory-guide/06-retrieval-entry-routing.png)

[![07 候选层级与召回通道](../viewer/public/assets/pigmemory-guide/07-retrieval-candidates-channels.png)](../viewer/public/assets/pigmemory-guide/07-retrieval-candidates-channels.png)

[![08 排序与安全注入](../viewer/public/assets/pigmemory-guide/08-retrieval-ranking-injection.png)](../viewer/public/assets/pigmemory-guide/08-retrieval-ranking-injection.png)

[![09 L2 Policy 归纳](../viewer/public/assets/pigmemory-guide/09-l2-policy-induction.png)](../viewer/public/assets/pigmemory-guide/09-l2-policy-induction.png)

[![10 L3 World Model](../viewer/public/assets/pigmemory-guide/10-l3-world-model.png)](../viewer/public/assets/pigmemory-guide/10-l3-world-model.png)

[![11 Skill 与模型路由](../viewer/public/assets/pigmemory-guide/11-skill-lifecycle-model-routing.png)](../viewer/public/assets/pigmemory-guide/11-skill-lifecycle-model-routing.png)

[![12 反馈修复与可观测性](../viewer/public/assets/pigmemory-guide/12-feedback-repair-observability.png)](../viewer/public/assets/pigmemory-guide/12-feedback-repair-observability.png)
