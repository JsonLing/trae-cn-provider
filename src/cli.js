#!/usr/bin/env node
// cli.js - login / models / serve / chat
import { spawn } from 'node:child_process';
import { detectEnv, loadCredentials, saveCredentials, CRED_FILE } from './env.js';
import { webLogin } from './trae-auth.js';
import { chat } from './trae-client.js';
import { TraeProvider, startServer } from './openai-server.js';

function requireCredentials() {
  const creds = loadCredentials();
  if (!creds) {
    console.error(`未找到凭据 (${CRED_FILE})，请先运行: node src/cli.js login`);
    process.exit(1);
  }
  return creds;
}

async function cmdLogin() {
  const env = detectEnv();
  console.log(`Trae CN 环境: ideVersion=${env.ideVersion} versionCode=${env.ideVersionCode} (${env.source})`);
  console.log('即将在浏览器中打开 Trae 授权页，请在页面上登录你自己的账号。\n');
  const creds = await webLogin({
    ideVersion: env.ideVersion,
    onAuthorizeUrl: (url) => {
      console.log(`授权链接：\n${url}\n`);
      if (process.platform === 'darwin') {
        spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      }
    },
  });
  const file = saveCredentials(creds);
  console.log(`\n登录成功 ✓`);
  console.log(`  userId: ${creds.userId}`);
  if (creds.username) console.log(`  username: ${creds.username}`);
  console.log(`  凭据已写入 ${file} (0600)`);

  const models = await new TraeProvider({ env, credentials: creds }).models();
  console.log(`  可用模型 ${models.length} 个，例如: ${models.slice(0, 5).map((m) => m.configName).join(', ')}`);
}

async function cmdModels() {
  const provider = new TraeProvider({ credentials: requireCredentials() });
  const models = await provider.models({ force: true });
  console.log(`共 ${models.length} 个模型（来源: ${provider.env.source}）\n`);
  console.log('config_name'.padEnd(28) + 'display'.padEnd(26) + 'ctx'.padEnd(10) + '思考');
  for (const m of models) {
    const ctx = (m.maxMode ? m.maxContextWindow : m.contextWindow) || 0;
    console.log(
      m.configName.padEnd(28) +
        String(m.name).slice(0, 24).padEnd(26) +
        String(ctx || '-').padEnd(10) +
        (m.supportThinking ? (m.effortOptions.join('/') || 'yes') : '-'),
    );
  }
}

async function cmdServe() {
  const args = process.argv.slice(3);
  const portArg = args.indexOf('--port');
  const port = Number(portArg >= 0 ? args[portArg + 1] : process.env.PORT || 8317);
  const keyArg = args.indexOf('--api-key');
  const apiKey = keyArg >= 0 ? args[keyArg + 1] : process.env.API_KEY || null;
  const provider = new TraeProvider({ credentials: requireCredentials() });
  const { url } = await startServer(provider, { port, apiKey });
  console.log(`Trae CN → OpenAI 兼容服务已启动: ${url}`);
  console.log(`  Base URL: ${url}/v1`);
  console.log(`  API Key : ${apiKey || '(未设置，仅监听 127.0.0.1)'}`);
  console.log(`  模型目录: http://127.0.0.1:${port}/v1/models`);
  try {
    const models = await provider.models();
    console.log(`  已加载 ${models.length} 个模型`);
  } catch (err) {
    console.error(`  模型目录预拉取失败: ${err.message}`);
  }
  process.on('SIGINT', () => {
    console.log('\n已停止');
    process.exit(0);
  });
}

async function cmdChat() {
  const prompt = process.argv.slice(3).join(' ');
  if (!prompt) {
    console.error('用法: node src/cli.js chat <提示词>');
    process.exit(1);
  }
  const provider = new TraeProvider({ credentials: requireCredentials() });
  await provider.ensureFresh();
  await provider.models();
  const caps = provider.resolveModel('auto');
  const body = {
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    function: caps.function || 'chat_v3',
    stream: true,
    config_name: caps.configName,
    model: caps.modelName || caps.configName,
    model_name: caps.modelName || caps.configName,
    config_source: caps.configSource ?? 1,
    is_custom_model: false,
    provider: caps.provider || '',
  };
  const result = await chat({
    creds: provider.creds,
    env: provider.env,
    body,
    onEvent: (event) => {
      if (event.type === 'text') process.stdout.write(event.text);
      else if (event.type === 'reason') process.stderr.write(event.text);
    },
  });
  process.stdout.write('\n');
  if (result.usage) console.error(`\n[usage] ${JSON.stringify(result.usage)}`);
}

const commands = { login: cmdLogin, models: cmdModels, serve: cmdServe, chat: cmdChat };

const command = process.argv[2];
if (!commands[command]) {
  console.log('用法: node src/cli.js <login|models|serve|chat>');
  process.exit(command ? 1 : 0);
}
commands[command]().catch((err) => {
  console.error(`失败: ${err.message}`);
  process.exit(1);
});
