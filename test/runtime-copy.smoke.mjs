/**
 * 运行副本冒烟测试:确认 node_modules 那份(宿主实际加载的那份)也能被 import、
 * 注册工具并跑通 create → list → remove(乐观锁拒绝 + 删空回收板)→ 角色门拒绝,
 * 外加四条新口径的现场:
 *   ① 父子会话共板:子代理的写入落在**父会话那块板**上(boardKey = 根会话 id,boardSource = ancestor);
 *   ② 依赖缺失口径(blocked_by 指向的 id 被 remove / 从没建过 ⇒ 不算阻塞 + missingBlockers 提示);
 *   ③ 上溯失败回退:父会话已不是活对象 ⇒ 板键回退成调用者自己的会话 id,且**不报错、不拒调用**;
 *   ④ 领域存储(2026-09-26):用假 storageDomain 跑一遍**落盘 + 跨重启水合**,
 *      证明运行副本这份也能解析 `@deepseek-ai/dsh-storage-domain` / `zod` 并声明域(拿不到服务则降级)。
 * 且**每一次工具返回值都过严格无损 JSON 关口**(宿主契约:undefined / NaN / Map / Date /
 * 循环引用等一律让宿主拒掉整条调用)。
 * 只加载**运行副本**,证明两侧副本行为一致(配合 lib/index.js 的 SHA256 比对)。
 *
 * 运行:node test/runtime-copy.smoke.mjs(必须在 profile 目录 ~\.dsh\profiles\<profile 名> 下跑,
 * 脚本按 cwd 相对解析 node_modules/dsh-host-task-board/lib/index.js)
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const RUNTIME_COPY = pathToFileURL(resolve('node_modules/dsh-host-task-board/lib/index.js')).href
const mod = await import(RUNTIME_COPY)

// ── 活对象注册表桩(宿主:ctx.get('agents').get(id) → { session })────────────────
// 插件用它沿会话头的 parentSession 父链上溯到根会话;形状照抄宿主 AgentRegistry。
const LIVE_AGENTS = new Map()
const sessionStub = (id, parentSession, delegationDepth) => ({
  id,
  header: {
    id,
    cwd: 'C:\\__rt__\\p',
    agentPreset: mod.GATE_PRESET,
    ...(parentSession === undefined ? {} : { parentSession, origin: 'subagent' }),
    ...(delegationDepth === undefined ? {} : { delegationDepth }),
  },
})
const ROOT = sessionStub('s-rt-root')
const SUB = sessionStub('s-rt-sub', 's-rt-root', 1)
const OWNER_ROOT = sessionStub('s-rt-owner')
const GHOST_ROOT = sessionStub('s-rt-ghost')
/** 父会话不存在于活对象表里 ⇒ 上溯必然失败,用来验回退路径。 */
const ORPHAN = sessionStub('s-rt-orphan', 's-rt-gone', 1)
const OTHER = { id: 's-rt-other', header: { id: 's-rt-other', cwd: 'C:\\__rt__\\p', agentPreset: 'standard' } }
for (const session of [ROOT, SUB, OWNER_ROOT, GHOST_ROOT]) LIVE_AGENTS.set(session.id, { session })

/**
 * 假的 ctx.storageDomain(只实现本插件用到的那一小块):介质就是一个 Map,不碰真实 storages 目录。
 * 照搬真实域层的三条关键语义:同名域同时只能开一个(already-open)、开域时按 spec 的 schema 校验记录、
 * 写入异步且先落介质后改域内存。同一份 medium 传给两次 apply = 两次进程启动。
 */
