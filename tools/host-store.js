import { assertStoredWorkflow } from './workflow.js';

export const inject = ['storageDomain'];

export async function apply(ctx) {
  // This table is opened by Host code. No model-facing operation can write a receipt.
  const domain = await ctx.storageDomain.open({
    name: 'control_your_video_approvals',
    version: 1,
    layout: 'per-record',
    tables: { projects: { valueSchema: { parse: assertStoredWorkflow } } },
  });
  ctx.effect(() => () => domain.close());
  const table = domain.table('projects');
  ctx.provide('controlYourVideoStore', {
    get: key => table.get(key),
    put: (key, value) => table.put(key, assertStoredWorkflow(value)),
    locks: new Set(),
  });
}
