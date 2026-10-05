/**
 * dsh-host-task-board v0.1.0
 *
 * 给 DSH web 宿主加一块「共享任务板」,只暴露一个模型工具 task_board
 * (动作 create / list / get / update / remove)。动机:协调者预设此前拿项目根的
 * `.dsh/.project/context.md` 当工作内存,只增不减(最严重一份 53,746 token);
 * 改为任务板后,长期结论由人或代理**手动**搬进项目 AGENTS.md / README。
 *
 * ── 存储(2026-09-26 改造:取代原先的"模块作用域 Map 独存 / dsh 重启必空")──────────
 *   · 内存(BOARD)是**权威读源**:读全部同步、零 IO,五个动作的对外语义与旧版逐条一致。
 *   · 宿主领域存储(ctx.storageDomain,域 `task_board` v1 / 表 `boards`)是**持久投影**:
 *     每次写先 await 落盘、成功后才改内存 —— 与域层自身"后端先落盘、再改域内存"同一顺序。
 *   · apply 时打开域并**水合**:介质里有、内存里还没有的板灌回 BOARD ⇒ **跨 dsh 重启存活**。
 *     打开走 ctx.inject(['storageDomain'], cb) 的**子 fiber**(不是 apply 里一次性 ctx.get):
 *     服务缺席就不执行回调(不报错、不阻塞本行的其它注册),服务**后到**会补跑,
 *     服务热替换会重跑(旧的一次性 ctx.get 在那种行序下会静默降级 —— 见 README「依赖与行序」)。
 *   · 为什么不走"写进会话日志"(已调研确认):未知事件类型会让整段会话在下次读取时被拒。
 *     领域存储正是宿主给"必须跨重启存活、且带 schema 校验的宿主侧数据"准备的形态:
 *     读同步 / 写在落盘后才 resolve / 事件不进会话历史,与"板是宿主状态、不是会话内容"同向。
 *   · 降级(拿不到服务、或打开失败):**不抛错、不让整行加载失败**,只打一条警告并退回纯内存态
 *     (旧行为:dsh 重启即空);此时 create / remove 的 note 会明说"本次运行只存内存"。
 *   · 本模块仍**不 import 任何 node:fs** —— 落盘由宿主后端(dsh-storage-json)完成,
 *     这里只调域 handle(连 node:path 也不需要,分桶不再用路径)。
 *
 * 关键设计(每条都对应一条本机已核实的事实):
 *   · 板状态放**模块作用域** Map ⇒ 跨工具调用 / 跨会话(每棵会话树一块板)/ 跨配置热加载存活;
 *     放 apply 局部变量或服务实例字段会被热加载清空。域 handle 反过来是**每个 apply 一份**
 *     (WeakMap 按 ctx 取,disposer 里 close):宿主规定同一 domain 名同一时刻只能开一个。
 *   · 只注册**一个**工具、五个动作 ⇒ 常驻 schema 预算最小(省上下文)。
 *   · 只有 output.render() 的 content 落会话历史 ⇒ 返回体必须精简,
 *     **绝不 dump 整板**(list 只回 {id,status,ready,revision,owner,subject},再按需 get)。
 *   · 角色门:只有协调者预设(preset id = `coordinator`)的会话及其子代理可调用;
 *     子代理继承父会话的 agentPreset ⇒ 同一个判据覆盖两者。
 *   · 分桶 key = **根会话 id**(2026-09-25 用户决定,取代原先的"规范化项目根路径"):
 *     同一个顶层会话及其派生的全部子代理(任意深度)共用一块板,换一个新对话就是全新一块板。
 *     上溯只走会话头里的 parentSession 父链、只查**内存里的活代理/活会话**;
 *     解析失败一律回退调用者自己的会话 id —— 细节与依据见 resolveBoardKey / makeSessionLookup 注释。
 *   · update / remove 用 expected_revision 做乐观锁(CAS):版本过期即拒并回**最新 revision**。
 *   · remove 按 id 删一条;板空了**连板对象一起删**(桶与 id 序列一起复位,与"完成即搬走"同向)。
 *   · ready 的判据(2026-09-25 用户决定,改过一次):blocked_by 里**存在**的 id 全部 completed ⇒ 就绪;
 *     **板上不存在的 id 不算阻塞**,只在视图的 missingBlockers 与摘要里如实提示"这条依赖已经不在板上了"。
 *     旧实现把"不存在"也当阻塞(注释写的是旧意图、实现与之不符)⇒ 依赖项一被 remove 就把下游**永久**卡死
 *     且毫无提示,板上再无任何动作能救活它。要恢复阻塞请用 update 重设 blocked_by。
 *   · 上限治理(2026-09-25 用户决定后只剩"单字段上限"):description / subject 的字节数、
 *     blocked_by / write_scopes 的条数各有硬顶 —— 它们挡的是"一次调用塞进巨量文本",超限**拒绝**不截断。
 *     **增长型上限(每板任务数、板子数量)已整体删除**:一个对话写不了多少条,拿它挡没有收益,
 *     只会挡住正常使用(见下方 LIMITS 注释)。
 *
 * 依赖的宿主事实(2026-09-25 实查,非猜测):
 *   · 工具注册:ctx.tools.register(defineTool({name, description, parameters, output, execute}))
 *     返回 disposer;parameters 的 value-schema DSL 里 `required` 只接受 true(写 false 会抛
 *     "unsupported JSON schema: parameters.<name>.required must be true when present"),
 *     可选参数必须**省略** required;output.schema 的 object 根必须显式写 additionalProperties。
 *   · 只读动作声明 isConcurrencySafe:defineTool 的 `isConcurrencySafe` 选项
 *     (dsh-tools lib/index.js:882,由 agent loop 的并行调度器消费 :3052-3061);
 *     写动作**不声明** ⇒ 默认 exclusive。
 *   · 工具执行上下文:exec.agent.session → .id / .header.cwd / .header.agentPreset
 *     (dsh-session 持久化时校验 agentPreset 必须是字符串,lib/index.js:1012)。
 *   · 会话头里的父链:子代理会话头由 dsh-subagent 的 childSessionMeta() 写入
 *     `parentSession` = 父会话 id、`origin` = 'subagent'、`delegationDepth`(dsh-subagent/lib/index.js:470-481)。
 *     ⇒ 沿 parentSession 逐级上溯即可得到"根会话"= 本会话树的顶层会话。
 *   · 可选读服务:ctx.get(name) 本身不需要 inject(cordis/lib/index.js:755-765
 *     "Read a service from the store without the inject requirement"),没提供时回 undefined。
 *     解析板键用的 agents / sessions、以及存储用的 storageDomain,因此都走 ctx.get 可选读取、
 *     **不进本模块的 inject 导出** —— 进了 inject 而服务缺失会让 apply 抛错 ⇒ 整行加载失败
 *     (与"绝不抛回 loader"的纪律冲突)。
 *   · **可选**依赖的正确形态是 ctx.inject(names, cb)(cordis/lib/index.js:1594-1606 + Fiber 的
 *     _checkImpl / _refresh / _setEpoch,:1098-1101、1306-1344):回调**只在服务可用时**执行,
 *     缺席不执行也不报错;服务后到会补跑;服务消失/替换会把回调的 effect 清理掉再重跑。
 *     存储打开就挂在这个回调里(handle 仍在 applyInner 里同步建、按 ctx 存进 STORAGES,
 *     所以服务缺席时行为与"没有存储"完全一致:纯内存 + 一行警告)。
 *     实测(cordis 4.0.4,真实 Context/Fiber):服务缺席 ⇒ 回调从不执行;服务后到 ⇒ 回调补跑;
 *     父插件卸载 ⇒ 子 fiber 的 disposer 照常执行。
 *   · 领域存储(dsh-storage-domain,2026-09-26 实查):
 *     · 声明:defineDomain({ name, version, tables }) + domainTable(zodSchema),
 *       **在模块加载期**就校验字段 ⇒ 非法名/版本会直接抛(见 DOMAIN_SPEC 的注释:domain 名
 *       必须匹配 UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/,所以是 `task_board` 而不是 `task-board`)。
 *     · 打开:await ctx.storageDomain.open(spec) ⇒ handle;`table(name)` 返回稳定句柄,
 *       `get/entries/keys/size` **同步**读、`put/delete/update` 异步且**落盘后才 resolve**
 *       (lib/index.js:257-287:先 await unit.putRecord,再改域内存,再发 domain/changed)。
 *     · 取出的 record 是**普通不可变数据**(域内存里就是那个对象本身,不做防御性拷贝)
 *       ⇒ 一律 copyTask 深拷贝进自己的结构,绝不原地改。
 *     · 同一 domain 名同一时刻只能开一个:重复 open 抛 DomainError('already-open'),
 *       close() 幂等、且要等收尾跑完才释放名字 ⇒ 热加载竞态用"稍等重试"化解(见 openDomainWithRetry)。
 *     · 域记录会**整体 JSON 化**落到 <DSH_HOME>/storages/<domain>.json(single 布局)
 *       ⇒ undefined 键会被 JSON 丢掉,故 owner 没值时**不写该键**(与返回体的口径一致)。
 *   · 本包新增的两个裸 import(`@deepseek-ai/dsh-storage-domain`、`zod`)与既有的
 *     `@deepseek-ai/dsh-tools` 走**同一套 Node 解析**:profile 级 node_modules 里
 *     `~\.dsh\profiles\node_modules\<pkg>` 是指向 dsh 安装树内的 junction,插件目录与运行副本
 *     都是它的子路径(实测 import.meta.resolve 两个包都解析成功;同 profile 的 dsh-llm-auto
 *     早就这么 import `@deepseek-ai/schemastery`)。package.json **没有**新增依赖。
 *   · 活对象注册表(解析父链只查内存,不读会话日志):
 *     · agents   = dsh-agent 的 AgentRegistry(`super(ctx, 'agents')`:lib/types/index.js:43);
 *       `get(id)` 注释即 "Look up a live agent"(:344-351),活会话挂在返回值的 `.session` 上。
 *     · sessions = dsh-session 的 SessionStore(`super(ctx, 'sessions')`:lib/types/index.js:771);
 *       `get(id)` 注释即 "Look up a live session"(:1037-1044)= 查内存 Map,不触发任何落盘读取。
 *     两者都是"活对象"口径,与 dsh-subagent 自己的 liveLineage() 一致(其 lib/index.js:1036-1048:
 *     ctx.agents.get(parentSession) 逐级向上 + seen 防环)。
 *   · 清理用 ctx.effect(() => () => {...});**不要**用 ctx.on('dispose') —— cordis 无此事件。
 *   · execute 抛错 ⇒ 返回 `Error: <msg>` 失败结果,**不结束轮次**(与"返回 ok:false"等效但不污染 schema)。
 *   · 工具**成功返回的值**必须是**严格无损 JSON**:宿主实测报错文案
 *     `tool "task_board" returned invalid output: value is not lossless JSON`;
 *     规则出处 dsh-tools 的 snapshotToolValue() → dsh-util-values 的 snapshotJsonValue():
 *     只收 null / 布尔 / 有限且非负零的数 / 字符串 / 稠密数组 / 普通或 null 原型对象(键必须可枚举);
 *     undefined / NaN / ±Infinity / -0 / 函数 / symbol / BigInt / Map / Set / Date / RegExp /
 *     类实例 / 稀疏数组 / 循环引用一律不合格。
 *     ⇒ 构造返回体的铁律:**可能没有值的字段一律"省略该键"**,绝不塞 undefined。
 *     踩过一次:`owner` 在 list 的 toSummary() 里有守卫、toView() 里漏了 ⇒
 *     "create 不带 owner"整条成功路径被宿主拒(抛错路径不经过该校验,所以只有成功路径炸)。
 *     test/task-board.test.mjs 把严格关口挂在每次工具调用上,补字段时别绕过它。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** loader 条目 id(与 cordis.patch.yml 里那一行一致;仅用于日志前缀)。 */
