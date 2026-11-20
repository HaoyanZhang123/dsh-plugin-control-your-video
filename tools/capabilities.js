import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function probe(command, signal) {
  try {
    const { stdout } = await execute(command, ['-version'], {
      timeout: 5000, maxBuffer: 96 * 1024, windowsHide: true, signal,
    });
    return { available: true, version: stdout.split(/\r?\n/, 1)[0] };
  } catch (error) {
    signal?.throwIfAborted();
    return { available: false, reason: error.code ?? 'version-probe-failed' };
  }
}

export async function discoverLocalCapabilities(signal) {
  const [ffmpeg, ffprobe] = await Promise.all([probe('ffmpeg', signal), probe('ffprobe', signal)]);
  let encoders = '';
  if (ffmpeg.available) {
    try {
      ({ stdout: encoders } = await execute('ffmpeg', ['-hide_banner', '-encoders'], {
        signal, timeout: 5000, windowsHide: true, maxBuffer: 512 * 1024,
      }));
    } catch (error) {
      signal?.throwIfAborted();
      ffmpeg.encoderProbeError = error.code ?? 'encoder-probe-failed';
    }
  }
  const h264 = /\blibx264\s/.test(encoders);
  const aac = /\baac\s/.test(encoders);
  return { ffmpeg, ffprobe, h264, aac, localProduction: ffmpeg.available && ffprobe.available && h264 };
}

// A media integration is installed/configured by the Host, never from a tool's arguments.
export function discoverMediaModels(providers = []) {
  const models = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      models.push({ provider: provider.id, model: model.id, capabilities: model.capabilities });
    }
  }
  return models;
}

const consumedApprovals = new WeakSet();

export async function executeOneMediaRequest({ providers, request, approved, signal }) {
  if (!approved || consumedApprovals.has(approved) || approved.operationId !== request.operationId || approved.model !== request.model
    || approved.provider !== request.provider || approved.costLimit !== request.costLimit
    || approved.currency !== request.currency) {
    throw new Error('This model selection and spending limit need separate explicit approval.');
  }
  const provider = providers.find(candidate => candidate.id === request.provider);
  if (!provider?.models.some(model => model.id === request.model)) throw new Error('Media model is unavailable.');
  if (!/^[A-Z]{3}$/.test(request.currency) || !Number.isSafeInteger(request.costLimit) || request.costLimit < 0) {
    throw new Error('Provide a nonnegative spending cap in the smallest currency unit.');
  }
  consumedApprovals.add(approved);
  const estimate = await provider.estimate(request, { signal });
  if (!Number.isSafeInteger(estimate) || estimate < 0 || estimate > approved.costLimit) {
    throw new Error('The media request is over budget or its cost cannot be verified.');
  }
  signal?.throwIfAborted();
  // One approved dispatch. Continuation, batch calls and retries need a separate design decision.
  return provider.generate(request, { signal, maxCost: approved.costLimit });
}
