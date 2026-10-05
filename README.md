# dsh-host-task-board

DSH 宿主插件：**共享任务板**，只注册一个模型工具 `task_board`，供协调者预设
（`coordinator`）的会话及其子代理共用，**按根会话分桶**。

它替代的是原先只增不减的 `项目根\.dsh\.project\context.md`（最严重一份到过 53,746 token）。
板上只放**未完成的事**：完成的条目先把结论手动搬进项目 `AGENTS.md` / `README.md`，再从板上删掉。
**板落进宿主领域存储（`ctx.storageDomain`），跨 dsh 重启存活**（2026-09-26 改造前是纯内存态、
重启即空）。板仍是工作内存、不是档案库：长期结论该搬走的照样要搬走。
同一天还按独立复核的发现修了四处：卸载撞上"域正在打开"导致**域句柄泄漏 ⇒ 整进程永久降级**、
空板先入内存导致的并发读窗口、水合时 `seq` 被介质牵着走导致**覆盖已有条目**、
以及降级态下提示自相矛盾（详见下面各节与「自测」里的 `18f`–`18i`）。

## 安装

在 profile 目录下（含 profile `package.json` / `dsh.profile.bundles` 的那个目录，例如
`%USERPROFILE%\.dsh\profiles\desktop`）：

```powershell
cd <profile 目录>\plugins           # 例：%USERPROFILE%\.dsh\profiles\desktop\plugins
git clone https://github.com/liuyun847/dsh-host-task-board.git
cd ..
dshpm add file:./plugins/dsh-host-task-board --profile desktop
```

- **三处装载入口必须齐全**（见「注册：三处入口，缺一不可」），`dshpm add` 会补齐它们；
  之后**重启 dsh** 才真正加载（`lib\*.js` 不重启不生效）。
- 本包**不新增 npm 依赖**：`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-storage-domain` 与 `zod`
  都是裸 import，由宿主（profile 级 `node_modules`）提供 ⇒ `package.json` 里只声明
  `peerDependencies`（版本一律 `*`），本包按 `file:` / `link:` 本地安装，不发布到 npm。
- 自测：包目录下 `node --test "test/*.test.mjs"`（纯内存桩，不碰宿主、不写任何文件）。

## 配套包：协调者预设

