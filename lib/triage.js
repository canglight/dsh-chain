/** Batch triage suggestions.  This module deliberately never writes memories. */

const BRANCHES = new Set(['append', 'merge', 'retire', 'keep']);
const POOLS = new Set(['core', 'fact', 'skillRule', 'skillExp', 'dailyCore', 'dailyPartial', 'emotion']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normaliseFragments(fragments) {
  return Array.isArray(fragments) ? fragments.map((fragment) => ({
    id: text(fragment?.id),
    text: text(fragment?.text),
    ageDays: Number.isFinite(Number(fragment?.ageDays)) ? Number(fragment.ageDays) : null,
    pool: text(fragment?.pool),
  })) : [];
}

/** Build the model prompt without network or other side effects. */
export function buildTriagePrompt(fragments, opts = {}) {
  const items = normaliseFragments(fragments);
  const context = text(opts.context);
  return `你是记忆整理助手。请把以下碎片分组，并且只输出一个 JSON 对象：{"groups":[...]}，不要 Markdown。

每个 group 必须为 {"label":string,"branch":"append"|"merge"|"retire"|"keep","ids":string[],"reason":string,"draft"?:object}。
规则：
1. 四分支含义：append=值得存成新判断；merge=与已有条目同义、合并；retire=一次性内容、退役；keep=判断不出、交给人。对不确定的情况，宁可 keep，绝不硬判。
2. 输出 ids 只能使用输入中出现的 id；所有输入 id 必须恰好覆盖一次，不能漏、不能重复。
3. 同一件事但信息量不同，应合并并保留信息更多者。正例（应合并）："今天食堂的菜有点咸" + "食堂菜咸、宿舍空调坏了"，后者信息更多。反例（不应合并）："下好了" 和 "堵好了" 都是对弈落子的节奏句，主题相近但不是同一件事，各自 retire。
4. draft 仅在 branch=append 时必须提供；其它分支可省略。draft 形状为 {"judgement":string,"evidence":string[],"conclusion":string,"pool":"core"|"fact"|"skillRule"|"skillExp"|"dailyCore"|"dailyPartial"|"emotion"}。
5. draft、reason 不得加入输入中没有的事实或杜撰原话；reason 是一句话且不超过 60 个字符。label 用中文且至少 2 个字符。
6. 正反例必须都被遵守：只因主题相近而非同一事件时不能 merge；信息确实描述同一事件才可 merge。
${context ? `\n附加上下文：${context}\n` : ''}
输入碎片：
${JSON.stringify(items)}`;
}

function parseModelJson(raw, errors) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try {
    const value = JSON.parse(candidate);
    if (!value || !Array.isArray(value.groups)) {
      errors.push('模型返回的 JSON 缺少 groups 数组');
      return [];
    }
    return value.groups;
  } catch {
    errors.push('模型返回不是可解析的 JSON');
    return [];
  }
}

function validateGroups(candidateGroups, fragments, errors) {
  const inputIds = new Set(fragments.map((item) => item.id).filter(Boolean));
  const seen = new Set();
  const valid = [];
  if (!Array.isArray(candidateGroups)) return valid;
  candidateGroups.forEach((group, index) => {
    const prefix = `groups[${index}]`;
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      errors.push(`${prefix} 不是对象`); return;
    }
    const label = text(group.label);
    const branch = text(group.branch);
    const ids = Array.isArray(group.ids) ? group.ids.map(text).filter(Boolean) : [];
    const reason = text(group.reason);
    let ok = true;
    if (Array.from(label).length < 2) { errors.push(`${prefix}.label 必须至少 2 个字符`); ok = false; }
    if (!BRANCHES.has(branch)) { errors.push(`${prefix}.branch 非法`); ok = false; }
    if (!ids.length) { errors.push(`${prefix}.ids 不能为空`); ok = false; }
    if (!reason || Array.from(reason).length > 60) { errors.push(`${prefix}.reason 必须为不超过 60 字的一句话`); ok = false; }
    for (const id of ids) {
      if (!inputIds.has(id)) { errors.push(`${prefix} 含输入外 id: ${id}`); ok = false; }
      if (seen.has(id)) { errors.push(`id 重复覆盖: ${id}`); ok = false; }
      seen.add(id);
    }
    const draft = group.draft;
    if (branch === 'append' && (!draft || typeof draft !== 'object' || Array.isArray(draft))) {
      errors.push(`${prefix}.draft 在 append 时必填`); ok = false;
    }
    if (draft !== undefined && draft !== null) {
      if (!draft || typeof draft !== 'object' || Array.isArray(draft)) { errors.push(`${prefix}.draft 非法`); ok = false; }
      else {
        if (!text(draft.judgement) || !text(draft.conclusion) || !Array.isArray(draft.evidence) || draft.evidence.length === 0 || !draft.evidence.every((item) => text(item))) { errors.push(`${prefix}.draft 字段不完整`); ok = false; }
        if (!POOLS.has(text(draft.pool))) { errors.push(`${prefix}.draft.pool 非法`); ok = false; }
      }
    }
    if (ok) valid.push({ label, branch, ids, reason, ...(draft !== undefined && draft !== null ? { draft: { judgement: text(draft.judgement), evidence: draft.evidence.map(text), conclusion: text(draft.conclusion), pool: text(draft.pool) } } : {}) });
  });
  for (const id of inputIds) if (!seen.has(id)) errors.push(`输入 id 未覆盖: ${id}`);
  return valid;
}

/** Make one LLM call, returning validation failures as data rather than throwing. */
export async function runTriage(fragments, opts = {}) {
  const errors = [];
  const items = normaliseFragments(fragments);
  const baseUrl = text(opts.baseUrl ?? process.env.TRIAGE_BASE_URL).replace(/\/+$/, '');
  const apiKey = text(opts.apiKey ?? process.env.TRIAGE_API_KEY);
  const model = text(opts.model ?? process.env.TRIAGE_MODEL);
  const usage = { promptTokens: 0, completionTokens: 0, model };
  for (const [name, value] of [['TRIAGE_BASE_URL', baseUrl], ['TRIAGE_API_KEY', apiKey], ['TRIAGE_MODEL', model]]) if (!value) errors.push(`缺少 ${name}`);
  if (errors.length) return { groups: [], usage, raw: '', errors };
  const prompt = buildTriagePrompt(items, opts);
  let raw = '';
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0 }),
    });
    const body = await response.text();
    if (!response.ok) { errors.push(`LLM 请求失败: HTTP ${response.status}`); return { groups: [], usage, raw: body, errors }; }
    let payload;
    try { payload = JSON.parse(body); } catch { errors.push('LLM 响应不是 JSON'); return { groups: [], usage, raw: body, errors }; }
    raw = typeof payload?.choices?.[0]?.message?.content === 'string' ? payload.choices[0].message.content : '';
    if (!raw) errors.push('LLM 响应缺少 choices[0].message.content');
    usage.promptTokens = Number(payload?.usage?.prompt_tokens) || 0;
    usage.completionTokens = Number(payload?.usage?.completion_tokens) || 0;
    return { groups: validateGroups(parseModelJson(raw, errors), items, errors), usage, raw, errors };
  } catch (error) {
    errors.push(`LLM 请求异常: ${error instanceof Error ? error.message : String(error)}`);
    return { groups: [], usage, raw, errors };
  }
}