function makeStorageStub(medium) {
  const opened = new Set()
  return {
    medium,
    async open(spec) {
      if (opened.has(spec.name)) { const error = new Error(`domain '${spec.name}' is already open`); error.code = 'already-open'; throw error }
      opened.add(spec.name)
      const unit = medium.get(spec.name) ?? new Map()
      medium.set(spec.name, unit)
      const tables = new Map()
      for (const [tableName, tableSpec] of Object.entries(spec.tables)) {
        const stored = unit.get(tableName) ?? new Map()
        unit.set(tableName, stored)
        const records = new Map()
        for (const [key, raw] of stored) records.set(key, tableSpec.valueSchema.parse(raw))
        tables.set(tableName, { records, stored })
      }
      let closed = false
      const assertOpen = () => { if (closed) throw new Error(`domain '${spec.name}' is closed`) }
      return {
        name: spec.name,
        table(tableName) {
          const entry = tables.get(tableName)
          if (entry === undefined) throw new Error(`domain '${spec.name}' declares no table '${tableName}'`)
          const { records, stored } = entry
          return {
            get: (key) => { assertOpen(); return records.get(key) },
            entries: () => { assertOpen(); return [...records.entries()][Symbol.iterator]() },
            keys: () => { assertOpen(); return [...records.keys()][Symbol.iterator]() },
            get size() { assertOpen(); return records.size },
            async put(key, value) {
              assertOpen()
              const serialized = JSON.parse(JSON.stringify(value))
              await Promise.resolve()
              stored.set(key, serialized)
              records.set(key, serialized)
            },
            async delete(key) {
              assertOpen()
              if (!records.has(key)) return false
              stored.delete(key)
              records.delete(key)
              return true
            },
          }
        },
        async close() { closed = true; opened.delete(spec.name) },
      }
    },
  }
}

const medium = new Map()
const storageStub = makeStorageStub(medium)

let tool = null
/**
 * 桩 ctx:register 记下工具;effect 记下 disposer(模拟"进程重启"时要靠它关掉旧实例的域)。
 * `inject` 的语义照抄真实 cordis(服务可用才执行回调、缺席不执行也不报错),因为插件的存储
 * 打开挂在 `ctx.inject(['storageDomain'], cb)` 上;`dispose()` 先跑存储子 fiber 的 disposer
 * 再跑本 fiber 的(与真实 cordis 的收尾顺序一致)。
 */
const makeCtx = (live, storage) => {
  const parentEffectors = []
  const childEffectors = []
  const ctx = {
    get: (serviceName) => (serviceName === 'tools'
      ? { register: (registered) => { tool = registered; return () => {} } }
      : serviceName === 'storageDomain' ? storage
        : live && serviceName === 'agents' ? { get: (id) => LIVE_AGENTS.get(id) } : undefined),
    inject: (names, callback) => {
      if (!names.every((serviceName) => ctx.get(serviceName) !== undefined)) return Promise.resolve()
      const child = {
        get: (serviceName) => ctx.get(serviceName),
        effect: (fn) => { const disposer = fn(); childEffectors.push(disposer); return () => { disposer?.() } },
      }
      return Promise.resolve(callback(child))
    },
    effect: (fn) => { const disposer = fn(); parentEffectors.push(disposer); return () => { disposer?.() } },
  }
  return {
    ctx,
    dispose: async () => {
      for (const disposer of childEffectors.splice(0)) await disposer?.()
      for (const disposer of parentEffectors.splice(0)) await disposer?.()
    },
  }
}
const first = makeCtx(true, storageStub)
const ctx = first.ctx
mod.apply(ctx, { MAX_DESCRIPTION_BYTES: 512 })
/** 第一份注册(带 storageDomain 的那份):后面的领域存储段要用它,因为 tool 会被后来的 apply 覆盖。 */
const storageTool = tool

