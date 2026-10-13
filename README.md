# trae-cn-provider

把 **Trae CN** 作为一个**原生 LLM provider** 接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。
安装后 Trae 的模型会直接出现在 DSH 的模型选择器里，也可以额外开出一个 OpenAI 兼容接口给 Cline / Claude Code 之类的客户端用。

macOS 优先、源码可审计、**凭据不出本机**。

---

## ⚠️ 先读这一段：风险声明

1. **本项目违反 Trae（字节跳动）的使用条款。** 它把 Trae 客户端内部的接口当作通用 LLM API 使用，这不是官方支持的用法。
2. **你的 Trae 账号有被封禁的风险。** 请自行判断是否接受。
3. 消耗的是**你自己账号的额度/积分**。本项目不提供、不转让、不代充任何额度。
4. 本项目与 Trae、字节跳动**没有任何关系**，未获其授权或背书。
5. 请**不要**把本插件连同你的凭据一起分发。凭据只应存在于你自己的机器上。
6. 作者不对因使用本项目产生的任何后果负责（包括但不限于账号封禁、额度损失、数据问题）。**如果你不接受以上任何一条，请不要安装。**

---

## 它做什么

- 以 DSH **原生 `LlmAdapter`** 的形式注册一个 provider route：`trae-cn`
- 模型自动出现在模型选择器（从 Trae 的模型目录实时拉取）
- 支持流式正文、思考链（reasoning）、原生 function calling、上下文窗口、思考档位
- 支持**图片输入**（多模态模型）：DSH 的图片块经 attachments 缝内联为 data URL；OpenAI 层也接受 `image_url`
- 可选：在宿主已有的 web server 上挂一个 OpenAI 兼容面（`/v1/models`、`/v1/chat/completions`），**不自己占用端口**
- 同时提供一个独立 CLI，可脱离 DSH 单独当本地代理跑

## 它不做什么

- 不代理、不中转、不上传任何凭据到第三方。**代码里出网的域名只有 Trae 官方域名**（见「出网清单」）。
- 不共享额度给别人，不做多账号池，不做额度转卖。
- 不修改 Trae 客户端，不 hook 它的进程。

---

## 安装

```bash
# 从 npm 安装到 web profile（安装即激活：会自动追加进 dsh.profile.bundles）
dsh plugin --profile web add trae-cn-provider

# 桌面版：需要先完全退出 DeepSeek Harness 桌面应用
dsh plugin --profile desktop add trae-cn-provider
```

> **桌面 profile 的坑**：`dsh plugin --profile desktop` 要求桌面应用完全退出后再执行
> （否则报 `Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it`）。
> 卸载：`dsh plugin --profile <p> remove trae-cn-provider`。

安装后重启对应 profile 即可。模型选择器里会出现 **Trae CN** 分组。

---

## 登录与凭据来源

插件有三档凭据来源，通过 `credentialSource` 配置：

| 值 | 行为 | 需要浏览器 | 包内是否存在解密凭据的代码路径 |
|---|---|---|---|
| `oauth`（**默认**） | 只在 DSH 里走一次浏览器登录，凭据存本机 | 是（一次） | **否** |
| `local` | 直接读本机已登录的 Trae 客户端凭据 | 否 | **是（显式开启才生效）** |
| `auto` | 先看已保存的 OAuth 凭据，没有再看本机客户端 | 视情况 | 是（同上） |

### `oauth`（默认，推荐）

在 DSH 里执行登录命令（默认 `/trae-login`），会打开浏览器到 Trae 官方授权页：

```
https://www.trae.cn/authorization?...&auth_callback_url=http://127.0.0.1:<port>/authorize
```

**实测发现：Trae 的回调不是下发授权码，而是直接把凭据塞进回调参数**（`userJwt` 是 URL 编码的 JSON，含 `Token` / `RefreshToken` / `TokenExpireAt`；`userInfo` 含 `UserID` / `Name`）。所以不存在「换码」这一步。回调只在 `127.0.0.1` 上临时监听，拿完即关。

凭据默认落在 `~/.trae-proxy/credentials.json`（权限 `0600`）。若 DSH 的 `credentials` 服务可用，会优先存进那里。
目录可以用环境变量 `TRAE_PROXY_CRED_DIR` 覆盖（测试用它做隔离；也可以在你想把凭据放到别处时用）。

### `local`（可选，零摩擦）

