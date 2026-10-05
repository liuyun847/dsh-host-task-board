/**
 * dsh-host-task-board 桩测试(不重启 dsh、不接触宿主、不写任何真实文件)。
 *
 * 做法:
 *   · defineTool 走**真实实现**(@deepseek-ai/dsh-tools,与宿主同一份模块);
 *   · 域声明走**真实实现**(@deepseek-ai/dsh-storage-domain 的 defineDomain / domainTable + 真实 zod schema);
 *   · ctx 是桩:假 register/effect/get(含 agents / sessions 两个活对象注册表的桩),记录注册到的工具与日志;
 *   · 存储用**假 storageDomain**(介质就是一个 Map,见 makeStorageDomainStub):不碰真实 storages 目录,
 *     但把真实域层的关键语义照搬过来 —— 开域时按 spec 的 schema 逐条校验、写入异步且先落介质后改内存、
 *     close 后不可用。用例 18 用它模拟"进程重启"(同一份介质 + 清空内存 + 新建 apply 实例)。
 *   · 用例经 useCase() 注册,**在插件的 applyInner 之内**(同步函数体)执行 ⇒
 *     一条链多个用例靠共享的状态对象串联,顺带断言了"apply 真的跑完且没抛错"
 *     (apply 的 try/catch 会把注册期抛错静默降级成"工具未注册")。
 *   · 业务调用走 tool.execute(args, {agent:{session, ctx}}) —— 参数校验层也是真实的。
 *
 * 分桶口径(2026-09-25 用户决定):板键 = **根会话 id**,沿会话头 parentSession 父链在内存里上溯。
 * 所以本文件的"第二块板"= 另一个**根会话**,父子/祖孙代理共用一块板 —— 见用例 2 / 2c / 3 /
 * 3b(共板与隔离)与 16(四种解析失败一律回退调用者自己的会话 id)。
 * `project` 参数已从契约里删除(用例 12 钉住"传了也不参与分桶");增长型上限(每板任务数、板数)已删,
 * 只剩单字段上限(用例 8 两侧都钉:该拒的拒、该放的放)。
 *
 * 运行:node test/task-board.test.mjs
 */
import assert from 'node:assert/strict'
import {
  apply, useCase, __resetForTest, __storageStatus, dispatch, resolveBoardKey,
  TOOL_NAME, GATE_PRESET, LIMITS, TOOL_DESCRIPTION, TOOL_PARAMETERS,
  DOMAIN_NAME, TABLE_BOARDS, DOMAIN_SPEC,
} from '../lib/index.js'

const DESCRIBE_LIMIT = 512

// ── 会话桩 ────────────────────────────────────────────────────────────────
/** 所有桩会话共用一个 cwd:证明**分桶与 cwd 无关**(同一个 cwd 下可以是两块不同的板)。 */
const SHARED_CWD = 'C:\\__tb_test__\\shared-cwd'

/**
 * 造一个会话桩。`parentSession` 有值即模拟子代理会话头 —— 形状照抄宿主:
 * dsh-subagent 的 childSessionMeta() 写入 parentSession / origin='subagent' / delegationDepth
 * (dsh-subagent/lib/index.js:470-481)。
 */
function sessionStub(id, parentSession, delegationDepth) {
  return {
    id,
    header: {
      id,
      cwd: SHARED_CWD,
      agentPreset: GATE_PRESET,
      ...(parentSession === undefined ? {} : { parentSession, origin: 'subagent' }),
      ...(delegationDepth === undefined ? {} : { delegationDepth }),
    },
  }
}

/** 顶层协调者会话 = 板 A 的根;SUB 是它的直接子代理,GRAND 是孙代理,SIBLING 是兄弟子代理。 */
const ROOT = sessionStub('s-root')
const SUB = sessionStub('s-sub', 's-root', 1)
const GRAND = sessionStub('s-grand', 's-sub', 2)
const SIBLING = sessionStub('s-sub-b', 's-root', 1)
/** 另一个顶层会话 = **另一块板**(同一 cwd,照样互不可见)。 */
const ROOT_B = sessionStub('s-root-b')
/** owner 口径专用板:用例内建完即删空回收,不影响后面的板数断言。 */
const OWNER_ROOT = sessionStub('s-root-owner')
/** 依赖缺失口径专用板(被依赖项 remove / 从未存在):同样在用例内删空回收,不干扰板数断言。 */
const MISSING_ROOT = sessionStub('s-root-missing')
const MISSING_SUB = sessionStub('s-missing-sub', 's-root-missing', 1)
/** 回退口径专用会话:父会话已销毁的子代理。 */
const ORPHAN_SUB = sessionStub('s-orphan-sub', 's-root-gone', 1)
/** 角色门反例。 */
const OTHER = { id: 's-other', header: { id: 's-other', cwd: SHARED_CWD, agentPreset: 'standard' } }
const NO_PRESET = { id: 's-nopreset', header: { id: 's-nopreset', cwd: SHARED_CWD } }

// ── 活对象注册表桩(宿主:ctx.get('agents') / ctx.get('sessions'))────────────
/**
 * 宿主里这两个服务是**活对象**注册表(dsh-agent 的 AgentRegistry / dsh-session 的 SessionStore),
 * `get(id)` 只查内存、返回活对象或 undefined。插件正是用它们解析父链。
 * `LIVE_AGENTS`:id → { session }(AgentRegistry 形状);`LIVE_SESSIONS`:id → session(SessionStore 形状)。
 */
const LIVE_AGENTS = new Map()
const LIVE_SESSIONS = new Map()
/** 把一个会话登记为"活代理"(默认口径);可再单独放进 LIVE_SESSIONS 验"只有活会话没有活代理"。 */
function revive(...sessions) {
  for (const session of sessions) LIVE_AGENTS.set(session.id, { session })
}

// ── 桩 ctx ────────────────────────────────────────────────────────────────
/**
 * @param options.live 是否提供 agents / sessions 服务。
 *   false = 模拟"服务拿不到"(插件必须走回退,绝不因此报错)。
 * @param options.storage 假的 storageDomain 设施(见 makeStorageDomainStub)。
 *   不给 = 模拟"宿主没挂 storageDomain" ⇒ 插件必须降级为纯内存态并打警告(用例 18d 钉住这条)。
 *
 * ⚠ 桩必须实现 `inject`,而且语义要**照抄真实 cordis**(cordis 4.0.4 的
 * Fiber 构造 + _checkImpl/_refresh/_setEpoch):插件现在把存储打开挂在
 * `ctx.inject(['storageDomain'], cb)` 上(见 lib/index.js 的 W1 说明)。
 *   · 服务**可用** ⇒ 立刻用子 ctx 执行回调(真实 cordis 是同一 tick 的微任务里跑;桩同步跑,
 *     差别只在于"storage.ready 是否已经指向真正的打开 promise"这件事的时机,断言不依赖它);
 *   · 服务**不可用** ⇒ **不执行**回调、不报错、不阻塞其它注册(桩只记一笔 pending,便于断言);
 *   · 子 ctx 的 effect 单独记账:父 fiber 卸载时先跑子 disposer、再跑父 disposer(与真实一致)。
 */
function makeCtx({ live = true, storage = undefined } = {}) {
  const state = { registered: [], logs: [], disposed: 0, effectors: [], injected: [], childEffectors: [] }
  const ctx = {
    get(serviceName) {
      if (serviceName === 'tools') {
        return {
          register(tool) {
            state.registered.push(tool)
            return () => { state.disposed += 1 }
          },
        }
      }
      if (serviceName === 'storageDomain') return storage
      if (!live) return undefined
      // 两个活对象注册表的桩:形状与宿主一致(get(id) → 活对象或 undefined)
      if (serviceName === 'agents') return { get: (id) => LIVE_AGENTS.get(id) }
      if (serviceName === 'sessions') return { get: (id) => LIVE_SESSIONS.get(id) }
      return undefined
    },
    inject(names, callback) {
      state.injected.push({ names, callback })
      // 服务可用才执行(真实 cordis:缺席 ⇒ 回调永不执行,且不报错)
      if (!names.every((serviceName) => ctx.get(serviceName) !== undefined)) return Promise.resolve()
      const child = {
        get: (serviceName) => ctx.get(serviceName),
        effect(fn) {
          const disposer = fn()
          state.childEffectors.push(disposer)
          return () => { disposer?.() }
        },
      }
      return Promise.resolve(callback(child))
    },
    effect(fn) {
      const disposer = fn()
      state.effectors.push(disposer)
      return () => { disposer?.() }
    },
    // 本插件**禁止**用 ctx.on('dispose')(cordis 无此事件、永不触发)⇒ 一旦被调用就炸
    on() { throw new Error('本插件不得使用 ctx.on(cordis 无 dispose 事件)') },
  }
  state.ctx = ctx
  /** 卸载:子 fiber 的 disposer 先跑(真实 cordis 里子 effect 先于父 fiber 收尾),再跑本 fiber 的。 */
  state.dispose = async () => {
    for (const disposer of state.childEffectors.splice(0)) await disposer?.()
    for (const disposer of state.effectors.splice(0)) await disposer?.()
  }
  return { ctx, state }
}

// ── 假 storageDomain(不碰真实 storages 目录;介质就是一个 Map)──────────────
/** 睡一会儿(假设施里只用它模拟"close 是异步收尾")。 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * 造一个**与宿主 ctx.storageDomain 语义等价**的假设施(只实现本插件用到的那一小块)。
 *
 * 照搬的真实语义(每条都对着 @deepseek-ai/dsh-storage-domain 的 lib/index.js):
 *   · open(spec):同名域**同时只能开一个**(重复开抛 code='already-open');
 *     **开域时逐条用 spec 的 schema 校验介质里的记录**(真实 facility 就是这么做的 ⇒ 记录不合 schema
 *     会让 open 失败、插件随之降级,这条路径也被覆盖);
 *   · put / delete:异步,且**先写介质、后改自己的内存**(真实域层:await unit.putRecord → records.set);
 *   · 介质里放的是 **JSON 往返后**的记录(真实 json 后端就是"整域一个 JSON 文档")
 *     ⇒ "记录必须经得起 JSON 往返"这条约束是真被验过的(undefined 键会被丢掉);
 *   · close():异步收尾,跑完才释放域名(真实域层要等写链排空 + 释放后端 unit)⇒ 用 closeDelayMs
 *     模拟"新实例先撞 already-open、稍后重试成功"这段热加载竞态;
 *   · close 之后任何读写都抛(真实域层用 DomainError('closed'))。
 *
 * `medium` 是**跨"进程重启"共享的那份介质**:同一份 medium 先后传给两次 apply,就等于两次进程启动。
 * @param medium Map<domain 名, Map<表名, Map<键, 记录>>>(由调用方建、可复用)
 * @param options.closeDelayMs 模拟异步收尾的时长(默认 0)
 * @param options.openDelayMs 模拟"open 还没落定"的窗口(默认 0;S1 用例 18f 用它造卸载竞态)
 * @param options.putDelayMs 模拟"落盘还没完成"的窗口(默认 0;W2 用例 18g 用它造并发 list 的窗口)
 */