export const name = 'task-board'

/**
 * 唯一必需注入的服务:tools。
 * 解析板键用的 agents / sessions、以及存储用的 storageDomain 都走 ctx.get **可选**读取(见文件头):
 * 进了 inject 而服务缺失会让 apply 直接抛错 ⇒ 整行加载失败,与"绝不抛回 loader"的纪律冲突。
 */
export const inject = ['tools']

/** 工具名。 */
export const TOOL_NAME = 'task_board'

/**
 * 角色门:唯一放行的 preset id。
 * 取值出处(实查,不是猜):plugins/dsh-agent-preset-coordinator/presets/coordinator.patch.yml:52
 * 的 `id: coordinator`(该行 name = '@deepseek-ai/dsh-agent-preset',故 preset id = `coordinator`)。
 * 本机 profile 只挂这一个自定义预设 ⇒ 白名单硬编码为单值;要扩就改这里加成员。
 */
export const GATE_PRESET = 'coordinator'

/**
 * 上限(超限**拒绝**,不截断)。2026-09-25 用户决定后只剩**单字段输入上限**:
 * 它们挡的是"一次调用塞进巨量文本",与"板上能攒多少条"无关。
 * 增长型上限(每板未完成任务数 / 板子数量)已整体删除,理由写在下面第 1 条。
 *
 * · MAX_DESCRIPTION_BYTES = 8192(8 KiB UTF-8)
 *   这是本插件的存在理由所在:老 context.md 最严重一份 53,746 token(约 178 KB)。
 *   8 KiB ≈ 2.4k token(按本机实测 3.318 B/token),一条任务描述写满也只有老文件的
 *   1/22;且"描述"该放的是验收标准与产出物,不是正文 —— 正文留给 AGENTS.md/README。
 *   参照 dsh-experimental-agent-team 的 DEFAULT_MAX_MESSAGE_BYTES = 65536,本板收严 8 倍,
 *   因为单条描述会随 list/get 进入协调者上下文,消息只投递给一个收件人。
 *
 * · MAX_WRITE_SCOPES = 8
 *   writeScopes 的语义是"这次改动会落在哪几个路径"(用于并行时不撞车),不是清单。
 *   写超过 8 个路径的任务本身就说明它没被拆开 —— 该拆成多条任务,而不是把一条写肥。
 *
 * · MAX_SUBJECT_BYTES = 200 / MAX_BLOCKED_BY = 16
 *   纯防滥用:subject 是行内显示的一行标题(200 B ≈ 100 个汉字足够);
 *   blocked_by 是前置依赖列表,超过 16 条说明依赖关系该重新分层。
 *
 * 1. 已删除:MAX_TASKS_PER_PROJECT = 64(每板未完成任务数硬顶)
 *    旧取值参照 dsh-experimental-agent-team 的 DEFAULT_MAX_TASKS = 256,理由是"板是工作内存、
 *    64 已经把没在收尾的状态顶到很宽"。用户 2026-09-25 决定取消:**一个对话写不了多少条**,
 *    用条数硬顶去逼"完成即移出"属于拿闸门代替习惯,顺带把正常使用也挡住(撞顶时的出路是
 *    "先把完成的条目移出去",而在真需要抢救的场合,人在忙别的)。
 *    仍然成立的那半边纪律由文档承担:完成即 remove / 标 completed,长期结论搬进 AGENTS.md。
 *
 * 2. 已删除:MAX_PROJECTS = 32(板子数量硬顶)
 *    旧理由是"挡 project 传成随机串/每个子目录一个桶导致的桶爆炸"。板键改成**根会话 id**之后
 *    这个风险消失了:键由宿主会话头决定,调用方**无法**凭空造键;而板数天然被"进程里同时存在的
 *    会话树数量"限住,量级与人手开几个对话相同 ⇒ 再设硬顶没有收益。
 *
 * 全部可用 config 覆盖(仍受 1 下限约束);非法值 fail loud(与同 profile 的其它插件一致)。
 * 已删掉的两个键若仍出现在 config 里,会被静默忽略(resolveConfig 只遍历本表)。
 */
export const LIMITS = {
  MAX_DESCRIPTION_BYTES: 8192,
  MAX_WRITE_SCOPES: 8,
  MAX_SUBJECT_BYTES: 200,
  MAX_BLOCKED_BY: 16,
}

/** 三个合法状态。 */
export const STATUSES = ['pending', 'in_progress', 'completed']

/**
 * 内存里的板(**权威读源**):跨 apply() 重跑(配置热加载)存活;内容由宿主领域存储持久化,
 * 所以**也跨 dsh 重启存活**(apply 时从介质水合回来,见 hydrateBoards)。
 * 结构:Map<板键 = 根会话 id, { key, seq, tasks: Map<id, Task> }>
 * Task = { id, revision, subject, description, status, owner, blockedBy, writeScopes, createdAt, updatedAt }
 * 一块板 = 一个会话树(根会话 + 其全部子代理,任意深度)。板内条目被 remove 删空 ⇒ 该板从 Map 里
 * 整体删掉(介质里的记录同时删除);板再建时 seq 从 0 起(id 复位为 t1)。没有任何数量上限
 * (2026-09-25 用户决定)。
 */
const BOARD = new Map()

// ── 宿主领域存储(ctx.storageDomain):板的持久投影 ─────────────────────────────

/** 域存储的 domain 名。⚠ 必须匹配宿主 UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/(dsh-storage lib/index.js:80)。 */
export const DOMAIN_NAME = 'task_board'

/** 域存储的表名(同样受 UNIT_NAME_RE 约束)。 */
export const TABLE_BOARDS = 'boards'

/**
 * 一条任务的域记录 schema。**在 open 时逐条校验介质里的记录**(非法即 open 失败 ⇒ 走降级),
 * 顺带把记录规范化:zod 的 object 默认剥掉未知键、`owner` 缺失时给 undefined。
 * ⚠ 与 toView()/toSummary() 的"没有值就省略键"口径一致:owner 允许缺失。
 */
const taskRecordSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().nonnegative(),
  subject: z.string(),
  description: z.string(),
  status: z.enum(STATUSES),
  owner: z.string().optional(),
  blockedBy: z.array(z.string()),
  writeScopes: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** 一条板的域记录 schema:key = 板键,seq = id 序列,tasks = 整板任务。 */
const boardRecordSchema = z.object({
  key: z.string().min(1),
  seq: z.number().int().nonnegative(),
  tasks: z.array(taskRecordSchema),
})

/**
 * 域声明。**在模块加载期**就校验(defineDomain):名字不合规 / 版本非负整数 / global 接受 null 都直接抛。
 * ⚠ domain 名写 `task_board` 而不是 `task-board`:UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/ 不收连字符,
 *   写连字符会让**整个模块加载失败**(比降级更糟:工具彻底消失)。
 * 记录形状 { key, seq, tasks } ⇒ 一块板一条记录:put 是整板覆盖写、delete 是整板删除,
 * 与"板被删空即回收"一一对应。布局用默认的 single(整域一个 JSON 文档,与本 profile 的 json 后端一致)。
 */
export const DOMAIN_SPEC = defineDomain({
  name: DOMAIN_NAME,
  version: 1,
  tables: { [TABLE_BOARDS]: domainTable(boardRecordSchema) },
})

/**
 * 每个 apply 实例持有的域 handle:WeakMap<插件 ctx, {
 *   domain: 域 handle | null, table: 表 handle | null,
 *   status: 'opening' | 'ready' | 'degraded', reason: string,
 *   disposed: boolean, ready: Promise<void> }>。
 *
 * 为什么按 ctx 存而不是一个模块变量:同一进程里可能同时存在多个 apply 实例(配置热加载、
 * 测试里的多个桩 ctx),按 ctx 取才不会串台;WeakMap 也不阻止 ctx 被回收。
 * `ready` 是"打开 + 水合"的完成信号,工具执行前 await 它 ⇒ 第一次调用也能看到水合后的板。
 * handle 在 applyInner 里**同步**建好(于是服务缺席时工具照样能用、只是纯内存),
 * 域本身在 ctx.inject 的子 fiber 回调里打开(见 startStorage)。
 */
const STORAGES = new WeakMap()

/** 打开域的重试参数:热加载时上一个实例的域可能还在异步收尾(close 未跑完 ⇒ already-open)。 */
const OPEN_RETRY_ATTEMPTS = 12
const OPEN_RETRY_DELAY_MS = 50

/** 等一会儿(只用于 already-open 重试)。 */
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** 空操作(写链的尾部归一化用)。 */
function noop() {}

/** 一个"先给出去、后面再兑现"的 promise(存储的 ready 必须**先**给出去:工具可能立刻就要 await 它)。 */
function makeDeferred() {
  const deferred = { resolve: noop, reject: noop, promise: null }
  deferred.promise = new Promise((resolve, reject) => {
    deferred.resolve = resolve
    deferred.reject = reject
  })
  return deferred
}

