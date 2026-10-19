# Trae CN 上游协议（逆向记录）

来源：`https://github.com/sdn205/Trae-Relay`（开源参考实现，仓库无 LICENSE ⇒ **只读作协议事实，不复用其代码**）
本机版本：Trae CN `2.3.90452`，`nameShort = "Trae CN"`，`applicationName = trae-cn`，`dataFolderName = .trae-cn`

---

## 1. 上游主机

| 用途 | 地址 |
|---|---|
| 聊天 / 模型目录（CN） | `https://trae-api-cn.mchost.guru` |
| OAuth / 用户信息 | `https://api.trae.cn` |
| 网页登录授权页 | `https://www.trae.cn/authorization` |
| 国际版（参考） | `a0ai-api-sg.byteintlapi.com` |

## 2. 请求头（IDE 头组）

```
Content-Type: application/json
Authorization: Cloud-IDE-JWT <accessToken>
X-Cloudide-Token: <accessToken>
X-Ide-Token: <accessToken>
X-Uid: <userId>          (同时给小写 x-uid)
x-app-id: 6eefa01c-1036-4c7e-9ca5-d891f63bfcd8
x-app-version: default
x-app-version-code: <ideVersionCode>
x-device-id / x-machine-id: <设备标识>
x-request-id: <uuid>
x-ide-version / x-ide-version-code: <当前 IDE 版本>
x-ide-version-type: stable
x-device-cpu / x-device-brand / x-device-type / x-os-version / x-system-type
Accept: text/event-stream | application/json
```

> 注意：`x-ide-version-code` 用旧固定值会让模型接口返回旧目录，应读本机实际构建号。

## 3. 聊天通道（主通道）

```
POST https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat
Accept: text/event-stream   (SSE)
```

请求体：

```jsonc
{
  "messages": [ { "role": "user|system|assistant|tool",
                  "content": [ {"type":"text","text":"..."},
                               {"type":"image_url","image_url":{"url":"..."}} ],
                  "tool_calls": [ {"id":"call_x","type":"function",
                                   "function_call":{"name":"...","arguments":"JSON字符串"}} ],
                  "tool_call_id": "...", "name": "..." } ],
  "function": "chat_v3",          // 或 solo_agent
  "stream": true,
  "config_name": "<config_name>",
  "model": "<model_name>",
  "model_name": "<model_name>",
  "config_source": 1,
  "is_custom_model": false,
  "provider": "<provider>",
  "reasoning_effort": "low|high|extra_high",   // 可选，顶层
  "tools": [ {"type":"function","function":{"name","description","parameters":"JSON字符串"}} ],
  "tool_choice": "auto"
}
```

要点：
- `tools[].function.parameters` 上游要求 **JSON 字符串**（OpenAI 是对象）。
- 工具结果走原生 `role:"tool"` + `tool_call_id`。
- 历史文本里的 `opencode_tool_call` 等标签要改写成中性标签，否则上游会中断输出。

SSE 事件（`event:` 名 + `data:` JSON）：

| event | 语义 |
|---|---|
| `output` / `message` / `text` | 增量正文：`content` 与 `response` **都是增量**（不是累计快照，不能去重） |
| 同上 | 增量思考：`reasoning` / `reasoning_content` |
| 同上 | 工具调用增量：`tool_calls[]`，键名是 `function_call`（兼容 OpenAI 的 `function`）；`partial_arguments` 是本帧增量，`arguments` 可能是增量片段也可能是累计快照（以已累积内容为前缀则覆盖） |
| `token_usage` / `notify_usage` / `usage` | 平铺字段 `prompt_tokens` / `completion_tokens` / `total_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` / `reasoning_tokens` |
| `done` | `finish_reason`；工具调用需在此前按 index 累积完整后下发 |
| `error` | `{code, message}` |
| `[DONE]` | 流结束 |
| `request_wait_in_queue` / `queue_begin` / `queue_end` | 排队状态 |
| `progress_notice` / `metadata` / `extra_info` / `timing_cost` | 忽略 |

## 4. 模型目录

```
POST https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param
```

```json
{"function":"chat_v3","config_names":null,"need_prompt":false,
 "current_config_info":null,"poly_prompt":true,"mode_type":null,"agent_type":null}
```