// ── 严格无损 JSON 关口(与 task-board.test.mjs 同一套宿主契约,冒烟版精简重写)──────
// 宿主对工具返回值的要求是严格无损 JSON:undefined / 函数 / symbol / NaN / ±Infinity / 负零 /
// BigInt / Map / Set / Date / RegExp / 循环引用都会让宿主拒掉整条调用,报
//   tool "task_board" returned invalid output: value is not lossless JSON
// (规则出处:dsh-tools 的 snapshotToolValue() → dsh-util-values 的 snapshotJsonValue())
// 本脚本跑的是**宿主真正加载的那份运行副本** ⇒ 它也必须逐条过关(真实回归:create 不带 owner
// 时 toView() 回了 owner: undefined)。
function assertLosslessJson(value, label) {
  const ancestors = new Set()
  const walk = (node, path) => {
    const type = typeof node
    if (node === null || type === 'string' || type === 'boolean') return
    if (type === 'number') {
      assert.ok(Number.isFinite(node), `${path}: ${String(node)} 不是有限数(NaN / ±Infinity)`)
      assert.ok(!Object.is(node, -0), `${path}: 负零 -0 不合格(宿主 isJsonValue 明确拒 -0)`)
      return
    }
    if (type !== 'object') assert.fail(`${path}: 出现 ${type}(${String(node).slice(0, 40)})——严格无损 JSON 不允许`)
    assert.equal(
      Object.prototype.toString.call(node),
      Array.isArray(node) ? '[object Array]' : '[object Object]',
      `${path}: 不是数组也不是普通对象(Map / Set / Date / RegExp / 类实例都不合格)`,
    )
    if (!Array.isArray(node)) {
      assert.ok([Object.prototype, null].includes(Object.getPrototypeOf(node)), `${path}: 原型不是 Object.prototype`)
      assert.equal(Object.getOwnPropertySymbols(node).length, 0, `${path}: symbol 键不合格`)
    }
    assert.ok(!ancestors.has(node), `${path}: 循环引用`)
    ancestors.add(node)
    try {
      const keys = Object.keys(node)
      if (Array.isArray(node)) assert.equal(keys.length, node.length, `${path}: 数组上有空洞或非索引自有属性`)
      for (const key of keys) walk(node[key], Array.isArray(node) ? `${path}[${key}]` : `${path}.${key}`)
    } finally {
      ancestors.delete(node)
    }
  }
  walk(value, '$')
  assert.deepStrictEqual(JSON.parse(JSON.stringify(value)), value, `${label}:JSON 往返后与原值不深度相等`)
  return value
}

/** 过了关口的返回值计数(证明每次工具调用都过了关)。 */
let gatedReturns = 0
const call = async (args, session) => {
  const value = await tool.execute(args, { agent: { session, ctx } })
  gatedReturns += 1
  return assertLosslessJson(value, `${String(args.action)} 的返回值`)
}

assert.ok(tool !== null, '运行副本应注册工具')
assert.equal(tool.name, 'task_board')
assert.equal('project' in mod.TOOL_PARAMETERS, false, '运行副本的契约里也必须已无 project 参数')

const created = await call({ action: 'create', subject: '运行副本冒烟' }, ROOT)
assert.equal(created.ok, true)
assert.equal(created.task.id, 't1')
assert.equal(created.boardKey, 's-rt-root', '板键 = 根会话 id')
assert.equal(created.boardSource, 'self')
// 真实回归现场:create 不带 owner ⇒ 返回体里**不得有 owner 键**(undefined 会被宿主拒掉整条调用)
assert.equal('owner' in created.task, false, 'create 无 owner ⇒ 任务视图里没有 owner 键')

const listed = await call({ action: 'list' }, SUB)
assert.equal(listed.total, 1)
assert.equal(listed.boardKey, 's-rt-root', '子代理看到的是父会话那块板')
assert.equal(listed.boardSource, 'ancestor', '沿 parentSession 上溯到根会话')
assert.equal('owner' in listed.tasks[0], false, 'list 行同样不得有 owner 键')
// 落会话历史的就是 render 这行 JSON ⇒ 它必须是返回值的无损序列化
const rendered = tool.output.render({ action: 'list' }, listed)
assert.equal(rendered[0].type, 'text')
assert.deepStrictEqual(JSON.parse(rendered[0].text.split('\n')[1]), listed, 'render 的 JSON 行必须可无损解析回返回值')

const gotOwnerless = await call({ action: 'get', id: 't1' }, SUB)
assert.equal('owner' in gotOwnerless.task, false, 'get 无 owner 的任务同样没有 owner 键')

