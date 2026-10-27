#!/usr/bin/env node
// test/smoke-quota.js - tests for the read-only quota snapshot and the
// quota-aware chat failure message.
//
//   node test/smoke-quota.js
import { assert, assertEqual, mockFetch, test } from './support.js';
import { installShims, load } from './support.js';

installShims();

const { summarizeQuota, fetchQuota, formatQuota, tenantOf } = await load('src/quota.js');
const { describeFailure } = await load('src/trae-client.js');

// The shape the live endpoint returns for an exhausted account. Numbers are
// from a real response (4500 granted, 4500 consumed).
const EXHAUSTED = {
  is_credits_billing: true,
  is_dollar_usage_billing: false,
  usage_summary: { consumed_amount: 4500, consumption_ratio: 1, total_amount: 4500 },
  user_entitlement_pack_list: [
    {
      display_desc: '老用户福利',
      group_name: '用户福利',
      quota: { credits_limit: 4000 },
      usage: { credits_amount: 4000 },
      expire_time: 1795057439,
      status: 0,
    },
    { display_desc: '每月登录赠送', quota: { credits_limit: 500 }, expire_time: 1793462399, status: 1 },
  ],
};

console.log('smoke-quota:');

await test('summarizeQuota reads the summary and keeps remaining at zero', async () => {
  const snapshot = summarizeQuota(EXHAUSTED);
  assertEqual(snapshot.total, 4500, 'total');
  assertEqual(snapshot.consumed, 4500, 'consumed');
  assertEqual(snapshot.remaining, 0, 'remaining');
  assertEqual(snapshot.ratio, 1, 'ratio');
  assertEqual(snapshot.billingMode, 'credits', 'billing mode');
  assertEqual(snapshot.packs.length, 2, 'packs');
  assertEqual(snapshot.packs[0].name, '老用户福利', 'pack name');
  assertEqual(snapshot.packs[0].creditsAmount, 4000, 'pack credits');
});

await test('summarizeQuota survives a payload without a summary', async () => {
  const snapshot = summarizeQuota(null);
  assertEqual(snapshot.total, 0, 'total');
  assertEqual(snapshot.remaining, 0, 'remaining');
  assertEqual(snapshot.ratio, 0, 'ratio avoids division by zero');
  assertEqual(snapshot.packs, [], 'no packs');
});

await test('fetchQuota posts the JWT to the read-only endpoint and parses it', async () => {
  const mock = mockFetch((url, init) => {
    assertEqual(url, 'https://api.trae.cn/trae/api/v2/pay/web_user_ent_usage', 'endpoint');
    assertEqual(init.method, 'POST', 'method');
    assertEqual(init.headers.Authorization, 'Cloud-IDE-JWT tok', 'auth header');
    assertEqual(JSON.parse(init.body).require_usage, true, 'request body');
    return EXHAUSTED;
  });
  try {
    const snapshot = await fetchQuota({ token: 'tok' });
    assertEqual(snapshot.remaining, 0, 'remaining');
    assertEqual(snapshot.host, 'https://api.trae.cn', 'host recorded');
  } finally {
    mock.restore();
  }
});

await test('fetchQuota explains a 405 instead of leaking the HTML page', async () => {
  const mock = mockFetch(() => ({ status: 405, body: '<html>405 Not Allowed</html>' }));
  try {
    let caught;
    try {
      await fetchQuota({ token: 'tok' }, { host: 'https://console.enterprise.trae.cn' });
    } catch (err) {
      caught = err;
    }
    assert(caught, 'a 405 throws');
    assert(caught.message.includes('405'), 'status is reported');
    assert(caught.message.includes('api.trae.cn'), 'the host to use is named');
  } finally {
    mock.restore();
  }
});

await test('fetchQuota rejects a nonzero business code', async () => {
  const mock = mockFetch(() => ({ code: 20101, message: 'token invalid' }));
  try {
    let caught;
    try {
      await fetchQuota({ token: 'tok' });
    } catch (err) {
      caught = err;
    }
    assert(caught && caught.message.includes('20101'), 'business code is surfaced');
  } finally {
    mock.restore();
  }
});

await test('formatQuota warns on a zero balance and names the tenant', async () => {
  const text = formatQuota(summarizeQuota(EXHAUSTED), { tenantId: 'tob_online', username: 'u' });
  assert(text.includes('可用: 0'), 'shows the balance');
  assert(text.includes('tob_online'), 'shows the tenant');
  assert(text.includes('企业席位额度'), 'points enterprise users at the seat pool');
  assert(text.includes('不代表'), 'does not claim the tenant is out of quota');
  assert(text.includes('老用户福利'), 'lists the packs');
});

await test('a consumer account with a zero balance is told 4008 is expected', async () => {
  const text = formatQuota(summarizeQuota(EXHAUSTED), {});
  assert(text.includes('4008'), 'explains what 4008 means');
  assert(text.includes('个人积分已用尽'), 'names the personal ledger');
  assert(!text.includes('企业席位额度'), 'no enterprise advice without a tenant');
});

await test('tenantOf decodes the JWT claims without verifying them', async () => {
  const payload = Buffer.from(JSON.stringify({ data: { tenant_id: 'tob_online', user_id: '42' } })).toString('base64url');
  assertEqual(tenantOf(`x.${payload}.y`), { tenantId: 'tob_online', userId: '42' }, 'claims');
  assertEqual(tenantOf('not-a-jwt'), { tenantId: '', userId: '' }, 'malformed token is inert');
});

await test('describeFailure appends the quota snapshot to a 4008', async () => {
  const message = describeFailure({
    code: 4008,
    message: 'Your requests have exceeded the quota.',
    remainUsage: { cn_credits: 0, ide_credits: 0 },
    creditsRemain: { ide_credits: 0, work_credits: 0 },
    billingMode: 'credits',
  });
  assert(message.startsWith('trae 4008: Your requests have exceeded the quota.'), 'keeps the upstream text');
  assert(message.includes('ide_credits=0'), 'includes the credit snapshot');
  assert(message.includes('trae-cn usage'), 'points at the usage command');
});

await test('describeFailure leaves unrelated failures unchanged', async () => {
  const message = describeFailure({ code: -1, message: '上游提前关闭流' });
  assertEqual(message, 'trae -1: 上游提前关闭流', 'no quota suffix');
});