/**
 * 组装一条域记录(整板快照)。任务一律经 copyTask 深拷贝 ⇒ 写进介质的记录**绝不与内存对象共享引用**
 * (域层明说取出的 record 是普通不可变数据、不得原地改;反过来我们也不把可变对象交出去)。
 * `owner` 没值时不写该键:记录会被整体 JSON 化,undefined 键会被 JSON 丢掉,不写才与读回的形状一致。
 */
function recordOf(key, seq, tasks) {
  return { key, seq, tasks: tasks.map((task) => copyTask(task)) }
}

/**
 * 一条任务的可变副本(内存里用)。
 * 出参是**普通对象 + 普通数组**,既满足宿主对返回体的严格无损 JSON 要求,也与域记录的"不可变数据"隔离。
 */
function copyTask(task) {
  const out = {
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: task.description,
    status: task.status,
    blockedBy: Array.isArray(task.blockedBy) ? [...task.blockedBy] : [],
    writeScopes: Array.isArray(task.writeScopes) ? [...task.writeScopes] : [],
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
  if (typeof task.owner === 'string') out.owner = task.owner
  return out
}

/** 从任务 id 反推 seq(只在介质里的 seq 字段不可用时兜底)。 */
function maxSeqOf(tasks) {
  let max = 0
  for (const id of tasks.keys()) {
    const match = /^t(\d+)$/.exec(id)
    if (match !== null) max = Math.max(max, Number(match[1]))
  }
  return Math.max(max, tasks.size)
}

/**
 * 域记录 → 内存板(深拷贝)。
 * 板键取**表键**而不是记录里的 key 字段:表键才是 requireBucket 的查找依据,两者不一致时以表键为准,
 * 免得水合出一块永远查不到的板(记录里的 key 只作介质里的人工可读标注)。
 *
 * ⚠ seq 取 `max(介质里的 seq, 板内任务 id 的最大序号)`(**不是**无条件信任介质里的 seq):
 *   介质是纯文本 JSON,seq 被手改小/写错时,若直接采信就会**分配出已存在的 id** ——
 *   下一次 create 会把板上原有那条任务整条覆盖掉(实测:把 seq 手改成 1 ⇒ create 分到 t2,
 *   把原有的 t2 覆盖)。取两者较大值 ⇒ id 只会向前走,绝不回退、绝不覆盖。
 *   介质里的 seq 非法(缺失/负数/非安全整数)时退回 maxSeqOf(tasks)。
 */
function bucketFromRecord(key, record) {
  if (record === null || typeof record !== 'object') return undefined
  const tasks = new Map()
  for (const raw of Array.isArray(record.tasks) ? record.tasks : []) {
    if (raw === null || typeof raw !== 'object') continue
    const task = copyTask(raw)
    if (typeof task.id !== 'string' || task.id.length === 0) continue
    tasks.set(task.id, task)
  }
  const fromTasks = maxSeqOf(tasks)
  const recordSeq = Number.isSafeInteger(record.seq) && record.seq >= 0 ? record.seq : 0
  return { key, seq: Math.max(recordSeq, fromTasks), tasks }
}

/**
 * 水合:把介质里有、内存里还没有的板灌进 BOARD。
 * 内存优先(它就是权威读源):热加载时内存里已有全部板 ⇒ 一块都不会被介质覆盖;
 * 只有"新进程 / 内存被清空"时才会真正从介质恢复,这正是"跨重启存活"的落点。
 * @returns 本次灌进来的板数(只用于日志)。
 */
function hydrateBoards(table) {
  let restored = 0
  for (const [key, record] of table.entries()) {
    if (typeof key !== 'string' || key.length === 0) continue
    if (BOARD.has(key)) continue
    const bucket = bucketFromRecord(key, record)
    if (bucket === undefined) continue
    BOARD.set(key, bucket)
    restored += 1
  }
  return restored
}

/**
 * 打开域(带 already-open 重试)。
 * 只有 `already-open` 才重试:热加载时旧实例的 disposer 已经调了 close(),但 close 是异步收尾
 * (等写链排空 + 释放后端 unit),名字要等收尾跑完才释放 ⇒ 稍等即可开成功。
 * 其它错误(backend-not-found / facet-unsupported / invalid-record / version-mismatch)直接抛给调用方降级。
 * `isAborted()` 为真(本实例已被卸载)⇒ 立刻放弃,不再白等重试(见 startStorage 的 disposed 闸)。
 */
async function openDomainWithRetry(facility, isAborted) {
  let lastError
  for (let attempt = 1; attempt <= OPEN_RETRY_ATTEMPTS; attempt += 1) {
    if (typeof isAborted === 'function' && isAborted()) {
      throw new Error('本实例已卸载,放弃打开域(不再重试)')
    }
    try {
      return await facility.open(DOMAIN_SPEC)
    } catch (error) {
      lastError = error
      if (error?.code !== 'already-open' || attempt === OPEN_RETRY_ATTEMPTS) throw error
      await delay(OPEN_RETRY_DELAY_MS)
    }
  }
  throw lastError
}

/**
 * 打开一个 apply 实例的存储:**绝不抛错**(抛了就等于让整行加载失败)。
 * 传进来的 `storage` 是 applyInner 里同步建好的 handle(同一对象也挂在 STORAGES 上),
 * 本函数只负责把它的 ready / domain / table / status 填上。
 * 成功 ⇒ status='ready'(此后每次写都先落盘);失败 ⇒ status='degraded'(纯内存态)+ 一行警告。
 * `gate` 是 applyInner 里先交出去的那个 deferred:这里把"打开 + 水合"的 promise 兑现给它,
 * 于是 `storage.ready` 从 apply 起就一直可 await,且等到的确实是打开落定。
 * **本函数返回的 promise 自身绝不 reject**。
 *
 * ⚠ 卸载竞态(两处闸,缺一不可):
 *   ① 子 fiber 的 disposer 先 `await storage.ready` 再决定 close —— 打开是异步的,
 *      "apply 后毫秒级就被卸载"时 storage.domain 还是 null;不等落定就查,等于**永远漏掉**那次 close,
 *      域句柄不可达、域名永不释放 ⇒ 同一进程内此后每次 apply 都撞 already-open 并降级为纯内存。
 *   ② ready 落定处再查一次 `storage.disposed`:卸载**已经发生**时,open 成功后立刻 close,
 *      免得"打开成功的那一刻 disposer 已经跑完"这条窗口留下一个开着的域。
 *   (真实 cordis 实测:父插件卸载时子 fiber 的 disposer 一定会执行;服务后到/热替换时回调会重跑。)
 */
function startStorage(storage, ctx, log, gate) {
  const ready = (async () => {
    try {
      const facility = ctx.get('storageDomain')
      if (facility === null || facility === undefined || typeof facility.open !== 'function') {
        storage.status = 'degraded'
        storage.reason = 'storageDomain 服务不可用(注入回调未拿到服务)'
        log(`警告:${storage.reason} ⇒ 降级为纯内存态,dsh 重启即空(task_board 仍可用)。`)
        return
      }
      const domain = await openDomainWithRetry(facility, () => storage.disposed)
      const table = domain.table(TABLE_BOARDS)
      const restored = hydrateBoards(table)
      storage.domain = domain
      storage.table = table
      storage.status = 'ready'
      log(`storageDomain 就绪:域 ${DOMAIN_NAME} v${DOMAIN_SPEC.version} / 表 ${TABLE_BOARDS};`
        + `本次从介质水合 ${restored} 块板(内存里共 ${BOARD.size} 块)⇒ 跨 dsh 重启存活`)
      if (storage.disposed) {
        // 闸 ②:卸载发生在打开落定之前 ⇒ 这里必须自己把域关掉(disposer 已经跑过了,不会再来看一次)
        await closeDomain(storage, log, 'dispose(打开落定后才看到卸载)')
      }
    } catch (error) {
      storage.status = 'degraded'
      storage.reason = `storageDomain 打开失败:${error?.message ?? error}`
      log(`警告:${storage.reason} ⇒ 降级为纯内存态,dsh 重启即空(task_board 仍可用)。`)
    }
  })()
  gate?.resolve(ready)
  return ready
}

/**
 * 关掉本实例的域(幂等:close 自己幂等,且这里先把 handle 摘掉)。
 * 绝不抛:disposer 里抛错会变成 unhandled rejection(没人 await 它),而域已经没用了。
 */
async function closeDomain(storage, log, why) {
  const domain = storage.domain
  storage.domain = null
  storage.table = null
  if (domain === null) return
  try {
    await domain.close()
  } catch (error) {
    log(`dispose:域 close 抛错(${error?.message ?? error})`)
  }
  log(`dispose:已关闭域 handle(${why};板数据留在领域存储里,下次 apply 重新水合)`)
}

/**
 * 取某个 ctx 的存储 handle 并等它就绪;没有 handle(该 ctx 没 apply 过)、降级、或**本实例已被卸载**
 * ⇒ null(纯内存态)。`disposed` 那条不是装饰:卸载后域句柄已被 close,再往上写会撞
 * DomainError('closed')(工具注册已撤销,正常路径到不了,但导出给测试的 dispatch 能到)。
 */
async function awaitStorageReady(ctx) {
  const handle = ctx === null || ctx === undefined ? undefined : STORAGES.get(ctx)
  if (handle === undefined) return null
  await handle.ready // ready 自身绝不 reject
  return handle.status === 'ready' && !handle.disposed ? handle : null
}

/** 这个 handle 现在能不能落盘(降级 / 已卸载 / 没有 handle 都不能)。 */
function isPersistable(storage) {
  return storage !== null && storage !== undefined
    && storage.status === 'ready' && !storage.disposed && storage.table !== null
}

/**
 * 落盘一条板记录(整板覆盖写)。降级态直接返回 false(纯内存行为)。
 * ⚠ 顺序纪律:调用方必须**先 await 本函数、成功后才改内存** —— 失败时内存与介质都保持原样,
 * 调用方抛错(模型看到一条明确失败),绝不出现"内存说有、介质里没有"的中间态。
 */
async function persistRecord(storage, record) {
  if (!isPersistable(storage)) return false
  await storage.table.put(record.key, record)
  return true
}

/** 删除一条板记录(板被删空时)。同样先落盘、后改内存。 */
async function persistDrop(storage, key) {
  if (!isPersistable(storage)) return false
  await storage.table.delete(key)
  return true
}

/**
 * 测试用:读某个 ctx 的存储状态(生产无调用点)。
 * @returns {{ status: string, reason: string, domain: string, boards: number }}
 */
export function __storageStatus(ctx) {
  const handle = ctx === null || ctx === undefined ? undefined : STORAGES.get(ctx)
  if (handle === undefined) return { status: 'none', reason: '该 ctx 上没有 apply 实例', domain: DOMAIN_NAME, boards: BOARD.size }
  return { status: handle.status, reason: handle.reason, domain: DOMAIN_NAME, boards: BOARD.size }
}

/**
 * 板写操作的串行链:校验 → 落盘 → 改内存 三步整体原子。
 * 为什么需要:写路径现在跨了 await(落盘),同一块板可能被父会话与其子代理**并发**写
 * (两个 agent loop 各跑各的);不串行化就会出现"两边都读到同一个 seq ⇒ 都算出 t5"这类丢更新。
 * 与域层自身的单写链同向;写动作本来就是 exclusive,串行化不损失吞吐。
 */
let WRITE_CHAIN = Promise.resolve()

/** 把一个写任务排进写链(前一个失败不影响后一个;返回值/rejection 原样交给调用方)。 */
function enqueueBoardWrite(job) {
  const run = WRITE_CHAIN.then(() => job())
  WRITE_CHAIN = run.then(noop, noop)
  return run
}

/**
 * 测试用例注册表(生产为空)。
 *
 * 为什么把测试接到 applyInner 的末尾而不是只导出纯函数:apply 的 try/catch 会让
 * "注册工具时抛错"这类问题**静默降级**(工具根本没注册,但测试全绿)。把用例跑在
 * apply 之内,就等于断言了"apply 真的正常跑完并注册成功"。生产环境没人往这里塞东西,
 * 所以模块里不会留测试代码路径。
 */
const CASES = new Map()

/** 注册一个测试用例(仅供 test/task-board.test.mjs 使用)。 */
export function useCase(caseName, run) {
  if (typeof caseName !== 'string' || caseName.length === 0) throw new TypeError('useCase: caseName 必须是非空字符串')
  if (typeof run !== 'function') throw new TypeError('useCase: run 必须是函数')
  CASES.set(caseName, run)
}

/**
 * 测试收尾:清空内存板与用例表,避免用例之间互相污染。
 *
 * 为什么需要它:BOARD 是**模块作用域**的(这正是"跨 apply 重跑存活"的实现手段),
 * 所以测试里的多个桩 ctx 会**共享同一块板** —— 想验"另一块板独立计数"就必须先显式清空。
 * 清空内存也是测试里模拟"dsh 进程重启"的手段:接着用同一份介质新建 apply 实例,
 * 就能验"介质里的板会水合回来"(见 test/task-board.test.mjs 的用例 18)。
 * 生产环境没有任何调用点(整个导出只为测试而存在)。
 */
export function __resetForTest() {
  BOARD.clear()
  CASES.clear()
}

// ── 小工具 ────────────────────────────────────────────────────────────────

/** 字节数(UTF-8)。 */
function bytesOf(text) {
  return Buffer.byteLength(text, 'utf8')
}

/** ISO 时间戳(字符串进内存与域记录,经得起 JSON 往返 —— 不用 Date 对象)。 */
function nowIso() {
  return new Date().toISOString()
}

/** 规范化配置:非法值 fail loud;缺省用 LIMITS。 */
export function resolveConfig(config) {
  const cfg = config ?? {}
  const out = {}
  for (const [key, fallback] of Object.entries(LIMITS)) {
    const raw = cfg[key]
    if (raw === undefined) {
      out[key] = fallback
      continue
    }
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) {
      throw new TypeError(`task-board: config.${key} 必须是 ≥1 的整数,收到 ${JSON.stringify(raw)}`)
    }
    out[key] = raw
  }
  return out
}