再拉一次 `{"function":"solo_agent", ...}`。解析 `data.config_info_list[]`：
- 每个 `config_info_list[i]` 是一个 `config_name`；`is_invisible_to_user` / `config_switch=false` 的过滤掉
- `model_detail_list[]` 里每个条目给 `model_name`、`reasoning_effort_config`、`context_window_size`、`max_mode`、`raw_chat_function`
- `config_source == 1` 是 IDE 主目录；`__max` 后缀的 `model_name` 是 Max/1M 上下文档案（配合 `mode_type:1` + `context_window_size`）

## 5. 鉴权

### 5a. 网页登录（OAuth + PKCE，推荐）
1. 生成 EC P-256 设备密钥对，构造 `DeviceInfo{DeviceID, MachineID, PlatformCode:"IDE_PC", DeviceType:"PC", DevicePublicKey: PEM, ClientVersion, ...}`
2. PKCE：`verifier = base64url(48B随机)`，`challenge = base64url(sha256(verifier))`
3. 本地起 HTTP 服务 `127.0.0.1:<随机端口>`，回调路径 `/authorize`
4. 浏览器打开 `https://www.trae.cn/authorization?...`，参数含：
   `client_id=ono9krqynydwx5`、`login_channel=native_ide`、`auth_type=local`、`auth_callback_url=http://127.0.0.1:<port>/authorize`、
   `code_challenge`/`code_challenge_method=S256`、`machine_id`、`device_id`、`x_app_version`、`x_app_type=stable`、`login_trace_id`
5. 回调 query 里的 `authCodeInfo` 是 URL 编码 JSON，取 `AuthCode`
6. 换 token：`POST https://api.trae.cn/trae/api/v3/oauth/ExchangeToken`
   `{ClientID, AuthCode, CodeVerifier, DeviceInfo, IDEVersion}` → `Result{Token, RefreshToken, TokenExpireAt}`
7. 取用户：`POST https://api.trae.cn/cloudide/api/v3/trae/GetUserInfo`
   body `{ReqSource:"IDE", IDEVersion}` + `x-cloudide-token: <token>` → `UserID` / `Username`

### 5b. 刷新（网页登录账号）
```
POST https://api.trae.cn/trae/api/v3/oauth/ExchangeToken
{ClientID, ClientSecret:"", RefreshToken, DeviceInfo, DeviceProof, IDEVersion}
```
`DeviceProof = {Signature, Timestamp, Nonce}`，签名内容：
```
"POST\n" + "/trae/api/v3/oauth/ExchangeToken" + "\n" + clientId + "\n" + refreshToken + "\n" + timestamp + "\n" + nonce
```
ECDSA-P256/SHA-256，Signature = base64(DER)。Node 可直接用 `crypto.sign(..., {dsaEncoding:'der'})`。

### 5c. 刷新（本机目录凭据）
```
POST https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken
{ClientID, RefreshToken, ClientSecret:"-", UserID}
```

## 6. 本机凭据存储（macOS）

`~/Library/Application Support/Trae CN/User/globalStorage/storage.json`：

| key | 说明 |
|---|---|
| `iCubeAuthInfo://icube.cloudide` | 主凭据容器（base64） |
| `iCubeAuthInfo://usertag` | 用户标识 |
| `iCubeAuthInfo://icube-dc:<uid>` | 分域凭据 |
| `iCubeServerData://icube.cloudide` | 含 `saasEntitlementInfo`（额度） |
| `iCubeHostInfo` | `apiHost` / `consoleHost` |

解码 `iCubeAuthInfo://icube.cloudide` 后：前 6 字节 `74 63 05 10 00 00`（`"tc"` + `05 10 00 00`），
其余长度**均为 32 的整数倍** ⇒ 疑似 `IV(16) + AES-CBC 密文`。

**已排除的组合**（均未解出）：Chromium OSCrypt（`saltysalt`/1003/PBKS2-SHA1、
Keychain 条目 `Trae CN Safe Storage` 与 `Trae Safe Storage` 的密码，两者均为 24 字节可打印 ASCII）、
`md5("Trae CN")` 十六进制字符串当 AES-256-CBC 密钥、header 偏移 {0,2,6,22}、IV ∈ {前16字节, 16空格, 全0}。

