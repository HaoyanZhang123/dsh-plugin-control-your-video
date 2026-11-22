import { assertStoredWorkflow } from './workflow.js';
import { assertStoredMediaGrant } from './media-grants.js';

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
  const mediaDomain = await ctx.storageDomain.open({
    name: 'control_your_video_media_grants',
    version: 1,
    layout: 'per-record',
    tables: { grants: { valueSchema: { parse: assertStoredMediaGrant } } },
  });
  ctx.effect(() => () => mediaDomain.close());
  const grants = mediaDomain.table('grants');
  ctx.provide('controlYourVideoStore', {
    get: key => table.get(key),
    put: (key, value) => table.put(key, assertStoredWorkflow(value)),
    locks: new Set(),
    mediaGrants: {
      get: key => grants.get(key),
      put: (key, value) => grants.put(key, assertStoredMediaGrant(value)),
    },
  });
}
