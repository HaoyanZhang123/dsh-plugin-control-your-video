// Frozen public contract for AI Video Studio v0.1: identities, commands, decisions, scopes, errors.
import { createHash } from 'node:crypto';
export const SCHEMA_VERSION = 1;
export const ADAPTER = { adapter: 'html-scene', adapter_version: '1' };
export class ContractError extends Error {
    code;
    status;
    details;
    constructor(code, message, status = 400, details) {
        super(message);
        this.code = code;
        this.status = status;
        this.details = details;
    }
}
export const nowIso = () => new Date().toISOString();
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export function canonicalJson(v) {
    if (v === null)
        return 'null';
    const t = typeof v;
    if (t === 'number')
        return JSON.stringify(Object.is(v, -0) ? 0 : v);
    if (t === 'string' || t === 'boolean')
        return JSON.stringify(v);
    if (Array.isArray(v))
        return '[' + v.map((x) => canonicalJson(x === undefined ? null : x)).join(',') + ']';
    if (t === 'object') {
        const obj = v;
        const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
        return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
    }
    throw new ContractError('FINGERPRINT_INVALID', 'unsupported value in fingerprint');
}
export const fingerprintOf = (parts) => sha256(Buffer.from(canonicalJson(parts), 'utf8'));
const ASPECTS = ['typography', 'motion', 'sound', 'material', 'layout'];
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
export function validateScope(raw, media, legacyEndInclusive = false) {
    if (!raw || typeof raw !== 'object')
        throw new ContractError('SCOPE_REQUIRED', 'an explicit scope is required', 400);
    const s = raw;
    const kind = s.kind;
    if (kind === 'full_version')
        return { kind: 'full_version' };
    if (kind === 'time_range') {
        if (!media || !finite(media.duration_seconds) || media.duration_seconds <= 0)
            throw new ContractError('SCOPE_TIME_RANGE_REQUIRES_TIMED_MEDIA', 'the target version has no measured duration', 400);
        const a = s.start_seconds, b = s.end_seconds;
        if (!finite(a) || !finite(b))
            throw new ContractError('SCOPE_INVALID', 'time range endpoints must be finite numbers', 400);
        if (!(a >= 0 && a < b && b <= media.duration_seconds))
            throw new ContractError('SCOPE_OUT_OF_BOUNDS', 'require 0 <= start < end <= duration (' + media.duration_seconds + 's)', 400, { duration_seconds: media.duration_seconds });
        const scope = { kind: 'time_range', start_seconds: a, end_seconds: b };
        if (legacyEndInclusive || s.end_inclusive === true)
            scope.end_inclusive = true;
        return scope;
    }
    if (kind === 'region') {
        if (!media)
            throw new ContractError('SCOPE_REGION_REQUIRES_MEDIA', 'region scope needs measured media', 400);
        const f = s.frame_seconds;
        if (!finite(f) || f < 0 || f > media.duration_seconds)
            throw new ContractError('SCOPE_OUT_OF_BOUNDS', 'frame_seconds outside the media', 400);
        if (s.basis !== 'display')
            throw new ContractError('SCOPE_COORDINATE_SPACE_UNSUPPORTED', "only basis 'display' is supported", 400);
        const x = s.x, y = s.y, w = s.width, h = s.height;
        if (![x, y, w, h].every(finite))
            throw new ContractError('SCOPE_INVALID', 'region needs finite x/y/width/height', 400);
        const X = x, Y = y, W = w, H = h;
        if (!(W > 0 && H > 0 && X >= 0 && Y >= 0 && X + W <= media.width && Y + H <= media.height))
            throw new ContractError('SCOPE_OUT_OF_BOUNDS', 'region outside the display frame (' + media.width + 'x' + media.height + ')', 400);
        return { kind: 'region', frame_seconds: f, x: X, y: Y, width: W, height: H, basis: 'display' };
    }
    if (kind === 'aspect') {
        const aspect = s.aspect;
        if (typeof aspect !== 'string' || !ASPECTS.includes(aspect))
            throw new ContractError('SCOPE_INVALID', 'aspect must be one of ' + ASPECTS.join('/'), 400);
        if (typeof s.description !== 'string' || !s.description.trim())
            throw new ContractError('SCOPE_INVALID', 'aspect scope needs a written description', 400);
        return { kind: 'aspect', aspect: aspect, description: String(s.description) };
    }
    throw new ContractError('SCOPE_UNSUPPORTED_KIND', 'unsupported scope kind: ' + String(kind), 400);
}
// ---------- decision matrix ----------
const USER_KINDS = ['partial_approval', 'change_request', 'reject', 'withdraw'];
export function assertDecisionAllowed(kind, principal) {
    if (kind === 'final')
        throw new ContractError('DECISION_UNSUPPORTED', 'final is not supported in v0.1', 400);
    if (kind === 'ai_check') {
        if (principal !== 'agent')
            throw new ContractError('DECISION_NOT_PERMITTED_FOR_PRINCIPAL', 'only an agent may record an ai_check', 403);
        return;
    }
    if (!USER_KINDS.includes(kind))
        throw new ContractError('DECISION_INVALID', 'unknown decision kind: ' + kind, 400);
    if (principal === 'agent')
        throw new ContractError('DECISION_NOT_PERMITTED_FOR_AGENT', 'an agent may not create a user decision', 403);
    // user + synthetic_test may create user-facing decisions; the channel decides which principal is recorded
}
export const commandFingerprint = (r) => fingerprintOf({ project_id: r.project_id, kind: r.kind, target: r.target ?? null, payload: r.payload ?? null, base_revision: r.base_revision });
