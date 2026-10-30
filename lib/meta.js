/**
 * 元记忆（meta-memory）：**这条记录"我自己怎么看它"**。
 *
 * 前者回答"我记得什么"，这里回答"我多信它、它多完整、我跟它多熟、它跟别的打不打架"。
 * 作者 的 v2.0.0 三块之一（感知层 / 决策层 / 元记忆）；本文件是元记忆的最小实现。
 *
 * ★ 三条设计约束（越界算返工）：
 *   1. **纯函数**：不读盘、不写盘、不调模型、不看时钟以外的外部状态（`Date.now()` 都不用）。
 *   2. **不新增手写字段**：所有输入都从已有事件派生
 *      （`recall` 自动命中 / `touch` 人工确认 / `supersede` 被取代 / 正文是否还在）。
 *   3. **不改签名**：`metaOf(entry)` 返回固定五键。
 *
 * 派生字段来源（见 store.js 的 `materialize()`）：
 *   · `recallCount`        —— 检索自动命中次数（type: 'recall'）
 *   · `touchCount`         —— 被想起**总**次数（含 recall + 人工 touch）
 *   · `lastTouched`        —— 最后一次被想起
 *   · `lastManualTouched`  —— 最后一次**人确认/手动**（= "验证过"）
 *   · `superseded`         —— 已被更准的记录取代
 *
 * @module dsh-chain/meta
 */

