// Mounts every row of the shipped video preset against the installed DSH packages and
// the services those rows inject. A row that fails to construct (missing required
// config, unresolved module, missing service) fails here instead of at startup.
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const installed = process.argv[2] || process.env.DSH_INSTALL_DIR;
const profile = process.env.DSH_PROFILE_DIR;
const packageDir = process.argv[3] || process.cwd();
const dsh = createRequire(path.join(installed, 'package.json'));
const { Context } = dsh('@deepseek-ai/cordis');
const include = dsh('@deepseek-ai/cordis-plugin-include');
const yaml = createRequire(dsh.resolve('@deepseek-ai/cordis-plugin-include'))('js-yaml');

function stub(name) {
  const target = function () { return stub(name); };
  return new Proxy(target, {
    get: (_t, prop) => {
      // Symbols drive promise/primitive protocol checks; a stub must not answer them.
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return stub(name);
    },
    apply: () => stub(name),
  });
}

// Services the standard rows look up. Stubbing them lets each plugin construct so its
// own config validation runs; production mounts the real ones.
const SERVICE_STUBS = {
  tools: { register() {}, guard() {}, restrict() {}, setExecutor() {}, get() {}, schemas() { return []; }, definitions() { return []; } },
  systemPrompt: {
    section() {}, tools() {}, context() {}, variable() {},
    getContextOrder() { return 0; }, getSectionOrder() { return 0; },
  },
  agents: { list() { return []; }, get() { return undefined; }, on() {} },
  sessions: { list() { return []; }, get() { return undefined; }, registerMessageProjection() {} },
  sessionProjections: { register: async () => ({ stateOf: () => undefined }) },
  fs: stub('fs'),
  shell: { sandboxMode: 'danger-full-access' },
  shellEnv: { resolve: async () => ({}) },
  subprocess: stub('subprocess'),
  jobs: stub('jobs'),
  web: stub('web'),
  skills: { list() { return []; }, register() {} },
  commands: { register() {} },
  goals: stub('goals'),
  subagents: stub('subagents'),
  workflowEngine: stub('workflowEngine'),
  userQuestions: { ask: async () => ({ answers: [] }) },
  workingDirectory: { get() { return process.cwd(); }, ensure: async () => process.cwd() },
  attachments: stub('attachments'),
  pluginManager: stub('pluginManager'),
  sandboxPolicy: stub('sandboxPolicy'),
  profileContext: stub('profileContext'),
  logger: stub('logger'),
};

async function main() {
  const patchFile = path.join(packageDir, 'cordis.patch.yml');
  const rows = include.applyEntryPatches([], yaml.load(fs.readFileSync(patchFile, 'utf8'), { schema: include.entryListSchema }));
  const preset = rows.find(row => row.config?.id === 'control-your-video');
  if (!preset) throw new Error('video preset row not found');

  const failures = [];
  const skipped = [];
  let checked = 0;
  const pending = new Set();
  // `!!js` expressions run against the row's loader context. Only `baseUrl`, `process`
  // and `ctx.get(<service>)` appear in this patch; service lookups answer from the same
  // stubs the rows are mounted with, so a conditional row behaves as it would in a
  // profile that provides those services.
  const ROW_CTX = { get: name => SERVICE_STUBS[name] };
  const evaluate = (value) => {
    if (Array.isArray(value)) return value.map(evaluate);
    if (value && typeof value === 'object' && typeof value.__jsExpr === 'string') {
      // The Loader evaluates `!!js` against the row's own context; these expressions
      // only need `baseUrl`, `process` and `ctx.get`, so evaluate them here.
      // eslint-disable-next-line no-new-func
      const fn = new Function('baseUrl', 'process', 'ctx', 'return (' + value.__jsExpr + ')');
      return fn(packageDir, process, ROW_CTX);
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, evaluate(v)]));
    }
    return value;
  };
  const flatten = (plugins) => plugins.flatMap(row => row.group && Array.isArray(row.config) ? flatten(row.config) : [row]);
  for (const row of flatten(preset.config.plugins)) {
    const ctx = new Context();
    for (const [name, value] of Object.entries(SERVICE_STUBS)) {
      try { ctx.provide(name, value); } catch {}
    }
    try {
      // A disabled row is skipped by the real Loader before it is constructed, so its
      // module and config are never exercised there. Evaluating the expression first keeps
      // this harness from mounting rows production would skip (for example `tool-bash`
      // on Windows) and reports an expression that throws.
      let disabled;
      try {
        disabled = evaluate(row.disabled);
      } catch (error) {
        throw new Error(`disabled expression failed to evaluate: ${error.message}`);
      }
      if (disabled === true) {
        skipped.push(row.id);
        continue;
      }
      let plugin;
      if (row.name.startsWith('dsh-plugin-control-your-video')) {
        const spec = createRequire(path.join(packageDir, 'package.json')).resolve(row.name);
        const loaded = await import(pathToFileURL(spec).href);
        plugin = loaded.apply ? loaded : loaded.default;
      } else {
        // `skill-filesystem` resolves the video package by name from its own row's
        // loader base URL, which this harness cannot reproduce. Its own module and
        // export are checked instead; the CLI smoke test covers the real resolution.
        const loaded = dsh(row.name);
        if (!loaded.apply && !loaded.default) throw new Error('module exports no plugin');
        plugin = loaded.apply ? loaded : loaded.default;
        if (row.name === '@deepseek-ai/dsh-skill-filesystem') {
          dsh.resolve('@deepseek-ai/dsh-agent-preset/package.json');
          createRequire(path.join(packageDir, 'package.json')).resolve('dsh-plugin-control-your-video/package.json');
          checked += 1;
          continue;
        }
      }
      await ctx.plugin(plugin, evaluate(row.config));
      checked += 1;
    } catch (error) {
      failures.push(`${row.id} (${row.name}): ${error.message}`);
    }
  }
  if (failures.length) {
    console.error(`preset check: ${failures.length} of ${checked + failures.length} rows failed to mount`);
    for (const failure of failures) console.error('  - ' + failure);
    process.exitCode = 1;
    return;
  }
  const skippedNote = skipped.length ? ` (${skipped.length} disabled on this platform: ${skipped.join(', ')})` : '';
  console.log(`preset check: ${checked} rows mounted without a configuration or resolution error${skippedNote}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
