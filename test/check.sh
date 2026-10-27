#!/usr/bin/env bash
# Static + smoke checks for trae-cn-provider.
#
# Runs without network access: every upstream call in the smoke suites is
# intercepted by a stub fetch. `npm run check` is this script.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== syntax =="
for f in lib/*.js src/*.js test/*.js; do
  node --check "$f"
done
echo "  ok: $(ls lib/*.js src/*.js test/*.js | wc -l | tr -d ' ') files"

echo "== cordis.patch.yml =="
if python3 -c "import yaml" 2>/dev/null; then
  python3 - <<'PY'
import sys, yaml
docs = yaml.safe_load(open('cordis.patch.yml'))
assert isinstance(docs, list), 'patch file must be a top-level YAML array'
rows = [r for d in docs for r in (d.get('insert') or [])]
assert rows, 'patch file declares no insert row'
row = rows[0]
assert row.get('id') and row.get('name'), 'insert row needs id + name'
print(f"  ok: insert row id={row['id']} name={row['name']}")
PY
else
  grep -q 'insert:' cordis.patch.yml
  echo "  ok (structural check only: PyYAML unavailable)"
fi

echo "== package.json manifest =="
node - <<'PY'
const fs = require('node:fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const patch = pkg?.dsh?.bundle?.patch;
if (!patch) throw new Error('package.json declares no dsh.bundle.patch');
if (!fs.existsSync(patch)) throw new Error(`dsh.bundle.patch points at a missing file: ${patch}`);
if (!(pkg.files ?? []).includes('cordis.patch.yml')) throw new Error('files[] must ship cordis.patch.yml');
for (const rel of pkg.files ?? []) {
  if (!fs.existsSync(rel)) throw new Error(`files[] lists a missing path: ${rel}`);
}
console.log(`  ok: patch=${patch}, ${pkg.files.length} declared files all exist`);
PY

echo "== Config is a Standard Schema =="
# cordis validates every plugin config through `Config['~standard'].validate`.
# A plain defaults object made that throw, and the failure is NOT a no-op: it
# aborts the whole profile boot. Checked here instead of discovering it at
# install time.
node -e "
import('./lib/index.js').then((m) => {
  const resolveConfig = (runtime, config) => {
    if (!runtime.Config) return config;
    const result = runtime.Config['~standard'].validate(config);
    if ('then' in result) throw new TypeError('async config validation is not supported');
    if (result.issues) throw new Error('ValidationError: ' + JSON.stringify(result.issues));
    return result.value;
  };
  const merged = resolveConfig(m, {});
  if (merged.requestStyle !== 'chat_v3') throw new Error('default requestStyle is not chat_v3');
  if (merged.credentialSource !== 'oauth') throw new Error('default credentialSource is not oauth');
  const override = resolveConfig(m, { credentialSource: 'local', edition: 'sg' });
  if (override.credentialSource !== 'local' || override.edition !== 'sg') {
    throw new Error('user config did not override the defaults');
  }
  console.log('  ok: defaults merged, overrides honoured');
}).catch((err) => { console.error('  FAIL: ' + err.message); process.exit(1); });
"

echo "== smoke: adapter =="
node test/smoke-adapter.js | tail -1
echo "== smoke: client =="
node test/smoke-client.js | tail -1
echo "== smoke: plugin entry =="
node test/smoke-plugin.js | tail -1
echo "== smoke: login command =="
node test/smoke-login.js | tail -1
echo "== smoke: quota =="
node test/smoke-quota.js | tail -1
echo "== smoke: gateway (keys, caps, usage ledger, admin) =="
node test/smoke-gateway.js | tail -1

echo
echo "all checks passed"