直接读本机 Trae 客户端的登录态，**不需要浏览器**。支持两种存储格式，运行时自动嗅探：

| edition | 存储格式 | 上游 |
|---|---|---|
| `cn` Trae CN | `tc` 加密 | `trae-api-cn.mchost.guru` |
| `solo` TRAE SOLO CN | `tc` 加密 | `trae-api-cn.mchost.guru` |
| `sg` Trae 国际版 | 明文 JSON | `a0ai-api-sg.byteintlapi.com` |
| `solo-sg` TRAE SOLO | `tc` 加密 | `a0ai-api-sg.byteintlapi.com` |

路径：macOS `~/Library/Application Support/<App>/User/globalStorage/storage.json`，Windows `%APPDATA%\<App>\User\globalStorage\storage.json`。

> **必须知道的取舍**：`tc` 格式的密钥材料**完全内嵌在密文自身**（第 6–38 字节派生），不需要 macOS Keychain，也不受它保护 —— 这意味着**本机任何能读到那个 `storage.json` 的进程都能解出你的 Trae token**。这是 Trae 自身格式的性质，不是本插件引入的。
>
> 选择 `local` 会让包内存在这条解密路径。如果你关心「发布包里有没有解密凭据的代码」，请保持默认的 `oauth`。

> **`local` 随时可能失效，这是正常现象。** `storage.json` 归 Trae 客户端所有，它会自己改写这个文件 —— 退出登录、重置登录态、原地迁移都会把 `iCubeAuthInfo://icube.cloudide` 这个键删掉（本机实测发生过：该键在客户端运行期间被移除，只留下设备密钥和 usertag）。
>
> 所以不要把 `local` 当成长期可靠的来源：
>
> - 想省事又要稳，用 `auto`（已保存的浏览器登录优先，本机凭据兜底）。
> - 键消失时插件会返回 502 并说明是哪个 edition 缺什么，**不会崩溃**；按提示在客户端重新登录，或换回 `oauth`。
> - `edition: auto` 会按 `cn → solo → sg → solo-sg` 顺序挑第一个能读的，但**不校验它的过期时间**，可能选中一个很久以前就过期的凭据（本机 `sg` 就是 2 月的）。这种时候上游会返回认证错误，看错误里的 edition 就知道换哪个了。

---

## 配置

通过 profile 的 `cordis.patch.yml` 覆盖：

```yaml
- id: trae-cn
  config:
    credentialSource: oauth      # oauth | local | auto
    edition: cn                  # local/auto 时读哪个 edition
    requestStyle: chat_v3        # chat_v3（实测可用）| inline_chat（实验，实测失败）
    appVersionCode: 20260401     # 必须是纯整数，见下方说明
    ideVersion: ''               # 留空 = 从本机 Trae 安装读取
    displayName: Trae CN
    loginCommand: trae-login
    mountOpenAIEndpoint: true
    openAIPath: /trae-cn        # 挂载前缀（不是 base URL）：对外接口为 /trae-cn/v1/...
```

`appVersionCode` 会作为 `x-app-version-code` / `x-ide-version-code` 发送。**它必须是纯整数**：带点的值（例如 `2.3.90452`）会被上游以
`bad request: binding: expr_path=app_version_code, cause=parameter type does not match binding data` 拒绝。
而且**该值决定网关加载哪套 function 配置** —— 太小（如 `20250325`）会报 `no function config found`。

---

## OpenAI 兼容接口