// ── 父子共板(2026-09-25 口径):子代理的写入落在父会话那块板上,且与父会话条目连号 ──
const bySub = await call({ action: 'create', subject: '子代理写的', blocked_by: ['t1'] }, SUB)
assert.equal(bySub.boardKey, 's-rt-root', '子代理与父会话共用一块板')
assert.equal(bySub.boardSource, 'ancestor')
assert.equal(bySub.task.id, 't2', 'id 与父会话写的 t1 连号 ⇒ 确实是同一块板')
assert.equal(bySub.task.ready, false, 't1 在同一块板上且未完成 ⇒ 未就绪(反证板是同一块)')
const rootSeesBoth = await call({ action: 'list' }, ROOT)
assert.equal(rootSeesBoth.total, 2, '父会话能看到子代理写的条目')

// 相邻情形:带 owner 的任务必须有 owner 键(另一个**根会话** = 另一块板,用完删空回收)
const owned = await call({ action: 'create', subject: '带 owner', owner: 'sub-rt' }, OWNER_ROOT)
assert.equal(owned.task.owner, 'sub-rt', 'create 带 owner ⇒ 视图里必须有 owner 键')
assert.equal(owned.boardKey, 's-rt-owner', '另一个根会话是另一块板')
const ownedRemoved = await call({ action: 'remove', id: 't1', expected_revision: 1 }, OWNER_ROOT)
assert.equal(ownedRemoved.boardRemoved, true, '临时板删空即回收')

// 依赖缺失口径(2026-09-25):blocked_by 指向的 id 被 remove 或从没建过 ⇒ **不算阻塞**,但要在视图里提示。
// 单独一块板,跑完删空回收,不影响下面 `removed.boards === 0` 的计数断言。
const ghost = await call({ action: 'create', subject: '依赖从未存在', blocked_by: ['t99'] }, GHOST_ROOT)
assert.equal(ghost.task.ready, true, '依赖不在板上 ⇒ 不算阻塞(ready=true)')
assert.deepEqual(ghost.task.missingBlockers, ['t99'], '缺失的依赖 id 要在视图里如实回报')
assert.ok(ghost.summary.includes('missingBlockers=t99'), '摘要要提一句')
const ghostDep = await call({ action: 'create', subject: '先建依赖' }, GHOST_ROOT)
assert.equal(ghostDep.task.id, 't2')
const ghostBlocked = await call({ action: 'create', subject: '依赖还在板上', blocked_by: ['t2'] }, GHOST_ROOT)
assert.equal(ghostBlocked.task.ready, false, '依赖存在但未 completed ⇒ 仍不就绪')
assert.equal('missingBlockers' in ghostBlocked.task, false, '依赖都在板上 ⇒ 省略该键')
await call({ action: 'remove', id: 't2', expected_revision: 1 }, GHOST_ROOT)
const ghostAfter = await call({ action: 'get', id: 't3' }, GHOST_ROOT)
assert.equal(ghostAfter.task.ready, true, '阻塞项被 remove ⇒ 依赖方转为就绪')
assert.deepEqual(ghostAfter.task.missingBlockers, ['t2'], 'get 要报出已不在板上的依赖 id')
const ghostCleanup = []
for (const [gid, grev] of [['t1', 1], ['t3', 1]]) {
  ghostCleanup.push(await call({ action: 'remove', id: gid, expected_revision: grev }, GHOST_ROOT))
}
assert.equal(ghostCleanup.at(-1).boardRemoved, true, '依赖缺失试验板删空即回收')
assert.equal(ghostCleanup.at(-1).boards, 1, '回收后只剩 s-rt-root 那块板')

// remove 乐观锁:过期 revision 必须被拒(与 update 同一套 CAS),且不改动板上状态
let staleMsg = ''
try {
  await call({ action: 'remove', id: 't1', expected_revision: 9 }, ROOT)
  assert.fail('过期 revision 的 remove 应被拒')
} catch (error) {
  staleMsg = String(error?.message ?? error)
}
assert.match(staleMsg, /revision 冲突/)
assert.match(staleMsg, /最新 revision 已是 1/)
const stillThere = await call({ action: 'list' }, ROOT)
assert.equal(stillThere.total, 2, '被拒的 remove 不得改动板上状态')

