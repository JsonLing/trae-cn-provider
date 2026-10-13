// test/probe-catalog.mjs - verification-only probe, never shipped.
//
// Injected through `dsh --profile web --patch test/probe-patch.yml` so the
// question "is `trae-cn` actually registered in the live llm service?" is
// answered from *inside* the running host instead of inferred from the fact
// that `apply()` returned. It writes /tmp/trae-probe-result.json and logs, then
// does nothing else.
import fs from 'node:fs';

const OUT = '/tmp/trae-probe-result.json';

const name = 'trae-probe';
const inject = ['llm'];

function apply(ctx) {
  const write = (payload) => {
    try {
      fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
    } catch (err) {
      console.log(`[trae-probe] write failed: ${err.message}`);
    }
  };

  setTimeout(async () => {
    const result = { at: new Date().toISOString() };
    try {
      result.providers = ctx.llm.listProviders();
      result.routes = (ctx.llm.listConfigurableProviders?.() ?? []).map((p) => p.provider);
      const models = await ctx.llm.listModels('trae-cn');
      result.traeModels = models.map((m) => m.id);
      if (models[0]) {
        const resolved = await ctx.llm.resolveModelInfo('trae-cn', models[0].id);
        result.resolvedFirst = {
          id: resolved.id,
          name: resolved.name,
          contextWindow: resolved.context?.contextWindow,
          efforts: resolved.reasoning?.efforts?.map((e) => e.id) ?? null,
        };
      }
      console.log(`[trae-probe] providers=${JSON.stringify(result.providers)}`);
      console.log(`[trae-probe] routes=${JSON.stringify(result.routes)}`);
      console.log(`[trae-probe] trae-cn models (${result.traeModels.length})=${JSON.stringify(result.traeModels)}`);
      console.log(`[trae-probe] resolved first=${JSON.stringify(result.resolvedFirst)}`);
    } catch (err) {
      result.error = String(err?.message ?? err);
      console.log(`[trae-probe] ERROR ${result.error}`);
    }
    write(result);
  }, 5000);
}

export { name, inject, apply };