`mountOpenAIEndpoint: true`（默认）时，挂在宿主 web server 的 `openAIPath` 下：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/trae-cn/v1/models` | 模型列表 |
| POST | `/trae-cn/v1/chat/completions` | 对话（流式 / 非流式，含 `reasoning_content` 与 tool calls） |
| GET | `/trae-cn/health` | 健康检查 |

独立 CLI 也可以把同样的接口跑在自有端口上：

```bash
node src/cli.js login     # 浏览器登录
node src/cli.js models    # 列出模型
node src/cli.js serve --port 8317 [--api-key <key>]
node src/cli.js chat "你好"
```

---

## 可用模型

模型目录是从上游实时拉取的，不在代码里硬编码。本机实测（2026-10）过滤后 7 个用户可选模型：

| config_name | 显示名 | 上下文 | 思考档位 |
|---|---|---|---|
| `Doubao-Seed-Code` | Seed-Code | 256000 | `light` / `high` |
| `glm-5.2` | GLM-5.2 | 116000 | — |
| `DeepSeek-V4-Flash-Official` | DeepSeek-V4-Flash | 116000 | — |
| `DeepSeek-V4-Pro-Official` | DeepSeek-V4-Pro 正式版 | 116000 | — |
| `DeepSeek-V4-Pro` | DeepSeek-V4-Pro | 116000 | — |
| `minimax-m3` | MiniMax-M3 | 116000 | — |
| `qwen-3.7-plus` | Qwen3.7-Plus | 200000 | — |

目录里还有 `summary` / `fast_apply` / `title_generation` / `input_optimization` / `custom_model_*` 等条目，它们是内部节点或自定义连接，已按 `usage` 字段过滤掉。

---

## 与同类项目的差异

生态里已有几个同类项目，写清楚差异免得你重复踩坑：

| 项目 | 形态 | 与我们不同的地方 |
|---|---|---|
| [`dsh-trae-api`](https://www.npmjs.com/package/dsh-trae-api) | DSH 插件 + 独立 HTTP 服务 | 它的目录路径写死 `%APPDATA%`，**正主在 macOS 上 100% 不可用**；且把 token **明文写进包目录下的 `.env`**；默认 API Key 硬编码；1.0.0/1.0.1 曾绑 `0.0.0.0` 且无鉴权（1.0.2 才修） |
| `@casually/dsh-trae-api` | 同上（fork） | 修了 macOS 路径，**只做 HTTP 服务**，不是 DSH 原生 provider |
| `@hajilongshi/dsh-trae-api` | 同上（fork） | 功能最全，但**声明的 GitHub 仓库 404**、维护者 GitHub 账号不存在，溯源无法核验 |
| [Trae-Relay](https://github.com/sdn205/Trae-Relay) | Windows 单 exe（C++） | 仅 Windows；用它做协议参考（本项目的协议事实来源之一） |
| [Trae-Proxy](https://github.com/arch3rPro/Trae-Proxy) | 反方向 | 是「把自己的 key 塞进 Trae」，与本项目方向相反 |

本项目的做法不同：

- **DSH 原生 `LlmAdapter`**，不是外部 HTTP 服务的壳 —— 工具调用、思考档位、usage 走 DSH 原生类型，不经过有损的 OpenAI 转换
- **不自己 listen 端口**，OpenAI 兼容面挂在宿主 web server 上
- 企业版账号的刷新按账号自身的 host 走（见下），这是同类项目普遍没处理的
- 凭据落在用户目录的 `0600` 文件，不落在包目录
- 全部出网域名可枚举、有完整性校验、凭据不进日志

---

## 实测验证状态

下面这些是**在真机上用真实账号跑过**的，不是推断：

| 能力 | 结果 |
|---|---|
| 模型目录 `get_detail_param` | 200，250KB / 42 条 config → 过滤后 7 个用户模型 |
| 流式对话 `llm_utils_chat` | 正文 + `reasoning_content` 增量正常 |
| usage | 平铺字段正常，**prompt cache 生效**（实测 `cached_tokens: 128`） |
| 原生 function calling | 完整 `tool_calls`：`get_weather {"city":"北京"}` |
| `finish` 语义 | 上游在带工具调用时也回 `finish_reason: "stop"`，已按实测改成 `{kind:'tool-calls'}` |
| OpenAI 兼容层 | `/v1/models`、`/v1/chat/completions`（流式 + 非流式） |
| 多模态图片输入 | 96×96 纯红 PNG 走**两条路径**都实测通过：DSH `{type:'image'}` 块 + attachments 缝，以及 OpenAI 层的 `image_url` data URL —— 模型均回答「红色」。脚本 `test/live-image.js` |
| 本机凭据 `tc` 解密 | `cn`（加密）/ `sg`（明文）两种格式均解出并调通上游 |
| token 刷新 | OAuth 与 local **两条来源都曾刷新成功**（走账号自己的 host、双信封解析）。**注意 refresh token 会被作废**，见下方「refresh token 会失效」 |
| 过期触发刷新链路 | `test/live-refresh.js` 用隔离的凭据副本把 `expiresAt` 强制到过去，验证「过期 → 自动刷新 → 请求成功 → 新 token 落盘」；当前该凭据的 refresh token 已失效，**需要重新登录后本项才能通过**（脚本会明确诊断，不会让你误以为插件坏了） |
| adapter 端到端 | `listModels` 7 个 / `resolveModel` 上下文正确 / `stream` 正文+思考+usage+工具调用 |
| 跨 DSH 版本 | 在 **0.1.2-rc.1**、**0.2.0-rc.2**、**0.2.1-alpha.2** 三个宿主上分别启动并验证：provider 注册、7 个模型、`resolveModelInfo`、挂载接口（health / models / 对话）全部通过。后两个分别对应桌面应用打包的版本与 npm 上的最新版 |

**企业版账号的两个坑**（同类项目基本没处理，会导致刷新永远失败）：

1. 刷新主机**不能写死 `api.trae.cn`**。企业版要打账号自己的 host（`account.saasBootConfig.apiHost`，或网页登录回调的 `host` 参数），否则返回 `20101 refresh token is invalid`。
2. 企业版网关用 `{code, message, Data}` 信封，不是 `{ResponseMetadata, Result}`，两者都要兼容。

### refresh token 会失效，而且网关会把它说成「网络异常」

这是个运维事实，不是插件缺陷，但很容易误判：

- 网关对一枚失效的 refresh token 回的是**自己的业务码 `30022 网络异常`**，看上去像瞬时网络故障，实际是鉴权失败，**唯一的恢复方式是重新登录**。
- refresh token **会被作废**：Trae 客户端自己那枚轮换后，你手上的副本就死了；任何一次刷新如果结果被丢弃（例如调试脚本干过一次），旧值也就没用了。
- 因此：**access token 的有效期就是「不用重新登录」的上限**（实测 `TokenExpireDuration` 是 14 天）。

插件对此的处理：
- **`/trae-login` 的返回值必须符合宿主的 `CommandResult` 联合类型**。`@deepseek-ai/dsh-commands` 会在注册边界校验它（其 `lib/index.js` 的 `normalizeResult`），不合规就抛 `command "<名字>" returned unknown result kind "<kind>"`。它只接受两种形状：`{ kind: 'success', text?: string }` 与 `{ kind: 'error', text: string }`（**字段名是 `text`**，错误文本且必须非空）。这条以前写成 `{ kind: 'text' }`，于是**每次 `/trae-login` 都会先把登录做完、再在返回的那一刻抛错**。离线套件当时只验证了命令「已注册」而没验证它的返回值，所以没抓到；现在由 `lib/support.js` 的 `commandSuccess` / `commandFailure` 统一产出，并有测试对着上面这条契约守着。
- **`prepareCall().stream()` 必须直接返回一个 AsyncIterable，不能返回「解析成 AsyncIterable 的 Promise」**。`dsh-llm@0.2.0-rc.2` 的 `adapterStream` 对 `dispatch(...)` 的返回值**同步**解引用 `[Symbol.asyncIterator]()`，拿到 Promise 就直接抛 `dispatch(...)[Symbol.asyncIterator] is not a function` —— 于是**每一次 Trae 模型调用都是立刻失败**。这条以前把 `stream` 对准了 async 的 `streamWithInfo`（它 `await` 之后才返回 chunk 生成器，等于返回 Promise）。现在由 `prepareCall()` 返回 `stream: (options) => this.streamPrepared(...)`，`streamPrepared` 是一个 async generator，`yield* await this.streamWithInfo(...)` 把「先用 Promise 完成建连、再把 chunk 流扇出」的既有时序原样保留；`test/smoke-plugin.js` 里有对着同步契约（`typeof dispatched[Symbol.asyncIterator] === 'function'`）的回归测试守着。
- **企业版/租户主机上会在两个刷新端点之间自动降级**。需要设备签名的 `/trae/api/v3/oauth/ExchangeToken` 在 `console.enterprise.trae.cn` 这类租户主机上**根本不存在**（网关回 404 + HTML），而免签名的 `/cloudide/api/v3/trae/oauth/ExchangeToken` 存在。所以刷新会先试签名那条，**只有在端点确实缺失（404/405）时**才退到免签名那条；如果服务器是**主动拒绝**签名，则原样抛出，绝不悄悄降级到更弱的流程。
- **access token 还没真过期时，刷新失败不致命**。`needsRefresh()` 提前 30 分钟触发，所以这半小时内一次短暂刷新失败会**降级为警告 + 继续用现有凭据**，而不是把本来还能成功的请求打掉。只有 token 真的过期了才硬失败。
- 硬失败时不再原样抛出「网络异常」，而是抛 `LlmError('REFRESH_FAILED')`，消息里说明「refresh token 已失效」并给出重登命令，同时保留原始上游原因便于排查。
- **401 之后的重试是真的会刷新**。这里曾经有个隐蔽 bug：旧代码靠写入 `expiresAt: 0` 来表示「强制刷新」，但 `needsRefresh()` 把 falsy 的过期时间当成「未知，不主动刷」，于是那次「重试」其实用的是同一枚刚被拒的 token。现在改成显式的 `ensureFresh(force = true)`。
- `credentialSource: local` 读到的凭据**刷新后只留在内存**，绝不写回 OAuth 凭据文件 —— 否则两个来源会静默错位。
- 上面每一条都有离线测试锁住（见「开发」一节），`test/live-refresh.js` 则把两种失效情况区分开并明确诊断。

---

## 出网清单

代码里出现的全部外部域名：

| 域名 | 用途 |
|---|---|
| `trae-api-cn.mchost.guru` | CN 版模型目录 + 聊天 |
| `a0ai-api-sg.byteintlapi.com` | 国际版模型目录 + 聊天 |
| `api.trae.cn` | 令牌刷新（默认 host） |
| `console.enterprise.trae.cn` 等 | 企业版账号**自己的**刷新 host（由凭据决定，不写死） |
| `www.trae.cn` | 浏览器授权页（仅 `oauth` 来源，由浏览器打开） |
| `127.0.0.1` | 本地回调监听（仅 `oauth` 登录期间，临时端口，用完即关） |

没有任何第三方域名，没有任何把 token 发往非 Trae 域名的代码路径。

---

## 工作原理（协议要点）

完整逆向记录见 [`PROTOCOL.md`](./PROTOCOL.md)（400+ 行）。关键点：

```
POST https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat
Authorization: Cloud-IDE-JWT <token>
X-Cloudide-Token / X-Ide-Token / X-Uid / x-app-id / x-app-version-code / x-ide-version ...

