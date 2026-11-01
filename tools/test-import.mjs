// Run: node tools/test-import.mjs
// All writes (including legacy tools and injected I/O failures) use a private fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temp = fs.mkdtempSync(path.join(root, 'tools', '.test-import-'));
const checks = [];
const check = (name) => { checks.push(name); console.log(`PASS ${name}`); };
const snapshot = (file) => fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);

function validate(schema, value) {
  if (schema.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.equal(schema.additionalProperties, false);
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), key);
    for (const [key, field] of Object.entries(value)) {
      assert.ok(schema.properties[key], key);
      validate(schema.properties[key], field);
    }
  } else if (schema.type === 'array') {
    assert.ok(Array.isArray(value));
    value.forEach((item) => validate(schema.items, item));
  } else if (schema.type === 'integer') assert.ok(Number.isInteger(value));
  else assert.equal(typeof value, schema.type);
  if (schema.enum) assert.ok(schema.enum.includes(value));
}

async function patched(object, replacements, task) {
  const originals = Object.fromEntries(Object.keys(replacements).map((key) => [key, object[key]]));
  Object.assign(object, replacements);
  syncBuiltinESMExports();
  try { return await task(); } finally {
    Object.assign(object, originals);
    syncBuiltinESMExports();
  }
}

try {
  const lib = path.join(temp, 'lib');
  fs.mkdirSync(lib);
  for (const file of fs.readdirSync(path.join(root, 'lib')).filter((name) => name.endsWith('.js'))) {
    fs.copyFileSync(path.join(root, 'lib', file), path.join(lib, file));
  }
  fs.writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}');
  const configFile = path.join(lib, 'config.js');
  const source = fs.readFileSync(configFile, 'utf8');
  const expression = "return join(homedir(), '.dsh', 'memories', STORE_DIR_NAME);";
  assert.ok(source.includes(expression), 'fixture must redirect the store before importing modules');
  fs.writeFileSync(configFile, source.replace(expression, `return ${JSON.stringify(path.join(temp, 'data'))};`));
  const indexFile = path.join(lib, 'index.js');
  assert.ok(fs.readFileSync(indexFile, 'utf8').includes('ctx.tools.register(defineImportTool())'));
  fs.appendFileSync(indexFile, '\nexport { defineImportTool, defineAppendTool, defineTouchTool, defineRecallTool };\n');
  const mod = await import(pathToFileURL(indexFile));
  const store = await import(pathToFileURL(path.join(lib, 'store.js')));
  const config = await import(pathToFileURL(configFile));
  const { POOLS } = await import(pathToFileURL(path.join(lib, 'pools.js')));
  const file = config.storePath();
  assert.ok(path.resolve(file).startsWith(path.resolve(temp) + path.sep));
  const tool = mod.defineImportTool();
  assert.equal(tool.name, 'chain_import');
  const poolSchema = tool.parameters.properties.appends.items.properties.pool;
  assert.equal(poolSchema.enum, undefined, 'invalid pool names must reach per-item validation');
  Object.keys(POOLS).forEach((pool) => assert.ok(poolSchema.description.includes(pool)));
  async function run(input, definition = tool) {
    const output = await definition.execute(input);
    validate(definition.output.schema, output);
    definition.output.render(input, output);
    return output;
  }
  const append = (judgement, pool = 'skillRule') => ({ judgement, pool, evidence: ['verified evidence'] });
  const entry = (id) => store.loadAll().entries.find((value) => value.id === id);

  const emptyDry = await patched(crypto, { randomBytes: () => { throw new Error('dry-run generated an id'); } },
    () => run({ dryRun: true, appends: [append('first preview')] }));
  assert.equal(emptyDry.created[0].id, '');
  assert.equal(fs.existsSync(config.storeDir()), false);
  assert.deepEqual(await run({}), { ok: true, dryRun: false, created: [], retired: 0, merged: 0, errors: [] });
  assert.equal(fs.existsSync(config.storeDir()), false);
  check('dry-run generates no ids and creates no directory/file; empty import is a no-op');

  const fragments = Array.from({ length: 36 }, (_, i) => store.appendChain({
    judgement: `fragment ${i}`, evidence: ['source'], tags: ['海马体'], weight: 0.7,
  }));
  // A fact retagged into hippocampus must be retireable; raw JSONL has no pool column.
  fragments[0] = store.appendChain({ judgement: 'converted fact', tags: ['用户'] });
  store.appendChainEvent({ id: fragments[0].id, type: 'retag', pool: 'hippocampus' });
  const protectedEntries = Object.keys(POOLS).filter((pool) => pool !== 'hippocampus').map((pool) => {
    const value = store.appendChain({ judgement: `protected ${pool}`, tags: ['海马体'] });
    store.appendChainEvent({ id: value.id, type: 'retag', pool });
    return value;
  });
  const body = {
    appends: Array.from({ length: 13 }, (_, i) => ({
      ...append(`import-lookup-${String(i).padStart(2, '0')} ${'判断依据'.repeat(12)}`),
      conclusion: 'because verified', hesitation: ['alternative'], weight: 0.7, tags: ['教训'],
    })),
    retire: fragments.slice(0, 30).map((value) => value.id),
    merge: Array.from({ length: 3 }, (_, i) => ({
      ids: fragments.slice(30 + i * 2, 32 + i * 2).map((value) => value.id), pool: 'fact',
    })),
  };
  const before = snapshot(file);
  assert.equal(before.toString().trim().split('\n').map(JSON.parse).filter((row) => row.pool === 'hippocampus').length, 1);
  const dry = await patched(crypto, { randomBytes: () => { throw new Error('dry-run generated an id'); } },
    () => run({ ...body, dryRun: true }));
  assert.equal(dry.ok, true);
  assert.equal(dry.created.length, 13);
  assert.equal(dry.retired, 30);
  assert.equal(dry.merged, 6);
  assert.ok(dry.created.every((value) => value.id === '' && Array.from(value.judgement).length === 31));
  assert.deepEqual(snapshot(file), before);
  assert.equal(fs.statSync(file).size, before.length);
  check('full dry-run previews 13 appends + 30 retires + 6 merged entries, byte-for-byte unchanged');

  let writes = 0;
  const originalWrite = fs.writeSync;
  const imported = await patched(fs, { writeSync: (...args) => { writes++; return originalWrite(...args); } }, () => run(body));
  assert.equal(imported.ok, true);
  assert.equal(imported.created.length, 13);
  assert.equal(imported.retired, 30);
  assert.equal(imported.merged, 6);
  assert.equal(writes, 1, 'normal batch uses one write');
  const addedRows = snapshot(file).subarray(before.length).toString().trim().split('\n').map(JSON.parse);
  assert.equal(addedRows.length, 13 * 2 + 30 + 6);
  assert.equal(addedRows.filter((row) => row.type === 'retag').length, 19);
  for (const value of imported.created) {
    assert.match(value.id, /^c_[0-9a-f]{8}$/);
    assert.equal(entry(value.id).pool, 'skillRule');
    assert.equal(entry(value.id).rawWeight, 0.7);
    assert.equal(entry(value.id).touchCount, 0);
    assert.deepEqual(entry(value.id).evidence, ['verified evidence']);
  }
  body.retire.forEach((id) => assert.equal(entry(id).superseded, true));
  body.merge.flatMap((group) => group.ids).forEach((id) => {
    assert.equal(entry(id).pool, 'fact');
    assert.equal(entry(id).superseded, false);
    assert.equal(entry(id).rawWeight, 0.7);
    assert.equal(entry(id).touchCount, 0);
  });
  const recalled = await run({ query: 'import-lookup-', limit: 20 }, mod.defineRecallTool({}));
  assert.deepEqual(new Set(recalled.entries.map((value) => value.id)), new Set(imported.created.map((value) => value.id)));
  check('one real import writes 62 rows in one write; all 13 real ids immediately recallable');

  const mixedBefore = snapshot(file);
  const invalid = {
    appends: [append('bad pool', 'xxx'), { ...append('no evidence'), evidence: [] },
      { ...append('  '), evidence: ['source'] }, { ...append('empty evidence'), evidence: ['  '] }, append('valid partial import', 'fact')],
    retire: ['c_missing', ...protectedEntries.map((value) => value.id)],
    merge: [{ ids: [fragments[30].id, 'c_missing'], pool: 'skillRule' },
      { ids: [fragments[31].id], pool: '__proto__' }],
  };
  const mixedDry = await run({ ...invalid, dryRun: true });
  assert.deepEqual(snapshot(file), mixedBefore);
  const mixed = await run(invalid);
  assert.equal(mixed.ok, false);
  assert.equal(mixed.created.length, 1);
  assert.equal(mixed.created[0].pool, 'fact');
  assert.equal(mixed.retired, 0);
  assert.equal(mixed.merged, 0);
  assert.deepEqual(mixed.errors, mixedDry.errors);
  for (const where of ['appends[0]', 'appends[1]', 'appends[2]', 'appends[3]', 'retire[0]', 'merge[0]', 'merge[1]']) {
    assert.ok(mixed.errors.some((error) => error.where === where), where);
  }
  protectedEntries.forEach((value) => assert.equal(entry(value.id).superseded, false));
  assert.equal(entry(fragments[30].id).pool, 'fact', 'invalid merge rejects the entire group');
  check('invalid pools/evidence/judgements/ids and every protected pool rejected; valid partial success reported');

  const malformedBefore = snapshot(file);
  for (const input of [null, [], { dryRun: 'true', appends: [append('must not write')] },
    { appends: {}, retire: 'id', merge: null },
    { appends: [null, { ...append('bad fields'), hesitation: 'x', tags: [2], conclusion: 1, weight: '0.7' }],
      retire: [null, {}], merge: [null, { ids: [], pool: 'fact' }, { ids: 'x', pool: 'fact' }] }]) {
    const rejected = await run(input);
    assert.equal(rejected.ok, false);
    assert.ok(rejected.errors.length > 0);
  }
  assert.deepEqual(snapshot(file), malformedBefore);
  check('malformed payloads are rejected without writes, including non-boolean dryRun');

  const legacyAppend = mod.defineAppendTool({});
  const legacyTouch = mod.defineTouchTool({});
  const legacy = await run({ judgement: 'legacy works', conclusion: 'compatible', evidence: ['source'], tags: ['教训'] }, legacyAppend);
  await run({ id: legacy.id, outcome: 'set-pool', pool: 'skillExp' }, legacyTouch);
  await run({ id: legacy.id, outcome: 'confirmed' }, legacyTouch);
  assert.equal(entry(legacy.id).pool, 'skillExp');
  assert.equal(entry(legacy.id).touchCount, 1);
  assert.equal(entry(legacy.id).rawWeight, 0.5);
  assert.equal(entry(legacy.id).weight, 0.55);
  await run({ ids: [legacy.id], outcome: 'superseded' }, legacyTouch);
  assert.equal(entry(legacy.id).superseded, true);
  check('legacy chain_append and chain_touch signatures/behavior preserved');

  const dedup = await run({ retire: [fragments[0].id, fragments[0].id], merge: [
    { ids: [fragments[30].id, fragments[30].id], pool: 'fact' },
    { ids: [fragments[30].id], pool: 'skillRule' },
  ] });
  assert.equal(dedup.ok, true);
  assert.equal(dedup.retired, 1);
  assert.equal(dedup.merged, 1);
  assert.equal(entry(fragments[30].id).pool, 'skillRule');
  const pools = await run({ appends: Object.keys(POOLS).map((pool) => append(`pool ${pool}`, pool)) });
  assert.equal(pools.ok, true);
  pools.created.forEach((value) => assert.equal(entry(value.id).pool, value.pool));
  check('duplicates counted once, last merge group wins; all legal pools match materialized state');

  const ioBody = { appends: [append('io failure')], retire: [fragments[0].id],
    merge: [{ ids: [fragments[31].id, fragments[32].id], pool: 'skillRule' }] };
  const ioBefore = snapshot(file);
  const brokenWrite = (_fd, buffer, offset, size) => {
    originalWrite(_fd, buffer, offset, Math.min(size, 20));
    throw new Error('injected disk failure');
  };
  const rolledBack = await patched(fs, { writeSync: brokenWrite }, () => run(ioBody));
  assert.equal(rolledBack.ok, false);
  assert.equal(rolledBack.created.length, 0);
  assert.equal(rolledBack.retired, 0);
  assert.equal(rolledBack.merged, 0);
  assert.deepEqual(snapshot(file), ioBefore, JSON.stringify(rolledBack));
  assert.ok(rolledBack.errors.some((error) => error.where === 'write' && error.reason.includes('回滚')));
  check('disk failure rolls back to the exact original bytes and reports unperformed operations');

  const failRollback = () => { throw new Error('injected rollback failure'); };
  // Persist append+retag, retire, and one id from a two-id merge; then fail mid-row.
  const partial = await patched(fs, {
    writeSync: (fd, buffer, offset) => {
      const lines = buffer.toString().split('\n');
      const size = Buffer.byteLength(lines.slice(0, 4).join('\n') + '\n') + 5;
      originalWrite(fd, buffer, offset, size);
      throw new Error('injected partial write');
    }, truncateSync: failRollback,
  }, () => run(ioBody));
  assert.equal(partial.ok, false);
  assert.equal(partial.created.length, 1);
  assert.equal(entry(partial.created[0].id).pool, 'skillRule');
  assert.equal(partial.retired, 1);
  assert.equal(partial.merged, 1);
  assert.equal(entry(fragments[31].id).pool, 'skillRule');
  assert.equal(entry(fragments[32].id).pool, 'fact');
  assert.ok(partial.errors.some((error) => error.where === 'merge[0]' && error.reason.includes('前 1')));
  assert.ok(partial.errors.some((error) => error.where === 'write' && error.reason.includes('回滚失败')));
  fs.writeFileSync(file, ioBefore);
  // Persist only the new judgement: report its real fallback pool and failed retag.
  const unpinned = await patched(fs, {
    writeSync: (fd, buffer, offset) => {
      originalWrite(fd, buffer, offset, buffer.indexOf(10) + 1);
      throw new Error('failed before retag');
    }, truncateSync: failRollback,
  }, () => run(ioBody));
  assert.equal(unpinned.created.length, 1);
  assert.equal(unpinned.created[0].pool, 'hippocampus');
  assert.equal(entry(unpinned.created[0].id).pool, 'hippocampus');
  assert.ok(unpinned.errors.some((error) => error.where === 'appends[0]' && error.reason.includes('定池未完成')));
  fs.writeFileSync(file, ioBefore);
  check('failed rollback reports only persisted rows, including partial merge and append without retag');

  // Exercise short writes, and appending after a complete legacy line lacking its newline.
  fs.writeFileSync(file, ioBefore.toString().trimEnd());
  const short = await patched(fs, { writeSync: (fd, buffer, offset, size) =>
    originalWrite(fd, buffer, offset, Math.min(size, 11)) }, () => run({ appends: [append('short writes')] }));
  assert.equal(short.ok, true);
  assert.equal(store.loadAll().skipped, 0);
  assert.equal(entry(short.created[0].id).pool, 'skillRule');
  check('short writes and files without trailing newline are handled safely');

  console.log(`\n${checks.length} checks passed. All memory writes were isolated fixtures.`);
} finally {
  const resolved = path.resolve(temp);
  const intended = path.resolve(root, 'tools') + path.sep;
  assert.ok(resolved.startsWith(intended) && path.basename(resolved).startsWith('.test-import-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
