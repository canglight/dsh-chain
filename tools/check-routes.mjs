#!/usr/bin/env node
/**
 * 自检：Web API 的**挂载前缀**必须和 api.js 里的**路由前缀**一致。
 *
 * 为什么要有它（2026-10-30 事故）：
 *   index.js 用 webCtx.webServer.register({ kind:'prefix', path:'/chain-shared' }) 挂整个 API；
 *   api.js 里的路由写成 `/chain-shared/api/graph`。
 *   一旦这里两边不一致（比如挂载写成 `/chain`），宿主会直接 404 —— 而 404 的 body 是空的，
 *   前端的 `r.json()` 抛 `Unexpected end of JSON input`，界面只显示「读取失败」。
 *   **症状像是前端坏了，其实是路由没接上。** 这个脚本就是防它。
 *
 * 用法：node tools/check-routes.mjs
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');

function read(name) {
  return readFileSync(join(LIB, name), 'utf8');
}

const indexSrc = read('index.js');
const apiSrc = read('api.js');
const clientSrc = read('client.js');

// ① 挂载前缀
const mount = (indexSrc.match(/prefix',\s*path:\s*'([^']+)'/) ?? [])[1] ?? '';
// ② api.js 里的路由前缀（取每个 path === '...' 的 /api/ 之前的部分）
const routePrefixes = [...new Set(
  [...apiSrc.matchAll(/path === '([^']+)'/g)]
    .map((m) => m[1].split('/api/')[0])
    .filter((p) => p.startsWith('/')),
)];
// ③ 前端请求用的前缀
const clientPrefixes = [...new Set(
  [...clientSrc.matchAll(/fetch\('(\/[^'?]+)/g)]
    .map((m) => m[1].split('/api/')[0])
    .filter((p) => p.startsWith('/')),
)];

const lines = [
  '挂载前缀   ' + (mount || '（没找到）'),
  '路由前缀   ' + (routePrefixes.join(', ') || '（没找到）'),
  '前端前缀   ' + (clientPrefixes.join(', ') || '（没找到）'),
];

const problems = [];
if (!mount) problems.push('index.js 里没有找到 webServer.register 的前缀');
if (routePrefixes.length === 0) problems.push('api.js 里没有找到任何路由');
if (routePrefixes.some((p) => p !== mount)) problems.push('api.js 的路由前缀和挂载前缀不一致');
if (clientPrefixes.some((p) => p !== mount)) problems.push('client.js 请求的前缀和挂载前缀不一致');

for (const line of lines) console.log('  ' + line);

if (problems.length > 0) {
  console.error('\n❌ ' + problems.join('；'));
  console.error('   后果：宿主 404 → 响应体为空 → 前端 r.json() 抛 Unexpected end of JSON input。');
  process.exit(1);
}
console.log('\n✔ 三处前缀一致');
