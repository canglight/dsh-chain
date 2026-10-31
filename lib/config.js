/**
 * 常量与会话范围判定。
 *
 * **本文件是开源版（全会话通用）**：默认所有会话共用同一份思维链，
 * 不绑定任何会话 id —— 你在哪个会话里说话，看到的都是同一套记忆。
 *
 * （需要「一套记忆只服务一条会话」的隔离版是另一条线，不在这个包里。）
 *
 * 会话判定刻意做成**前缀无关**：`scope.id` 可能带 `session-` 前缀，也可能不带，
 * 这里两种都认，避免因为格式猜错导致整段注入永不出现。
 *
 * @module dsh-chain-shared/config
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * schemastery 是**可选依赖**。
 *
 * 有它 → 插件能导出 `Config`，DSH 设置页里就会出现表单；
 * 没有它 → 插件照常工作，只是没有设置页（所有参数用代码里的默认值）。
 *
 * 为什么要这样：开源包可能被 `link:` 进 profile，而 pnpm **不会**给 link 的包跑安装，
 * 于是插件自己目录下没有 node_modules —— 直接 `import '@deepseek-ai/schemastery'`
 * 会让整个插件加载失败（连带工具与注入全没）。宁可少一个设置页，不能整个挂掉。
 */
let Schema = null;
try {
  const mod = await import('@deepseek-ai/schemastery');
  Schema = mod?.default ?? mod;
  if (typeof Schema?.object !== 'function') Schema = null;
} catch {
  Schema = null;
}

/**
 * **可在 DSH 设置页里改的参数**（2026-10-29 加）。
 *
 * 为什么用 schema 而不是自己的 settings.json：
 * DSH 的 `dsh-settings` 是 schema 驱动的 —— 插件导出 `Config`，宿主自动生成设置表单
 * （校验 / 修订号 / 密文脱敏都由宿主负责），不用自己写读写文件的代码。
 *
 * 这里只暴露「用户真的想调」的东西：天数和半衰期排第一，其次是注入预算与夜巡时间。
 * 没暴露的是结构性常量（段名、池规则关键词）—— 那些改了会破坏记忆的语义。
 */
export const Config = Schema ? Schema.object({
  patrolHour: Schema.number().default(18).min(0).max(23)
    .description('夜巡每天几点之后开始（本地时间，0–23）'),
  injectMaxChars: Schema.number().default(24000).min(2000).max(200000)
    .description('注入段最多多少字符（越大越贵，但记得越全）'),
  coreMax: Schema.number().default(32).min(1).max(300)
    .description('核心池最多几条；满了之后拒绝新增「原则/人格」'),
  pools: Schema.dict(Schema.object({
    graceDays: Schema.number().description('宽限天数：这段时间内不衰减'),
    halfLifeDays: Schema.number().description('半衰期（天）：衰减到一半要多久'),
    archiveDays: Schema.number().description('归档天数：超过就不再做可视化的主角'),
  })).description('按池调寿命。key 用 core / fact / skill / dailyCore / dailyPartial / emotion / hippocampus'),
})
  .description('思维链记忆')
  // **`.volatile()` 是设置页能不能看见它的关键**（2026-10-29 实测）。
  // DSH 的 `SettingsForms.describe()` 只列「schema 里有 volatile 字段」的插件 ——
  // 没有这个标记，schema 再完整也不会出现在设置页（它被当成"只在装载时读一次的普通配置"）。
  // 标了 volatile 语义上也对：这些参数改了应该**不重启就生效**。
  .volatile() : undefined;

/** schemastery 有没有装上（自检 / README 用）。 */
export const settingsSchemaReady = Schema !== null;

/**
 * 允许被注入的会话 id（不含 `session-` 前缀的规范形式）。
 * 配置项 `targetSessionIds` 会覆盖它。
 * @type {readonly string[]}
 */
// 可选环境变量：逗号分隔会话 id；缺省空字符串表示所有会话共享。
export const DEFAULT_TARGET_SESSIONS = Object.freeze(
  (process.env.DSH_CHAIN_TARGET_SESSION_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean),
);

/** 私有数据目录名（放在 memories 下，与 memory 三轨并列但独立）。 */
export const STORE_DIR_NAME = '.chain-shared';

/** 数据文件名。JSONL：一行一条，追加写，坏一行不会毁了整库。 */
export const STORE_FILE_NAME = 'chains.jsonl';

/** 单个字符串字段的最大字数，超出截断（防止一条记录把注入撑爆）。 */
export const FIELD_MAX = 500;

/** 数组字段最多保留几项。 */
export const LIST_MAX = 8;

/**
 * 注入段每次最多输出多少字符。
 *
 * ⚠️ **这个值原来写的是 1500（约 1000 token），那是个错误。**
 * 它导致 95 条记忆里只有 12 条进得了注入，其余必须靠 `chain_recall` 现查——
 * 那就成了"外挂硬盘"，不是"记得"。用户原话：
 *   「思维链应该是你脑子里绝对拥有的东西，不应该是要你去找」
 *
 * 重算过成本：95 条记忆**每条只放一行判断**（约 50 字符）≈ 5000 字符 ≈ 1800 token，
 * 相对当前 700k+ 的上下文只有 0.25% —— 这点钱换"绝对拥有"完全值得。
 *
 * 所以上限放到 24000 字符（约 8k token），足够放下几百条"一行判断"。
 * 真正该省的是**依据/犹豫的全文**（那些才是长的），不是判断本身。
 */