/** 把任意数夹到 0~1；非数字当 0。 */
function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/** 非负整数化（次数类字段）。 */
function count(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** 正文里"还有几块拼图"——用来算完整度的原料。 */
function shapeOf(entry) {
  const judgement = typeof entry?.judgement === 'string' && entry.judgement.trim() !== '';
  const conclusion = typeof entry?.conclusion === 'string' && entry.conclusion.trim() !== '';
  const evidence = Array.isArray(entry?.evidence)
    ? entry.evidence.filter((item) => typeof item === 'string' && item.trim() !== '').length
    : 0;
  return { judgement, conclusion, evidence };
}

/**
 * 一条记录的元记忆。
 *
 * **confidence（我多确定）**
 *   0.35 底座（能成条本身就有一点底气）
 * + 0.35 × 命中饱和项 `1 − 0.5^recall`（0 次 0 / 1 次 .5 / 3 次 .875 —— 首次最值钱，边际递减）
 * + 0.15 × 人工确认（一次就满，因为"人看过"比"机器反复命中"重）
 * + 0.15 × 依据（2 条依据就满）
 * 最后：被 `supersede` 的乘 0.25 —— 它已被更准的记录取代，我不该还那么笃定。
 *
 * **completeness（依据还在不在）**
 *   判断 0.4 + 结论 0.25 + 依据每条 0.175（最多 2 条算满）→ 只剩一句判断时 = 0.4。
 *   这条专门用来发现"被裁过 / 写残了"的记录：完整度掉下来而权重没掉，就是该补依据的信号。
 *
 * **familiarity（见过没细看）**
 *   `recall / (recall + 人工touch)`：全是被检索自动命中 → 1（我很熟它，但没真去核实）；
 *   全是人工确认过 → 0（我熟它是因为我看过，不是因为见过）。
 *   注意这是**比值**，不是次数 —— 次数在 confidence 里。
 *
 * **conflict（和别的条目打架）**
 *   现阶段恒 `false`，接口先留好：夜巡②（疑似重复对）接进来以后由它填。
 *   ⚠️ 这里刻意不自己算 —— 单条记录看不到"别的条目"，算了也是瞎猜。
 *
 * **lastVerified（最后一次被验证）**
 *   取 `lastManualTouched`（人确认/手动的时刻），没有就是 `null`。
 *   **不用 lastTouched** —— 那是"被想起"，不等于"被验证"。
 *
 * @param entry - 已 materialize 的记录（loadAll().entries 的成员）。
 * @returns `{ confidence, completeness, familiarity, conflict, lastVerified }`，五键固定。
 */
/**
 * @deprecated **别用这个。**（2026-10-30 用户审出来的）
 *
 * 原因：真库实测 152 条活条里有 151 条 confidence 挤在 0.5–0.7 ——
 * 那个分没有分辨力，还会诱导模型拿它当"我不太确定"的判据。
 * 那是假数包装成判断，比没有更糟。
 *
 * 对外只输出**能说准的事实**，见 `metaFacts()`。
 * 这个函数留着只是为了旧的单测与历史对照，任何注入/UI/工具都不许调用它。
 */
export function metaOf(entry) {
  const recallCount = count(entry?.recallCount);
  const touchCount = count(entry?.touchCount);
  // 人工确认次数 = 总数 − 自动命中数。旧数据里 recall 事件一律记成 touch，
  // 所以老记录 recallCount=0、全部算人工确认 —— 这是**有意偏保守**的兼容策略。
  const manualCount = Math.max(0, touchCount - recallCount);

  const { judgement, conclusion, evidence } = shapeOf(entry);

  // ① confidence
  const recallScore = 1 - Math.pow(0.5, recallCount);
  const manualScore = clamp01(manualCount);
  const evidenceScore = Math.min(1, evidence / 2);
  let confidence = 0.35 + 0.35 * recallScore + 0.15 * manualScore + 0.15 * evidenceScore;
  if (entry?.superseded === true) confidence *= 0.25;
  confidence = clamp01(confidence);

  // ② completeness
  const completeness = clamp01(
    (judgement ? 0.4 : 0) + (conclusion ? 0.25 : 0) + Math.min(0.35, evidence * 0.175),
  );

  // ③ familiarity
  const seen = recallCount + manualCount;
  const familiarity = seen === 0 ? 0 : clamp01(recallCount / seen);

  return {
    confidence,
    completeness,
    familiarity,
    // ④ conflict：接口占位，等夜巡②的疑似重复对接进来。
    conflict: false,
    // ⑤ lastVerified：只认人工确认，不认"被想起"。
    lastVerified: typeof entry?.lastManualTouched === 'string' && entry.lastManualTouched !== ''
      ? entry.lastManualTouched
      : null,
  };
}


/* ════════════ 只输出「能说准的」那一层（2026-10-30） ════════════ */

/**
 * **元记忆的精准版**：只给可数的原始事实，不给综合评分。
 *
 * 由来：上面那个 `metaOf` 会算一个 0..1 的 confidence，但真库实测
 * **152 条活条里 151 条挤在 0.5–0.7** —— 那种分说了等于没说，还会诱导模型
 * 拿它当"我不太确定"的判据。那是假数包装成判断，比没有更糟。
 *
 * 所以对外（注入 / 面板 / 工具）只露这四样，全部是**数得出来**的：
 *   · recalled      被自动命中几次（recall 事件）
 *   · verified      被人确认几次（touch 且 delta > 0）
 *   · lastVerified  最后一次被确认的时间（ISO 或 null）
 *   · state         active / superseded / archived
 *
 * 判据：**每一条都能拿出来给人核对**。给不出依据的东西，这一层不输出。
 *
 * @param entry - materialize 之后的条目。
 * @returns `{ recalled, verified, lastVerified, state }`
 */
/** 最后人工确认的时刻；没有就是 null（不是"全算成确认过"）。 */
function lastVerifiedOf(e) {
  const v = e?.lastManualTouched;
  return typeof v === 'string' && v !== '' ? v : null;
}

export function metaFacts(entry) {
  const e = entry ?? {};
  const recalled = Math.max(0, Math.floor(Number(e.recallCount) || 0));
  // 「被人确认」= touch 次数 - recall 次数（老数据没有 recallCount 时，全按人工算）
  const touched = Math.max(0, Math.floor(Number(e.touchCount) || 0));
  // ⚠️ 2026-10-30 用户审出来的：老记录的 touch 里混着**自动命中**，无法回溯区分。
  // 原来的写法把"没确认过痕迹"的老数据全算成人工确认 —— 那不是保守，是**假装被验证过**。
  // 现在的口径：没有 lastManualTouched 就说明**一次人工确认都没留下**，verified 记 0，
  // 并把那些来历不明的 touch 单独标成 legacyTouch，让人自己看。
  const legacyTouch = touched - recalled;
  const verified = lastVerifiedOf(e) === null ? 0 : Math.max(0, legacyTouch);
  const lastVerified = lastVerifiedOf(e);
  let state = 'active';
  if (e.superseded === true) state = 'superseded';
  else if (e.archived === true) state = 'archived';
  return { recalled, verified, lastVerified, state, legacyTouch };
}