// 建 → 删 → 确认板回收:删空后板本身被删除,板数随之下降
const rmFirst = await call({ action: 'remove', id: 't2', expected_revision: 1 }, SUB)
assert.equal(rmFirst.remaining, 1, '子代理也能删父会话板上的条目(同一块板)')
const removed = await call({ action: 'remove', id: 't1', expected_revision: 1 }, ROOT)
assert.equal(removed.ok, true)
assert.equal(removed.removed, 't1')
assert.equal(removed.remaining, 0, '删掉唯一一条 ⇒ 板内剩 0 条')
assert.equal(removed.boardRemoved, true, '删空 ⇒ 回收板')
assert.equal(removed.boards, 0, '回收后板数归零')

const goneBucket = await call({ action: 'list' }, ROOT)
assert.equal(goneBucket.ok, false, '板已回收 ⇒ list 回到"还没有任务板"')
assert.match(goneBucket.summary, /还没有任务板/)

const denied = await call({ action: 'list' }, OTHER)
assert.equal(denied.ok, false)
assert.equal(denied.denied, 'preset')

// 上溯失败 ⇒ 回退本会话 id(绝不报错、绝不拒调用);服务整体拿不到时同一路径
const orphan = await call({ action: 'create', subject: '父会话不在活对象表里' }, ORPHAN)
assert.equal(orphan.ok, true, '解析失败不得拒调用')
assert.equal(orphan.boardKey, 's-rt-orphan', '回退成调用者自己的会话 id')
assert.equal(orphan.boardSource, 'fallback')
assert.ok(orphan.summary.includes('板键回退'), '摘要要明说用了回退键')
const offlineInstance = makeCtx(false, undefined)
mod.apply(offlineInstance.ctx, {})
const offline = await assertLosslessJson(
  await tool.execute({ action: 'list' }, { agent: { session: ORPHAN, ctx: offlineInstance.ctx } }),
  'list 的返回值(服务不可用)',
)
gatedReturns += 1
assert.equal(offline.boardKey, 's-rt-orphan', 'agents / sessions 都拿不到时同样回退本会话 id')
assert.equal(offline.boardSource, 'fallback')
assert.equal(offline.total, 1, '回退只影响板键:两次回退落到同一块回退板上(前面 create 写的那条)')

// ── 领域存储(2026-09-26):运行副本这份也要能声明域、落盘、跨"重启"水合回来 ──────────
// 介质是内存里的 Map(不碰真实 storages 目录);同一份介质先后传给两个 apply 实例 = 两次进程启动。
// ⚠ 这里必须**显式指定用哪份工具注册**:`tool` 会被后来的 apply 覆盖(上一段刚用无存储的那份
//   覆盖过一次)⇒ 用 storageTool / restartTool 才落在带存储的实例上。
const STORE_ROOT = sessionStub('s-rt-store-root')
const STORE_SUB = sessionStub('s-rt-store-sub', 's-rt-store-root', 1)
LIVE_AGENTS.set(STORE_ROOT.id, { session: STORE_ROOT })
/** 指定某份注册的调用(同样过严格无损 JSON 关口)。 */
const callVia = async (registered, args, session) => {
  const value = await registered.execute(args, { agent: { session, ctx } })
  gatedReturns += 1
  return assertLosslessJson(value, `${String(args.action)} 的返回值`)
}
assert.equal(mod.DOMAIN_SPEC.name, 'task_board', 'domain 名必须匹配宿主 UNIT_NAME_RE(连字符会让模块加载期抛)')
assert.equal(mod.__storageStatus(ctx).status, 'ready', '运行副本这份也要能把域打开(证明 storage-domain / zod 解析成功)')

const persisted = await callVia(storageTool, { action: 'create', subject: '落盘冒烟', status: 'in_progress' }, STORE_ROOT)
assert.equal(persisted.task.id, 't1')
const persistedBySub = await callVia(storageTool, { action: 'create', subject: '子代理也写这块板', blocked_by: ['t1'] }, STORE_SUB)
assert.equal(persistedBySub.task.id, 't2')
await callVia(storageTool, { action: 'update', id: 't1', expected_revision: 1, status: 'completed' }, STORE_ROOT)
const storedRecord = medium.get('task_board')?.get('boards')?.get('s-rt-store-root')
assert.ok(storedRecord !== undefined, '介质里必须真有这条板记录')
assert.equal(storedRecord.seq, 2, 'seq 落盘')
assert.deepEqual(storedRecord.tasks.map((task) => task.id), ['t1', 't2'])
assert.equal(storedRecord.tasks[0].revision, 2, 'update 后的 revision 立刻落盘')