本工具有**角色门**：只放行 `agentPreset === 'coordinator'` 的会话（子代理继承父会话的同一值，
故一个判据同时覆盖两者），其它预设调用时拿到一段明确的拒绝说明、不抛错。也就是说**单装本包，
没有任何会话能用上它** —— 配套的预设组合包是
[`liuyun847/dsh-agent-preset-coordinator`](https://github.com/liuyun847/dsh-agent-preset-coordinator)：
那个包提供 `coordinator` 这个 preset id 与协调协议技能，本包提供该预设当工作内存用的 `task_board` 工具，
**两者成对使用**。角色门的判据、拒绝文案与放行白名单都在 `lib\index.js` 的 `GATE_PRESET` 处（单值硬编码，要扩就改这里）。

## 存储：内存权威读 + 宿主领域存储持久投影（2026-09-26）

| 层 | 角色 | 依据 |
| --- | --- | --- |
| 内存 `BOARD`（模块作用域 Map） | **权威读源**：五个动作全部同步读、零 IO | 板是工作内存，读路径不该等 IO |
| 宿主领域存储 `ctx.storageDomain` | **持久投影**：每次写先 `await` 落盘、成功后才改内存 | 域层自身就是「后端先落盘 → 再改域内存 → 发事件」 |

- 域声明：`defineDomain({ name: 'task_board', version: 1, tables: { boards: domainTable(zodSchema) } })`，
  记录形状 `{ key = 板键, seq = id 序列, tasks = 整板任务数组 }` ⇒ **一块板一条记录**，
  `put` 是整板覆盖写、板被删空时 `delete` 掉这条记录。
  ⚠ domain 名是 **`task_board`（下划线）**：宿主 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`
  （`@deepseek-ai/dsh-storage` lib/index.js:80）不收连字符，写 `task-board` 会让**整个模块在加载期抛错**
  （比降级更糟：工具彻底消失）。表名 `boards` 同理合规。
- 落点：本 profile 的 `storage-domain` 行路由到 `storage-json` 后端（`backend: json`，
  root = `$DSH_HOME\storages`）⇒ 实际文件是 `$DSH_HOME\storages\task_board.json`
  （默认 `single` 布局：整域一个 JSON 文档）。**本模块自己不 import 任何 `node:fs`**，落盘全由宿主后端做。
- 水合：打开域后把介质里有、内存里还没有的板灌回 `BOARD`。内存优先（它就是权威读源）
  ⇒ 热加载时一块都不会被介质覆盖；只有新进程（内存为空）才真正从介质恢复 —— 这正是"跨重启存活"的落点。
  ⚠ 水合时 `seq` 取 **`max(介质里的 seq, 板内任务 id 的最大序号)`**：介质是纯文本 JSON，
  seq 被手改小/写错时若直接采信，下一次 `create` 会**分配出已存在的 id 并覆盖原有条目**。
  取较大值 ⇒ id 只向前走，绝不回退、绝不覆盖。
- 顺序纪律：**先落盘、后改内存**。落盘失败 ⇒ 整条调用报错，内存与介质都保持原样，
  不会出现"内存说有、介质里没有"的中间态。`create` 建新板时，**空板要等记录落盘成功之后才进内存**
  —— 否则"板已入内存、记录还没写"那段窗口里并发 `list` 会看到"板存在但 0 条"。
- 并发：写路径现在跨了 `await`（落盘），而父会话与其子代理可能**同时**写同一块板 ⇒ 写操作走一条
  模块级写链串行化（取板、CAS 校验、落盘、改内存整体原子）。读动作不进写链。
- 删除：板被删空 ⇒ 介质里的那条记录**同时删除**（不是留一条空记录）。
- **降级**：`ctx.storageDomain` 拿不到、或打开失败（`backend-not-found` / `facet-unsupported` /
  `invalid-record` / `version-mismatch`）⇒ **不抛错、不让整行加载失败**，只打一条警告日志
  （`[task-board] 警告:… ⇒ 降级为纯内存态,dsh 重启即空(task_board 仍可用)`）并退回纯内存态。
  降级时**五个动作的摘要**都追加同一句 `[降级:storageDomain 不可用 ⇒ 本次运行只写内存,dsh 重启即空]`
  （`create` / `remove` 的 `note` 另补一句"数据只在本进程内存里、原因看启动日志"）
  —— 只做 `list` / `get` 的调用方也必须能一眼看出没落盘；摘要里**不会**出现"持久态/跨重启存活"这类
  与降级相矛盾的陈述。
- 热加载竞态：宿主规定**同一 domain 名同一时刻只能开一个**，而 `close()` 是异步收尾
  ⇒ 新实例可能先撞 `already-open`；实现里对该错误**稍等重试**（12 × 50 ms），仍失败才降级。
- **卸载竞态（2026-09-26 修，S1）**：存储打开是**异步**的（apply 后毫秒级才落定）。卸载正好落在
  "域正在打开"这段窗口里时，光看 `domain !== null` 会**漏掉那次 close** ⇒ 域句柄不可达、域名永不释放
  ⇒ 同一进程内此后每次 apply 都撞 `already-open` 并**永久降级为纯内存**（数据只写内存、重启即丢，
  只有一行警告）。现在两处闸一起挡：**disposer 先 `await` 打开落定再决定 close**；
  打开落定处再查一次"是否已卸载"，是就**立刻 close**。
- **可选依赖的形态**：存储走 `ctx.inject(['storageDomain'], cb)`，不是 apply 里查一次 `ctx.get`
  —— 理由与语义见下面「依赖与行序」。
- 依赖：**没有新增 npm 依赖**。`@deepseek-ai/dsh-storage-domain` 与 `zod` 都是裸 import，
  靠 profile 级 `~\.dsh\profiles\node_modules\<pkg>`（指向 dsh 安装树内的 junction）解析 ——
  与既有的 `@deepseek-ai/dsh-tools`、以及同 profile 的 `dsh-llm-auto` 用 `@deepseek-ai/schemastery`
  是同一套机制（实测 `import.meta.resolve` 两个包都能解析）。
- 为什么不用"写进会话日志"：未知事件类型会让整段会话在下次读取时被拒（已调研确认）。
  领域存储正是宿主给"必须跨重启存活、带 schema 校验的宿主侧数据"准备的形态：
  读同步、写在落盘后才 resolve、事件不进会话历史。

## 依赖与行序（W1，2026-09-26）

本包对外只声明一个必需注入：`export const inject = ['tools']`（缺了它工具根本注册不了）。
其余三个服务都是**可选**依赖，两条路走：

| 服务 | 取法 | 为什么 |
| --- | --- | --- |
| `agents` / `sessions`（解析会话父链） | `ctx.get(...)`，**每次调用时现取** | 纯读、每次都要最新活对象；拿不到就回退本会话 id，不涉及"要不要重来" |
| `storageDomain`（持久化） | `ctx.inject(['storageDomain'], cb)` | 需要"服务出现/消失时**重来一次**"的生命周期语义 |

**`ctx.inject(names, cb)` 的确切语义**（实查 `cordis` 4.0.4 源码 + 用真实 `Context`/`Fiber` 实测，
不是猜的；出处 `cordis/lib/index.js:1594-1606` 的 `registry.inject` → `Fiber` 构造
`:1098-1101` 的 `_checkImpl`/`_refresh` → `:1306-1344`）：

- 它等价于 `ctx.plugin({ inject: names, apply: cb })` ⇒ 回调跑在一个**子 fiber**里，
  拿到的是子 ctx（本 scope 的上下文，`ctx.get('storageDomain')` 在里面必定是活的实现）；
- 服务**已可用** ⇒ 回调执行（同一 tick 的微任务内）；
- 服务**不可用** ⇒ 回调**不执行**、**不报错**、**不阻塞本行其它注册**（工具照常注册）；
- 服务**后到** ⇒ 回调**补跑**；
- 服务**消失 / 热替换** ⇒ 回调注册的 effect 被清理，服务回来后再跑一次（旧域先关、新域再开）；
- 父插件卸载 ⇒ 子 fiber 的 disposer 照常执行（域因此一定被关，见上面的"卸载竞态"）。

因此**行序不再是硬约束**：把本插件挪到 `storage-domain` 那一行之前，服务稍后出现时回调会补跑，
存储照样启用（旧写法"apply 里查一次 `ctx.get`"在那种行序下会**静默降级**、整进程只剩内存态）。
仍然成立的软约束是：`storage` / `storage-json` / `storage-domain` 三行要**存在于**这个 profile
（都在 `@deepseek-ai/dsh-base` 的 `cordis.patch.yml`），否则工具可用但只写内存。
若哪天把回调改成异步拿服务，**别 unref 那个"注入回调始终未激活 ⇒ 降级"的定时器**：
unref 的定时器不阻止事件循环退出，调用方卡在等存储落定的 top-level await 上时它会永不执行。

## 分桶：一棵会话树一块板（2026-09-25 用户决定）

- 板键 = **根会话 id**：从调用者会话沿会话头的 `parentSession` 往上走到"没有父会话"的那一层。
  ⇒ 同一个顶层协调者会话**及其派生的全部子代理（任意深度）共用一块板**；换一个新对话就是全新一块板。
- 上溯只查**内存里的活对象**，不读任何会话日志：先 `ctx.get('agents')`（`dsh-agent` 的 `AgentRegistry`，
  `agents.get(id).session`），其次 `ctx.get('sessions')`（`dsh-session` 的 `SessionStore`，
  `sessions.get(id)` 本身就是活会话）。依据：子代理会话头由 `dsh-subagent` 的 `childSessionMeta()`
  写入 `parentSession` / `origin='subagent'` / `delegationDepth`，所以沿这条链上溯即得会话树根。
- 这两个服务走 `ctx.get` **可选读取**（每次调用现取），**不进本包的 `inject` 导出** ——
  进了 `inject` 而服务缺失会让 `apply` 抛错、整行加载失败；`storageDomain` 同理不进 `inject`，
  但它用 `ctx.inject(['storageDomain'], cb)` 拿（语义与理由见上一节）。
- **解析失败一律回退为调用者自己的会话 id**（父会话已销毁、两个服务都拿不到、父链成环或过深）：
  绝不报错、绝不拒调用。回退值一定取自调用者自己的 id ⇒ 不可能把内容写进无关的板；
  代价只是"这个会话自己一块板"，此时摘要会明说一句。这一条有两处例外都不是"上溯失败"：
  调用者会话连 id 都没有 ⇒ 板键无从谈起，只能报错。
- 分桶与 **cwd、路径、`project` 参数全无关系**（`project` 参数已从契约删除；老调用方多传它会被忽略）。
  注：会话**分叉**（fork）也写 `parentSession` ⇒ 分叉出来的会话与其来源共用一块板（同一个"会话树根"口径）。

## 怎么用

一个工具、五个动作：`create` / `list` / `get` / `update` / `remove`。
契约以 `lib\index.js` 的 `TOOL_DESCRIPTION` / `TOOL_PARAMETERS` 为准。

| 参数 | 说明 |
| --- | --- |
| `action` | 必填，五选一 |
| `id` | 任务号 `t1` / `t2`…（板内单调递增，板删空重建后从 `t1` 重来）；`get` / `update` / `remove` 必填 |
| `subject` | 一行标题；`create` 必填，`update` 可选 |
| `description` | "要做什么 + 验收标准"；`create` 可选，缺省空串 |
| `status` | `pending`（`create` 默认）/ `in_progress` / `completed` |
| `owner` | 归属标签，通常是子代理 id；**没有负责人时返回体里省略该键**（不写 `undefined`） |
| `blocked_by` | 前置任务 id 列表，不能含自己；**不在板上的 id 不算阻塞**（见下） |
| `write_scopes` | 本次会写到的路径，供并行避撞 |
| `expected_revision` | `update` / `remove` 必填的乐观锁版本；过期即拒，并回最新 revision |
| `limit` | `list` 专用，1–200，默认 50 |

- 每个回体都报**这次落在哪块板**：`boardKey`（= 根会话 id）+ `boardSource`
  （`self` 自己就是根 / `ancestor` 沿父链上溯到了根 / `fallback` 上溯失败、只能用本会话 id）。
  两者都是字符串；`fallback` 时摘要里另有一句提示。（角色门拒绝不碰板，故不带这两个字段。）
- `ready` 是派生值：`blocked_by` 里**仍在板上**的 id **全部**处于 `completed` 才算就绪。指向**不在板上**的
  id（已被 `remove`、从没建过、写错、或来自别的板）**不算阻塞** ⇒ `ready` 为 `true`，同时在视图里以
  `missingBlockers`（字符串数组，按 `blocked_by` 原顺序）如实提示，摘要里也提一句。缺失时**省略该键**
  （与 `owner` 同口径：没有值的字段一律省略、绝不写 `undefined`）；没有缺失时这个键不存在。
  要恢复阻塞就 `update` 重设 `blocked_by`。就绪不会启动任何人，只是给你一个可调度的判据。
  > 改过的语义（2026-09-25）：旧实现把"依赖不存在"也算阻塞 ⇒ 被依赖的条目一旦 `remove`，依赖方就
  > **永远** `ready=false` 且毫无提示，板上没有任何动作能救活它。现在缺失只是提示，不是闸门。
- `missingBlockers` 只出现在 `create` / `get` / `update` 的任务视图里；`list` 的瘦投影**刻意不带**它
  （一行保持固定形状、不写肥），改由 `list` 摘要在有缺失时给出条数（`其中 N 条有 missingBlockers`），
  细节用 `get` 看。`update` 的"没有字段需要改"回执没有任务视图 ⇒ 提示只走摘要，不新增顶层字段。
- `list` 只回瘦投影（`id` / `status` / `ready` / `revision` / `subject` / 可选 `owner`），正文用
  `get` 取；返回体会进会话历史，所以这块板刻意不 dump 全集。
- 返回值必须是**严格无损 JSON**（宿主校验）：没有值的字段一律**省略该键**，不写 `undefined`
  —— 任务没有负责人时 `owner` 键不存在（`list` 的瘦投影与 `create` / `get` / `update` 的完整视图
  同一口径）。这条有真实回归背书：`create` 不带 `owner` 曾被宿主以
  `value is not lossless JSON` 整条拒绝。
- `remove` 删一条；板被删空则**连板一起回收**（`boardRemoved: true`），该板再建时 id 从 `t1` 重新开始；
  存储里的那条记录**同时删除**。`remove` 与 `update` 共用同一套乐观锁。
- **没有增长型上限**（2026-09-25 用户决定）：每板任务数、板子数量都**不设硬顶** —— 一个对话写不了多少条，
  拿闸门去逼"完成即移出"只会把正常使用也挡住。攒了多少如实报：`create` 回
  `counts: { tasksActive, boards }`，`remove` 回 `boards`（板数 = 内存里现在有几块板；
  2026-09-26 起，重启后从介质水合回来的板也算在内）。
  `list` 的 `limit` 是**输出分页**（每页最多 200 行），不是写入闸门。
- **单字段上限仍在**（挡的是"一次调用塞进巨量文本"，超限一律**拒绝**、不截断，每个都可用插件 config 覆盖）：
  单条 `description` 8,192 B / `subject` 200 B / `write_scopes` 8 条 / `blocked_by` 16 条。
  被顶住时该做的是"把长期结论写进 `AGENTS.md` / `README`，或把任务拆成多条"，不是"把板调大"。
- 角色门：会话 `agentPreset === 'coordinator'` 放行；子代理继承父会话的同一值，故一个判据同时
  覆盖两者。其它预设收到的是一段明确的拒绝说明，不抛错。
- **降级提示的口径**：存储不可用时，**五个动作的摘要**末尾都会追加同一句
  `[降级:storageDomain 不可用 ⇒ 本次运行只写内存,dsh 重启即空]`（`create` / `remove` 的 `note`
  另补"数据只在本进程内存里、原因看启动日志"）；正常路径的摘要**不带**任何存储陈述，
  也不会出现"持久态/跨重启存活"这种在降级态下会自相矛盾的措辞。
- 没有 wait / block / sleep / poll / watch 动作：重新 `list` 就是检查手段。

## 注册：三处入口，缺一不可

1. **包内** `cordis.patch.yml`：本包自带的 patch 层，含 `- insert: - id: task-board /
   name: 'dsh-host-task-board'`。行 id `task-board` 是插件页行级开关与 settings 命名空间的寻址
   键，勿改。
2. **包** `package.json`：`dsh.bundle.patch` 指向 `./cordis.patch.yml`，且 `files` 数组要含
   `cordis.patch.yml` —— pnpm 的 `file:` 拷贝**只按 `files` 落文件**。
3. **profile** `package.json`：`dsh.profile.bundles` 里要有包名 `dsh-host-task-board`。

少任何一处，插件要么根本不被选中（3），要么整包被静默跳过（1、2）。
启停：插件页「已安装」卡片的总开关（写 profile 的 `dsh.profile.bundles`），或卡片详情里的行级
开关（向 profile 的 `cordis.patch.yml` 写 `disabled` 覆盖）。

## 生效机制（本机实测 + 宿主源码核对）

- **包目录先定，patch 路径后拼**：`@deepseek-ai/dsh-app-boot` 的 `resolveBundleDir` 按 Node 的
  node_modules 查找顺序解析包目录（dsh 安装锚点优先，其次 profile 的 `package.json`），
  `bundlePatchPaths` 再以**该目录**为基准拼包内 patch 文件；其后的模块 import 也走这一份。本地
  插件只可能落在 `<profile 目录>\node_modules\dsh-host-task-board\`（**运行副本**）
  ⇒ **只改源目录 `plugins\dsh-host-task-board\` 不生效。**
- **配置层改动会热加载，但宿主只盯三处输入**：profile 的 `cordis.patch.yml`、`$DSH_HOME\cordis.patch.yml`、
  profile 的 `package.json` —— 判据逐监听点不同：两份 patch 文件**任一内容变化即重读整棵树**，
  `package.json` 只有 `dsh.profile.bundles` 真的变了才算（判据有个陷阱，见 `dsh-agent-preset-coordinator`
  的 README「改动何时生效」一节）。变化时重新从磁盘读整棵树再 reconcile（由 `@deepseek-ai/dsh-base`
  挂的 `hmr` 行驱动，实现在 `@deepseek-ai/dsh-hmr`）⇒ **改包内 `cordis.patch.yml` 本身不会热生效**；
  两条搭车路径：**保存 profile 自己的 `cordis.patch.yml`**（内容一变即重读整棵树，而重读是从磁盘重读
  整个 profile 目录、会把包内 patch 的新文本一并带进来），或"插件页总开关关→开"（写 bundles 搭车重读
  整棵树）；代码改动另需重启。profile 清单里已无 `dsh.profile.patchReload` 键（该键全树零消费者），
  热重载由 `hmr` 行（`@deepseek-ai/dsh-hmr`）驱动。
- **改 `lib\*.js` 永远要重启**：本 profile 的 hmr 配置是 `config.root: []`，模块文件根本不在监视
  范围；即便触发重载，loader 也按 URL 缓存已 import 的模块、只重跑 `apply()`，不会重新 import。
  实测：注册行热生效之后，新加的 `remove` 动作在当前进程里仍报 `unknown tool`。
  ⇒ 本次（2026-09-26）的存储改造同样**只有重启 dsh 后才真正生效**。
- **存储依赖基础层的三行**：`storage` / `storage-json`（root = `$DSH_HOME\storages`）/
  `storage-domain`（`backend: json`），都在 `@deepseek-ai/dsh-base` 的 `cordis.patch.yml`（161-174 行）。
  它们由基础层提供，本包**不把它们写进 `inject` 导出**（存储用 `ctx.inject(['storageDomain'], cb)`
  可选接入，见「依赖与行序」）—— 缺了不影响启动，只会让任务板降级为纯内存态并打一行警告。
- **新增包内文件不会自己进运行副本**：得重跑 link（profile 目录下 `pnpm install`，或
  `dshpm remove` + `dshpm add`）才会带上；漏了同样是被静默跳过。
- **硬链接 vs 实体拷贝：逐文件实测，别一概而论**：本机 pnpm 的 `file:` 依赖两种形态都有 —— 本包 4/4
  共享文件实测为硬链接（两侧同 inode，`fsutil file queryfileid` / `fsutil hardlink list` 同源）；
  `dsh-host-restart` 4/4 拷贝、`dsh-host-godot-tool-layering` 5 拷贝 + 1 硬链接（`lib/assembly.js`）、`dsh-client-ui-peak-valley` 6 拷贝 + 2 硬链接（`LICENSE`、`lib/index.js`）
  ⇒ 判据是逐文件实测 `fileId`，不是"多为/一概"。硬链接下原地改会同时改到两侧，但 write/edit 这类
  "写临时文件再改名"的换文件式写入会**打断链接**，让运行副本留在旧内容。⇒ 硬链接文件原地改即生效，
  仍要收尾核对：两侧 SHA256 一致（硬链接再加一条 `fsutil hardlink list` 仍同源）。

## 自测

- 包目录下：`node test\task-board.test.mjs` —— 桩 ctx（含 `agents` / `sessions` 两个活对象注册表的桩，
  以及**照抄真实 cordis 语义**的 `ctx.inject`）+ 真实 `defineTool` + 真实 `defineDomain`/zod schema +
  **假 storageDomain**（介质是内存里的 Map，不写任何真实 storages 目录），50 组断言，覆盖五个动作、
  CAS 拒绝、单字段上限、角色门、并发声明、render 精简、`ctx.effect` 回收，以及**逐条返回值的
  严格无损 JSON 关口**（含 `create` 不带 `owner` 这条真实回归用例与关口自身的自检）。
  分桶口径逐条钉住：父会话 + 子代理 + 孙代理（任意深度）+ 兄弟子代理共板，另一个根会话是另一块板
  且互不可见（同一 cwd 也一样）；`project` 已不在参数表、传了也不参与分桶；增长型上限两侧都测
  （同一板连写 70 条、40 个根会话 40 块板全放行），单字段上限仍逐项拒绝。依赖语义四类情形各有断言：
  依赖存在但未完成 ⇒ 不就绪 / 依赖已完成 ⇒ 就绪（两条回归保护）、依赖被 `remove` 与依赖从没建过
  ⇒ 非阻塞且 `missingBlockers` 如实提示。上溯失败五路（父会话已销毁 / 服务拿不到 / 父链成环 /
  超深链 / 无 lookup）都断言"回退本会话 id、不报错、不写错板"。
  **存储口径（用例 18）**：写入必须落进介质（记录形状 `{key, seq, tasks}`、严格无损 JSON、
  无 owner 时不写该键）→ 模拟**进程重启**（关域 + 清空内存 + 同一份介质新建 apply 实例）后
  条目 / `revision` / `seq` / 依赖关系 / CAS 全都还在（过期 rev 被拒并回最新值、正确 rev 放行且立刻落盘）
  → 板删空后介质里的记录也消失且不会在下次重启复活 → 新实例先撞 `already-open` 再靠重试开成功
  → 拿不到 `storageDomain` 时打一条警告并降级（五个动作照常可用）→ 介质里的记录不合 schema 导致
  `open` 失败时同样只降级、不抛回 loader → 落盘失败时整条调用报错、内存回滚（不留"内存里有、
  介质里没有"的幽灵空板，`seq` 也不推进）。
  **四条新增回归（2026-09-26，独立复核发现的问题）**：
  `18f` 卸载撞上"域正在打开"⇒ 域句柄不泄漏（域已关、名字已释放、随后 apply 能正常 ready 且写入落盘；
  修复前这条必红，已用"临时退回旧写法"验过它有区分度）；
  `18g` 落盘未完成时并发 `list` 不得看到"板存在但 0 条"（空板推迟到落盘成功之后才入内存）；
  `18h` 水合时 `seq` 取 `max(介质 seq, 板内 id 最大序号)`（把介质 seq 手改成 1 ⇒ 新条目必须是 `t3`，
  绝不能是 `t2` 而覆盖原有条目）；
  `18i` 降级态下五个动作（含"无字段可改"与"板已回收"两条回执）的摘要都带同一句降级提示，
  `note` 不再自称"持久态"。
  （另有一次**一次性验证**用真实 `DomainFacility` + 真实 `JsonStorageBackend`（临时目录）跑通了
  「落盘成 `task_board.json` → 关域关后端 → 新后端重开 → 水合回来 → CAS 生效 → 删空即删记录」，
  跑完已删；那条不在测试里，属于人工核验。`ctx.inject` 的语义另用真实 `Context`/`Fiber`
  （cordis 4.0.4）单独探针实测过：服务缺席 ⇒ 回调不执行、服务后到 ⇒ 补跑、父卸载 ⇒ 子 disposer 执行。）
- profile 目录下（`<profile 目录>`）：`node <包目录>\test\runtime-copy.smoke.mjs` —— 冒烟的
  是**运行副本**，脚本按 cwd 相对解析 `node_modules/dsh-host-task-board/lib/index.js`，所以必须在
  该目录里跑；除 create / list / remove / 角色门 / 严格无损 JSON 外，也含父子共板、依赖缺失口径、
  "上溯失败 ⇒ 回退"，以及**运行副本这份也能声明域、落盘、跨重启水合**（证明
  `@deepseek-ai/dsh-storage-domain` / `zod` 从运行副本位置也能解析）。
- 两个测试都只在内存里跑，不碰宿主、不写任何真实文件（存储介质是内存 Map）；运行副本里**没有**
  `test\`（`files` 不含它）。

## 坑清单

1. **静默跳过**：包目录解析不到、包内 patch 文件不在运行副本里、包名不在 bundles 里…… 都不会让
   启动失败，而是在 `loadProfileDirectory` 里被收进 `skippedBundles`（该函数自己不打印任何东西）。
   这就是"注册行漏了没人发现"的原因。事后能查的两条线索：启动时 CLI 的 `reportSkippedBundles`
   会往 stderr 打一行 `skipping profile bundle ...`，配置 schema 把它记为 error；**热重载路径完全
   没声**，别指望日志。
2. 只改 `plugins\` 源目录 ⇒ 断链后的拷贝文件不生效（宿主读的是 `node_modules\` 运行副本）；仍是硬链接的文件原地改即两侧同变，立即生效。
3. 改包内 `cordis.patch.yml` ⇒ 不热生效（它不在监视清单里）。
4. 改 `lib\*.js` ⇒ 不重启不生效（模块按 URL 缓存 + 本 profile 不监视模块根）。
5. 包内新增文件 ⇒ 不重新 link 就不会出现在运行副本里，随后被静默跳过。
6. 换文件式写入 ⇒ 打断硬链接，运行副本留旧内容；收尾用 SHA256 / inode 核对。
7. 运行副本里找不到 `test\` 目录是正常的，别去那儿跑测试。
8. **返回值必须是严格无损 JSON**（宿主校验：`dsh-tools` 的 `snapshotToolValue()` →
   `dsh-util-values` 的 `snapshotJsonValue()`）：`undefined` / `NaN` / `±Infinity` / 负零 /
   函数 / symbol / BigInt / `Map` / `Set` / `Date` / `RegExp` / 类实例 / 稀疏数组 / 循环引用
   一律让宿主拒掉整条调用，报
   `tool "task_board" returned invalid output: value is not lossless JSON`。**抛错路径不经过这道
   校验**（宿主自己渲染成 `Error: <msg>`），所以坏了只会坏在成功路径上。踩过一次：`create` 不带
   `owner` 时 `toView()` 回了 `owner: undefined`（`toSummary()` 有守卫、`toView()` 漏了）。
   ⇒ 加返回字段时先问"它可能是 undefined 吗"，是就**省略该键**；`test\task-board.test.mjs`
   把严格关口挂在每次工具调用上，别绕过它。
9. **domain 名不能带连字符**：`UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`，`defineDomain` 在**模块加载期**
   就校验 ⇒ 写成 `task-board` 会让整个模块 import 失败（工具彻底消失，比降级更糟）。现用 `task_board`。
10. **域记录必须经得起 JSON 往返**：介质是 JSON 文档，`undefined` 键会被丢掉 ⇒ 写记录时
   `owner` 没值就**不写该键**（`recordOf` → `copyTask`），否则"内存里有 owner 键、重启后没有"
   这种两侧形状不一致会埋很久。测试里的假介质也做 JSON 往返，就是为了钉住这条。
11. **同一 domain 名同时只能开一个**：热加载时旧实例的 `close()` 是异步收尾（等写链排空 +
   释放后端 unit），名字要等收尾完才释放 ⇒ 新实例的 `open` 会先撞 `DomainError('already-open')`。
   实现里对该错误重试 12 × 50 ms，仍失败才降级。**"卸载撞上域正在打开"这条竞态另有单独的闸**
   （disposer 先 `await` 打开落定再决定 close；打开落定处再查一次是否已卸载）—— 少了它，
   域会被打开而没人关，同一进程内此后每次 apply 都永久降级为纯内存态。回归用例 `18f`。
12. **降级不是错误但必须出声**：拿不到 `storageDomain`（或打开失败）时工具照常可用，但数据只写内存。
   这条体现在**启动日志 + 五个动作的摘要**（`create` / `remove` 的 `note` 另补一句数据在哪）
   ⇒ 排查"重启后板空了"时先看启动日志有没有那行 `警告:… ⇒ 降级为纯内存态`；
   只看工具返回值也能发现（摘要里带 `[降级:…]`）。真实落盘文件是
   `$DSH_HOME\storages\task_board.json`，可用来核对"到底写没写进去"。

## 许可

MIT，见 [LICENSE](LICENSE)。Copyright (c) 2026 liuyun847