export const INJECT_MAX_CHARS = 24000;

/** 注入里"最近"取几条（带全文的那种）。 */
export const INJECT_RECENT = 8;

/** 注入里"高权重"再取几条（与最近去重后）。 */
export const INJECT_TOP = 5;

/** 权重达到多少算"高权重"。 */
export const TOP_WEIGHT_MIN = 0.7;

/** `chain_recall` 默认返回条数 / 上限。 */
export const RECALL_DEFAULT = 10;
export const RECALL_MAX = 50;

/** `chain_graph` 默认节点上限 / 上限。 */
export const GRAPH_DEFAULT = 30;
export const GRAPH_MAX = 120;

/**
 * 连续多久未被使用才开始淡出；避免一条刚写下的记忆立刻被时间惩罚。
 *
 * **2026-10-28 从 21 改成 15**（用户 定）。原值是按"已经稳定运行的库"定的，
 * 而我们是新建库，21 天意味着所有条目三周内完全不动 —— 遗忘机制在那个窗口里
 * 等于不存在。改 15 让"开始淡"提前 6 天。
 *
 * ⚠️ 但要清楚：**光改这个几乎没效果**。按公式算，21→15 在第 90 天只差 2%
 * （0.690 → 0.674）。真正决定"多久淡掉一半"的是下面的半衰期。
 */
export const WEIGHT_DECAY_GRACE_DAYS = 15;

/**
 * 使用热度的半衰期（天）。它比视觉透明度慢，避免频繁重新排序。
 *
 * **2026-10-28 从 180 改成 90**（用户 定）。实测三套参数（0.9 权重、从没被想起）：
 *
 *   天数      21/180    15/180    15/90
 *   第 90 天  0.690     0.674     0.505
 *   第 200 天 0.452     0.441     0.217
 *
 * 关键是**对比度**而不是绝对值：第 200 天时，"没人提"剩 0.217、"被想起 10 次"剩 0.566
 * —— 差 2.6 倍，人眼能看出区别；而 180 那套只差 1.6 倍，看起来两者一样亮，
 * 遗忘机制等于没显形。
 */
export const WEIGHT_DECAY_HALF_LIFE_DAYS = 90;

/** 注入段在 system prompt 里的位置：850 落在 800(PTC_ONLY) 与 900(FILE_REFERENCE) 之间。 */
export const SECTION_ORDER = 850;

/** 段名（同名重复注册会抛错，所以起一个足够独特的名字）。 */
export const SECTION_NAME = 'chain:thinking';

/**
 * 取出私有数据目录的绝对路径。
 * @returns 目录绝对路径。
 */
export function storeDir() {
  return join(homedir(), '.dsh', 'memories', STORE_DIR_NAME);
}

/**
 * 取出数据文件的绝对路径。
 * @returns 文件绝对路径。
 */
export function storePath() {
  return join(storeDir(), STORE_FILE_NAME);
}

/**
 * 用户设置在磁盘上的位置（**不是** DSH 的设置命名空间，是插件自己的 json）。
 *
 * 为什么不用 DSH 的设置页：那套要走 `plugins.item` 槽位 + `configForms`，
 * 接了两轮才通（而且依赖宿主内部约定）。用户（用户）提了个更好的主意：
 * **把配置塞进「思维链」画布的右上角** —— 有自己的样式、自己的入口，
 * 而且写进去能当场生效（同一个进程里直接改运行时值）。
 */
export function settingsPath() {
  return join(storeDir(), 'settings.json');
}

/**
 * 读磁盘上的用户设置。读不到 / 坏掉都返回空对象（坏文件不该让插件起不来）。
 * @returns 设置对象。
 */