function makeStorageDomainStub(medium, { closeDelayMs = 0, openDelayMs = 0, putDelayMs = 0 } = {}) {
  const opened = new Set()
  /** 打开过的域名顺序(断言"真的开过"用)。 */
  const openLog = []
  /** 测试注入:置 true ⇒ 下一次 put 直接失败(验"落盘失败要回滚内存")。 */
  const failNextPut = { value: false }
  return {
    medium,
    failNextPut,
    openLog,
    /** 域名现在是不是被占着(等价于真实 facility 里"这个域还开着")。 */
    isOpen: (domainName = DOMAIN_NAME) => opened.has(domainName),
    async open(spec) {
      if (opened.has(spec.name)) {
        const error = new Error(`domain '${spec.name}' is already open`)
        error.code = 'already-open'
        throw error
      }
      if (openDelayMs > 0) await sleep(openDelayMs) // 打开是异步的:这段窗口里卸载就会撞上 S1
      if (opened.has(spec.name)) {
        const error = new Error(`domain '${spec.name}' is already open`)
        error.code = 'already-open'
        throw error
      }
      opened.add(spec.name)
      openLog.push(spec.name)
      const unit = medium.get(spec.name) ?? new Map()
      medium.set(spec.name, unit)
      const tables = new Map()
      for (const [tableName, tableSpec] of Object.entries(spec.tables)) {
        const stored = unit.get(tableName) ?? new Map()
        unit.set(tableName, stored)
        const records = new Map()
        // 与真实 facility 一致:开域即逐条校验(校验失败就抛 ⇒ 调用方降级)
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
            // 快照迭代器(真实实现也是快照,不是活视图)
            entries: () => { assertOpen(); return [...records.entries()][Symbol.iterator]() },
            keys: () => { assertOpen(); return [...records.keys()][Symbol.iterator]() },
            get size() { assertOpen(); return records.size },
            async put(key, value) {
              assertOpen()
              if (failNextPut.value) {
                failNextPut.value = false
                throw new Error('磁盘写失败(测试注入)')
              }
              const serialized = JSON.parse(JSON.stringify(value)) // 落盘 = JSON 化
              await Promise.resolve() // 落盘是异步的
              if (putDelayMs > 0) await sleep(putDelayMs) // 造"落盘还没完成"的窗口(用例 18g)
              stored.set(key, serialized) // 先落盘
              records.set(key, serialized) // 后改域内存
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
        async close() {
          if (closed) return
          closed = true
          if (closeDelayMs > 0) await sleep(closeDelayMs)
          opened.delete(spec.name) // 收尾跑完才释放域名
        },
      }
    },
  }
}

/** 从介质里读一条板记录(断言"真的落盘了"用)。 */
function storedBoards(stub) {
  return stub.medium.get(DOMAIN_NAME)?.get(TABLE_BOARDS)
}

/**
 * 等某个 apply 实例的存储状态落定(ready 或 degraded),再读状态。
 * 为什么需要:存储打开挂在 `ctx.inject` 的回调上(真实 cordis 里回调在**同一 tick 的微任务**里跑,
 * 桩里同步跑);而"服务缺席 ⇒ 降级"这条是 applyInner 用 setTimeout(0) 判死的(见 lib/index.js),
 * 所以 `apply()` 刚返回时 status 可能还是 'opening'。测试里统一用它等到终态。
 */
async function settledStatus(ctx) {
  await sleep(0) // 让 setTimeout(0) 那条"注入回调未激活 ⇒ 降级"先跑完
  return __storageStatus(ctx)
}

// ── 严格无损 JSON 关口 ────────────────────────────────────────────────────
/**
 * 宿主对工具返回值的要求是**严格无损 JSON**:值里只要出现 undefined / 函数 / symbol / NaN /
 * ±Infinity / 负零 / BigInt / Map / Set / Date / RegExp / 循环引用,宿主就拒绝这次调用并回
 *   tool "task_board" returned invalid output: value is not lossless JSON
 * (实测:只有成功路径的返回值出问题;抛错路径由宿主自己渲染成 `Error: <msg>`,不经过这道校验)。
 * 规则出处:@deepseek-ai/dsh-tools 的 snapshotToolValue() → @deepseek-ai/dsh-util-values 的
 * snapshotJsonValue()(只收 null / 布尔 / 有限且非 -0 的数 / 字符串 / 稠密数组 / 普通或
 * null 原型对象,且键必须可枚举;类实例、稀疏数组、symbol 键一律拒)。
 *
 * 本关口就是这条宿主契约的**可执行副本**,挂在 call() 上 ⇒ 每条用例、每个分支(含角色门拒绝、
 * "还没有任务板"这类**返回式**拒绝路径)的返回值都必须过关。真实踩过的坑:create 不带 owner 时
 * toView() 回了 `owner: undefined`(list 用的 toSummary() 有守卫,toView() 漏了)。
 *
 * 两层校验,缺一不可:
 *   ① 递归遍历——类型白名单之外一律失败,并带出出错路径;同时挡循环引用、symbol 键、
 *      稀疏数组、非普通对象(类实例)。
 *   ② JSON.parse(JSON.stringify(v)) 与 v **深度相等**——任何"序列化时会被丢掉或被改写"的
 *      内容(undefined 值、undefined 数组元素、symbol 键、非枚举属性、类实例)都会在这里现形。
 */
function assertLosslessJson(value, label = 'tool return') {
  walkLossless(value, '$', new Set())
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(value)),
    value,
    `${label}:JSON 往返后与原值不深度相等(存在序列化会丢或会改写的内容)`,
  )
  return value
}

/** assertLosslessJson 的递归体;path 让失败信息直接指到出问题的那个字段。 */
function walkLossless(value, path, ancestors) {
  const type = typeof value
  if (value === null || type === 'string' || type === 'boolean') return
  if (type === 'number') {
    assert.ok(Number.isFinite(value), `${path}: ${String(value)} 不是有限数(NaN / ±Infinity 不合格)`)
    assert.ok(!Object.is(value, -0), `${path}: 负零 -0 不合格(宿主 isJsonValue 明确拒 -0;序列化会丢符号)`)
    return
  }
  if (type !== 'object') {
    // 剩下的是 undefined / function / symbol / bigint
    assert.fail(`${path}: 出现 ${type}(${String(value).slice(0, 40)})——严格无损 JSON 不允许`)
  }
  const tag = Object.prototype.toString.call(value)
  assert.ok(!(value instanceof Map) && !(value instanceof Set), `${path}: ${tag} 不合格(Map / Set 无法无损 JSON 化)`)
  assert.ok(!(value instanceof Date), `${path}: ${tag} 不合格(Date 要改存 ISO 字符串)`)
  assert.ok(!(value instanceof RegExp), `${path}: ${tag} 不合格(RegExp 无法无损 JSON 化)`)
  assert.ok(Array.isArray(value) || tag === '[object Object]', `${path}: ${tag} 既不是数组也不是普通对象`)
  if (!Array.isArray(value)) {
    const proto = Object.getPrototypeOf(value)
    assert.ok(proto === Object.prototype || proto === null, `${path}: 原型不是 Object.prototype(类实例不合格)`)
  }
  assert.ok(!ancestors.has(value), `${path}: 循环引用(JSON 无法无损表示)`)
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        assert.ok(index in value, `${path}[${index}]: 稀疏数组的空洞不合格(会被序列化成 null)`)
        walkLossless(value[index], `${path}[${index}]`, ancestors)
      }
      assert.equal(Object.keys(value).length, value.length, `${path}: 数组上有非索引自有属性`)
    } else {
      const symbols = Object.getOwnPropertySymbols(value)
      assert.equal(symbols.length, 0, `${path}: symbol 键(${String(symbols[0])})不合格(序列化会丢)`)
      for (const key of Object.getOwnPropertyNames(value)) {
        assert.ok(
          Object.prototype.propertyIsEnumerable.call(value, key),
          `${path}.${key}: 不可枚举属性不合格(序列化会丢)`,
        )
        walkLossless(value[key], `${path}.${key}`, ancestors)
      }
    }
  } finally {
    ancestors.delete(value)
  }
}

/** 过了关口的返回值计数:结算里用它证明"每条用例的返回值都过了关"。 */
let gatedReturns = 0

/** 直调 dispatch 的返回值(工具调用层进不去的分支:owner:null 置空、拿不到 action)也过关口。 */
let gatedDirect = 0
function gateDirect(value, label) {
  gatedDirect += 1
  return assertLosslessJson(value, label)
}

/** 真实工具调用:含 defineTool 的参数校验层,且返回值必过严格无损 JSON 关口。 */
async function call(state, args, session) {
  const tool = state.registered.find((candidate) => candidate.name === TOOL_NAME)
  assert.ok(tool !== undefined, `工具 ${TOOL_NAME} 应已注册`)
  // ctx 也照宿主交进去:code 里解析父链用的是 exec.agent.ctx 兜底(真实 Agent 上有 .ctx)
  const value = await tool.execute(args, { agent: { session, ctx: state.ctx } })
  gatedReturns += 1
  return assertLosslessJson(value, `${String(args?.action)} 的返回值`)
}

/** 断言一次调用**被拒**(抛错),返回错误文本。 */
async function expectFail(state, args, session) {
  try {
    const value = await call(state, args, session)
    assert.fail(`预期被拒,实际返回:${JSON.stringify(value)}`)
  } catch (error) {
    return String(error?.message ?? error)
  }
}

// ── 用例 ──────────────────────────────────────────────────────────────────
const S = {} // 跨用例共享的串联状态
__resetForTest()
revive(ROOT, SUB, GRAND, SIBLING, ROOT_B, OWNER_ROOT, MISSING_ROOT, MISSING_SUB)

/**
 * useCase 是"apply 之内"的执行钩子,只能同步 —— 这里只登记**用例名**(让
 * "这条链覆盖了哪些用例"显式可见),真正的断言在下面 run() 里按同一顺序 await。
 * 两者名字一一对应,改一处要改两处。
 */
for (const caseName of [
  '0 严格 JSON 关口自检:17 种非法形态全被拦下(含路径定位),合法样本放行',
  '1 create 建任务(协调者会话 = 板键的根,boardSource=self)',
  '2 create(子代理)带 blocked_by / write_scopes 去重,与父会话共用同一块板',
  '2b owner 省略口径:create 不带 owner / get / update 置空 都过严格无损 JSON 关口',
  '2c 任意深度:孙代理照旧落在根会话那块板上(boardSource=ancestor)',
  '3 分桶:另一个根会话是另一块板(同一 cwd,id 各自从 t1 起,内容互不可见)',
  '3b 隔离:板 A 的条目不出现在板 B,板 B 的 list 也看不见板 A',
  '4 list 只回瘦投影(不含 description)',
  '5 get 单条完整视图 + 阻塞来源状态',
  '6 update 用正确 revision 成功(revision +1)且下游 ready 是派生值',
  '6b 依赖缺失口径:被 remove / 从未存在 ⇒ 非阻塞(ready=true + missingBlockers 提示);存在未完成 ⇒ 仍不就绪;已完成 ⇒ 就绪',
  '7 update 过期 / 缺 expected_revision 被拒并回最新 revision',
  '7b remove 三条失败路径(缺 revision / 过期 / id 不存在)均被拒且不改板',
  '7c remove 删除成功;删空 ⇒ 板回收(板数与 id 序列双双复位)',
  '8 上限:单字段上限仍拒绝(description / subject / write_scopes / blocked_by);增长型上限已删(70 条任务 / 40 块板全放行)',
  '9 角色门:非协调者预设、未声明 preset 的会话被拒;无 action 的拒绝路径也过关口',
  '10 并发声明:list/get 可并发,create/update 独占',
  '11 非法 action 被真实参数校验拦下',
  '12 契约已无 project:参数表无该键、描述无旧口径、传了也不参与分桶',
  '13 render 输出精简(一行摘要 + 一行紧凑 JSON)且可无损解析回返回值',
  '14 ctx.effect disposer 撤销工具注册',
  '15 契约一致:描述 / 参数 / 实现三处的动作集合都是那五个',
  '16 上溯失败一律回退本会话 id:父已销毁 / 服务不可用 / 成环 / 超深 / 无 lookup(且摘要明说回退)',
  '17 会话没有 id 时才报错(这不是上溯失败,而是板键无从谈起)',
  '18 领域存储:写入先落盘(记录形状/严格 JSON)、跨"进程重启"水合回来(revision/seq/依赖/CAS 全存活)、删空即删记录、already-open 重试、服务缺失与 open 失败都降级为内存态、落盘失败回滚内存',
  '18f 卸载撞上"域正在打开":域句柄不泄漏(名字释放、随后 apply 能正常 ready)——S1 回归',
  '18g W2:落盘未完成时并发 list 看不到"板存在但 0 条"(空板推迟到落盘成功之后才入内存)',
  '18h W3:水合时 seq 取 max(介质 seq, 板内 id 最大序号)⇒ 介质 seq 被改小也不会覆盖已有条目',
  '18i W5:降级态下五个动作的提示口径一致(摘要明说只写内存,note 不再自相矛盾)',
]) {
  useCase(caseName, async () => {})
}