// ── 板键:根会话 id(沿 parentSession 父链在内存里上溯)────────────────────────

/** 父链上溯的跳数上限(防环 + 防病态深链;真实子代理是 1~3 层的量级)。 */
const MAX_LINEAGE_HOPS = 32

/**
 * 取会话 id。`header.id` 是权威副本(dsh-session 的 `Session.id` getter 就是它,lib/types/index.js:354-357),
 * 退化时读 `session.id`(桩对象常见形态)。
 */
function sessionIdOf(session) {
  const fromHeader = session?.header?.id
  if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader
  const own = session?.id
  return typeof own === 'string' && own.length > 0 ? own : undefined
}

/**
 * 可选读一个宿主服务。ctx.get(name) 本身就**不需要 inject**(cordis/lib/index.js:755-765),
 * 服务没提供时回 undefined;这里再包一层 try/catch:解析板键的任何意外都不许冒出去。
 */
function optionalService(ctx, serviceName) {
  if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return undefined
  try {
    return ctx.get(serviceName) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * 造"父会话 id → 活会话"的查找器(**纯内存,不读任何会话日志**)。
 *
 * 数据源两个,都是宿主自己的活对象注册表,顺序与理由:
 *   1. agents   —— dsh-agent 的 AgentRegistry(`super(ctx, 'agents')`,lib/types/index.js:43);
 *      `get(id)` 的注释就是 "Look up a live agent"(:344-351),活会话挂在返回值的 `.session` 上。
 *      这正是 dsh-subagent 自己上溯父链用的那个(liveLineage(),dsh-subagent/lib/index.js:1036-1048)。
 *   2. sessions —— dsh-session 的 SessionStore(`super(ctx, 'sessions')`,lib/types/index.js:771);
 *      `get(id)` 的注释是 "Look up a live session"(:1037-1044)= 查内存 Map,不触发落盘读取。
 * 服务拿不到就少一个数据源;两个都拿不到 ⇒ 查找器恒回 undefined ⇒ 调用方走"回退本会话 id"。
 * 传进来的多个 ctx 按顺序各取一遍(apply 的插件 ctx 优先,exec.agent.ctx 兜底),
 * 同一个服务实例只收一次(免得重复查同一个 Map)。
 */
function makeSessionLookup(contexts) {
  const sources = []
  for (const ctx of contexts) {
    for (const [serviceName, kind] of [['agents', 'agent'], ['sessions', 'session']]) {
      const service = optionalService(ctx, serviceName)
      if (service === undefined || typeof service.get !== 'function') continue
      if (!sources.some((source) => source.service === service)) sources.push({ service, kind })
    }
  }
  if (sources.length === 0) return () => undefined
  return (sessionId) => {
    for (const { service, kind } of sources) {
      try {
        const hit = service.get(sessionId)
        if (hit === null || hit === undefined) continue
        const session = kind === 'agent' ? hit.session : hit
        if (session !== null && session !== undefined) return session
      } catch {
        // 单个数据源出错不影响其它数据源(整个解析仍可能成功)
      }
    }
    return undefined
  }
}

/**
 * 板键 = **根会话 id**:从调用者会话沿 header.parentSession 上溯到没有父会话的那一层。
 * 于是"同一个顶层协调者会话 + 它派生的任意深度子代理"共用一块板,换一个新对话就是全新一块板。
 *
 * 依据(2026-09-25 实查):子代理会话头由 dsh-subagent 的 childSessionMeta() 写入
 * `parentSession: parentHeader.id`(外加 origin='subagent'、delegationDepth),
 * 见 dsh-subagent/lib/index.js:470-481;上溯只查内存活对象(见 makeSessionLookup)。
 * 注:会话**分叉**(SessionStore.fork)同样会写 parentSession(dsh-session/lib/types/index.js:1077-1085)
 * ⇒ 分叉出来的会话与其来源共用一块板,这与"按会话树根分桶"是同一个口径。
 *
 * 解析失败**一律回退为调用者自己的会话 id**(2026-09-25 用户决定):绝不报错、绝不拒调用。
 * 上溯只是为了"让子代理和父会话共用一块板",失败的最坏后果是"这个会话自己一块板";
 * 而回退值一定取自调用者自己的 id,所以不可能把内容写进无关的板。
 * 三种回退情形:拿不到 ctx / agents 与 sessions 都拿不到 / 链上某一级父会话已不是活对象(或成环、超深)。
 *
 * @param session 调用者会话(exec.agent.session)。
 * @param lookup  父会话 id → 活会话(见 makeSessionLookup);缺失即每次上溯都失败 ⇒ 回退。
 * @returns {{ key: string, source: 'self' | 'ancestor' | 'fallback' }}
 */
export function resolveBoardKey(session, lookup) {
  const ownId = sessionIdOf(session)
  if (ownId === undefined) {
    // 这一条不是"上溯失败":调用者会话连 id 都没有 ⇒ 板键无从谈起,只能如实报错(真实宿主不会发生)
    throw new Error('task_board 无法确定本会话 id(exec.agent.session 缺失,或 header.id 不是非空字符串)')
  }
  let parentId = session?.header?.parentSession
  if (typeof parentId !== 'string' || parentId.length === 0) return { key: ownId, source: 'self' }
  const seen = new Set([ownId])
  let currentId = ownId
  for (let hop = 0; hop < MAX_LINEAGE_HOPS; hop += 1) {
    if (seen.has(parentId)) return { key: ownId, source: 'fallback' } // 父链成环 ⇒ 回退(不改板)
    const parent = typeof lookup === 'function' ? lookup(parentId) : undefined
    if (parent === null || parent === undefined) return { key: ownId, source: 'fallback' }
    seen.add(parentId)
    currentId = parentId
    parentId = parent.header?.parentSession
    if (typeof parentId !== 'string' || parentId.length === 0) return { key: currentId, source: 'ancestor' }
  }
  return { key: ownId, source: 'fallback' } // 超过跳数上限 ⇒ 回退
}

/**
 * 回退提示(只在真回退时出声)。
 * 摘要会落会话历史 ⇒ 正常路径一个字都不加;真回退时明说"这块板是本会话自己的",
 * 免得父子各自成板却没人知道为什么(重新开一段对话、或让父会话自己调一次即可对齐)。
 */
function fallbackNote(source) {
  return source === 'fallback'
    ? ' [板键回退:父会话链未能在内存中解析(父会话已销毁/服务不可用/成环或过深)⇒ 本板键 = 本会话自己的 id]'
    : ''
}

/**
 * 角色门。
 * 子代理继承父会话的 agentPreset ⇒ 一个判据同时覆盖协调者与其子代理。
 * @returns { ok: true } | { ok: false, message: string }
 */
export function checkPresetGate(session) {
  const preset = session?.header?.agentPreset
  if (preset === GATE_PRESET) return { ok: true }
  const shown = typeof preset === 'string' && preset.length > 0 ? `\`${preset}\`` : '(未声明 agentPreset)'
  return {
    ok: false,
    message: [
      `task_board 未执行:本工具只对协调者预设(preset id = \`${GATE_PRESET}\`)的会话及其子代理开放,`,
      `本次调用来自 ${shown} 的会话。`,
      '共享任务板是协调者的工作内存(只放未完成的事),其它预设不参与该流程。',
      '若你需要记录工作进度,请用自己项目里的文件(如 AGENTS.md / TODO.md);',
      `若确实需要共享协调状态,请让用户把本会话切到 \`${GATE_PRESET}\` 预设后重开。`,
    ].join(''),
  }
}

// ── 视图 ──────────────────────────────────────────────────────────────────

/**
 * `blockedBy` 里在**本板上找不到**的 id(保持写入顺序)。
 *
 * 为什么单独抽出来:这些 id 既不阻塞、也不该被静默吞掉 —— 调用方需要知道"这条依赖已经不在板上了"
 * (多半是被 remove 收尾/作废,也可能是 create 时写错了 id 或引用了别的板的 id)。
 * 暴露口径:视图的 missingBlockers 字段(非空才出现) + 各动作摘要里的 missingBlockers=… 提示。
 */
function missingBlockers(bucket, task) {
  return task.blockedBy.filter((depId) => !bucket.tasks.has(depId))
}

/**
 * 一条任务是否就绪:`blockedBy` 里**存在**的 id 全都已完成才算就绪;
 * 板上不存在的 id **不算阻塞**(2026-09-25 用户决定)。
 *
 * 为什么缺失不阻塞:被依赖的条目一旦 remove,依赖它的任务在旧实现下会**永远**显示为不可做,
 * 且没有任何提示(remove 的乐观锁/角色门都不管这件事),人只能翻 blocked_by 去猜。
 * 现在缺失只是提示(missingBlockers),不是闸门;"存在但未完成"依然阻塞,"已完成"依然放行。
 * 就绪**不会**启动任何人,只是给协调者一个可调度的判据。
 */
function isReady(bucket, task) {
  return task.blockedBy.every((depId) => {
    const dep = bucket.tasks.get(depId)
    return dep === undefined || dep.status === 'completed'
  })
}

/**
 * 摘要里的"依赖缺失"提示(没有缺失就返回空串,绝不写 undefined)。
 * 摘要会落会话历史 ⇒ 只在真有缺失时出现,一句话说清"不算阻塞 + 怎么恢复阻塞"。
 */
function missingBlockersNote(missing) {
  if (missing === undefined || missing.length === 0) return ''
  return ` missingBlockers=${missing.join(',')}(不在板上 ⇒ 不算阻塞;要恢复阻塞请 update blocked_by)`
}

/** 完整任务视图(任务视图字段:见任务书)。 */
function toView(bucket, task) {
  const view = {
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: task.description,
    status: task.status,
    blockedBy: [...task.blockedBy],
    ready: isReady(bucket, task),
    writeScopes: [...task.writeScopes],
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
  // owner 可有可无:没有负责人时**省略该键**,绝不写 undefined ——
  // 宿主校验工具返回值必须是严格无损 JSON,一个 undefined 就让整个调用被拒
  // (报 `value is not lossless JSON`);list 的 toSummary() 一直是这个口径,
  // 这里曾经漏掉,导致"create 不带 owner"整条成功路径不可用。改这里要同步这条口径。
  if (task.owner !== undefined) view.owner = task.owner
  // missingBlockers 同口径:只在**真有**缺失时才出现。空数组也能过关口,但(1)与 owner 的
  // "没值就省略键"纪律不一致,(2)每次成功返回都白背一段负载,(3)"有依赖已经不在板上"这个
  // 信号会在 JSON 里彻底看不出来 —— 而这条信号正是本次改动要让人看见的东西。
  const missing = missingBlockers(bucket, task)
  if (missing.length > 0) view.missingBlockers = missing
  return view
}

/**
 * list 用的瘦投影:只够认人,不够 dump。
 * 刻意**不带** missingBlockers:list 一行要保持固定形状且足够瘦,缺失的存在性由 actionList 的摘要
 * 给条数提示,细节用 get 看(toSummary 与 toView 字段不同是既定口径,不是漏写)。
 */
function toSummary(bucket, task) {
  const view = {
    id: task.id,
    status: task.status,
    ready: isReady(bucket, task),
    revision: task.revision,
    subject: task.subject,
  }
  if (task.owner !== undefined) view.owner = task.owner
  return view
}

// ── 参数校验(只剩单字段上限)────────────────────────────────────────────────

/**
 * 字符串数组参数:类型 + 条数上限 + 非空 + 去重。
 * `configKey` 只用于把拒绝信息指到那一条 config(免得调用方去猜是哪条上限)。
 */
function readStringArray(value, field, maxItems, configKey) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组`)
  if (value.length > maxItems) {
    throw new Error(
      `${field} 有 ${value.length} 条,超过单字段硬顶 ${maxItems}(config.${configKey}=${maxItems})。`
      + '请合并或拆成多条任务后再写,不要突破上限。',
    )
  }
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) throw new Error(`${field} 的元素必须是非空字符串`)
    const text = item.trim()
    if (!out.includes(text)) out.push(text)
  }
  return out
}

/** description 的字节上限(超限拒绝并给出"先移出再写"的指引)。 */
function assertDescription(description, limits) {
  if (typeof description !== 'string') throw new Error('description 必须是字符串')
  const size = bytesOf(description)
  if (size > limits.MAX_DESCRIPTION_BYTES) {
    throw new Error(
      `description 为 ${size} B,超过单条硬顶 ${limits.MAX_DESCRIPTION_BYTES} B。`
      + '这块板是工作内存、不是档案库:请把长期结论**手动**写进项目 AGENTS.md / README,'
      + '这里只留"要做什么 + 验收标准",或把该任务拆成多条。',
    )
  }
  return description
}

/** subject 的字节上限。 */
function assertSubject(subject, limits) {
  if (typeof subject !== 'string' || subject.trim().length === 0) throw new Error('subject 必须是非空字符串')
  const size = bytesOf(subject)
  if (size > limits.MAX_SUBJECT_BYTES) {
    throw new Error(`subject 为 ${size} B,超过硬顶 ${limits.MAX_SUBJECT_BYTES} B,请压缩成一行标题。`)
  }
  return subject.trim()
}

/**
 * 拿板(只查内存,不建)。建板由 create 在**落盘成功之后**显式做(见 actionCreate)——
 * 这是 W2 的修法:旧实现在这里直接 BOARD.set(...),于是"空板已入内存、记录还没落盘"那段窗口里
 * 并发 list 会看到"板存在但 0 条"(requireBucket 的不变量被短暂破坏)。
 * 现在空板**只在介质里那条记录成功之后**才进 BOARD ⇒ 那个窗口不存在了。
 */
function requireBucket(key) {
  return BOARD.get(key)
}

/**
 * 把一块**新建的**板插进 BOARD(只在 create 的落盘成功之后调用,见 actionCreate 的 W2 顺序)。
 * ⚠ 入参必须是 `{ key, seq, tasks: Map }` 形状 —— 板里的 tasks 一律是 Map(见 BOARD 的说明);
 *   传普通对象当 tasks 会让 `BOARD.get(key).tasks.get(...)` 直接炸(踩过一次:参数名撞车)。
 * ⚠ 调用方必须先确认 BOARD 里没有这块板:create 走写链(串行),不会有并发建板。
 */
function insertBucket(bucket) {
  BOARD.set(bucket.key, bucket)
  return bucket
}

/**
 * 算下一条任务的 id 与新的 seq(形如 t1 / t2,短,省上下文)。
 * ⚠ **不改板**:seq 只在记录落盘成功之后才写回 bucket(否则落盘失败会留下一个凭空跳号的板)。
 */
function nextTaskId(bucket) {
  const seq = bucket.seq + 1
  return { id: `t${seq}`, seq }
}

/** 取任务,缺失即抛(带可读指引)。 */
function requireTask(bucket, id) {
  if (typeof id !== 'string' || id.trim().length === 0) throw new Error('该动作必须提供 id')
  const task = bucket.tasks.get(id.trim())
  if (task === undefined) {
    const known = [...bucket.tasks.keys()].slice(0, 10).join(', ')
    throw new Error(`本板(根会话 ${bucket.key})里没有任务 ${id.trim()}${known.length > 0 ? `(现有:${known})` : '(该板目前为空)'}`)
  }
  return task
}

// ── 五个动作 ──────────────────────────────────────────────────────────────

/**
 * create:新建一条任务(板内条目数不设上限)。
 * ⚠ 顺序:校验 → **落盘整板** → 才改内存。落盘失败 ⇒ 整条调用报错,板一个字节都不动。
 *
 * W2:板本身也在这条顺序里 —— 只有"介质里那条记录写成功"之后才 BOARD.set(空板)。
 * 旧实现先把空板塞进内存再落盘,于是那段窗口里并发 list 会看到"板存在但 0 条";
 * 现在空板只活在函数局部,介质写失败连局部对象一起丢弃(没有"幽灵空板"要回滚)。
 * ⚠ 本函数**必须**在写链里跑(dispatch 只对 create/update/remove 入链):它跨 await,
 *   而"读现有板 → 算 id → 落盘 → 入内存"这段不能被另一个写穿插。
 */
async function actionCreate(key, args, limits, storage) {
  const subject = assertSubject(args.subject, limits)
  const description = args.description === undefined ? '' : assertDescription(args.description, limits)
  const blockedBy = readStringArray(args.blocked_by, 'blocked_by', limits.MAX_BLOCKED_BY, 'MAX_BLOCKED_BY') ?? []
  const writeScopes = readStringArray(args.write_scopes, 'write_scopes', limits.MAX_WRITE_SCOPES, 'MAX_WRITE_SCOPES') ?? []
  const status = args.status === undefined ? 'pending' : args.status
  if (!STATUSES.includes(status)) throw new Error(`status 必须是 ${STATUSES.join(' / ')} 之一`)
  const owner = args.owner === undefined ? undefined : String(args.owner)
  const stamp = nowIso()
  // 已有板就用它(它的 tasks/seq 就是权威);没有 ⇒ 一块**还没入 BOARD** 的空板(见 W2)
  const existing = requireBucket(key)
  const bucket = existing ?? { key, seq: 0, tasks: new Map() }
  const { id, seq } = nextTaskId(bucket)
  const task = {
    id,
    revision: 1,
    subject,
    description,
    status,
    owner,
    blockedBy,
    writeScopes,
    createdAt: stamp,
    updatedAt: stamp,
  }
  // 先落盘、后改内存:put 成功之前 BOARD 与 bucket 一动不动(失败也没有任何东西要回滚)
  await persistRecord(storage, recordOf(bucket.key, seq, [...bucket.tasks.values(), task]))
  bucket.seq = seq
  bucket.tasks.set(task.id, task)
  if (existing === undefined) insertBucket(bucket) // W2:落盘成功之后空板才进内存
  const view = toView(bucket, task)
  const tasksActive = [...bucket.tasks.values()].filter((item) => item.status !== 'completed').length
  return {
    ok: true,
    action: 'create',
    summary: `created ${task.id} [${task.status}] rev=${task.revision} ready=${view.ready}`
      + `${missingBlockersNote(view.missingBlockers)} — ${task.subject}${degradedNote(storage)}`,
    task: view,
    // 计数是"看得见"的那一份治理:没有硬顶,攒了多少条就如实报多少(板数同理)
    counts: { tasksActive, boards: BOARD.size },
    note: `本板只放未完成的事;要长期保留的结论请手动写进项目 AGENTS.md / README。`
      + storageNote(storage),
  }
}

/** list:列出本板的瘦投影。 */
function actionList(bucket, args, storage) {
  const all = [...bucket.tasks.values()]
  let filtered = all
  if (args.status !== undefined) {
    if (!STATUSES.includes(args.status)) throw new Error(`status 必须是 ${STATUSES.join(' / ')} 之一`)
    filtered = filtered.filter((task) => task.status === args.status)
  }
  const limit = args.limit === undefined ? 50 : args.limit
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('limit 必须是 1~200 的整数')
  const page = filtered.slice(0, limit)
  const active = all.filter((task) => task.status !== 'completed').length
  // 瘦投影刻意不带 missingBlockers(保持 list 一行固定形状、别把每行写肥)⇒ 用条数提示存在性,细节用 get
  const missingCount = filtered.filter((task) => missingBlockers(bucket, task).length > 0).length
  return {
    ok: true,
    action: 'list',
    summary: `${filtered.length} 条命中(共 ${all.length} 条,未完成 ${active} 条)`
      + `${filtered.length > page.length ? `,本页 ${page.length} 条` : ''}`
      + `${missingCount > 0 ? `,其中 ${missingCount} 条有 missingBlockers(依赖已不在板上 ⇒ 不算阻塞;细节用 get)` : ''}`
      + degradedNote(storage),
    total: all.length,
    matched: filtered.length,
    tasks: page.map((task) => toSummary(bucket, task)),
    ...filtered.length > page.length ? { truncated: true, limit } : {},
    hint: '这是瘦投影。要读某条的 description/blockedBy/writeScopes 用 action=get + id;绝不要指望 list 给整板正文。',
  }
}

/** get:单条完整视图。 */
function actionGet(bucket, args, storage) {
  const task = requireTask(bucket, args.id)
  const view = toView(bucket, task)
  // 阻塞来源逐条给状态,免得协调者为了算 ready 再 get 一遍
  const blockers = view.blockedBy.map((depId) => {
    const dep = bucket.tasks.get(depId)
    return dep === undefined ? `${depId}(不在此板)` : `${depId}(${dep.status})`
  })
  return {
    ok: true,
    action: 'get',
    summary: `${view.id} [${view.status}] rev=${view.revision} ready=${view.ready}`
      + `${blockers.length > 0 ? ` blockedBy=${blockers.join(',')}` : ''}`
      + `${missingBlockersNote(view.missingBlockers)} — ${view.subject}${degradedNote(storage)}`,
    task: view,
  }
}

/**
 * update:CAS 写。必须给 expected_revision;不匹配即拒并回最新 revision。
 * 只覆盖**显式提供**的字段(其余原样保留),revision 每次成功写 +1。
 * ⚠ 顺序:校验 → **落盘整板** → 才改内存;被拒的写(缺/过期 revision、超限)不落盘也不改内存。
 */
async function actionUpdate(bucket, args, limits, storage) {
  const task = requireTask(bucket, args.id)
  const expected = args.expected_revision
  if (expected === undefined) {
    throw new Error(
      `update 必须带 expected_revision(乐观锁)。当前本板的 ${task.id} 最新 revision = ${task.revision};`
      + '请先用 get 取最新值再写。',
    )
  }
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('expected_revision 必须是非负整数')
  if (expected !== task.revision) {
    throw new Error(
      `revision 冲突:你给的是 ${expected},但本板的 ${task.id} 最新 revision 已是 ${task.revision}`
      + '(说明有人在你读到它之后改过)。请按最新 revision 重放本次改动。',
    )
  }

  // 先算后写:任何校验失败都不改变板上状态
  const next = { ...task, blockedBy: [...task.blockedBy], writeScopes: [...task.writeScopes] }
  const changed = []

  if (args.subject !== undefined) {
    next.subject = assertSubject(args.subject, limits)
    changed.push('subject')
  }
  if (args.description !== undefined) {
    next.description = assertDescription(args.description, limits)
    changed.push('description')
  }
  if (args.status !== undefined) {
    if (!STATUSES.includes(args.status)) throw new Error(`status 必须是 ${STATUSES.join(' / ')} 之一`)
    if (args.status !== next.status) changed.push(`status:${next.status}->${args.status}`)
    next.status = args.status
  }
  if (args.owner !== undefined) {
    next.owner = args.owner === null ? undefined : String(args.owner)
    changed.push('owner')
  }
  const blockedBy = readStringArray(args.blocked_by, 'blocked_by', limits.MAX_BLOCKED_BY, 'MAX_BLOCKED_BY')
  if (blockedBy !== undefined) {
    if (blockedBy.includes(task.id)) throw new Error('blocked_by 不能包含任务自己的 id')
    next.blockedBy = blockedBy
    changed.push('blocked_by')
  }
  const writeScopes = readStringArray(args.write_scopes, 'write_scopes', limits.MAX_WRITE_SCOPES, 'MAX_WRITE_SCOPES')
  if (writeScopes !== undefined) {
    next.writeScopes = writeScopes
    changed.push('write_scopes')
  }
  if (changed.length === 0) {
    // 这条是"什么都没改"的回执(没有 task 视图),故 missingBlockers 只进摘要 ——
    // 它照样要能让调用方看见"ready 为什么是 true/false"。
    // 什么都没改 ⇒ **连存储都不碰**(不写介质、不推进 revision),回执里如实说"未写盘"。
    const view = toView(bucket, task)
    return {
      ok: true,
      action: 'update',
      summary: `${task.id}: 没有字段需要改(revision 仍是 ${task.revision},未写盘)。`
        + `ready=${view.ready}${missingBlockersNote(view.missingBlockers)}${degradedNote(storage)}`,
      revision: task.revision,
      changed: [],
      ready: view.ready,
    }
  }

  next.revision = task.revision + 1
  next.updatedAt = nowIso()
  // 先落盘、后改内存:整板覆盖写,写的是"替换掉这一条之后"的快照
  const nextTasks = [...bucket.tasks.values()].map((item) => (item.id === next.id ? next : item))
  await persistRecord(storage, recordOf(bucket.key, bucket.seq, nextTasks))
  bucket.tasks.set(next.id, next)
  const view = toView(bucket, next)
  return {
    ok: true,
    action: 'update',
    summary: `${next.id}: rev ${task.revision}->${next.revision} ${changed.join(', ')}`
      + ` [${next.status}] ready=${view.ready}${missingBlockersNote(view.missingBlockers)}${degradedNote(storage)}`,
    revision: next.revision,
    changed,
    task: view,
  }
}

/**
 * remove:CAS 删(与 update 同一套乐观锁)。必须给 expected_revision;
 * 缺失或不匹配即拒并回最新 revision,且**不改动板上任何状态**。
 * 删完若本板空了 ⇒ 连板对象一起删(存储里的记录**同时删除**);该板再建时 id 复位为 t1。
 * ⚠ 顺序:校验 → **落盘**(整板覆盖写,或板空时删记录)→ 才改内存。
 *
 * 依赖影响(2026-09-25 口径):被删的 id 若仍出现在别的任务的 blockedBy 里,**不再**卡住那些任务 ——
 *   isReady 只要求"仍然存在的依赖项都 completed",缺失的 id 只作为 missingBlockers 提示(视图 + get/list
 *   摘要),依赖方该就绪就就绪。要恢复阻塞,用 update 重设那一侧的 blocked_by;remove 自身不做级联改写。
 */
async function actionRemove(bucket, args, storage) {
  const task = requireTask(bucket, args.id)
  const expected = args.expected_revision
  if (expected === undefined) {
    throw new Error(
      `remove 必须带 expected_revision(乐观锁)。当前本板的 ${task.id} 最新 revision = ${task.revision};`
      + '请先用 get 取最新值再删。',
    )
  }
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('expected_revision 必须是非负整数')
  if (expected !== task.revision) {
    throw new Error(
      `revision 冲突:你给的是 ${expected},但本板的 ${task.id} 最新 revision 已是 ${task.revision}`
      + '(说明有人在你读到它之后改过)。请按最新 revision 重放本次删除。',
    )
  }

  const remainingTasks = [...bucket.tasks.values()].filter((item) => item.id !== task.id)
  const boardRemoved = remainingTasks.length === 0
  // 先落盘、后改内存:板删空 ⇒ 删记录(与"板被回收"一一对应),否则整板覆盖写
  if (boardRemoved) await persistDrop(storage, bucket.key)
  else await persistRecord(storage, recordOf(bucket.key, bucket.seq, remainingTasks))
  bucket.tasks.delete(task.id)
  if (boardRemoved) BOARD.delete(bucket.key)
  const remaining = bucket.tasks.size
  const active = [...bucket.tasks.values()].filter((item) => item.status !== 'completed').length
  return {
    ok: true,
    action: 'remove',
    summary: `removed ${task.id} [${task.status}] rev=${task.revision} — ${task.subject}`
      + `;本板剩 ${remaining} 条(未完成 ${active} 条)`
      + `${boardRemoved ? ',板已空 ⇒ 已回收(该板再建时 id 从 t1 重新开始)' : ''}`
      + degradedNote(storage),
    removed: task.id,
    remaining,
    boardRemoved,
    boards: BOARD.size,
    note: '条目内容要长期保留的话,先手动写进项目 AGENTS.md / README 再删。'
      + `板删空时,宿主领域存储(域 ${DOMAIN_NAME})里的这条记录也一并删除。`
      + storageNote(storage),
  }
}

/**
 * 降级时的**唯一一句**提示文案(create/remove 的 note 与五个动作的摘要共用同一份字面量)。
 * 为什么五个动作都要出声(2026-09-26 修):旧实现只在 create / remove 的 note 里追加,
 * 而 note 只存在于那两个动作 ⇒ **只做 list / get 的调用方完全察觉不到没落盘**;
 * 更糟的是 create 的 note 首句无条件写"持久态:…跨 dsh 重启存活",降级时与末尾那句自相矛盾。
 * 现在:降级态下五个动作的 summary 都追加同一句,note 里的持久/降级陈述也由本函数统一给出。
 */
const DEGRADED_HINT = ' [降级:storageDomain 不可用 ⇒ 本次运行只写内存,dsh 重启即空]'

/** 这个存储 handle 现在是不是真的在落盘(降级 / 已卸载 / 没有 handle 都不算)。 */
function storageReady(storage) {
  return storage !== null && storage !== undefined && storage.status === 'ready' && !storage.disposed
}

/** 降级提示(只进摘要;正常路径一个字符都不加)。 */
function degradedNote(storage) {
  return storageReady(storage) ? '' : DEGRADED_HINT
}

/**
 * 写动作 note 里的存储陈述(只在真的降级时出声)。
 * 降级态下**只有内存**有内容 ⇒ 必须让调用方看见,否则会误以为写进板就安全了。
 * ⚠ 正常路径**不写**"持久态/跨 dsh 重启存活"这类陈述:摘要已经承担了这件事,
 *   而"摘要说持久 + note 说降级"这种自相矛盾正是本次要修掉的东西(见 DEGRADED_HINT)。
 * 降级态下也不重复那句提示(摘要里已经有了),只补一句去哪看原因。
 */
function storageNote(storage) {
  return storageReady(storage)
    ? ''
    : '(原因见启动日志里那条 [task-board] 警告;板数据只在本进程内存里)'
}

/**
 * 分发:参数合法性之外的全部业务规则。
 * 返回结构即 output.render() 拿到的东西(只有 render 的 content 落会话历史)。
 *
 * **异步**的原因:写动作要先 await 落盘、成功后才改内存(见文件头"存储"一段)。
 * 读动作不写任何东西,只是等一次"域已就绪"(首调用可能正赶上 apply 后的打开/水合)。
 */
export async function dispatch(args, exec, limits, pluginCtx) {
  const session = exec?.agent?.session
  const gate = checkPresetGate(session)
  if (!gate.ok) {
    // 角色门失败**不抛错**:这是一条明确的拒绝信息,要原样让模型读到。
    // action 在参数层理论上必填,但这函数是导出的 ⇒ 拿不到就**省略该键**,
    // 不留 undefined(严格无损 JSON;见文件头"宿主事实")。
    // 角色门在**碰存储之前**返回:被拒的调用不该等打开、也不该看到任何板状态。
    return {
      ok: false,
      denied: 'preset',
      ...(args?.action === undefined ? {} : { action: args.action }),
      summary: gate.message,
    }
  }
  // 板键 = 根会话 id。两个 ctx 都试:插件自己的(apply 传入)优先,exec.agent.ctx 兜底
  // (真实 Agent 上有 .ctx,dsh-subagent 也这么读:parent.ctx.get("agentPresets"))。
  const { key, source } = resolveBoardKey(session, makeSessionLookup([pluginCtx, exec?.agent?.ctx]))
  const action = args?.action
  // 存储 handle 按 ctx 取(每个 apply 一份);降级/没有 ⇒ null(纯内存态,行为与旧版一致)
  const storage = await awaitStorageReady(pluginCtx)

  /**
   * 取板 + 跑动作。写动作在**写链**里跑:取板、校验、落盘、改内存整体原子
   * (父会话与其子代理可能并发写同一块板 ⇒ 不串行化会丢更新)。
   * 读动作不进写链(只读动作不该改板,否则并发不安全)。
   * ⚠ create 只传板键、**不在这里取板**:没有板时那块空板由 actionCreate 在落盘成功后才入内存
   *   (W2 —— 否则并发 list 会看见"板存在但 0 条")。
   */
  const run = () => {
    if (action === 'create') return actionCreate(key, args, limits, storage)
    const bucket = requireBucket(key)
    if (bucket === undefined) return null
    return dispatchAction(action, bucket, args, limits, storage)
  }
  const result = action === 'create' || action === 'update' || action === 'remove'
    ? await enqueueBoardWrite(run)
    : run()
  if (result === null) {
    // "本会话还没有任务板":与动作无关的回执(读动作没板、update/remove 指到没板也走这里)
    return {
      ok: false,
      ...(action === undefined ? {} : { action }),
      summary: `本会话(${key})还没有任务板(用 create 建第一条)。${fallbackNote(source)}${degradedNote(storage)}`,
      boardKey: key,
      boardSource: source,
      tasks: [],
      total: 0,
    }
  }
  // 板标识(键 + 键的来源)是五个动作共有的返回字段:统一在这里挂。
  // 逐个动作各写一遍就等于给自己留"漏一个 ⇒ 契约不一致"的坑(文件头记着这个老毛病)。
  result.boardKey = key
  result.boardSource = source
  if (source === 'fallback') result.summary = `${result.summary}${fallbackNote(source)}`
  return result
}

/** 把动作名分派到实现(不含板标识:dispatch 统一补)。写动作是 async(先落盘后改内存)。 */
function dispatchAction(action, bucket, args, limits, storage) {
  switch (action) {
    case 'list':
      return actionList(bucket, args, storage)
    case 'get':
      return actionGet(bucket, args, storage)
    case 'update':
      return actionUpdate(bucket, args, limits, storage)
    case 'remove':
      return actionRemove(bucket, args, storage)
    default:
      // create 刻意不在这里:它拿的是**板键**而不是板对象(空板要等落盘成功才入内存,见 actionCreate 的 W2)
      throw new Error(`未知 action ${JSON.stringify(action)},只支持 create / list / get / update / remove`)
  }
}

// ── 工具定义 ──────────────────────────────────────────────────────────────

/**
 * 工具描述:**逐条写清**给模型看的硬事实,措辞短而准。
 * 每条都对应上面实现里的一个真实机制 —— 描述与行为必须同步,改行为就改这里。
 */
export const TOOL_DESCRIPTION = [
  'Shared task board for the coordinator preset and its subagents, bucketed by ROOT SESSION; one tool, five actions.',

  // 1) 存储语义(2026-09-26 起:宿主领域存储持久化,跨重启存活)
  'DURABLE: the board is persisted in the host domain storage (ctx.storageDomain, domain task_board), so it survives',
  'across tool calls, across config hot-reload, AND across dsh restarts. Reads are served from the process memory',
  'cache, and every write is persisted before it is applied. If that service is unavailable the tool degrades to',
  'memory-only for that run: EVERY action then says so in its summary (a degraded run never claims durability, and',
  'the board is empty after a restart).',

  // 2) 完成即搬走 + 不作为持久档案
  'When a task is finished, move its conclusions into the project AGENTS.md / README by hand and then delete that',
  'entry (action remove) or mark it completed (action update). The board survives restarts, but it is still a working',
  'memory, not a documentation archive: keep descriptions short and move long-term conclusions out.',

  // 3) 分桶 = 根会话(父子共板 + 换新对话即新板 + 键怎么来的 + 每回都报键)
  'The coordinator and its subagents share ONE board: the board key is the ROOT session id, resolved by walking the',
  "parentSession chain over live in-process sessions, so a subagent of any depth lands on its parent's board, while a",
  'new conversation gets a brand-new empty board. No project, path, or cwd is involved in bucketing, and unrelated',
  'session trees never share a board. Every response names the board it touched (boardKey, plus boardSource =',
  "self | ancestor | fallback): fallback means the parent chain could not be resolved in memory and the caller's own",
  'session id was used as the key — that is never an error and never a write to an unrelated board.',

  // 4) CAS(update 与 remove 同一套乐观锁)
  'update and remove are compare-and-set: pass expected_revision, and a stale revision is refused and reports the',
  'current revision instead.',

  // 4b) ready 的判据(含"依赖已不在板上 ⇒ 不算阻塞"这条 2026-09-25 的口径)
  'A task is ready when every id still present in its blocked_by is completed; an id that is no longer on the board',
  '(removed, or never created) does NOT block it — such a task stays ready and reports those dead ids in a',
  'missingBlockers array (present only when non-empty, and also called out in the human-readable summary), so a',
  'deleted dependency can never freeze a task forever. To re-block, set blocked_by again with update.',

  // 5) 动作清单 + 无等待/阻塞动作 + 不涉及模型与 provider
  'Actions: create, list, get, update, remove. remove deletes one entry by id and drops the board once it becomes',
  'empty (creating it again restarts its ids at t1). There is deliberately NO wait, block, sleep, or poll action and',
  'no watch/notify action — readiness never starts anyone, and you re-check with list. This tool neither selects nor',
  'changes any model, provider, or route.',

  // 用法与预算纪律 + 上限口径(增长型上限已删,只剩单字段上限)
  'Usage: list returns a THIN projection (id, status, ready, revision, subject, optional owner) and NEVER dumps the',
  'whole board; call get for one task description / blockedBy / writeScopes. A task with no owner omits the owner key',
  'entirely (it is never null). Keep description short — it is a working note, not documentation. There are NO growth',
  'caps: no per-board task limit and no board-count limit, since one conversation cannot fill a board. The only caps',
  'are per-field input caps, refused rather than truncated: description bytes, subject bytes, blocked_by entries, and',
  'write_scopes entries. Restricted to the coordinator preset and its subagents; other presets are refused with an',
  'explanation.',
].join(' ')

/** 参数(注意:可选参数必须**省略** required,写 required:false 会被 defineTool 直接抛)。 */
export const TOOL_PARAMETERS = {
  action: {
    type: 'string',
    required: true,
    enum: ['create', 'list', 'get', 'update', 'remove'],
    description: 'create | list | get | update | remove',
  },
  id: {
    type: 'string',
    description: 'Task id, e.g. t3. Required for get, update, and remove.',
  },
  subject: {
    type: 'string',
    description: 'One-line title. Required on create; optional on update.',
  },
  description: {
    type: 'string',
    description: 'What to do and its acceptance criteria (short!). Bounded by a byte cap; long-term conclusions belong in AGENTS.md / README.',
  },
  status: {
    type: 'string',
    enum: STATUSES,
    description: 'pending | in_progress | completed. Optional; create defaults to pending.',
  },
  owner: {
    type: 'string',
    description: 'Owner label, typically a subagent id. Optional.',
  },
  blocked_by: {
    type: 'array',
    items: { type: 'string' },
    description: 'Task ids on this board that must be completed before this one is ready. An id that is not on the board does NOT block (it is reported as a missing blocker). Optional.',
  },
  write_scopes: {
    type: 'array',
    items: { type: 'string' },
    description: 'Paths this task will write, for collision avoidance. Optional, few entries only.',
  },
  expected_revision: {
    type: 'integer',
    description: 'CAS precondition: the revision you last read. Required for update and remove; a stale value is refused.',
  },
  limit: {
    type: 'integer',
    description: 'list only: max rows to return (1-200, default 50).',
  },
}

/**
 * 注册工具。返回 disposer 或 null(服务不可用时)。
 * 只读动作(list/get)声明 isConcurrencySafe ⇒ 可与其它工具并发;
 * 写动作(create/update/remove)**不声明** ⇒ 保持默认 exclusive。
 */
function registerTool(ctx, limits, log) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  if (tools === undefined || tools === null || typeof tools.register !== 'function') {
    log('tools 服务不可用,task_board 未注册')
    return null
  }
  return tools.register(defineTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: {
      // value-schema DSL:object 根必须显式写 additionalProperties。
      // 输出结构由 dispatch 构造,这里声明宽松 object。
      schema: { type: 'object', additionalProperties: true },
      // ⚠ 只有这里返回的 content 会落会话历史(永久占上下文)⇒ 必须精简:
      // 第一行人类可读摘要,第二行紧凑 JSON(无缩进),且**绝不 dump 整板**。
      render: (_args, value) => [{
        type: 'text',
        text: `${typeof value?.summary === 'string' ? value.summary : 'task_board 无摘要'}\n${JSON.stringify(value ?? {})}`,
      }],
    },
    // 只读动作可并发;写动作返回 false ⇒ 独占(默认即独占,这里显式表达意图)
    isConcurrencySafe: (args) => args?.action === 'list' || args?.action === 'get',
    presentCall: (args) => ({
      card: 'generic',
      title: `Task board: ${typeof args?.action === 'string' ? args.action : '?'}`,
      kind: 'other',
      rawInput: {},
    }),
    async execute(args, exec) {
      // 业务错误一律**抛**(→ 标准 `Error: ...` 失败结果,不结束轮次):
      // 参数之外的冲突/上限/角色门/会话 id 缺失都走这条,模型能直接读到原因并自行修正。
      // pluginCtx 交给 dispatch:(1) **可选**读 agents / sessions 解析会话父链(见 makeSessionLookup);
      // (2) 按 ctx 取本 apply 实例的存储 handle(见 STORAGES)。两者都缺 ⇒ 内存态,照样能用。
      return dispatch(args, exec, limits, ctx)
    },
  }))
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  // 绝不把异常抛回 loader:插件加载失败会让整个 dsh 起不来(同 profile 的既有教训)。
  // 任何意外只降级(工具可能未注册)并留一行日志。
  // ⚠ 存储的打开是**异步**的(startStorage 只挂 handle.ready,自身不 await、不抛),
  //   所以这里的同步 try/catch 依然是完整的兜底。
  try {
    applyInner(ctx, config)
  } catch (error) {
    console.error(`[task-board] apply 抛错,插件已降级(task_board 可能未注册):${error?.stack ?? error}`)
  }
}

function applyInner(ctx, config) {
  const limits = resolveConfig(config)
  const log = (message) => {
    try {
      console.log(`[task-board] ${message}`)
    } catch { /* 日志失败不影响功能 */ }
  }
  log(`apply: v0.1.0 limits=${JSON.stringify(limits)} gate=${GATE_PRESET} boards=${BOARD.size}`
    + '(模块作用域内存 = 权威读源;持久投影 = 宿主领域存储)')

  // 存储 handle 在**这里同步建好**(工具执行时按 ctx 取,见 STORAGES)⇒ 服务缺席时行为与
  // "没有存储"完全一致:纯内存 + 一行警告,工具照常注册、照常可用。
  // 域本身在下面的 ctx.inject 子 fiber 回调里打开 + 水合(异步、失败只降级,绝不抛回 loader)。
  const storage = { domain: null, table: null, status: 'opening', reason: '', disposed: false, ready: null }
  // ready 是"打开 + 水合"的完成信号,必须**立刻**可 await(工具可能在回调跑之前就被调用)
  // ⇒ 用一个 deferred,回调里在真正开始打开时把它交给 startStorage 的 promise(同一个对象,永远有效)。
  const readyGate = makeDeferred()
  storage.ready = readyGate.promise
  STORAGES.set(ctx, storage)

  /**
   * W1:可选依赖用 ctx.inject 而不是"apply 里查一次 ctx.get"。
   * cordis 语义(实查 cordis 4.0.4 源码 + 真实 Context/Fiber 实测,见 README「依赖与行序」):
   *   · 服务不可用 ⇒ **回调不执行**,不报错、不阻塞本行其它注册(工具照旧注册);
   *   · 服务**后到** ⇒ 回调补跑(旧写法此时已经永久降级了);
   *   · 服务消失 / 热替换 ⇒ 回调的 effect 被清理,服务回来后再跑一次(旧域先关、新域再开);
   *   · 父插件卸载 ⇒ 子 fiber 的 disposer 照常执行 ⇒ 域一定被关(disposer 里先 await ready,见 startStorage)。
   * 回调拿到的是子 ctx(本 fiber 的 scope):ctx.get('storageDomain') 在这里必定是活的实现。
   */
  try {
    if (typeof ctx.inject !== 'function') throw new TypeError('ctx.inject 不可用')
    let activated = false
    ctx.inject(['storageDomain'], (storageCtx) => {
      activated = true
      // ⚠ 必须**同步**注册 disposer:打开是异步的,卸载可能先到(见 startStorage 的两处闸)。
      //   storage.ready 从 apply 起就是同一个 deferred promise(永不换对象),它兑现的时机正是
      //   "打开 + 水合"落定 ⇒ 这里 await 它,再决定要不要 close(那时 domain 才有值)。
      storageCtx.effect(() => () => {
        storage.disposed = true
        return storage.ready.then(
          () => closeDomain(storage, log, 'dispose(打开已落定或正在落定)'),
          noop,
        )
      })
      startStorage(storage, storageCtx, log, readyGate) // 内部自己兜住一切异常(ready 绝不 reject)
    })
    // 回调**从不执行**时(服务缺席)也要有个终态:否则 status 永远停在 'opening',
    // 日志里也不会出现那行"降级"警告(旧实现是 apply 里直接查一次 ctx.get,所以能当场判死)。
    // 真实 cordis 里服务一旦提供,通知与激活都在同一 tick 内完成(回调最迟在这个宏任务之前跑),
    // 所以这个检查不会误伤"稍后才提供"的正常情形;真被误判也只是日志/状态偏保守,
    // 存储的**实际**启用仍由回调决定(工具侧另有 status/table 双闸)。
    // ⚠ **不要** unref 这个定时器:宿主(以及本包的测试)可能正卡在一个 top-level await 上等
    //   存储落定,而 unref 的定时器**不阻止事件循环退出** ⇒ 回调永不执行、await 永远不返回。
    //   代价只是最多 1ms 的额外存活。
    setTimeout(() => {
      if (activated) return
      storage.status = 'degraded'
      storage.reason = 'storageDomain 服务不可用(注入回调始终未激活)'
      readyGate.resolve()
      log(`警告:${storage.reason} ⇒ 降级为纯内存态,dsh 重启即空(task_board 仍可用)。`)
    }, 0)
  } catch (error) {
    storage.status = 'degraded'
    storage.reason = `ctx.inject 不可用:${error?.message ?? error}`
    log(`警告:${storage.reason} ⇒ 降级为纯内存态,dsh 重启即空(task_board 仍可用)。`)
    readyGate.resolve()
  }

  let disposeTool = null
  try {
    disposeTool = registerTool(ctx, limits, log)
    log(disposeTool === null ? 'task_board 未注册' : `task_board 已注册(disposer=${typeof disposeTool})`)
  } catch (error) {
    log(`task_board 注册失败:${error?.message ?? error}`)
  }

  // 清理:插件卸载/热重载时撤销工具注册。
  // ⚠ 用 ctx.effect(() => () => {...});**不要**用 ctx.on('dispose') —— cordis 无此事件、永不触发。
  // ⚠ 这里**不清空 BOARD** —— 内存板要跨配置热加载存活;介质里的记录更不受影响
  //   (下次 apply 打开域时会把内存里没有的板水合回来)。
  // ⚠ 关域**不在这里**:域是 ctx.inject 子 fiber 的 effect 打开的,由它自己的 disposer 关
  //   (子 fiber 先于本 fiber 收尾)⇒ 这里只管工具注册 + 把 STORAGES 里的条目摘掉。
  try {
    ctx.effect(() => () => {
      if (typeof disposeTool === 'function') {
        try { disposeTool() } catch { /* 已回收 */ }
        disposeTool = null
      }
      if (STORAGES.get(ctx) === storage) STORAGES.delete(ctx)
      log('dispose:已回收工具注册(域 handle 由存储子 fiber 的 disposer 关闭,板数据留在领域存储里)')
    })
  } catch (error) {
    log(`ctx.effect 不可用(${error?.message ?? error}),工具注册将在热重载时泄漏一个实例`)
  }

  // 测试收尾钩子:任何用例抛错都冒泡 ⇒ 宿主 apply 的 try/catch 会记一行日志,
  // 测试侧据此判定失败(见文件头 CASES 的说明)。
  for (const [caseName, run] of CASES) {
    try {
      run({ ctx, limits, log, dispatch, checkPresetGate, resolveBoardKey, makeSessionLookup, BOARD, storage })
    } catch (error) {
      throw new Error(`task-board 测试用例「${caseName}」失败:${error?.message ?? error}`)
    }
  }
}