export function readSettingsFile() {
  try {
    // 去掉 BOM：记事本 / PowerShell 写出来的 json 常带 BOM（实测踩过）。
    const raw = readFileSync(settingsPath(), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 把设置写到磁盘（调用方负责已经合并过的完整对象）。
 * @param settings - 要落盘的设置。
 * @returns 实际写入的对象。
 */
export function writeSettingsFile(settings) {
  const dir = storeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const clean = settings && typeof settings === 'object' ? settings : {};
  writeFileSync(settingsPath(), JSON.stringify(clean, null, 2) + '\n', 'utf8');
  return clean;
}

/** 各项的默认值与取值范围（画布里的设置面板拿它画输入框）。 */
export const SETTINGS_DEFAULTS = Object.freeze({
  patrolHour: { value: 18, min: 0, max: 23, label: '夜巡开始小时' },
  injectMaxChars: { value: 24000, min: 2000, max: 200000, label: '注入段字符上限' },
  coreMax: { value: 32, min: 1, max: 300, label: '核心池上限（条）' },
});

/** 池的寿命字段（面板按这个顺序画三列）。 */
export const POOL_FIELDS = Object.freeze(['graceDays', 'halfLifeDays', 'archiveDays']);

/**
 * 合并两份设置：`base` 打底，`patch` 覆盖，**非法值一律丢弃**。
 *
 * 为什么要校验而不是直接展开：这个接口会被画布里的输入框直接调用，
 * 空字符串 / 负号 / 打错的字段都可能传进来。宁可保留旧值，也不要写进一个
 * 会让衰减公式算出 NaN 的数。
 *
 * @param base - 当前设置。
 * @param patch - 要覆盖的部分。
 * @returns 合并后的新对象（不改动入参）。
 */
export function mergeSettings(base, patch) {
  const out = (base && typeof base === 'object') ? JSON.parse(JSON.stringify(base)) : {};
  const src = (patch && typeof patch === 'object') ? patch : {};

  for (const [key, spec] of Object.entries(SETTINGS_DEFAULTS)) {
    if (!(key in src)) continue;
    // ⚠️ `Number('') === 0` —— 空字符串会被夹成下限，等于"清空一个输入框就把它改成最小值"。
    // 所以空串 / null / 布尔一律当"没填"，直接跳过（2026-10-29 实测踩到）。
    if (isBlank(src[key])) continue;
    const num = Number(src[key]);
    if (!Number.isFinite(num)) continue;
    out[key] = Math.min(spec.max, Math.max(spec.min, num));
  }

  if (src.pools && typeof src.pools === 'object') {
    const pools = (out.pools && typeof out.pools === 'object') ? out.pools : {};
    for (const [poolKey, fields] of Object.entries(src.pools)) {
      if (!fields || typeof fields !== 'object') continue;
      const target = (pools[poolKey] && typeof pools[poolKey] === 'object') ? { ...pools[poolKey] } : {};
      for (const field of POOL_FIELDS) {
        if (!(field in fields)) continue;
        if (isBlank(fields[field])) continue;
        const num = Number(fields[field]);
        if (!Number.isFinite(num) || num <= 0) continue;
        target[field] = num;
      }
      if (Object.keys(target).length > 0) pools[poolKey] = target;
    }
    out.pools = pools;
  }

  return out;
}

/** 是不是"没填"（空串、纯空白、null、布尔）。 */
function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

/**
 * 把一个会话 id 归一成可比形式：去空白、去 `session-` 前缀、小写。
 * @param value - 任意会话 id 或 scope.id。
 * @returns 归一后的字符串；无法识别时返回空串。
 */
export function normalizeSessionId(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^session-/i, '').toLowerCase();
}

/**
 * 判定某个 scope.id 是否属于允许注入的会话。
 * @param scopeId - `AssembleContext.scope?.id`。
 * @param targets - 允许的会话 id 列表（已归一或未归一都可）。
 * @returns 是否命中。
 */
export function isTargetSession(scopeId, targets = DEFAULT_TARGET_SESSIONS) {
  const id = normalizeSessionId(scopeId);
  if (id === '') return false;
  const list = Array.isArray(targets) ? targets : DEFAULT_TARGET_SESSIONS;
  // ★ 开源版口径：**列表为空 = 不限制会话**（全会话共用一份记忆）。
  if (list.length === 0) return true;
  return list.some((candidate) => normalizeSessionId(candidate) === id);
}

/* ════════════ 运行时设置（来自 DSH 设置页 / cordis 配置） ════════════ */

/**
 * 当前生效的设置。
 *
 * 为什么是模块级变量而不是到处传参：
 *   `poolDef()` / `format.js` 这些地方在第 3、4 层调用里，一路传参会把签名污染一大片。
 *   `apply()` 在插件启动时调一次 `applyConfig(config)` 就够了 ——
 *   配置变了宿主会重新解析插件，`apply` 再跑一次，值就换新了。
 */
let runtime = {};

/** 应用一份设置（`apply()` 里调）。非法值会被忽略，回落到默认。 */
export function applyConfig(config) {
  runtime = (config && typeof config === 'object') ? { ...config } : {};
  return runtime;
}

/** 读当前设置（只读，别改它）。 */
export function getConfig() {
  return runtime;
}

/** 取一个数字设置，非法就回落到 fallback。 */
export function configNumber(key, fallback) {
  const value = Number(runtime?.[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 取某个池的寿命覆盖值（设置页里改了才有）。
 *
 * @param key - 池子的 key。
 * @returns `{ graceDays, halfLifeDays, archiveDays }` 的部分字段；没配就是空对象。
 */
export function poolOverride(key) {
  const pools = runtime?.pools;
  const entry = pools && typeof pools === 'object' ? pools[key] : undefined;
  if (!entry || typeof entry !== 'object') return {};
  const out = {};
  for (const field of ['graceDays', 'halfLifeDays', 'archiveDays']) {
    const value = Number(entry[field]);
    if (Number.isFinite(value) && value > 0) out[field] = value;
  }
  return out;
}