/** 真实断言序列(async;断言与上面的用例名一一对应)。 */
export async function run() {
  const { ctx, state } = makeCtx()
  apply(ctx, { MAX_DESCRIPTION_BYTES: DESCRIBE_LIMIT })

  const out = []
  const step = (name, detail) => { out.push(`  [ok] ${name}${detail === undefined ? '' : ` — ${detail}`}`) }

  // 工具确实注册了,且 apply 已跑完
  assert.equal(state.registered.length, 1, '应恰好注册一个工具(省常驻 schema)')
  const tool = state.registered[0]
  assert.equal(tool.name, TOOL_NAME)
  step('apply 注册工具', `name=${tool.name}`)

  // ── 0) 关口自检:校验器本身必须有牙,否则它只是个摆设 ──────────────────────
  /** 样本必须被关口拦下(显式 try/catch,不依赖 assert.throws 的参数签名细节)。 */
  const expectGateReject = (name, sample) => {
    let message = ''
    try {
      assertLosslessJson(sample, name)
    } catch (error) {
      message = String(error?.message ?? error)
    }
    assert.ok(message.length > 0, `关口必须拦下「${name}」,实际放行了`)
    return message
  }
  const badSamples = [
    ['undefined 字段', { ok: true, owner: undefined }],
    ['数组元素 undefined', { ok: true, list: [1, undefined] }],
    ['函数值', { fn: () => {} }],
    ['symbol 值', { sym: Symbol('x') }],
    ['symbol 键', { plain: 1, [Symbol('k')]: 1 }],
    ['NaN', { n: Number.NaN }],
    ['Infinity', { n: Number.POSITIVE_INFINITY }],
    ['-Infinity', { n: Number.NEGATIVE_INFINITY }],
    ['负零 -0', { n: -0 }],
    ['BigInt', { n: 1n }],
    ['Map', { m: new Map([['a', 1]]) }],
    ['Set', { s: new Set([1]) }],
    ['Date', { d: new Date(0) }],
    ['RegExp', { r: /x/ }],
    ['类实例', { c: new (class Widget { constructor() { this.a = 1 } })() }],
    ['稀疏数组', { a: [1, , 3] }],
  ]
  for (const [name, sample] of badSamples) expectGateReject(name, sample)
  const cyclic = { ok: true }
  cyclic.self = cyclic
  expectGateReject('循环引用', cyclic)
  // 失败信息要指到出问题的字段(否则排查成本全落在人身上)
  assert.match(expectGateReject('undefined 字段(查路径)', { task: { owner: undefined } }), /\$\.task\.owner/)
  // 反面:合法值必须放行,不能把正常返回体也拦了
  assertLosslessJson({ ok: true, task: { id: 't1', blockedBy: [], ready: false, revision: 1 } }, '合法样本')
  step('严格 JSON 关口自检', `${badSamples.length + 1} 种非法形态全被拦下(含路径定位),合法样本放行`)

  // ── 1) create(顶层协调者会话)─────────────────────────────────────────────
  S.created = await call(state, {
    action: 'create',
    subject: '桩测试任务',
    description: '第一个用例',
    status: 'in_progress',
    owner: 'sub-1',
    write_scopes: ['lib/index.js'],
  }, ROOT)
  assert.equal(S.created.ok, true)
  assert.equal(S.created.task.id, 't1')
  assert.equal(S.created.task.revision, 1)
  assert.equal(S.created.task.status, 'in_progress')
  assert.equal(S.created.task.ready, true, '无前置依赖 ⇒ ready')
  assert.equal(S.created.boardKey, 's-root', '板键 = 根会话 id(自己就是根)')
  assert.equal(S.created.boardSource, 'self', '顶层会话没有父链 ⇒ source=self')
  assert.deepEqual(S.created.counts, { tasksActive: 1, boards: 1 }, '只有计数,没有硬顶')
  step('create', `id=${S.created.task.id} rev=${S.created.task.revision} ready=${S.created.task.ready}`)
  step('板键', `boardKey=${S.created.boardKey} source=${S.created.boardSource} counts=${JSON.stringify(S.created.counts)}`)

  // ── 2) create + blocked_by(**子代理在父会话的同一块板上写**)────────────────
  // 这条同时证明两件事:(1) 子代理解析到自己父会话的板;(2) 它看得见父会话刚写的 t1
  // (blocked_by 指向 t1 且被判为"存在且未完成" ⇒ 板是同一块)。
  S.blocked = await call(state, {
    action: 'create',
    subject: '被 t1 阻塞的任务',
    description: '第二个用例',
    blocked_by: ['t1'],
    write_scopes: ['lib/a.js', 'lib/b.js', 'lib/b.js'], // 重复项应被去重
    owner: 'sub-2',
  }, SUB)
  assert.equal(S.blocked.boardKey, 's-root', '子代理与父会话共用一块板')
  assert.equal(S.blocked.boardSource, 'ancestor', '沿 parentSession 上溯到根会话')
  assert.equal(S.blocked.task.id, 't2', 'id 序列与父会话连号 ⇒ 确实是同一块板')
  assert.equal(S.blocked.task.ready, false, 't1 未 completed ⇒ 未就绪')
  assert.deepEqual(S.blocked.task.writeScopes, ['lib/a.js', 'lib/b.js'], 'write_scopes 应去重')
  step('create(子代理, blocked_by)', `id=${S.blocked.task.id} ready=${S.blocked.task.ready} boardKey=${S.blocked.boardKey}/${S.blocked.boardSource}`)

  // ── 2b) owner 省略口径(本次宿主回归的现场)─────────────────────────────
  // 现场:create 不带 owner ⇒ toView() 回了 `owner: undefined` ⇒ 宿主拒绝整个调用:
  //   tool "task_board" returned invalid output: value is not lossless JSON
  // 契约:没有值的字段一律**省略该键**(与 list 的 toSummary() 同口径),不写 undefined。
  // 下面每条调用都已经在 call() 里过严格无损 JSON 关口 —— 这条口径一旦破,这里就红。
  S.ownerless = await call(state, { action: 'create', subject: '无 owner 的任务' }, GRAND)
  assert.equal(S.ownerless.task.id, 't3')
  assert.equal(S.ownerless.boardKey, 's-root', '孙代理(深度 2)同样落在根会话那块板上')
  assert.equal(S.ownerless.boardSource, 'ancestor')
  assert.equal(S.ownerless.task.owner, undefined)
  assert.equal('owner' in S.ownerless.task, false, 'create 无 owner ⇒ 视图里不得有 owner 键(更不能是 undefined)')

  // get 同一条:同样省略 owner 键
  const ownerlessGet = await call(state, { action: 'get', id: S.ownerless.task.id }, ROOT)
  assert.equal('owner' in ownerlessGet.task, false, 'get 无 owner 的任务同样不得有 owner 键')

  // 相邻情形 1:create 带 owner ⇒ owner 键必须在(另起一块板:另一个根会话)
  S.owned = await call(state, {
    action: 'create', subject: '带 owner 的任务', owner: 'sub-7',
  }, OWNER_ROOT)
  assert.equal(S.owned.task.owner, 'sub-7', 'create 带 owner ⇒ 视图里必须有 owner 键')
  assert.equal(S.owned.boardKey, 's-root-owner', '另一个根会话 = 另一块板')

  // 相邻情形 2:update 把 owner 置空。⚠ 这条**过不了参数校验层**:TOOL_PARAMETERS.owner 是
  // `string`,null 会被真实的 defineTool 以 ToolArgsError 拦下(先钉住这个边界,免得有人以为
  // 走工具能清 owner)。实现里"清 owner"的写法是 `args.owner === null ⇒ undefined`,只在业务层
  // 可达 ⇒ 直接调导出的 dispatch(2026-09-26 起它是 async:写动作要先落盘),返回值**同样**
  // 过严格无损 JSON 关口。
  const clearViaTool = await expectFail(state, {
    action: 'update', id: S.owned.task.id, expected_revision: 1, owner: null,
  }, OWNER_ROOT)
  assert.match(clearViaTool, /"owner" must be a string/, 'owner:null 在参数层就被拦下')
  const cleared = gateDirect(await dispatch(
    { action: 'update', id: S.owned.task.id, expected_revision: 1, owner: null },
    { agent: { session: OWNER_ROOT, ctx } },
    { ...LIMITS, MAX_DESCRIPTION_BYTES: DESCRIBE_LIMIT },
    ctx,
  ), 'update owner:null 的返回值(dispatch 直调)')
  assert.equal(cleared.ok, true)
  assert.equal(cleared.revision, 2, '置空也是一次成功写 ⇒ revision +1')
  assert.equal(cleared.changed.includes('owner'), true, '置空要如实记进 changed')
  assert.equal(cleared.task.owner, undefined)
  assert.equal('owner' in cleared.task, false, 'owner 置空后不得留 undefined 键')
  const clearedGet = await call(state, { action: 'get', id: S.owned.task.id }, OWNER_ROOT)
  assert.equal('owner' in clearedGet.task, false, '置空后 get 同样不得有 owner 键')

  // 收尾:把这个临时板删干净(板空即回收)⇒ 后续用例看到的板数不受影响
  const clearedRemove = await call(state, {
    action: 'remove', id: S.owned.task.id, expected_revision: 2,
  }, OWNER_ROOT)
  assert.equal(clearedRemove.boardRemoved, true, '临时板删空即回收,不干扰后续板数')
  step('owner 省略口径', `无 owner ⇒ 无键;带 owner ⇒ 有键;置空 ⇒ rev${cleared.revision} 键消失`)

  // ── 2c) 任意深度:孙代理(深度 2)与根会话共板(与 2b 同一块板,上面已断言 boardKey)──
  assert.equal(S.ownerless.counts.boards, 1, '孙代理落在根会话那块板上 ⇒ 进程里仍只有 1 块板')
  step('任意深度共板', `GRAND(s-grand → s-sub → s-root) 写入 ${S.ownerless.boardKey}/t3`)

  // ── 3) 分桶:另一个**根会话**是另一块板(同一 cwd 也不算同板)────────────────
  const other = await call(state, { action: 'create', subject: 'B 板任务' }, ROOT_B)
  assert.equal(other.boardKey, 's-root-b')
  assert.equal(other.boardSource, 'self')
  assert.equal(other.task.id, 't1', '每块板 id 各自从 t1 开始')
  assert.equal(S.created.task.id, 't1', '同一 cwd 下两块板的 id 序列互不干扰')
  step('分桶', `另一根会话独立板 boardKey=${other.boardKey} id=${other.task.id}`)

  // ── 3b) 隔离:父子共板 与 不同会话树互不可见,两面都要钉住──────────────────
  const listB = await call(state, { action: 'list' }, ROOT_B)
  assert.equal(listB.total, 1, 'B 板只有自己那一条')
  assert.equal('桩测试任务' in listB.tasks, false)
  assert.ok(!JSON.stringify(listB).includes('桩测试任务'), 'B 板看不见 A 板的条目')
  const listA = await call(state, { action: 'list' }, SIBLING)
  assert.equal(listA.total, 3, 'A 板:父会话写的 t1/t2 + 孙代理写的 t3 都在')
  assert.ok(!JSON.stringify(listA).includes('B 板任务'), 'A 板看不见 B 板的条目')
  step('共板与隔离', `A(sibling 视角)=${listA.total} 条,B(另一根会话)=${listB.total} 条,互不可见`)

  // ── 4) list 瘦投影(绝不 dump 整板)────────────────────────────────────────
  S.list = await call(state, { action: 'list' }, SUB)
  assert.equal(S.list.total, 3)
  assert.equal(S.list.tasks.length, 3)
  const keys = Object.keys(S.list.tasks[0]).sort()
  assert.deepEqual(keys, ['id', 'owner', 'ready', 'revision', 'status', 'subject'], 'list 行只应有瘦投影字段(owner 可选)')
  const unowned = S.list.tasks.find((row) => row.id === 't3')
  assert.equal('owner' in unowned, false, '无 owner 时不得凭空补 owner 键')
  assert.ok(!JSON.stringify(S.list).includes('第一个用例'), 'list 不得带 description 正文')
  step('list 瘦投影', `total=${S.list.total} keys=${keys.join(',')}`)
  assert.equal(S.list.summary.includes('3 条命中'), true)
  assert.match(S.list.summary, /未完成 3 条/, '摘要只说条数,不再有"未完成 x/上限"这种口径')
  step('list 摘要', S.list.summary)

  // ── 5) get 单条完整视图 ──────────────────────────────────────────────────
  S.get = await call(state, { action: 'get', id: 't2' }, ROOT)
  assert.equal(S.get.task.description, '第二个用例')
  assert.deepEqual(S.get.task.blockedBy, ['t1'])
  assert.equal(S.get.summary.includes('blockedBy=t1(in_progress)'), true, 'get 摘要应带阻塞来源状态')
  step('get', S.get.summary)

  // ── 6) update 正确 revision ──────────────────────────────────────────────
  S.updated = await call(state, {
    action: 'update',
    id: 't1',
    expected_revision: 1,
    status: 'completed',
    owner: 'sub-9',
  }, ROOT)
  assert.equal(S.updated.ok, true)
  assert.equal(S.updated.revision, 2, '成功写 ⇒ revision +1')
  assert.equal(S.updated.task.owner, 'sub-9')
  step('update(rev 1→2)', S.updated.summary)

  // t1 完成后,t2 应变为 ready(就绪是派生值,不需要额外写)
  const afterReady = await call(state, { action: 'get', id: 't2' }, SUB)
  assert.equal(afterReady.task.ready, true, '阻塞项 completed ⇒ 下游 ready')
  step('ready 派生', `t2 ready=${afterReady.task.ready}`)

  // ── 6b) 依赖缺失口径:不在板上的阻塞项**不算阻塞**,但要显式提示(2026-09-25 用户决定)──
  // 旧行为:blocked_by 指向的 id 被 remove(或从没建过)⇒ 依赖方**永远** ready=false 且毫无提示,
  // 板上也没有任何动作能救活它(remove 的乐观锁 / 角色门都不管这件事)。
  // 新口径:缺失只作为 missingBlockers 提示,ready 由"仍在板上的依赖"决定。
  // 四种情形各断言一次;独立板(MISSING_ROOT 自己的会话树),收尾删空回收,不影响后面的板数断言。
  const depLive = await call(state, {
    action: 'create', subject: '会被依赖(先建后删)',
  }, MISSING_ROOT)
  assert.equal(depLive.task.id, 't1')
  assert.equal('missingBlockers' in depLive.task, false, '无 blocked_by ⇒ 省略 missingBlockers 键')

  // ③ 依赖存在但未完成 ⇒ 仍不就绪(行为不变,回归保护);这条走**子代理**,顺带再钉一次共板
  S.depPending = await call(state, {
    action: 'create', subject: '依赖存在但未完成', blocked_by: ['t1'],
  }, MISSING_SUB)
  assert.equal(S.depPending.boardKey, 's-root-missing', '子代理落在自己父会话那块板上')
  assert.equal(S.depPending.task.id, 't2')
  assert.equal(S.depPending.task.ready, false, '依赖存在且未 completed ⇒ 仍不就绪')
  assert.equal('missingBlockers' in S.depPending.task, false, '依赖都在板上 ⇒ 省略 missingBlockers 键')

  // ② 从未存在的依赖 id(create 时直接引用别处/写错的 id)⇒ 非阻塞 + 提示
  S.depGhost = await call(state, {
    action: 'create', subject: '依赖从未存在', blocked_by: ['t98'],
  }, MISSING_ROOT)
  assert.equal(S.depGhost.task.id, 't3')
  assert.equal(S.depGhost.task.ready, true, '依赖 id 不在板上 ⇒ 不算阻塞(ready=true)')
  assert.deepEqual(S.depGhost.task.missingBlockers, ['t98'], '缺失的 id 要在视图里如实回报')
  assert.ok(S.depGhost.summary.includes('missingBlockers=t98'), 'create 摘要要提一句缺失的 id')
  assert.ok(!JSON.stringify(S.depGhost).includes('undefined'), '缺失提示不得写成 undefined')

  // ① 依赖被 remove ⇒ 依赖方由"未就绪"变为"就绪",且返回值里能看到缺失的 id
  S.depRemoved = await call(state, {
    action: 'create', subject: '依赖被 remove', blocked_by: ['t1'],
  }, MISSING_ROOT)
  assert.equal(S.depRemoved.task.id, 't4')
  assert.equal(S.depRemoved.task.ready, false, 't1 还在板上 ⇒ 先不就绪')
  const depGone = await call(state, {
    action: 'remove', id: 't1', expected_revision: 1,
  }, MISSING_ROOT)
  assert.equal(depGone.removed, 't1')
  const afterDepGone = await call(state, { action: 'get', id: 't4' }, MISSING_ROOT)
  assert.equal(afterDepGone.task.ready, true, '阻塞项被 remove ⇒ 不再阻塞(ready=true)')
  assert.deepEqual(afterDepGone.task.missingBlockers, ['t1'], 'get 的视图要报出已不在板上的依赖 id')
  assert.ok(afterDepGone.summary.includes('missingBlockers=t1'), 'get 摘要要指出缺失的 id')
  assert.ok(afterDepGone.summary.includes('t1(不在此板)'), 'blockedBy 逐条状态仍标注"不在此板"')
  // 同一条任务,依赖被删前/后两次读取 ⇒ ready 由 false 翻成 true,正是本次要修的那个"卡死"
  const t2AfterDepGone = await call(state, { action: 'get', id: 't2' }, MISSING_ROOT)
  assert.equal(t2AfterDepGone.task.ready, true, '原本就不就绪的那条,依赖被删后也随之就绪')

  // ④ 依赖已完成 ⇒ 就绪(行为不变,回归保护)
  const depDone = await call(state, {
    action: 'create', subject: '依赖已完成', status: 'completed',
  }, MISSING_ROOT)
  assert.equal(depDone.task.id, 't5')
  S.depOk = await call(state, {
    action: 'create', subject: '依赖在板上且已完成', blocked_by: ['t5'],
  }, MISSING_ROOT)
  assert.equal(S.depOk.task.id, 't6')
  assert.equal(S.depOk.task.ready, true, '依赖 completed ⇒ 就绪')
  assert.equal('missingBlockers' in S.depOk.task, false, '依赖都在板上 ⇒ 省略 missingBlockers 键')

  // update 的摘要同样要提(改状态也是一次 ready 重算);视图照旧带 missingBlockers
  S.depUpdate = await call(state, {
    action: 'update', id: 't2', expected_revision: 1, status: 'in_progress',
  }, MISSING_ROOT)
  assert.equal(S.depUpdate.task.ready, true)
  assert.deepEqual(S.depUpdate.task.missingBlockers, ['t1'])
  assert.ok(S.depUpdate.summary.includes('missingBlockers=t1'), 'update 摘要同样要提一句')

  // update 的"没有字段需要改"回执(没有 task 视图)也要能看见缺失依赖 ⇒ 提示进摘要,不动回执的键集合
  const noopUpdate = await call(state, {
    action: 'update', id: 't3', expected_revision: 1,
  }, MISSING_ROOT)
  assert.deepEqual(noopUpdate.changed, [], '没有字段要改 ⇒ changed 为空、revision 不变')
  assert.equal(noopUpdate.revision, 1)
  assert.equal(noopUpdate.ready, true)
  assert.equal('task' in noopUpdate, false, '回执不带任务视图')
  assert.ok(noopUpdate.summary.includes('missingBlockers=t98'), '回执摘要也要提一句缺失的 id')
  assert.equal('missingBlockers' in noopUpdate, false, '回执不新增顶层字段(缺失提示只走摘要)')

  // list:摘要给"有缺失依赖"的条数,瘦投影本身保持原形状(不带 missingBlockers)
  const listMissing = await call(state, { action: 'list' }, MISSING_ROOT)
  assert.equal(listMissing.matched, 5, 't1 已删 ⇒ t2..t6 共 5 条')
  assert.ok(listMissing.summary.includes('3 条有 missingBlockers'), 'list 摘要要给缺失条数(t2/t3/t4)')
  assert.equal('missingBlockers' in listMissing.tasks[0], false, 'list 瘦投影保持原字段形状,不带 missingBlockers')
  step('依赖缺失 ⇒ 非阻塞', listMissing.summary)
  step('缺失依赖提示', `${afterDepGone.summary} ｜ ${S.depUpdate.summary}`)

  // 收尾:删空该临时板(板空即回收),后面的板数断言不受影响
  const depCleanup = []
  for (const [depId, depRev] of [['t2', 2], ['t3', 1], ['t4', 1], ['t5', 1], ['t6', 1]]) {
    depCleanup.push(await call(state, {
      action: 'remove', id: depId, expected_revision: depRev,
    }, MISSING_ROOT))
  }
  assert.equal(depCleanup.at(-1).remaining, 0, '删空 ⇒ 板内剩 0 条')
  assert.equal(depCleanup.at(-1).boardRemoved, true, '临时板删空即回收')
  assert.equal(depCleanup.at(-1).boards, 2, '回收后只剩 s-root / s-root-b 两块板(与 7c 的计数断言对齐)')
  step('依赖缺失板回收', `boards=${depCleanup.at(-1).boards},共删 ${depCleanup.length} 条`)

  // ── 7) update 过期 revision 被拒(并回最新 revision)─────────────────────
  S.stale = await expectFail(state, {
    action: 'update', id: 't1', expected_revision: 1, subject: '不该写进去',
  }, ROOT)
  assert.match(S.stale, /revision 冲突/)
  assert.match(S.stale, /最新 revision 已是 2/, '拒绝信息必须回最新 revision')
  const untouched = await call(state, { action: 'get', id: 't1' }, ROOT)
  assert.equal(untouched.task.subject, '桩测试任务', '被拒的写不得改动任何字段')
  assert.equal(untouched.task.revision, 2, '被拒的写不得推进 revision')
  step('update 过期拒绝', S.stale.split('。')[0])

  // 缺 expected_revision 也拒(update 必填)
  const noRev = await expectFail(state, { action: 'update', id: 't1', subject: 'x' }, ROOT)
  assert.match(noRev, /必须带 expected_revision/)
  step('update 缺 expected_revision 拒绝', noRev.split(';')[0])

  // ── 7b) remove 三条失败路径(与 update 同一套乐观锁)─────────────────────
  // 缺 expected_revision ⇒ 拒(remove 同样必填)
  const rmNoRev = await expectFail(state, { action: 'remove', id: 't3' }, ROOT)
  assert.match(rmNoRev, /remove 必须带 expected_revision/)
  assert.match(rmNoRev, /最新 revision = 1/, '拒绝信息要回最新 revision')
  step('remove 缺 expected_revision 拒绝', rmNoRev.split(';')[0])

  // 过期 revision ⇒ 拒(并回最新 revision)
  const rmStale = await expectFail(state, { action: 'remove', id: 't1', expected_revision: 1 }, ROOT)
  assert.match(rmStale, /revision 冲突/)
  assert.match(rmStale, /最新 revision 已是 2/)
  step('remove 过期 revision 拒绝', rmStale.split('。')[0])

  // id 不存在 ⇒ 拒
  const rmMissing = await expectFail(state, { action: 'remove', id: 't99', expected_revision: 1 }, ROOT)
  assert.match(rmMissing, /里没有任务 t99/)
  step('remove 不存在的 id 拒绝', rmMissing.slice(0, 44) + '…')

  // 三次被拒之后板上必须原样(3 条,且 t1 仍是 rev2)
  const afterRemoveFails = await call(state, { action: 'list' }, ROOT)
  assert.equal(afterRemoveFails.total, 3, '被拒的 remove 不得改动板上状态')
  const t1Still = await call(state, { action: 'get', id: 't1' }, ROOT)
  assert.equal(t1Still.task.revision, 2, '被拒的 remove 不得推进 revision')

  // ── 7c) remove 成功:删 t3(rev1),板还剩 2 条 ⇒ 板保留 ────────────────────
  S.removed = await call(state, { action: 'remove', id: 't3', expected_revision: 1 }, ROOT)
  assert.equal(S.removed.ok, true)
  assert.equal(S.removed.action, 'remove')
  assert.equal(S.removed.removed, 't3')
  assert.equal(S.removed.remaining, 2, '成功摘要必须回剩余条数')
  assert.equal(S.removed.boardRemoved, false, '板还有条目 ⇒ 不回收板')
  assert.equal(S.removed.boards, 2, '此时仍是 s-root / s-root-b 两块板')
  assert.equal('tasks' in S.removed, false, 'remove 只回摘要,不得 dump 整板')
  assert.ok(!JSON.stringify(S.removed).includes('被 t1 阻塞的任务'), 'remove 回体不得带别的条目正文')
  step('remove 删除成功(板保留)', S.removed.summary)

  // 删空 ⇒ 板本身被回收:板数下降,list 认不出这个会话
  const rmSecond = await call(state, { action: 'remove', id: 't2', expected_revision: 1 }, ROOT)
  assert.equal(rmSecond.remaining, 1)
  const rmLast = await call(state, { action: 'remove', id: 't1', expected_revision: 2 }, ROOT)
  assert.equal(rmLast.remaining, 0)
  assert.equal(rmLast.boardRemoved, true, '板空了 ⇒ 回收板本身')
  assert.equal(rmLast.boards, 1, '回收后板数下降(只剩 s-root-b)')
  const goneBucket = await call(state, { action: 'list' }, ROOT)
  assert.equal(goneBucket.ok, false, '板已回收 ⇒ list 回到"还没有任务板"')
  assert.match(goneBucket.summary, /还没有任务板/)
  assert.equal(goneBucket.boardKey, 's-root', '空板回执也要报板键(它没写板)')
  // 板重建:seq 复位 ⇒ id 从 t1 重新开始(证明旧板对象确实被删掉,不是清空复用)
  const reborn = await call(state, { action: 'create', subject: '回收后重建' }, ROOT)
  assert.equal(reborn.ok, true)
  assert.equal(reborn.task.id, 't1', '板被回收后重建,id 复位为 t1')
  step('remove 板空回收', `boards ${S.removed.boards}->${rmLast.boards},list.ok=${goneBucket.ok},重建 id=${reborn.task.id}`)

  // ── 8) 上限:只剩单字段上限;增长型上限已删(2026-09-25 用户决定)──────────
  // 8a) 该拒的仍然拒(挡的是"一次调用塞进巨量文本",与攒了多少条无关)
  const bigDesc = 'x'.repeat(DESCRIBE_LIMIT + 1)
  const descMsg = await expectFail(state, {
    action: 'create', subject: '超长描述', description: bigDesc,
  }, ROOT)
  assert.match(descMsg, /超过单条硬顶 512 B/)
  assert.match(descMsg, /AGENTS\.md/, '拒绝信息要给出"搬去 AGENTS.md"的出路')
  step('description 超限拒绝', descMsg.slice(0, 64) + '…')

  const scopesMsg = await expectFail(state, {
    action: 'create', subject: '超多写域', write_scopes: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
  }, ROOT)
  assert.match(scopesMsg, /超过单字段硬顶 8/)
  assert.match(scopesMsg, /config\.MAX_WRITE_SCOPES=8/, '拒绝信息要指到具体那条 config')
  step('write_scopes 超限拒绝', scopesMsg.slice(0, 56) + '…')

  const blockedMsg = await expectFail(state, {
    action: 'create', subject: '超多依赖', blocked_by: Array.from({ length: 17 }, (_, index) => `t${index}`),
  }, ROOT)
  assert.match(blockedMsg, /超过单字段硬顶 16/)
  assert.match(blockedMsg, /config\.MAX_BLOCKED_BY=16/)
  step('blocked_by 超限拒绝', blockedMsg.slice(0, 56) + '…')

  const subjectMsg = await expectFail(state, { action: 'create', subject: 'x'.repeat(201) }, ROOT)
  assert.match(subjectMsg, /超过硬顶 200 B/)
  step('subject 超限拒绝', subjectMsg.slice(0, 50) + '…')

  // ⚠ BOARD 是模块作用域的(设计如此:跨 apply 重跑存活)⇒ 多个桩 ctx 共享同一块板,
  //   所以下面先清空,再单独验"增长型上限确实不存在"。
  __resetForTest()

  // 8b) 每板任务数上限已删:同一块板连写 70 条(旧 MAX_TASKS_PER_PROJECT = 64)全部成功
  const many = makeCtx()
  apply(many.ctx, { MAX_DESCRIPTION_BYTES: DESCRIBE_LIMIT })
  const bulk = sessionStub('s-root-bulk')
  for (let index = 1; index <= 70; index += 1) {
    await call(many.state, { action: 'create', subject: `批量任务 ${index}` }, bulk)
  }
  const bulkList = await call(many.state, { action: 'list', limit: 1 }, bulk)
  assert.equal(bulkList.total, 70, '70 条全部写进同一块板 ⇒ 任务数硬顶确已删除')
  assert.equal(bulkList.matched, 70)
  assert.equal(bulkList.truncated, true, 'list 的分页上限仍在(limit 1 ⇒ 只回 1 行),但那是输出分页不是写入闸门')
  assert.equal(bulkList.summary.includes('未完成 70 条'), true)
  step('任务数无上限', `同一板写入 70 条全部成功,list.total=${bulkList.total}`)

  // 8c) 板数上限已删:40 个根会话各一块(旧 MAX_PROJECTS = 32)全部建成
  let lastBulk = null
  for (let index = 1; index <= 40; index += 1) {
    lastBulk = await call(many.state, { action: 'create', subject: `板 ${index}` }, sessionStub(`s-root-many-${index}`))
  }
  assert.equal(lastBulk.counts.boards, 41, '40 个新板 + bulk 那块 = 41 块,没有任何上限拦截')
  step('板数无上限', `boards=${lastBulk.counts.boards}(旧 MAX_PROJECTS=32 已删)`)

  // ── 9) 角色门 ────────────────────────────────────────────────────────────
  const denied = await call(state, { action: 'list' }, OTHER)
  assert.equal(denied.ok, false)
  assert.equal(denied.denied, 'preset')
  assert.match(denied.summary, /只对协调者预设/)
  assert.match(denied.summary, /`standard`/, '拒绝信息要点名调用方的 preset')
  assert.equal('boardKey' in denied, false, '角色门拒绝不碰板 ⇒ 也不报板键')
  assert.ok(!JSON.stringify(denied).includes('桩测试任务'), '被拒的调用不得泄露板内容')
  step('非协调者预设被拒', denied.summary.slice(0, 52) + '…')

  // 未声明 agentPreset 的会话同样被拒
  const noPreset = await call(state, { action: 'list' }, NO_PRESET)
  assert.equal(noPreset.ok, false)
  assert.match(noPreset.summary, /未声明 agentPreset/)
  step('无 preset 会话被拒', noPreset.summary.slice(0, 44) + '…')

  // 拒绝路径的同类隐患:dispatch 是导出的,拿不到 action 时**省略该键**而不是留 undefined
  const deniedNoAction = gateDirect(await dispatch(
    {}, { agent: { session: OTHER, ctx } }, { ...LIMITS, MAX_DESCRIPTION_BYTES: DESCRIBE_LIMIT }, ctx,
  ), '角色门拒绝(无 action)的返回值')
  assert.equal(deniedNoAction.ok, false)
  assert.equal('action' in deniedNoAction, false, '拿不到 action 时省略该键,不留 undefined')

  // ── 10) 并发声明 ────────────────────────────────────────────────────────
  assert.equal(tool.isConcurrencySafe({ action: 'list' }), true)
  assert.equal(tool.isConcurrencySafe({ action: 'get', id: 't1' }), true)
  assert.equal(tool.isConcurrencySafe({ action: 'create' }), false, '写动作必须独占')
  assert.equal(tool.isConcurrencySafe({ action: 'update' }), false, '写动作必须独占')
  step('并发声明', 'list/get=true, create/update=false')

  // ── 11) 参数校验走真实 DSL(非法 action 被 defineTool 挡在 execute 外)─────
  const badAction = await expectFail(state, { action: 'delete' }, ROOT)
  assert.match(badAction, /action/)
  step('非法 action 被参数校验拦下', badAction.split('\n')[0].slice(0, 60))

  // ── 12) 契约已无 project(2026-09-25 用户决定:参数整个删掉)───────────────
  // 12a) 参数表里没有它
  assert.equal('project' in TOOL_PARAMETERS, false, 'project 参数必须已从契约删除')
  assert.deepEqual(
    Object.keys(TOOL_PARAMETERS),
    ['action', 'id', 'subject', 'description', 'status', 'owner', 'blocked_by', 'write_scopes', 'expected_revision', 'limit'],
    '参数集合 = 动作 + 九个可选项(原 project 位已空出)',
  )
  // 12b) 描述里没有旧口径(分桶不再提"项目根";AGENTS.md 那处"project"是目录名,不在此列)
  assert.equal(TOOL_DESCRIPTION.includes('project root'), false, '描述里不得再有"按项目根分桶"的旧口径')
  assert.equal(TOOL_DESCRIPTION.includes('project defaults'), false)
  assert.equal(TOOL_DESCRIPTION.includes('tasks per project'), false)
  assert.equal(TOOL_DESCRIPTION.includes('project buckets'), false)
  assert.match(TOOL_DESCRIPTION, /ROOT session id/, '描述要写明板键 = 根会话 id')
  assert.match(TOOL_DESCRIPTION, /NO growth/, '描述要写明没有增长型上限')
  // 12c) 行为:老调用方多传的 project 会被忽略,绝不参与分桶(defineTool 容忍多余键)
  const contractTask = await call(state, { action: 'create', subject: '契约用例' }, ROOT)
  assert.equal(contractTask.boardKey, 's-root')
  const plainList = await call(state, { action: 'list' }, ROOT)
  const withStaleProject = await call(state, { action: 'list', project: 'C:\\__tb_test__\\elsewhere' }, ROOT)
  assert.equal(withStaleProject.boardKey, plainList.boardKey, 'project 已不参与分桶')
  assert.equal(withStaleProject.total, plainList.total, '传 project 不改变看到的板')
  assert.equal(withStaleProject.total, 1, '看到的仍是本会话树那块板')
  assert.ok(!JSON.stringify(withStaleProject).includes('elsewhere'), '回体里不得回显 project')
  step('契约已无 project', `参数 ${Object.keys(TOOL_PARAMETERS).length} 个;传 project 仍落在 ${withStaleProject.boardKey}`)

  // ── 13) render 输出必须精简 ──────────────────────────────────────────────
  const rendered = tool.output.render({ action: 'list' }, plainList)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  const lines = rendered[0].text.split('\n')
  assert.equal(lines.length, 2, 'render 应是"一行摘要 + 一行紧凑 JSON"')
  assert.ok(!lines[1].includes('\n  '), 'JSON 必须是紧凑形态(无缩进)')
  // 落会话历史的就是这一行 JSON ⇒ 它必须是返回值的无损序列化(关口之外再钉一条)
  assert.deepStrictEqual(JSON.parse(lines[1]), plainList, 'render 的 JSON 行必须是返回值的无损序列化')
  step('render 精简', `${rendered[0].text.length} B,2 行(JSON 行可无损解析回返回值)`)

  // ── 14) 清理钩子存在(热卸载时不泄漏工具注册)────────────────────────────
  assert.equal(typeof state.effectors[0], 'function', 'ctx.effect 应登记一个 disposer')
  assert.equal(state.injected.length >= 1, true, '存储打开应挂在 ctx.inject(可选依赖)上,而不是 apply 里查一次 ctx.get')
  await state.dispose()
  assert.equal(state.disposed, 1, 'disposer 应撤销工具注册')
  step('ctx.effect disposer', `disposed=${state.disposed}(存储子 fiber 的 disposer 也一并跑过)`)

  // ── 16) 上溯失败一律回退本会话 id(绝不报错、绝不拒调用、绝不写错板)────────
  // 纯函数层:四种情形分别断言
  const lookupFrom = (map) => (sessionId) => map.get(sessionId)?.session
  // ① 父会话不是活对象(已销毁)
  const liveOnlyRoot = new Map([[ROOT.id, { session: ROOT }]])
  assert.deepEqual(
    resolveBoardKey(sessionStub('s-x', 's-root-gone', 1), lookupFrom(liveOnlyRoot)),
    { key: 's-x', source: 'fallback' },
    '父会话已销毁 ⇒ 回退本会话 id',
  )
  // ② 完全没有 lookup(插件 ctx 与 exec.agent.ctx 都拿不到服务)
  assert.deepEqual(resolveBoardKey(SUB, undefined), { key: 's-sub', source: 'fallback' })
  // ③ 父链成环(宿主不会造出来,但解析必须能自保)
  const cycleA = sessionStub('c-a', 'c-b')
  const cycleB = sessionStub('c-b', 'c-a')
  assert.deepEqual(
    resolveBoardKey(cycleA, lookupFrom(new Map([['c-a', { session: cycleA }], ['c-b', { session: cycleB }]]))),
    { key: 'c-a', source: 'fallback' },
    '成环 ⇒ 回退,不能死循环',
  )
  // ④ 超深链(超过跳数上限)⇒ 回退;而正常的三层链要能一路到根
  const deep = []
  for (let index = 0; index < 64; index += 1) {
    deep.push(sessionStub(`d-${index}`, index === 0 ? undefined : `d-${index - 1}`))
  }
  const deepMap = new Map(deep.map((session) => [session.id, { session }]))
  assert.deepEqual(
    resolveBoardKey(deep.at(-1), lookupFrom(deepMap)),
    { key: 'd-63', source: 'fallback' },
    '超深链 ⇒ 回退(不会顺着链爬到底)',
  )
  assert.deepEqual(
    resolveBoardKey(sessionStub('n-3', 'n-2'), lookupFrom(new Map([
      ['n-1', { session: sessionStub('n-1') }],
      ['n-2', { session: sessionStub('n-2', 'n-1') }],
    ]))),
    { key: 'n-1', source: 'ancestor' },
    '正常多层链 ⇒ 一路到根会话',
  )
  // 只有"活会话"没有"活代理"时也要能解析(SessionStore 是第二个数据源)

  // 工具层:专用一对父子会话(不影响前面的板计数),先证明能上溯,再把父会话"销毁"看回退
  const FB_ROOT = sessionStub('s-fb-root')
  const FB_SUB = sessionStub('s-fb-sub', 's-fb-root', 1)
  revive(FB_ROOT)
  const beforeKill = await call(state, { action: 'create', subject: '上溯正常' }, FB_SUB)
  assert.equal(beforeKill.boardKey, 's-fb-root', '父会话活着 ⇒ 落在父会话那块板上')
  assert.equal(beforeKill.boardSource, 'ancestor')
  // ②b 数据源顺序:agents 里没有、sessions 里有 ⇒ 照样解析到父会话
  LIVE_SESSIONS.set('s-fb-root', FB_ROOT)
  LIVE_AGENTS.delete('s-fb-root')
  const viaSessionsOnly = await call(state, { action: 'list' }, FB_SUB)
  assert.equal(viaSessionsOnly.boardKey, 's-fb-root', 'agents 里没有也能从 sessions 解析到父会话')
  assert.equal(viaSessionsOnly.total, 1, '解析到同一块板')
  LIVE_SESSIONS.delete('s-fb-root')
  const orphanLive = await call(state, { action: 'create', subject: '父会话已销毁' }, FB_SUB)
  assert.equal(orphanLive.boardKey, 's-fb-sub', '回退到调用者自己的会话 id')
  assert.equal(orphanLive.boardSource, 'fallback')
  assert.ok(orphanLive.summary.includes('板键回退'), '摘要要明说这次用了回退键')
  assert.equal(orphanLive.ok, true, '回退绝不导致拒调用')
  assert.equal(orphanLive.task.id, 't1', '回退板是全新的独立板(id 从 t1 起,不是父会话那块)')
  const fbRootBoard = await call(state, { action: 'list' }, FB_ROOT)
  assert.equal(fbRootBoard.total, 1, '父会话的板只有它自己那条')
  assert.ok(!JSON.stringify(fbRootBoard).includes('父会话已销毁'), '回退期间写的内容没进父会话的板(没写错板)')
  const fbSubBoard = await call(state, { action: 'list' }, FB_SUB)
  assert.equal(fbSubBoard.total, 1, '子代理此刻看到的是自己的回退板')
  assert.ok(!JSON.stringify(fbSubBoard).includes('上溯正常'), '两块板内容互不相通')
  // 父会话恢复成活对象 ⇒ 同一个子代理又回到共板(它自己的回退板仍在内存里,不会被合并)
  LIVE_AGENTS.set('s-fb-root', { session: FB_ROOT })
  const backOnRoot = await call(state, { action: 'list' }, FB_SUB)
  assert.equal(backOnRoot.boardKey, 's-fb-root', '父会话恢复活对象后又回到共板')
  assert.equal(backOnRoot.total, 1, '回到父会话那块板(1 条)')
  // 服务整体不可用(拿不到 agents / sessions)⇒ 同一回退路径,且不报错
  const noServices = makeCtx({ live: false })
  apply(noServices.ctx, {})
  const offline = await call(noServices.state, { action: 'create', subject: '服务不可用' }, FB_SUB)
  assert.equal(offline.boardKey, 's-fb-sub', '两个服务都拿不到 ⇒ 回退本会话 id')
  assert.equal(offline.boardSource, 'fallback')
  assert.equal(offline.ok, true, '服务不可用绝不导致拒调用')
  assert.equal(offline.task.id, 't2', '仍是那块回退板(与父会话销毁期间写的是同一块)')
  step('上溯失败 ⇒ 回退', `父已销毁/无服务/成环/超深 四路皆回退;摘要带提示;恢复后回到 ${backOnRoot.boardKey}`)

  // ── 17) 只有"会话连 id 都没有"才报错(这不是上溯失败,而是板键无从谈起)────
  const noIdMsg = (() => {
    try {
      resolveBoardKey({ header: { agentPreset: GATE_PRESET } }, lookupFrom(new Map()))
      return ''
    } catch (error) {
      return String(error?.message ?? error)
    }
  })()
  assert.match(noIdMsg, /无法确定本会话 id/)
  step('会话无 id 才报错', noIdMsg)

  // ── 15) 契约一致:描述 / 参数 / 实现三处的动作集合必须一致(仍是五个)──────
  const ACTIONS = ['create', 'list', 'get', 'update', 'remove']
  assert.deepEqual(TOOL_PARAMETERS.action.enum, ACTIONS, '动作枚举变了 ⇒ 实现与 TOOL_DESCRIPTION 要一起改')
  assert.equal(TOOL_PARAMETERS.action.required, true, 'action 必填')
  for (const optional of [
    'id', 'subject', 'description', 'status', 'owner',
    'blocked_by', 'write_scopes', 'expected_revision', 'limit',
  ]) {
    assert.equal('required' in TOOL_PARAMETERS[optional], false, `可选参数 ${optional} 不得声明 required(false 会被 defineTool 直接抛)`)
  }
  assert.match(TOOL_DESCRIPTION, /one tool, five actions/, '描述要写明"一个工具、五个动作"')
  for (const action of ACTIONS) {
    assert.ok(TOOL_DESCRIPTION.includes(action), `TOOL_DESCRIPTION 要逐个列出动作:缺 ${action}`)
  }
  // 存储口径已改(2026-09-26):描述里不得再有"内存态 / 重启即空 / 从不落盘"的旧事实,
  // 且必须写明"跨重启存活"与降级行为 —— 描述与行为必须同步,这条就是那道闸。
  assert.equal(TOOL_DESCRIPTION.includes('MEMORY ONLY'), false, '描述里不得再有"内存态"的旧口径')
  assert.equal(TOOL_DESCRIPTION.includes('NEVER written to disk'), false, '描述里不得再有"从不落盘"的旧口径')
  assert.equal(TOOL_DESCRIPTION.includes('EMPTY after any dsh restart'), false, '描述里不得再有"重启即空"的旧口径')
  assert.match(TOOL_DESCRIPTION, /DURABLE/, '描述要写明存储是持久的')
  assert.match(TOOL_DESCRIPTION, /across dsh restarts/, '描述要写明跨 dsh 重启存活')
  assert.match(TOOL_DESCRIPTION, /ctx\.storageDomain/, '描述要点名持久化的落点')
  assert.match(TOOL_DESCRIPTION, /degrades to memory-only/, '描述要写明降级行为')
  step('契约一致(描述/参数/实现)', `actions=${ACTIONS.join('/')};9 个可选参数均未声明 required`)

  // ── 18) 领域存储:先落盘、跨"进程重启"存活、删空即删记录、降级 ──────────────
  // 这一段单起一份介质与两个 apply 实例,模拟宿主里的真实形态:
  //   实例 A = "重启前"(正常写入);实例 B = "重启后"(清空内存 + 同一份介质 ⇒ 从介质水合)。
  // 全程只碰内存里的假介质:不写用户真实 storages 目录、不起 dsh 进程。
  const ST_ROOT = sessionStub('s-store-root')
  const ST_SUB = sessionStub('s-store-sub', 's-store-root', 1)
  revive(ST_ROOT)
  const medium = new Map()
  const stubA = makeStorageDomainStub(medium, { closeDelayMs: 120 })
  const instA = makeCtx({ storage: stubA })
  apply(instA.ctx, { MAX_DESCRIPTION_BYTES: DESCRIBE_LIMIT })

  // 域声明本身要合规(名字必须匹配宿主 UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/ ⇒ 用下划线不用连字符)
  assert.equal(DOMAIN_SPEC.name, 'task_board', 'domain 名必须匹配 UNIT_NAME_RE(连字符会让模块加载期直接抛)')
  assert.equal(DOMAIN_SPEC.version, 1)
  assert.deepEqual(Object.keys(DOMAIN_SPEC.tables), [TABLE_BOARDS], '只有一个表:boards')
  assert.equal(typeof DOMAIN_SPEC.tables[TABLE_BOARDS].valueSchema.parse, 'function', '表 schema 必须能被域层 parse')

  const aCreate1 = await call(instA.state, {
    action: 'create', subject: '重启前第一条', description: '落盘验证', status: 'in_progress',
  }, ST_ROOT)
  assert.equal(aCreate1.ok, true)
  assert.equal(aCreate1.task.id, 't1')
  assert.equal(aCreate1.boardKey, 's-store-root')
  // W5 口径(2026-09-26):持久/降级的陈述由**摘要**统一承担(五个动作都有摘要),note 只在降级时出声。
  // 旧实现把"持久态:…跨 dsh 重启存活"无条件写进 create 的 note 首句 ⇒ 降级时与末尾那句自相矛盾。
  assert.equal(aCreate1.note.includes('降级'), false, '正常路径的 note 不得提降级')
  assert.equal(aCreate1.note.includes('持久态'), false, 'note 不再无条件宣称"持久态"(那是摘要与日志的活)')
  assert.equal(aCreate1.summary.includes('降级'), false, '正常路径的摘要不得提降级')
  assert.equal(aCreate1.summary.includes('跨 dsh 重启存活'), false, '摘要是"这一行板"的摘要,不该背存储语义')
  const aCreate2 = await call(instA.state, {
    action: 'create', subject: '重启前第二条', blocked_by: ['t1'], owner: 'sub-store',
  }, ST_SUB)
  assert.equal(aCreate2.task.id, 't2', '子代理与父会话共用一块板(回归保护)')
  const aUpdate = await call(instA.state, {
    action: 'update', id: 't1', expected_revision: 1, status: 'completed',
  }, ST_ROOT)
  assert.equal(aUpdate.revision, 2)
  assert.equal(aUpdate.summary.includes('降级'), false, '正常路径的 update 摘要也不得提降级')

  // 存储状态:必须是 ready(不是降级),且板就是内存里那一块
  const statusA = __storageStatus(instA.ctx)
  assert.equal(statusA.status, 'ready', `假 storageDomain 应当被正常打开,实际 status=${statusA.status}(${statusA.reason})`)
  assert.equal(statusA.domain, DOMAIN_NAME)

  // 介质里必须真有这条记录,且形状 = { key, seq, tasks }(一块板一条记录)
  assert.ok(medium.has(DOMAIN_NAME), '域必须在介质里落了 unit')
  const storedA = storedBoards(stubA)
  assert.equal(storedA.size, 1, '一块板 = 一条记录')
  const recordA = storedA.get('s-store-root')
  assert.equal(recordA.key, 's-store-root')
  assert.equal(recordA.seq, 2, 'seq 也落盘(id 序列跨重启不重复)')
  assert.deepEqual(recordA.tasks.map((task) => task.id), ['t1', 't2'])
  assert.equal(recordA.tasks[0].revision, 2, 'update 后的 revision 立刻落盘')
  assert.equal(recordA.tasks[0].status, 'completed')
  assert.equal(recordA.tasks[0].description, '落盘验证')
  assert.equal('owner' in recordA.tasks[0], false, '无 owner 的任务在介质里也不写 owner 键(undefined 会被 JSON 丢掉)')
  assert.equal(recordA.tasks[1].owner, 'sub-store')
  assert.deepEqual(recordA.tasks[1].blockedBy, ['t1'], '依赖关系也落盘')
  assertLosslessJson(recordA, '介质里的板记录') // 介质就是 JSON 文档:记录本身也必须严格无损
  step('写入落盘', `记录 ${DOMAIN_NAME}/${TABLE_BOARDS}/s-store-root:seq=${recordA.seq} tasks=${recordA.tasks.length} rev(t1)=${recordA.tasks[0].revision}`)

  // —— 模拟 dsh 进程重启 ——
  // ① 关掉旧实例的域(disposer 返回 close 的 promise;这里**故意不 await**,
  //    好让新实例先撞 already-open 再靠重试开成功 —— 那正是配置热加载时的真实竞态);
  // ② 清空内存板(等价于新进程里 BOARD 是空的);
  // ③ 同一份介质上新建 apply 实例 ⇒ 板必须从介质水合回来。
  const closingA = instA.state.effectors[0]()
  __resetForTest()
  const stubB = makeStorageDomainStub(medium) // 重启后的进程:域名还没被释放 ⇒ 第一次 open 必撞 already-open
  const instB = makeCtx({ storage: stubB })
  apply(instB.ctx, { MAX_DESCRIPTION_BYTES: DESCRIBE_LIMIT })

  const bList = await call(instB.state, { action: 'list' }, ST_ROOT)
  assert.equal(bList.ok, true, '重启后板还在(不是"还没有任务板")')
  assert.equal(bList.total, 2, '重启后两条都水合回来了')
  assert.deepEqual(bList.tasks.map((row) => row.id), ['t1', 't2'])
  assert.equal(bList.tasks[0].revision, 2, 'revision 跨重启存活')
  assert.equal(bList.tasks[0].status, 'completed')
  assert.equal(bList.tasks[1].owner, 'sub-store', 'owner 跨重启存活')
  assert.equal(__storageStatus(instB.ctx).status, 'ready', 'already-open 重试后应当开成功(而不是降级)')
  const bGet = await call(instB.state, { action: 'get', id: 't1' }, ST_ROOT)
  assert.equal(bGet.task.description, '落盘验证', 'description 跨重启存活')
  assert.equal(bGet.task.ready, true)
  const bGetBlocked = await call(instB.state, { action: 'get', id: 't2' }, ST_SUB)
  assert.equal(bGetBlocked.task.ready, true, '依赖关系也活着:t1 已完成 ⇒ t2 就绪')
  assert.deepEqual(bGetBlocked.task.blockedBy, ['t1'])
  assert.equal(bGetBlocked.boardKey, 's-store-root', '重启后父子共板口径不变')
  assert.equal(bGetBlocked.boardSource, 'ancestor')

  // seq 存活 ⇒ 新条目接在 t3(而不是从 t1 重来,更不会覆盖 t1)
  const bCreate = await call(instB.state, { action: 'create', subject: '重启后新建' }, ST_ROOT)
  assert.equal(bCreate.task.id, 't3', 'seq 跨重启存活 ⇒ id 不重复')
  assert.equal(bCreate.counts.boards, 1, '内存里只有介质里这一块板(其它板在"重启"时随内存清空)')

  // CAS 跨重启照样生效:过期即拒并回最新 revision,正确 revision 才放行
  const bStale = await expectFail(instB.state, {
    action: 'update', id: 't1', expected_revision: 1, subject: '不该写进去',
  }, ST_ROOT)
  assert.match(bStale, /revision 冲突/)
  assert.match(bStale, /最新 revision 已是 2/, '拒绝信息要回水合回来的最新 revision')
  const bCas = await call(instB.state, {
    action: 'update', id: 't1', expected_revision: 2, subject: '重启后改的',
  }, ST_ROOT)
  assert.equal(bCas.revision, 3)
  assert.equal(
    storedBoards(stubB).get('s-store-root').tasks[0].revision, 3,
    '成功写必须立刻推进介质里的 revision',
  )
  assert.equal(
    storedBoards(stubB).get('s-store-root').tasks[0].subject, '重启后改的',
    '成功写必须立刻落进介质',
  )
  step('跨重启存活', `重启后 list=${bList.total} 条,t1 rev=${bList.tasks[0].revision},新建 id=${bCreate.task.id},CAS 仍生效(过期 rev1 被拒、rev2 放行)`)

  // 板删空 ⇒ 介质里的记录也要删掉(不是留一条空记录),且删掉的板不会在下次重启复活
  const rmT3 = await call(instB.state, { action: 'remove', id: 't3', expected_revision: 1 }, ST_ROOT)
  assert.equal(rmT3.boardRemoved, false, '还有条目 ⇒ 板保留')
  assert.equal(storedBoards(stubB).has('s-store-root'), true, '板没空 ⇒ 介质里的记录仍在')
  await call(instB.state, { action: 'remove', id: 't2', expected_revision: 1 }, ST_ROOT)
  const rmT1 = await call(instB.state, { action: 'remove', id: 't1', expected_revision: 3 }, ST_ROOT)
  assert.equal(rmT1.boardRemoved, true, '删空 ⇒ 回收板')
  assert.equal(storedBoards(stubB).has('s-store-root'), false, '板删空 ⇒ 介质里的记录也删了')
  assert.equal(rmT1.note.includes('也一并删除'), true, 'remove 的 note 要写明记录同时删除')

  // 第三次"重启":删掉的板不得复活(介质里确实没这条记录了)
  await instB.state.effectors[0]()
  __resetForTest()
  const stubC = makeStorageDomainStub(medium)
  const instC = makeCtx({ storage: stubC })
  apply(instC.ctx, {})
  const cList = await call(instC.state, { action: 'list' }, ST_ROOT)
  assert.equal(cList.ok, false, '被删空的板不会在重启后复活')
  assert.match(cList.summary, /还没有任务板/)
  assert.equal(__storageStatus(instC.ctx).status, 'ready', '域仍可正常打开(介质里只是没有这条记录)')
  await closingA // 旧实例的 close 收尾(already-open 竞态那条路径的收尾)
  step('删空即删记录', `介质里 s-store-root 已消失,重启后 list.ok=${cList.ok}`)

  // 降级路径:宿主没挂 storageDomain ⇒ 打一条明确警告 + 退回纯内存态(工具照常可用)
  // ⚠ 日志用 console.log 拦截来收(桩 state.logs 只记 apply 期的东西,插件写日志走的是 console.log);
  //   拦截窗口必须**跨过** settledStatus(那条警告是 setTimeout(0) 里打的,apply 返回时还没出现)。
  const logged = []
  const originalLog = console.log
  const instD = makeCtx() // 不给 storageDomain
  let statusD
  try {
    console.log = (...parts) => { logged.push(parts.join(' ')) }
    apply(instD.ctx, {})
    statusD = await settledStatus(instD.ctx)
  } finally {
    console.log = originalLog
  }
  assert.equal(statusD.status, 'degraded', '服务缺失 ⇒ 降级')
  assert.ok(
    logged.some((line) => line.includes('警告') && line.includes('storageDomain')),
    '降级必须打一条明确的警告日志(不抛错、不让整行加载失败)',
  )
  assert.ok(
    logged.some((line) => line.includes('注入回调始终未激活')),
    '这条降级要说清是"注入回调没被激活"(而不是打开失败)',
  )
  assert.equal(instD.state.injected.length, 1, '存储必须挂在 ctx.inject 上(可选依赖的正确形态)')
  assert.deepEqual(instD.state.injected[0].names, ['storageDomain'])
  const dCreate = await call(instD.state, { action: 'create', subject: '降级态' }, sessionStub('s-degraded-root'))
  assert.equal(dCreate.ok, true, '降级不影响工具可用性')
  // W5 口径:降级提示**只出现一次**(在摘要里),note 不再重复、也不再宣称"持久态"(旧实现的自相矛盾)
  assert.equal(dCreate.summary.includes('降级'), true, '降级态摘要要明说本次只写内存')
  assert.equal(dCreate.summary.includes('dsh 重启即空'), true)
  assert.equal(dCreate.note.includes('降级'), false, 'note 不重复那句提示(摘要里已经有了)')
  assert.equal(dCreate.note.includes('持久态'), false, 'note 不得宣称"持久态"')
  assert.equal(dCreate.note.includes('只在本进程内存里'), true, 'note 要说清数据在哪、去哪看原因')
  const dRemove = await call(instD.state, { action: 'remove', id: 't1', expected_revision: 1 }, sessionStub('s-degraded-root'))
  assert.equal(dRemove.boardRemoved, true, '降级态下五个动作行为与旧版一致(板空即回收)')
  assert.equal(dRemove.summary.includes('降级'), true)
  assert.equal(dRemove.note.includes('持久态'), false)
  step('服务缺失降级', `status=degraded,警告已打,create/remove 照常(boards=${dCreate.counts.boards})`)

  // 打开失败也要降级(不抛回 loader):介质里放一条**不合 schema** 的记录 ⇒ 真实域层会在 open 时抛
  // invalid-record,插件必须只打警告 + 退回内存态(假设施与真实 facility 一样在 open 时逐条校验)
  const badMedium = new Map([[
    DOMAIN_NAME,
    new Map([[TABLE_BOARDS, new Map([['s-bad-root', { key: 's-bad-root', seq: '不是数字', tasks: [] }]])]]),
  ]])
  const instE = makeCtx({ storage: makeStorageDomainStub(badMedium) })
  const loggedE = []
  const originalLogE = console.log
  let eList
  try {
    console.log = (...parts) => { loggedE.push(parts.join(' ')) }
    apply(instE.ctx, {})
    eList = await call(instE.state, { action: 'list' }, sessionStub('s-bad-root'))
    await settledStatus(instE.ctx)
  } finally {
    console.log = originalLogE
  }
  assert.equal(eList.ok, false, '打不开域 ⇒ 只能看到内存(内存里没有这块板)')
  assert.equal(__storageStatus(instE.ctx).status, 'degraded', 'open 失败 ⇒ 降级')
  assert.ok(
    loggedE.some((line) => line.includes('警告') && line.includes('打开失败')),
    'open 失败必须打一条明确的警告日志',
  )
  step('打开失败降级', `介质记录不合 schema ⇒ status=${__storageStatus(instE.ctx).status},工具照常可用`)

  // 落盘失败 ⇒ 整条调用报错 + 内存回滚(不留"内存里有、介质里没有"的幽灵空板),介质里也没有记录
  const failStub = makeStorageDomainStub(new Map())
  const instF = makeCtx({ storage: failStub })
  apply(instF.ctx, {})
  const FAIL_ROOT = sessionStub('s-fail-root')
  await call(instF.state, { action: 'list' }, FAIL_ROOT) // 等"打开 + 水合"落定
  assert.equal(__storageStatus(instF.ctx).status, 'ready')
  failStub.failNextPut.value = true
  const putFailMsg = await expectFail(instF.state, { action: 'create', subject: '落盘失败' }, FAIL_ROOT)
  assert.match(putFailMsg, /磁盘写失败/, '落盘失败要让调用方看见失败(而不是静默只写内存)')
  assert.equal(storedBoards(failStub).has('s-fail-root'), false, '落盘失败 ⇒ 介质里不得留下记录')
  const afterFail = await call(instF.state, { action: 'list' }, FAIL_ROOT)
  assert.equal(afterFail.ok, false, '落盘失败后不得留下幽灵空板(仍是"还没有任务板")')
  const retryAfterFail = await call(instF.state, { action: 'create', subject: '失败后重试' }, FAIL_ROOT)
  assert.equal(retryAfterFail.ok, true)
  assert.equal(retryAfterFail.task.id, 't1', '回滚后 seq 未推进 ⇒ 重试仍从 t1 开始')
  assert.equal(storedBoards(failStub).has('s-fail-root'), true, '重试成功才落盘')
  step('落盘失败回滚', `create 报错「${putFailMsg.slice(0, 24)}…」,板未留痕,重试 id=${retryAfterFail.task.id}`)

  // ── 18f) S1 回归:卸载撞上"域正在打开" ⇒ 域句柄不得泄漏 ─────────────────────
  // 现场(独立复核的真机实测):apply 后毫秒级就卸载,此时存储的 open 还没落定 ⇒
  //   旧实现的 disposer 只查 `storage.domain !== null`,那时它是 null ⇒ 不 close;
  //   随后 open 成功 ⇒ 域被打开、句柄不可达、域名永不释放 ⇒ 同一进程内此后每次 apply
  //   都撞 already-open,12×50ms 重试全失败 ⇒ status=degraded,数据只写内存、重启即丢。
  // 修复:S1 两处闸(disposer 先 await ready 再决定 close;ready 落定处再查一次 disposed)。
  // 本用例让 open 慢 60ms、dispose 落在打开完成之前 ⇒ 断言"域真的被关掉、名字被释放、
  // 随后的 apply 能正常 ready(而不是 degraded)"。修复前这条必红(域一直开着)。
  const s1Medium = new Map()
  const s1Stub = makeStorageDomainStub(s1Medium, { openDelayMs: 60 })
  const s1Inst = makeCtx({ storage: s1Stub })
  apply(s1Inst.ctx, {})
  const S1_ROOT = sessionStub('s-s1-root')
  assert.equal(s1Stub.isOpen(), false, '前提:卸载发生在 open 落定之前(此刻域还没开)')
  assert.equal(__storageStatus(s1Inst.ctx).status, 'opening', '前提:此刻仍是 opening(不是 ready)')
  await s1Inst.state.dispose() // disposer 先 await ready,所以这里会等到打开落定并关掉域
  await sleep(120) // 防御:即便 disposer 不等打开落定(旧行为),也给它足够时间把域打开出来 —— 好让下面的断言真的咬住"泄漏"
  assert.equal(s1Stub.isOpen(), false, 'S1:卸载后域必须已被关掉(修复前:域一直开着 ⇒ 句柄泄漏)')
  assert.equal(
    __storageStatus(s1Inst.ctx).status, 'none',
    '卸载后 STORAGES 里的条目也摘掉了(工具注册已撤销,不会再有人来取它)',
  )
  assert.deepEqual(s1Stub.openLog, [DOMAIN_NAME], 'S1:域确实被打开过一次(打开本身成功,泄漏的只是那个没人关的句柄)')
  const s1Again = makeCtx({ storage: s1Stub })
  apply(s1Again.ctx, {})
  await call(s1Again.state, { action: 'list' }, S1_ROOT) // 等打开落定
  assert.equal(
    __storageStatus(s1Again.ctx).status, 'ready',
    'S1:同一设施上重新 apply 必须能正常 ready(修复前:domain already open ⇒ degraded,该进程内永久降级)',
  )
  const s1Created = await call(s1Again.state, { action: 'create', subject: 'S1 后仍能落盘' }, S1_ROOT)
  assert.equal(s1Created.ok, true)
  assert.equal(
    s1Medium.get(DOMAIN_NAME)?.get(TABLE_BOARDS)?.has('s-s1-root'), true,
    'S1:重新 apply 之后写盘照常(域是活的)',
  )
  await s1Again.state.dispose()
  assert.equal(s1Stub.isOpen(), false, 'S1:第二个实例卸载后域也关掉了(没有新泄漏)')
  step('S1 卸载竞态', `open 未落定时 dispose ⇒ 域已关;重新 apply ⇒ status=ready 且写入落盘(openLog=${s1Stub.openLog.join(',')})`)

  // ── 18g) W2:落盘未完成时并发 list 不得看到"板存在但 0 条" ────────────────
  // 旧实现:requireBucket 先把空板塞进内存,再去落盘 ⇒ 那段窗口里并发 list 会看到
  // "板存在但 0 条"(与"内存读 = 介质内容"的口径冲突)。修复:空板推迟到落盘成功之后才入 BOARD。
  const w2Stub = makeStorageDomainStub(new Map(), { putDelayMs: 50 })
  const w2Inst = makeCtx({ storage: w2Stub })
  apply(w2Inst.ctx, {})
  const W2_ROOT = sessionStub('s-w2-root')
  await call(w2Inst.state, { action: 'list' }, W2_ROOT) // 等打开 + 水合落定(此板还不存在)
  const w2Pending = call(w2Inst.state, { action: 'create', subject: 'W2 首条' }, W2_ROOT)
  const w2DuringList = await call(w2Inst.state, { action: 'list' }, W2_ROOT) // 此刻 put 还在 50ms 的窗口里
  assert.equal(
    w2DuringList.ok, false,
    'W2:落盘未完成时并发 list 必须仍是"还没有任务板"(修复前:板已入内存 ⇒ 看到 0 条的板)',
  )
  assert.match(w2DuringList.summary, /还没有任务板/)
  const w2Created = await w2Pending
  assert.equal(w2Created.task.id, 't1')
  const w2AfterList = await call(w2Inst.state, { action: 'list' }, W2_ROOT)
  assert.equal(w2AfterList.ok, true, '落盘成功之后板才出现')
  assert.equal(w2AfterList.total, 1)
  await w2Inst.state.dispose()
  step('W2 空板窗口', `落盘窗口内 list.ok=${w2DuringList.ok}(仍是"还没有任务板"),落盘后 total=${w2AfterList.total}`)

  // ── 18h) W3:水合时 seq 取 max(介质 seq, 板内 id 最大序号)─────────────────
  // 现场(独立复核实测):把介质里的 seq 手改成 1(板内其实有 t1/t2)⇒ 旧实现直接采信 1,
  // 下一次 create 分到 id=t2 ⇒ **把板上原有的 t2 整条覆盖**。修复后 seq = max(1, 2) = 2 ⇒ 新条目是 t3。
  const w3Medium = new Map([[
    DOMAIN_NAME,
    new Map([[TABLE_BOARDS, new Map([['s-w3-root', {
      key: 's-w3-root',
      seq: 1, // ⚠ 被人手改小/写错的 seq
      tasks: [
        {
          id: 't1', revision: 1, subject: '原有 t1', description: '', status: 'pending',
          blockedBy: [], writeScopes: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 't2', revision: 1, subject: '原有 t2(绝不能被覆盖)', description: '', status: 'pending',
          blockedBy: [], writeScopes: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }]])]]),
  ]])
  const w3Stub = makeStorageDomainStub(w3Medium)
  const w3Inst = makeCtx({ storage: w3Stub })
  apply(w3Inst.ctx, {})
  const W3_ROOT = sessionStub('s-w3-root')
  const w3List = await call(w3Inst.state, { action: 'list' }, W3_ROOT)
  assert.equal(w3List.total, 2, '前提:介质里的两条都水合回来了')
  const w3Create = await call(w3Inst.state, { action: 'create', subject: 'W3 新条目' }, W3_ROOT)
  assert.equal(w3Create.task.id, 't3', 'W3:seq 取 max(介质 seq=1, 板内最大序号=2) ⇒ 新 id 必须是 t3')
  assert.notEqual(w3Create.task.id, 't2', 'W3:绝不能分配出已存在的 id(那会覆盖原有条目)')
  const w3After = await call(w3Inst.state, { action: 'list' }, W3_ROOT)
  assert.equal(w3After.total, 3, '三条并存(t1/t2 都没被覆盖)')
  const w3T2 = await call(w3Inst.state, { action: 'get', id: 't2' }, W3_ROOT)
  assert.equal(w3T2.task.subject, '原有 t2(绝不能被覆盖)', 'W3:原有 t2 原封不动')
  assert.equal(
    storedBoards(w3Stub).get('s-w3-root').seq, 3,
    'W3:落盘的 seq 也被修正成 3(向前走,绝不回退)',
  )
  await w3Inst.state.dispose()
  step('W3 seq 硬化', `介质 seq=1 但板内有 t2 ⇒ 水合后新条目 ${w3Create.task.id},原有 t2 未被覆盖`)

  // ── 18i) W5:降级态下五个动作的提示口径一致 ───────────────────────────────
  // 旧实现:create 的 note 首句**无条件**写"持久态:…跨 dsh 重启存活",降级提示只追加在末尾(自相矛盾);
  // 而 list / get / update 完全不提降级 ⇒ 只做读动作的调用方根本察觉不到没落盘。
  // 现在:五个动作的**摘要**都追加同一句降级提示;note 里的存储陈述由同一个判据给出。
  const w5Inst = makeCtx() // 不给 storageDomain ⇒ 降级
  const originalLogW5 = console.log
  let statusW5
  try {
    console.log = () => {}
    apply(w5Inst.ctx, {})
    statusW5 = await settledStatus(w5Inst.ctx)
  } finally {
    console.log = originalLogW5
  }
  assert.equal(statusW5.status, 'degraded')
  const W5_ROOT = sessionStub('s-w5-root')
  const w5Create = await call(w5Inst.state, { action: 'create', subject: 'W5 降级态' }, W5_ROOT)
  const w5List = await call(w5Inst.state, { action: 'list' }, W5_ROOT)
  const w5Get = await call(w5Inst.state, { action: 'get', id: 't1' }, W5_ROOT)
  const w5Update = await call(w5Inst.state, { action: 'update', id: 't1', expected_revision: 1, status: 'completed' }, W5_ROOT)
  const w5Noop = await call(w5Inst.state, { action: 'update', id: 't1', expected_revision: 2 }, W5_ROOT)
  const w5Remove = await call(w5Inst.state, { action: 'remove', id: 't1', expected_revision: 2 }, W5_ROOT)
  const w5NoBoard = await call(w5Inst.state, { action: 'list' }, W5_ROOT)
  for (const [label, value] of [
    ['create', w5Create], ['list', w5List], ['get', w5Get], ['update', w5Update],
    ['update(无字段可改)', w5Noop], ['remove', w5Remove], ['list(板已回收)', w5NoBoard],
  ]) {
    assert.ok(value.summary.includes('降级'), `${label} 的摘要必须明说处于降级态(只写内存),否则调用方察觉不到没落盘`)
    assert.ok(value.summary.includes('dsh 重启即空'), `${label} 的摘要要说清后果`)
  }
  assert.equal(w5NoBoard.ok, false, '板已被回收 ⇒ list 回到"还没有任务板"')
  // note 的口径:不重复那句提示(摘要里已经有了)、不说"持久态",只补一句"数据在哪 + 去哪看原因"
  assert.equal(w5Create.note.includes('持久态'), false, '降级态 note 不得再说"持久态"(旧实现的自相矛盾)')
  assert.equal(w5Create.note.includes('只在本进程内存里'), true, '降级态 note 要说清数据在哪')
  assert.equal(w5Create.note.includes('启动日志'), true, '降级态 note 要指出去哪看原因')
  assert.equal(w5Remove.note.includes('持久态'), false, 'remove 的 note 同口径')
  assert.equal(w5Remove.note.includes('只在本进程内存里'), true)
  // 反面:正常路径(instA 那条)的摘要与 note 一个降级字眼都不许有(降级提示不能变成噪音)
  assert.equal(w5List.summary.includes('持久态'), false, '正常路径的摘要不提存储(摘要只讲板本身)')
  step('W5 降级口径', '五个动作(含无字段可改 / 板已回收两条回执)的摘要都带同一句降级提示,note 不再自相矛盾')

  return { out, limits: LIMITS, gatedReturns, gatedDirect }
}

// ── 执行 ──────────────────────────────────────────────────────────────────
const { out, gatedReturns: gated, gatedDirect: gatedDirectCalls } = await run()
console.log('dsh-host-task-board 桩测试')
console.log(`  defineTool = 真实实现(@deepseek-ai/dsh-tools);ctx = 桩(含 agents / sessions 活对象注册表);用例经 useCase 注册并由 applyInner 执行`)
console.log(out.join('\n'))
console.log(`\n全部通过:${out.length} 项断言组,${gated} 次工具返回值 + ${gatedDirectCalls} 次 dispatch 直调全过严格无损 JSON 关口,0 失败。`)