{ "messages": [{ "role":"user", "content":[{"type":"text","text":"..."}] }],
  "function": "chat_v3",
  "stream": true,
  "config_name": "glm-5.2",
  "model": "glm-5.2__dev",
  "model_name": "glm-5.2__dev",
  "config_source": 1,
  "is_custom_model": false,
  "provider": "" }
```

- `messages[].content` **必须是 parts 数组**，传字符串会被拒（`cannot unmarshal string into ... content of type []*...`）
- `model` / `model_name` 要用目录里 `model_detail_list[].model_name`（带 `__dev` 后缀）
- `tools[].function.parameters` 上游要求 **JSON 字符串**（不是对象）
- SSE 事件：`output`（`content` / `response` / `reasoning` / `reasoning_content` 都是**增量**）、`token_usage`、`done`、`error`、`[DONE]`

---

## 目录结构

```
lib/index.js      插件入口：{ name, inject, Config, apply }，注册 provider 与 adapter
lib/adapter.js    LlmAdapter 子类：目录 → 模型信息，Trae 事件 → StreamChunk
lib/chat-body.js  请求体构造（chat_v3 / inline_chat 两种形态）
lib/messages.js   DSH block 消息 / legacy OpenAI 消息 → Trae parts
lib/credentials.js 凭据存储与刷新（oauth / local / auto 三档）
lib/attribution.js DSH 强制的 attributionHeaders 接入
src/trae-client.js 上游客户端：目录 + SSE 解析 + 工具调用累积
src/trae-auth.js   OAuth 登录、回调解析、令牌刷新（两种信封）
src/trae-local-credentials.js 本机凭据读取（tc 解密 + 明文）
src/openai-server.js OpenAI 兼容层
src/cli.js         独立 CLI（login / models / serve / chat）
```

## 开发

```bash
npm run check     # 语法 + YAML + 清单一致性 + Config schema + 四套 smoke 测试（全部离线，mock fetch）
npm test          # 只跑四套 smoke 测试
```

smoke 测试全部用 stub fetch 拦截上游，**不需要凭据、不联网**。四套分别覆盖：

- `smoke-adapter.js` — `LlmAdapter` 契约：目录映射、chunk 序列、思考档位、工具调用、usage 映射，以及**凭据刷新的三条不变量**（并发调用只刷新一次、401 只重试一次不会无限循环、失效 refresh token 报可操作的 `REFRESH_FAILED`）
- `smoke-client.js` — 上游客户端与凭据：企业版刷新主机、双响应信封、回调解析、tc 解密
- `smoke-plugin.js` — **插件入口 `apply()`**：Config 是否是可被 cordis 校验的 Standard Schema、provider/adapter 是否按契约注册、挂载的 OpenAI 接口是否真的能应答，以及 **`prepareCall().stream()` 同步返回 AsyncIterable**（防 `[Symbol.asyncIterator] is not a function` 回归）
- `smoke-login.js` — **`/trae-login` 命令全链路**：命令注册 → `webLogin` → 授权链接 → **合成 Trae 的真实回调** → 凭据落盘。它把 `openInApp` 换成桩（否则会真的弹出浏览器），并用 `TRAE_PROXY_CRED_DIR` 隔离凭据文件，**不会碰你真实的登录态**

另有两个**需要联网的手动脚本**（不在 `npm run check` 里）：

```bash
node test/live-refresh.js   # 用隔离副本强制凭据过期，验证「过期 → 自动刷新 → 请求成功 → 新 token 落盘」
node test/live-image.js     # 现场生成纯红 PNG，验证两条图片路径都真的被模型看见（回答「红色」）
```

`live-refresh` 会断言刷新确实打到了账号自己的 host、没有回落到 `api.trae.cn`、新 token 已落盘，并校验**你真实的凭据文件未被触碰**（比对 SHA-256）。凭据的 refresh token 已失效时它会明确诊断而不是让你以为插件坏了。

`live-image` 自己生成图片（不依赖任何 fixture），分别走 DSH 的 `{type:'image'}` 块 + attachments 缝、以及 OpenAI 层的 `image_url` data URL —— 离线测试只能断言请求体里有 data URL，**证明不了上游真的接受、模型真的看得见**，这个脚本补的就是这一步。

> 第三套是必要的：上面两个真实崩溃（Config 不是 Standard Schema、把 `http.Server` 当请求处理器）都发生在这条路径上，而它一度是零覆盖。

### 验证插件是否真的注册进了运行中的 DSH

`apply()` 不抛错**不等于**注册成功。要拿到直接证据，用只用于验证的探针覆盖层从宿主进程内部读注册状态：

```bash
# 注意 --patch 是 dsh 层选项，必须放在 --profile 之前
dsh --patch test/probe-patch.yml --profile web --no-open --port 18318
```

启动日志会打印（同时写入 `/tmp/trae-probe-result.json`）：

```
[trae-probe] providers=[{"id":"deepseek-official",...},{"id":"trae-cn","name":"Trae CN"}]
[trae-probe] trae-cn models (7)=["Doubao-Seed-Code","glm-5.2",...]
[trae-probe] resolved first={"id":"Doubao-Seed-Code","contextWindow":256000,"efforts":["light","high"]}
```

探针文件（`test/probe-catalog.mjs`、`test/probe-patch.yml`）不在 `files[]` 里，**不会进发布包**。

### 验证发布产物本身

`link:` 安装不会装被链接包的 `dependencies`，所以它**不能**用来验证发布形态。要验证真实产物：

```bash
npm pack
dsh plugin --profile web remove trae-cn-provider
dsh plugin --profile web add ./trae-cn-provider-<version>.tgz
```

从 tarball 安装时 `@deepseek-ai/schemastery` 会被真正装上（走真实 schema 路径，而不是内部的兜底实现），这也是发布前应当跑一遍的检查。

### 在另一个 DSH 版本上验证（重要）

`~/.local/bin/dsh` 与桌面应用打包的 DSH **是不同版本**（本机实测分别是 `0.1.2-rc.1` 和 `0.2.0-rc.2`）。只在一个版本上验证是不够的 —— 桌面才装了 `@deepseek-ai/*` 的会话校验。DSH 的 API 面在两个版本间确有差异（`dsh-llm` 0.2.0-rc.2 比 0.1.2-rc.1 多出 20+ 个导出，例如 `assembleAssistantStream`、`AssistantStreamAccumulator`、`createSystemMessage`）。

桌面把整个 DSH 打进 `app.asar`，可以直接抽出来当独立 CLI 跑（`test/asar-read.mjs` 就是个最小 asar 读取器，不依赖 `npx asar`）：

```bash
RES="/Applications/DeepSeek Harness.app/Contents/Resources"
rm -rf /tmp/dsh020 && mkdir -p /tmp/dsh020
node test/asar-read.mjs "$RES/app.asar" extract dsh /tmp/dsh020
# 归档里的 .node 原生绑定是 unpacked 条目，必须从旁边补回来，否则启动会报
# "No usable native binding found for node-addon-require-builtin-darwin-arm64"
cp -R "$RES/app.asar.unpacked/dsh/." /tmp/dsh020/

node /tmp/dsh020/node_modules/@deepseek-ai/dsh/lib/bin.js --version   # 打印 0.2.0-rc.2
node /tmp/dsh020/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --patch test/probe-patch.yml --profile web --no-open --port 18320
```

用 `web` profile 是对的选择：`desktop` profile 被正在运行的桌面应用占着，`dsh` 会拒绝操作，而且装进去需要先退出应用。

---

## 发布

先说一个容易误解的点：**DSH 没有官方插件市场。** 在 DSH 应用里搜不到任何 `dsh-market` 组件，`dsh plugin` 本身只是 **pnpm 的透传壳**：

```
dsh plugin --profile <p> <pnpm 参数...>     # 在 $DSH_HOME/profiles/<p>/ 里执行 pnpm
```

所以「上市场」的落点就是**发布到 npm**：

```bash
npm run check                      # 先跑一遍离线检查
npm pack                           # 可选：先验证产物内容
npm publish --access public        # 需要你自己的 npm 账号
```

用户侧安装（`add` 之后 `reconcile()` 会自动把包追加进 `dsh.profile.bundles`，**安装即激活，无需手工改配置**）：

```bash
dsh plugin --profile web add trae-cn-provider
dsh plugin --profile desktop add trae-cn-provider   # 需先完全退出桌面应用
```

社区里存在若干「DSH 市场」类的第三方索引/UI 项目，它们与本仓库无关；本插件不依赖任何索引即可安装。

### 两个非显然的打包决定

**1. 所有 `@deepseek-ai/*` peer 都标了 `optional: true`，尽管它们在运行时是必需的。**

因为它们是**宿主进程提供的**（DSH 把插件加载进自己的进程，凭 `ctx` 拿到 `llm` / `credentials` 等服务），不该从 npm 装进插件自己的 `node_modules`。

注意这些范围本身**是能从 npm 解析的**（`>=0.1.2-rc.1` → `0.1.2-rc.1`；`npm view <pkg> version` 只显示 `latest` 标签，预发布版不会被打 latest，别被它误导）。问题不在装不上，而在于**多装**：声明为 required peer 时，包管理器会把 DSH 核心的一份副本拉进用户目录 —— 实测同一个 tarball：

| 声明方式 | `npm install` 结果 |
|---|---|
| required peer | `added 14 packages` |
| optional peer | `added 4 packages` |

多出来的 10 个包是宿主已经提供的 DSH 核心，纯属冗余，还可能造成同一模块存在两份实例。生态里的 `@furongjun1999/dsh-memory` 面对同样处境，做法也是全部标 optional。

**2. `prepublishOnly` 会先跑完 `npm run check`。**

所以 `npm publish` 不可能发出没通过检查的构建（语法、YAML、清单一致性、Config schema、四套 smoke）。

### 上架 dsh.so（社区插件市场）

`dsh.so` 是社区维护的 DSH 插件市场（收录 1.7 万+ 条目，带 L1–L5 验证等级）。**先发布到 npm，再去提交** —— 因为它的检查对象**恒为已发布的 tarball**，不是仓库。

要到 <https://www.dsh.so/zh/submit/> 粘贴仓库地址或 npm 包名，检查器会拉取、校验格式、跑安全扫描，通过后生成一份条目供审核。

它的接受标准，逐条对照本包：

| 标准 | 本包 |
|---|---|
| DSH 兼容信号（`dsh` 字段 / cordis manifest / `dsh-plugin` 话题） | ✅ `dsh.bundle.patch` + `dsh.compatibility`，仓库已打 `dsh-plugin` 话题 |
| README 带安装说明 | ✅ 「安装」小节 |
| SPDX 可识别的开源许可证 | ✅ MIT + `LICENSE` |
| 插件 id 符合 `^[a-z0-9]+(-[a-z0-9]+)*$` | ✅ `trae-cn-provider` |
| 仓库含可扫描源码 | ✅ 15 个 JS 文件 |
| 安全扫描无阻断级发现 | ⚠️ 见下 |

**关于安全扫描的风险，先说清楚**：它针对 JS/TS 做 AST 分析，找的是硬编码密钥、**数据外传端点**、破坏性操作、挖矿特征。而 dsh.so 页面上标注的扫描技术提供商是 [`dsh-plugin-vet`](https://github.com/wulun811/dsh-plugin-vet)（即 `@jieai/dsh-plugin-vet`），**它本身是可公开获取的**，所以提交前可以先自己用同一把尺子量一遍：

```sh
npx -p @jieai/dsh-plugin-vet vet-gate --package node_modules/trae-cn-provider
```

`0.1.0` 的实测结果：

```
"blocked": false
"verdict": "clean"
32 findings — all severity: info
  R3  x26   只读 process 成员（能力触达面）
  R15 x2    fetch 目标由运行时构造，静态不可审计（启发式）
  R6/R9/R10  各 1
```

即**无 medium/high/critical 发现**。两个值得留意的点仍在，供人工复核时对照：

- **`credentialSource: local` 会解密本机 Trae 的凭据存储**。默认值是 `oauth`（不碰任何解密），但代码路径确实在包里。详见 [SECURITY.md](./SECURITY.md)。
- **`test/` 里的测试语料含有形如 token 的字符串**（都是 `fake-` 前缀的假值）。社区里有先例：扫描器曾把插件的测试语料当成插件的危险行为（[deepseek-harness#2818](https://github.com/deepseek-ai/deepseek-harness/discussions/2818)）。

检查器在**提交之前**就会给出报告，所以先跑检查、看结论，再决定要不要提交。

收录后兼容性只会标记为 **Declared（作者声明）**；L5「运行验证通过」需要 dsh.so 自己针对具体 DSH 版本实测。你也可以按它给的模板到官方 Discussions 发兼容性报告，帮助把条目升到 Verified。

---

发布前检查清单：

- `npm run check` 全绿
- `npm pack` 的产物里包含 `cordis.patch.yml`（否则装上也白装）
- 从 tarball 安装一次并启动确认（见「开发」一节的验证方法）
- 版本号已更新；`private` 不是 `true`
- **补齐包元数据**：`author` / `repository` / `homepage` / `bugs` 目前都是空的。
  这里**故意没有填占位值** —— 编造的仓库地址比留空更糟。发布前请填上你真实的仓库地址（npm 不会为此报警，但它是别人评估「这个包可不可信」时最先看的东西之一；同类项目里就有因为 `repository` 为空而被质疑的例子）。

---

## 本仓库当前的完成度（自查用）

工程部分全部完成并已在真机验证：

| 目标项 | 状态 |
|---|---|
| macOS 本机凭据提取（`tc` 加密 + 明文，4 个 edition） | ✅ 实测解出并调通上游 |
| Trae 上游协议适配（`llm_utils_chat` SSE） | ✅ 正文 / 思考 / 工具调用 / usage / 图片全部实测 |
| OpenAI 兼容 `/v1/models` + `/v1/chat/completions` | ✅ 流式 + 非流式 + 工具 + 图片实测 |
| 打包成 DSH bundle 插件 | ✅ 从 tarball 安装并启动验证 |
| 在本机验证可用 | ✅ 在 DSH **0.1.2-rc.1** 与 **0.2.0-rc.2** 上分别验证 provider 注册与调用 |
| `prepareCall().stream()` 适配 0.2.0-rc.2 的同步解引用 | ✅ `streamPrepared` async generator + 回归测试（0.1.3） |
| 走通发布流程 | ⚠️ `npm pack` 与 `npm publish --dry-run` 均已通过；**实际 `npm publish` 需要账号持有者执行**（DSH 没有官方市场，分发渠道就是 npm） |

因此剩余步骤只有两个，且都**必须由账号持有者本人操作**：

1. `npm login` 后执行 `npm publish --access public`
2. 装进日常使用的 profile：先完全退出 DeepSeek Harness 桌面应用，再执行 `dsh plugin --profile desktop add trae-cn-provider`

## 许可

MIT，见 [LICENSE](./LICENSE)。

再次提醒：使用本项目违反 Trae 使用条款，且可能导致账号被封。请自行判断。
