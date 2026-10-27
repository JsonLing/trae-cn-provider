# Trae CN 模型接入说明（公司内部）

> 由内部网关提供，基于公司 Trae 账号额度。**请勿把 Key 转发给外部人员或粘贴到公开渠道。**

---

## 一、接入信息

| 项 | 值 |
|---|---|
| **Base URL** | `http://10.255.47.198:8317/v1` |
| **API Key** | `sk-weite-40a7651d40d5ef0fdba8976fa028ea82` |
| **协议** | OpenAI Chat Completions 兼容 |
| **默认模型** | `DeepSeek-V4.1-Flash-1017` |
| **网络要求** | 需在公司内网（或已连 VPN） |

⚠️ **注意是 `http://`，不是 `https://`。** 这是内网明文服务，填 `https` 会直接握手失败。

---

## 二、可用模型

共 23 个，常用如下（完整列表见 `/v1/models`）：

| 模型名 | 说明 |
|---|---|
| `DeepSeek-V4.1-Flash-1017` | **推荐**，默认模型 |
| `DeepSeek-V4.1-Flash` | |
| `DeepSeek-V4-Pro-Official` | |
| `glm-5.3` / `glm-5.3-flash` / `glm-5.3-flashx` / `glm-5.2` | 智谱 GLM |
| `kimi-k3` / `kimi-k3.1-pro` / `kimi-k2.8-preview` | |
| `qwen3.8-max` | |
| `Doubao-Seed-2.1-pro` / `Doubao-Seed-2.1-turbo` / `Doubao-Seed-2.0-Code` | 豆包 |
| `minimax-m3` / `minimax-m3.1-flash` / `minimax-m2.7` | |
| `mimo-v2.6-pro` / `mimo-v2.6-flash` | |
| `step-5-preview` | |

---

## 三、快速验证

```bash
curl http://10.255.47.198:8317/v1/chat/completions \
  -H "Authorization: Bearer sk-weite-40a7651d40d5ef0fdba8976fa028ea82" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "DeepSeek-V4.1-Flash-1017",
    "stream": false,
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

正常返回：

```json
{"choices":[{"message":{"role":"assistant","content":"你好！..."}}], "usage":{...}}
```

---

## 四、各语言/工具接法

### Python（openai SDK）

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://10.255.47.198:8317/v1",
    api_key="sk-weite-40a7651d40d5ef0fdba8976fa028ea82",
)

# 不传 stream 即一次性返回（OpenAI 默认行为）
resp = client.chat.completions.create(
    model="DeepSeek-V4.1-Flash-1017",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)

# 需要流式时显式 stream=True
stream = client.chat.completions.create(
    model="DeepSeek-V4.1-Flash-1017",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

> SDK 已实测通过（Python 与 Node 两种官方客户端，2026-10-27）。

> **环境变量方式更安全**（避免 key 写进代码）：
> ```bash
> export OPENAI_BASE_URL="http://10.255.47.198:8317/v1"
> export OPENAI_API_KEY="sk-weite-..."
> ```

### Node.js（openai SDK）

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://10.255.47.198:8317/v1',
  apiKey: 'sk-weite-40a7651d40d5ef0fdba8976fa028ea82',
});

const resp = await client.chat.completions.create({
  model: 'DeepSeek-V4.1-Flash-1017',
  messages: [{ role: 'user', content: '你好' }],
});
console.log(resp.choices[0].message.content);
```

### Cline / Roo Code / 类似 IDE 插件

在「自定义 OpenAI 兼容」里填：

| 字段 | 值 |
|---|---|
| Base URL | `http://10.255.47.198:8317/v1` |
| API Key | `sk-weite-40a7651d40d5ef0fdba8976fa028ea82` |
| Model ID | `DeepSeek-V4.1-Flash-1017` |

### Cherry Studio / ChatBox / 其他客户端

新增一个「OpenAI 兼容」provider：

- API 地址：`http://10.255.47.198:8317/v1`
- 密钥：`sk-weite-...`
- 模型：手动填 `DeepSeek-V4.1-Flash-1017`（或在客户端里点「获取模型列表」）

### LangChain / LlamaIndex 等框架

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    base_url="http://10.255.47.198:8317/v1",
    api_key="sk-weite-...",
    model="DeepSeek-V4.1-Flash-1017",
)
```

---

## 五、已支持的能力

| 能力 | 状态 |
|---|---|
| 流式输出（`stream: true`） | ✅ |
| 非流式 | ✅ |
| Function calling / tools | ✅ |
| 思考链（`reasoning_content`） | ✅ |
| 多轮对话 | ✅ |
| 图片输入（多模态模型） | ✅ 部分模型 |

**usage 字段是真实计费依据**，返回示例：

```json
"usage": {"prompt_tokens": 52, "completion_tokens": 26, "total_tokens": 78}
```

---

## 六、常见问题

### Q: 连不上 / 超时？

```bash
curl -s http://10.255.47.198:8317/v1/models \
  -H "Authorization: Bearer sk-weite-40a7651d40d5ef0fdba8976fa028ea82"
```

- 返回 `401` → key 错误
- 连接超时 → 不在内网，或网关未启动
- `Connection refused` → 网关没跑（找管理员）

### Q: 401 Unauthorized？

三种可能：
1. key 复制时带了空格/换行
2. key 已被停用（找管理员）
3. 用了 `https://` 而不是 `http://`

### Q: 429 Too Many Requests？

当日 token 额度已用尽，次日 00:00 重置。找管理员调整上限。

### Q: 返回 `4008 Your requests have exceeded the quota`？

这是**上游 Trae 账号**的额度问题，不是你的 key 问题。找管理员。

### Q: 模型名报错「未知模型」？

用 `/v1/models` 里的**精确 id**。注意大小写不敏感，但拼写要正确。

### Q: 能传图片吗？

可以，用 OpenAI 标准的 `image_url` 形式，且需选支持视觉的模型（如 `Doubao-Seed-Evolving`）。

---

## 七、使用须知

1. **额度是共享的**，请避免不必要的重复调用、长文本刷量。
2. **对话内容会经过网关**，但**不会落盘**（只记录 token 数、耗时、状态）。
3. **key 代表你的身份**，用量会记在你名下。请不要多人共用一个 key。
4. **服务在公司内网**，离开内网无法使用。
5. 如遇异常，把**请求时间**和**返回的错误信息**发给管理员，便于定位。