> 结论：macOS 侧 `tc` 的解密密钥尚未定位。已转向 5a 网页登录路线绕开该问题。

## 7. 本机安全观察（未利用）

Trae CN 的 IDE 进程在 `127.0.0.1:51000` 暴露 **gRPC over h2c**，且在传输层**无鉴权**
（`Content-Type: application/grpc` 直接 200，bogus 调用也受理）。结合 `libai_agent.dylib`
里的符号 `icube.common.commands.tooling.runCommandInTerminal`、`readBinaryFile`、`writeBinaryFile`
等，该端口是 IDE 提供给 ai-agent 的本地命令执行 / 文件读写 RPC。
仅作记录，未做任何调用尝试。

---

# 附：实测修正与打通记录（本机真机验证）

以上 §1–§7 来自参考实现源码。以下是**用真实凭据实测后必须修正/补充**的部分。

## A. 请求头：version code 必须是纯数字，且按数值大小灰度

```
x-app-version-code: 20260901      # 必须整数
x-ide-version-code: 20260901      # 必须整数
x-ide-version: 3.4.1              # product.json 的 appVersion
```

- 传 `product.json` 的 `tronBuildVersion`（`"2.3.90452"`，带点）→ 400：
  `{"code":4001,"message":"bad request: binding: expr_path=app_version_code, cause=parameter type does not match binding data"}`
- **该值同时决定网关加载哪套 function 配置**：`20250101` / `20250325` → `no function config found for appId=..., function=inline_chat`。
- **网关按数值的单调大小做灰度**（实测同一账号、同一凭据，只改这一个头）：

  | 取值 | `config_info_list` 条目 | 过滤后可聊天模型 |
  |---|---|---|
  | `20260401` | 42 | 7 |
  | `20260701` | 46 | — |
  | `20260901` | **57** | **20** |
  | `23090452` | 57（平台期） | 20 |

  即 **`>= 20260901` 解锁完整目录**，再往上不再增长。
- 目录响应的 `config_info_list` 在**顶层**（没有 `data` 包裹）；`trae-client.js` 两种形态都兼容，写探针时必须同样兼容，否则会把 42/57 条误读成 0 条。
- Trae 自己的 `main.js` 里 **没有** `app-version-code` 字样（0 处命中），最接近的是 `productService.traeVersionCode`（本机 `20250325`，但已偏旧）。故取「本机值若不比基准旧则用本机值，否则用基准」。
- **第二个独立维度：`DeviceName`。** 留成 `TraeProxy` 会被上游识别为非真客户端，只回 2 条 `fast_apply` trial 兜底目录。真客户端填的是本机短主机名，必须对齐（见 `src/trae-auth.js` 的 `createDevice`）。

## B. 聊天请求体：正确的字段组合（已实测通过）

`function` 必须是 **`chat_v3`**，且 `model` / `model_name` 用目录里 `model_detail_list[].model_name`（**带 `__dev` 后缀**）：

```json
{
  "messages": [{"role":"user","content":[{"type":"text","text":"..."}]}],
  "function": "chat_v3",
  "stream": true,
  "config_name": "glm-5.2",
  "model": "glm-5.2__dev",
  "model_name": "glm-5.2__dev",
  "config_source": 1,
  "is_custom_model": false,
  "provider": ""
}
```

失败组合（实测）：
- `function:"inline_chat"` + `model` → 会被路由到真实模型但供应商报
  `Invalid combination of reasoning_effort and thinking type: high + disabled`；补 `enable_thinking` / `thinking:{type:enabled}` / `thinking_type` / 注入 `model_extra_config` / `encrypted_model_params` **都无效**（说明该 function 的 thinking 由网关固定，不接受请求体控制）。
- `function:"chat_v3"` 但缺 `config_name`/`config_source` → `We're sorry, the param is invalid.`
- `function:"chat_v3"` + `config_name` 但 `model` 用 config_name（不带 `__dev`）→ 未验证通过。

## C. 模型目录解析：三个字段位置与参考实现不同