// 模拟"进程重启":关掉旧实例的域(disposer 先 await 打开落定,再 close)+ 清空内存板 + 同一份介质上新建 apply 实例
await first.dispose()
mod.__resetForTest()
const afterRestartInstance = makeCtx(true, makeStorageStub(medium))
mod.apply(afterRestartInstance.ctx, { MAX_DESCRIPTION_BYTES: 512 })
const restartTool = tool
const afterRestart = await callVia(restartTool, { action: 'list' }, STORE_ROOT)
assert.equal(afterRestart.ok, true, '重启后板还在')
assert.equal(afterRestart.total, 2, '重启后两条都从介质水合回来')
assert.equal(afterRestart.tasks[0].revision, 2, 'revision 跨重启存活')
assert.equal(afterRestart.boardSource, 'self')
const afterRestartSub = await callVia(restartTool, { action: 'get', id: 't2' }, STORE_SUB)
assert.equal(afterRestartSub.task.ready, true, '依赖关系也活着(t1 已 completed)')
assert.equal(afterRestartSub.boardKey, 's-rt-store-root', '重启后父子共板口径不变')
const staleAfterRestart = await (async () => {
  try {
    await callVia(restartTool, { action: 'update', id: 't1', expected_revision: 1, subject: 'x' }, STORE_ROOT)
    return ''
  } catch (error) { return String(error?.message ?? error) }
})()
assert.match(staleAfterRestart, /最新 revision 已是 2/, 'CAS 跨重启仍生效(过期 rev 被拒并回最新值)')
const casAfterRestart = await callVia(restartTool, { action: 'update', id: 't1', expected_revision: 2, subject: '重启后改的' }, STORE_ROOT)
assert.equal(casAfterRestart.revision, 3)
assert.equal(medium.get('task_board').get('boards').get('s-rt-store-root').tasks[0].revision, 3, '成功写立刻落盘')

console.log(`运行副本 OK:${RUNTIME_COPY}`)
console.log(`  create → ${created.summary}`)
console.log(`  list   → ${listed.summary}`)
console.log(`  共板   → 子代理写 ${bySub.boardKey}/${bySub.task.id}(source=${bySub.boardSource}),父会话 list 见到 ${rootSeesBoth.total} 条`)
console.log(`  owner  → create 无 owner:无键 / 带 owner:有键(相邻情形)`)
console.log(`  依赖缺失 → 从未存在/已被 remove 均不阻塞:t3 ready=${ghostAfter.task.ready} missingBlockers=${ghostAfter.task.missingBlockers.join(',')}`)
console.log(`  remove → ${removed.summary}`)
console.log(`  remove 乐观锁 → 过期 rev 被拒:${staleMsg.split('。')[0]}`)
console.log(`  板回收 → boards=${removed.boards},list.ok=${goneBucket.ok}`)
console.log(`  角色门 → ok=${denied.ok} denied=${denied.denied}`)
console.log(`  回退   → 父会话不在活对象表里/服务不可用 ⇒ boardKey=${orphan.boardKey} source=${orphan.boardSource}(不报错)`)
console.log(`  领域存储 → 域 ${mod.DOMAIN_SPEC.name} v${mod.DOMAIN_SPEC.version}:记录 seq=${storedRecord.seq} tasks=${storedRecord.tasks.length};`
  + `跨重启后 list=${afterRestart.total} 条 rev=${afterRestart.tasks[0].revision},CAS 仍生效`)
console.log(`  严格无损 JSON → ${gatedReturns} 次返回值全过关(undefined/NaN/Map/Date/循环引用等一律拒)`)
console.log(`  render()  → 摘要行 + 紧凑 JSON,可无损解析回返回值`)
