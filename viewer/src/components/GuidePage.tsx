const diagrams = [
  ["01-system-overview", "PigMemory 完整记忆闭环总览"],
  ["02-turn-topic-lifecycle", "回合、主题与 Episode 生命周期"],
  ["03-trace-extraction", "Trace 拆步与字段结构"],
  ["04-capture-two-phase", "即时捕获与主题级反思"],
  ["05-reflection-reward-scoring", "α、R_human、V 与 priority 评分链"],
  ["06-retrieval-entry-routing", "五种检索入口与 Query 编译"],
  ["07-retrieval-candidates-channels", "候选层级与六种召回通道"],
  ["08-retrieval-ranking-injection", "融合排序、LLM 精排与安全注入"],
  ["09-l2-policy-induction", "L2 Policy 归纳与 Gain 生命周期"],
  ["10-l3-world-model", "L3 World Model 聚类、抽象与合并"],
  ["11-skill-lifecycle-model-routing", "Skill 结晶、试用与当前模型路由"],
  ["12-feedback-repair-observability", "反馈修复、证据链与可观测性"],
] as const;

const formulaCards = [
  ["formula-reward-value", "任务奖励与 Trace 价值回传"],
  ["formula-priority", "记忆检索优先级与时间衰减"],
  ["formula-policy-gain", "Policy 基础 Gain、实际 Gain 与最终 Gain"],
  ["formula-retrieval-ranking", "多通道融合与 MMR 去重"],
] as const;

export function GuidePage() {
  return <div class="page-stack guide-page">
    <section class="guide-hero">
      <div>
        <span class="eyebrow">Huhu explains PigMemory</span>
        <h2>呼呼猪带你逐步看懂 PigMemory</h2>
        <p>先用 4 张大字号公式图理解评分与排序，再用 12 张高清流程图沿真实源码顺序展开。全部使用浅色矢量图片，点击可打开原始尺寸。</p>
      </div>
      <img src="/assets/huhu-pig-mascot.png" alt="戴圆眼镜、拿着记忆卡片的呼呼猪" />
    </section>

    <section>
      <div class="section-heading"><div><span class="eyebrow">Visual formulas</span><h2>核心公式图解</h2></div><span>公式已独立成图，不再挤在说明文字中</span></div>
      <div class="formula-guide-grid">
        {formulaCards.map(([file, alt]) => <figure class="formula-guide-card">
          <a href={`/assets/pigmemory-guide/${file}.svg`} target="_blank" rel="noreferrer">
            <img src={`/assets/pigmemory-guide/${file}.svg`} alt={alt} />
          </a>
          <figcaption>{alt} · 点击放大</figcaption>
        </figure>)}
      </div>
    </section>

    <section class="review-principle-guide">
      <div class="section-heading"><div><span class="eyebrow">Memory review trigger</span><h2>什么时候询问“这次记忆有帮助吗”</h2></div><span>可在设置页修改全部触发参数</span></div>
      <div class="review-hard-gate">
        <strong>先过硬门槛：本轮实际交付给模型的记忆数必须大于 0</strong>
        <p>检索阶段被淘汰的候选不算；没有引用记忆时没有评分对象，因此不计算触发分。任务成功完成且最终回复送达后，才会继续判断。</p>
      </div>
      <div class="review-principle-grid">
        <article><span>T · 默认 30%</span><h3>工具调用分</h3><p>有效工具数使用分段曲线，写入/修改与测试/验证可以加分。分段、加分值和匹配词都来自配置。</p></article>
        <article><span>D · 默认 30%</span><h3>任务难度分</h3><p>多步骤、正式产物、外部副作用、失败重试、验证和长耗时分别累加，最终封顶 100。</p></article>
        <article><span>M · 默认 40%</span><h3>记忆评价价值</h3><p>单条记忆由本轮相关度与评分不确定性组成；多条记忆再按本轮相关度加权。</p></article>
      </div>
      <div class="review-formula-block">
        <code>S = weightedAverage(T, D, M)</code>
        <code>mᵢ = weightedAverage(relevanceᵢ, 1 / √(1 + ratingCountᵢ))</code>
        <code>M = Σ(relevanceᵢ × mᵢ) / Σrelevanceᵢ</code>
      </div>
      <div class="review-principle-notes">
        <p><strong>为什么不用历史平均好评？</strong>如果既有评分越高就越容易再次弹卡，会形成“富者愈富”的反馈偏差。这里改用评分次数带来的不确定性：样本越少，越值得询问。</p>
        <p><strong>自动与手动：</strong>自动流程还受阈值、延迟、冷却和每天上限约束；用户输入 <code>/review</code> 可以评价上一轮低于阈值或已跳过的任务，但上一轮没有使用记忆时仍不会创建评分。</p>
        <p><strong>不会打断后续任务：</strong>卡片只在回复确认送达后延迟发送；延迟期间如果用户继续发消息，本次自动评分会被取消。</p>
      </div>
    </section>

    <section class="visual-guide-grid" aria-label="PigMemory 原理图集">
      {diagrams.map(([file, alt], index) => <figure class="workflow-figure visual-guide-figure">
        <a href={`/assets/pigmemory-guide/${file}.svg`} target="_blank" rel="noreferrer">
          <img
            src={`/assets/pigmemory-guide/${file}.svg`}
            alt={`${index + 1}. ${alt}`}
            loading={index < 2 ? "eager" : "lazy"}
          />
        </a>
        <figcaption>{String(index + 1).padStart(2, "0")} · {alt} · 点击放大</figcaption>
      </figure>)}
    </section>
  </div>;
}