1. **上下文窗口在 `context_window_tokens`**（形如 `{"dev": 256000}`），不是 `context_window_size`。
2. **显示名 / 多模态 / max_mode 嵌在 `display_config` 下**：`display_config.display_name`、`.multimodal`、`.max_mode`、`.is_custom_model`。
3. **`usage` 字段区分用途** —— 这是过滤内部模型最可靠的依据：
   - 用户可选模型：`usage = "chat_completion"`
   - 内部节点：`"summary"` / `"fast_apply"` / `"fast_apply_new"` / `"title_generation"` / `"input_optimization"`
   - 自定义连接：`"custom_model"`
   再叠加名称前缀过滤 `custom_` / `search_agent` / `browser_use` / `computer_use` / `file_search` / `explore_` 和 `-auto` 后缀。
4. **`reasoning_effort_config` 在 `config_info` 层（不是 `model_detail_list`），且只有部分模型有**。实测 `Doubao-Seed-Code` 的档位是 **`light` / `high`**（不是 `low`/`high`）。
5. 每个 config 的 `model_detail_list` 只有 1 条，字段很少：
   `model_name / prompt_max_tokens / max_tokens / max_turn / tool_call_history_max_tokens / encrypted_model_params / model_extra_config / icon / model_entitlement_usage_cost`。

过滤后本机可用模型（**20 个**，需 `appVersionCode >= 20260901`）：

| config_name | 显示名 | 档位 |
|---|---|---|
| `Doubao-Seed-Evolving` | Seed-Evolving | yes |
| `Doubao-Seed-2.1-Pro` | Seed-2.1-Pro-0915 | light/high |
| `Doubao-Seed-2.1-Turbo` | Seed-2.1-Turbo | light/high |
| `Doubao-Seed-Code` | Seed-Code | light/high |
| `mimo-v2.6-flash` | MiMo-V2.6-Flash | yes |
| `mimo-v2.6-pro` | MiMo-V2.6-Pro | yes |
| `step-5-preview` | Step-5-Preview | light/high |
| `glm-5.3-flashx` | GLM-5.3-FlashX | light/high/extra_high |
| `glm-5.3-flash` | GLM-5.3-Flash | light/high/extra_high |
| `glm-5.3` | GLM-5.3 | light/high/extra_high |
| `glm-5.2` | GLM-5.2 | high/extra_high |
| `deepseek-v4.1-flash` | DeepSeek-V4-Flash 正式版 | light/high/extra_high |
| `DeepSeek-V4-Flash-Official` | DeepSeek-V4-Flash | light/high/extra_high |
| `DeepSeek-V4-Pro-Official` | DeepSeek-V4-Pro | light/high/extra_high |
| `kimi-k3` | Kimi-K3 | light/high/extra_high |
| `kimi-k2.8-preview` | Kimi-K2.8-Preview | light/high/extra_high |
| `minimax-m3` | MiniMax-M3 | - |
| `qwen3.8-flash` | Qwen3.8-Flash | light/high/extra_high |
| `qwen3.8-max` | Qwen3.8-Max | light/high/extra_high |
| `qwen-3.7-plus` | Qwen3.7-Plus | - |

全量 57 条里的其余条目是 `custom_model_*` 占位、内部工具模型（`summary` / `fast_apply` / `title_generation` / `input_optimization`）与 `is_invisible_to_user` 的旧条目 —— **放宽过滤不会得到可用聊天模型**。

## D. 网页登录回调的真实形态（**与参考实现的 authCodeInfo 完全不同**）

`https://www.trae.cn/authorization` 会在回调上**直接下发凭据**，不是授权码：

| 参数 | 内容 |
|---|---|
| `userJwt` | **URL 编码的 JSON**：`{Token, RefreshToken, TokenExpireAt, RefreshExpireAt, TokenExpireDuration}` |
| `userInfo` | URL 编码的 JSON：`{UserInfo:{UserID, Name, Account, Email, TenantID, Region, ...}, RoleInfo, TenantInfoBase, ...}` |
| `refreshToken` / `data` | 同一个 refresh token 字符串 |
| `refreshExpireAt` | 毫秒时间戳 |
| `scope` / `host` / `consoleHost` / `coreHost` / `isRedirect` / `loginTraceID` | 元信息 |

因此**无需走 `/trae/api/v3/oauth/ExchangeToken` 换码**。可用简化刷新流程（免设备签名）：

```
POST https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken
{ "ClientID":"ono9krqynydwx5", "RefreshToken":"...", "ClientSecret":"-", "UserID":"..." }
```

## E. 验证结论（全部实测通过）

| 能力 | 结果 |
|---|---|
| 模型目录 `get_detail_param` | 200，57 条 config → 过滤后 20 个用户模型 |
| 流式对话 `llm_utils_chat` | 正文 + `reasoning_content` 增量正常 |
| `token_usage` | 平铺字段正常，**`cached_tokens` 生效**（实测 128） |
| 原生 function calling | 返回完整 `tool_calls`：`get_weather {"city":"北京"}` |
| OpenAI 兼容层 | `/v1/models`、`/v1/chat/completions`（流式 + 非流式）均正常 |

---

# 附二：本机凭据提取（`tc` 加密）—— 已解决

§6 曾记录「macOS 侧 `tc` 的解密密钥尚未定位」。**该结论已作废**，实际解法如下（已在本机对 `Trae CN` 与 `Trae`(SG) 两套真实数据上验证通过）。

## 关键认知：不存在外部密钥

`tc` 的密钥材料**完全来自密文自身**，因此：

- 不需要 macOS Keychain（`Trae CN Safe Storage` / `Trae Safe Storage` 与本格式**无关**）
- 不需要 DPAPI / CNG（那是 Windows 侧的误导线索）
- **安全含义**：任何能读到 `storage.json` 的进程都能解出 Trae token，Keychain 不提供任何保护。这是 Trae 自身格式的属性。

这也解释了我早先的失败：我一直在猜「外部密钥」，而正确答案是密钥从密文里的 32 字节派生。

## 格式

```
base64 解码后：
[ 0 : 6 )   6 字节类型标签
[ 6 : 38)  32 字节随机数 random
[ 38 :  )   N 字节 AES-128-CBC 密文（PKCS#7，N 必为 16 的倍数）
```

| 标签 (hex) | 含义 | salt |
|---|---|---|
| `74 63 05 10 00 00` (`"tc"`) | AES | `SALT_A ^ SALT_B` |
| `12 39 20 20 02 03` | AES_PRIVATE（未取得常量，暂不支持） | `SALT_C ^ SALT_D` |

标签的 `05` / `10 00 00` 语义**未知**，代码只把它当一个不透明整体比较。

## 密钥派生

```
salt = SALT_A XOR SALT_B
h1   = SHA512(random)                 # random = 密文 [6:38]
h2   = SHA512(h1 ‖ salt)
key  = h2[0:16]        iv = h2[16:32]
plain = AES-128-CBC-Decrypt(key, iv, ciphertext[38:])
assert plain[0:64] == SHA512(plain[64:])      # 完整性校验（非 AEAD，无 auth tag）
json  = UTF-8(plain[64:])
```

`salt` = `4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58`

**溯源**：`SALT_A` = AES 逆 S-box 的 `[0:64]`，`SALT_B` = 逆 S-box 的 `[192:256]`。
本实现由程序生成逆 S-box 再异或得到 salt，**与上述常量逐字节一致**（自证通过），未硬编码常量。

## 解密后的明文 JSON

CN（8 键）：`token`, `refreshToken`, `expiredAt`, `refreshExpiredAt`, `tokenReleaseAt`, `userId`, `userRegion`, `account`
SG（9 键）：同上 **外加 `host`**（SG 实测 `https://api-sg-central.trae.ai`）

- `token`：access token（JWT，本机实测 1124 字符）
- `machineId` **不在**这个 blob 里，而在同一 `storage.json` 的 **`telemetry.machineId`**
- CN 的 `userRegion` 只有 `_aiRegion`（没有 `region`）

## 四种 edition 的用户数据目录

| edition | macOS | Windows | 格式 | 上游 |
|---|---|---|---|---|
| `cn` | `~/Library/Application Support/Trae CN/User` | `%APPDATA%\Trae CN\User` | tc | `trae-api-cn.mchost.guru` |
| `solo` | `~/Library/Application Support/TRAE SOLO CN/User` | `%APPDATA%\TRAE SOLO CN\User` | tc | `trae-api-cn.mchost.guru` |
| `sg` | `~/Library/Application Support/Trae/User` | `%APPDATA%\Trae\User` | 明文 | `a0ai-api-sg.byteintlapi.com` |
| `solo-sg` | `~/Library/Application Support/TRAE SOLO/User` | `%APPDATA%\TRAE SOLO\User` | tc | `a0ai-api-sg.byteintlapi.com` |

`storage.json` 路径 = `<userDir>/globalStorage/storage.json`，凭据键 = `iCubeAuthInfo://icube.cloudide`。
格式**运行时嗅探**：值以 `{` 开头即明文 JSON，否则按 tc 解。

## 本机实测结果

| edition | 格式 | userId | token 长度 | 过期 |
|---|---|---|---|---|
| `cn` | tc | 429404416 | 1124 | 2026-10-26 |
| `sg` | 明文 | 7529754484382434312 | 1008 | 2026-02-23 |

**端到端验证**：用 `cn` 解出的凭据调用上游 → 模型目录 20 个、对话返回正文与 usage ✅

实现见 `src/trae-local-credentials.js`，可用 `readLocalCredentials(edition)` / `readAnyLocalCredentials()` / `discoverEditions()`。

---

# 附三：Token 刷新的两个坑（企业版账号）

§5 与参考实现都写「刷新打到 `https://api.trae.cn`」。**对 SaaS/企业版账号这是错的**，会得到：

```json
{"code":20101,"message":"Token 无效：refresh token is invalid."}
```

## 坑 1：刷新主机必须用账号自己的 host

企业版账号的刷新主机在凭据里就有：

- **网页登录**：回调参数 `host` / `consoleHost` / `coreHost`（实测 `https://console.enterprise.trae.cn`）
- **本机凭据**：解密后的 `account.saasBootConfig.apiHost`（实测同值）；明文版（SG）另有顶层 `host` 字段

正确组合（实测成功）：

```
POST https://console.enterprise.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken
{ "ClientID":"ono9krqynydwx5", "RefreshToken":"...", "ClientSecret":"-", "UserID":"429404416" }
```

主机优先级：`account.saasBootConfig.apiHost` > `account.saasBootConfig.consoleHost` > `auth.host`（SG 明文）> 平台默认。

**注意 `UserID` 必须是字符串**（传数字会被拒）：
```json
{"code":"InvalidRequest","message":".(1)req.(4)UserID: invalid request value, expected string, actual value: 429404416 (json.Number)"}
```

## 坑 2：企业版网关用 `{code, message, Data}` 信封

同一路径下存在两种响应信封，必须都兼容：

| 信封 | 形状 | 出现场景 |
|---|---|---|
| 旧版 | `{ResponseMetadata:{Error}, Result:{...}}` | `api.trae.cn` |
| 企业版 | `{code, message, Data:{...}, count}` | `console.enterprise.trae.cn` |

企业版成功响应实测：
```
Data.Token = <1124 字符>
Data.RefreshToken = <61 字符>
Data.TokenExpireAt / Data.RefreshExpireAt  = 毫秒时间戳
Data.TokenExpireDuration = 1209600000   (14 天)
```

错误判定要同时看 `ResponseMetadata.Error`（旧）和 `code !== 0`（新）。

## 验证结果

| 来源 | 刷新 | 刷新所得 token 调上游 |
|---|---|---|
| 网页登录 OAuth | ✓ | ✓ 模型目录 20 个 |
| 本机凭据（tc 解密） | ✓ | ✓ 模型目录 20 个 |

refresh token **不是一次性**的：重复刷新返回同一枚新 refreshToken。
刷新后必须把新的 `Token` / `RefreshToken` / 过期时间**持久化回写**，否则会一直用旧值。

## 附带的其它实测结论

- `product.json` 的 `iCubeApp.authConfig` 给出了各渠道 client_id：
  `TRAE.stable = ono9krqynydwx5`（与我们用的一致）、`beta/alpha/dev/local` 各有一枚；另有 `SOLO.*` 系列。
- `iCubeAuthInfo://icube-dc:<uid>` 解出来是 **`{privateKeyPEM, publicKeyPEM}`** ——
  **Trae 自己的 EC 设备密钥对**（私钥导出的公钥与存储公钥一致，已校验）。
  本机凭据的刷新实测**不需要**设备签名；该密钥对推测用于其它需要 DeviceProof 的接口。
- 本机凭据的 refreshToken 形态为 `<base64>.` + 16 位 hex 后缀（共 61 字符）。
