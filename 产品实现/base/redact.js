/**
 * Redaction of secrets and unnecessary real paths for logs, errors, evidence and receipts.
 *
 * Product rule (CT-12 §6, 01-不可误读目标与边界 §9.1): logs, evidence and receipts must not
 * contain credentials, tokens, unrelated private content or unnecessary real absolute paths.
 * This module is the single place that decides how to strip them, so every sink stays honest.
 *
 * Design notes:
 * - Redaction is applied to VALUES, not to a formatted string, so nested objects, arrays and
 *   error details are covered even when a caller forgets to format first.
 * - Key-based redaction catches secrets whose value shape is unrecognizable (short tokens).
 * - Path redaction replaces known roots with placeholders; unknown absolute paths are kept but
 *   truncated, because guessing "is this private?" and deleting it would hide real evidence.
 *
 * @module base/redact
 */

/** Placeholder used wherever a secret is removed. */
export const REDACTED = '[REDACTED]'

/** Default maximum string length kept in logs; longer strings are truncated with a marker. */
export const DEFAULT_MAX_STRING = 2000

/**
 * The truncation marker. Exported so tests and idempotency checks can recognize it, and so a
 * second redaction pass can detect that truncation already happened instead of re-truncating.
 * @param {number} removed
 * @returns {string}
 */
export function TRUNCATION_MARKER(removed) {
  return `…[truncated ${removed} chars]`
}

/** Matches a marker produced by {@link TRUNCATION_MARKER}. */
const TRUNCATION_SUFFIX = /…\[truncated \d+ chars\]$/

/**
 * Secret-bearing key names, kept as an explicit list so the rule is reviewable.
 *
 * Matching strategy: a key is insensitive if it contains a sensitive STEM as a word. Because
 * JavaScript code and JSON payloads overwhelmingly use camelCase (`secretAccessKey`,
 * `accessKeyId`, `bearerToken`), the match is performed on a lowercased key that has had
 * camelCase boundaries and separators normalized to `-`. So:
 *
 *   `secretAccessKey` -> `secret-access-key`   contains `secret`  -> sensitive
 *   `accessKeyId`     -> `access-key-id`       contains `key`     -> sensitive via `key`
 *   `x-api-key`       -> `x-api-key`           contains `api-key` -> sensitive
 *   `tokenCount`      -> `token-count`         contains `token-count`, an explicit non-secret
 *
 * The final negative list exists because a naive substring match over-triggers on innocent
 * names such as `tokenCounter`, `tokenLimit`, `keyCount` or `author`.
 */
const SECRET_KEY_STEMS = [
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'api-key',
  'access-key',
  'accesskey',
  'private-key',
  'privatekey',
  'credential',
  'credentials',
  'authorization',
  'auth',
  'cookie',
  'cookies',
  'session-key',
  'signature',
  'sig',
  'client-secret',
  'bearer',
  'jwt',
  'signing-key',
  'pat',
]

/**
 * Key-name shapes that CONTAIN a stem but are not secrets (metrics, counters, metadata).
 * Checked before the stem list so these are reported as non-sensitive.
 */
const NON_SECRET_SUFFIXES = [
  'count',
  'counts',
  'counter',
  'limit',
  'length',
  'lifetime',
  'type',
  'kind',
  'name',
  'ttl',
  'expiry',
  'expires',
  'duration',
  'age',
  'size',
  'bytes',
  'path',
  'file',
  'url',
  'uri',
  'endpoint',
  'enabled',
  'required',
]

const NON_SECRET_KEY_PATTERNS = [
  // `<stem><suffix>` such as tokenCount, keyPath, secretName.
  new RegExp(`(token|key|secret|auth|sig|pat)[-_]?(${NON_SECRET_SUFFIXES.join('|')})$`),
  // `<verb><stem>` such as hasToken, needsAuth, enablePassword. Note `requiresAuth` is NOT
  // included: in real payloads it is a capability flag, and the conservative direction for a
  // redactor is to over-redact rather than under-redact.
  /^(has|is|needs|should|can|use|enable|disable)[-_]?(token|auth|secret|key|password)/,
  /^(author|authority|authentic|patent|pattern|patch|path|payload)$/,
]

/**
 * Normalize a key name so camelCase, snake_case, kebab-case and dotted forms compare alike.
 * @param {string} key
 * @returns {string}
 */
function normalizeKeyName(key) {
  return String(key)
    // insert a separator at lower->upper boundaries: secretKey -> secret-Key
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    // unify separators
    .replace(/[_./\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Words that introduce an inline `key=value` secret inside arbitrary text.
 */
const INLINE_KEY_WORDS = [
  'api[-_]?key',
  'access[-_]?token',
  'refresh[-_]?token',
  'password',
  'passwd',
  'secret',
  'token',
  'sig',
  'signature',
  'authorization',
]

const INLINE_KEY_PATTERN = new RegExp(
  `\\b(${INLINE_KEY_WORDS.join('|')})\\s*[=:]\\s*` +
    // The value must not already be the placeholder, otherwise redaction would re-match
    // its own output and `findSecrets` would report a false positive on a clean line.
    `("(?!\\[REDACTED\\])[^"]*"|'(?!\\[REDACTED\\])[^']*'|(?!\\[REDACTED\\])[^\\s&;,"']+)`,
  'gi',
)

/**
 * Placeholder emitted in place of a private-key block.
 *
 * Deliberately NOT shaped like a real key header/footer pair, so the detector cannot match its
 * own output (which would break idempotency and make `findSecrets` report a false leak).
 * @type {string}
 */
const PRIVATE_KEY_PLACEHOLDER = `[${'REDACTED-PRIVATE-KEY'}]`

/**
 * Value-shape patterns. Order matters: the most specific patterns run first so a
 * partially matched value does not stop a broader match later.
 * @type {ReadonlyArray<{ name: string, re: RegExp, replace: string | ((...args: string[]) => string) }>}
 */
const VALUE_PATTERNS = Object.freeze([
  {
    name: 'private-key-block',
    // Matches any non-empty key body. An earlier `{16,}` threshold was added so the placeholder
    // would not self-match, but it silently let SHORT real keys through and `findSecrets`
    // reported them clean — trading a real leak for idempotency. Instead the placeholder is now
    // a form that cannot match this detector, so both properties hold.
    // dsh-allow S9: this is the DETECTOR pattern, not a real key.
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g, // dsh-allow S9: detector
    replace: PRIVATE_KEY_PLACEHOLDER,
  },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, replace: REDACTED },
  {
    name: 'bearer',
    re: /\b(?:Bearer|Token|Bot)\s+[A-Za-z0-9._~+/=-]{6,}/gi,
    replace: (matched) => `${matched.split(/\s+/)[0]} ${REDACTED}`,
  },
  { name: 'basic-auth', re: /\bBasic\s+[A-Za-z0-9+/=]{6,}/gi, replace: `Basic ${REDACTED}` },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{12,}\b/g, replace: REDACTED },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: REDACTED },
  { name: 'google-oauth-token', re: /\bya29\.[0-9A-Za-z_-]{20,}\b/g, replace: REDACTED },
  { name: 'sk-token', re: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replace: REDACTED },
  { name: 'gh-token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, replace: REDACTED },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{8,}\b/g, replace: REDACTED },
  // `Cookie:` / `Set-Cookie:` header values carry session identifiers.
  // The lookahead tolerates whitespace so it also skips `key: [REDACTED]` on a second pass,
  // which is what makes redaction idempotent.
  {
    name: 'cookie-header',
    re: /\b(set-cookie|cookie)\s*:(?!\s*\[REDACTED\])[^\r\n]+/gi,
    replace: (_matched, name) => `${name}: ${REDACTED}`,
  },
  // key=value forms inside arbitrary text (query strings, env dumps, CLI echoes).
  {
    name: 'inline-key-value',
    re: INLINE_KEY_PATTERN,
    replace: (_matched, key) => `${key}=${REDACTED}`,
  },
  // credentials embedded in a URL: scheme://user:pass@host
  {
    name: 'url-credentials',
    re: /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
    replace: (_matched, scheme) => `${scheme}${REDACTED}@`,
  },
])

/** Sample keys exposed for documentation and cross-checking. */
export const SENSITIVE_KEY_SAMPLE = Object.freeze([
  'password',
  'authorization',
  'apiKey',
  'token',
  'cookie',
  'client_secret',
  'accessKeyId',
  'secretAccessKey',
  'bearerToken',
])

/**
 * Decide whether a KEY NAME indicates a secret value.
 *
 * Deliberately stem-based rather than a single giant anchored regex: real code uses camelCase
 * (`secretAccessKey`), so a separator-anchored pattern misses exactly the names that matter
 * most. Normalization is applied first, then non-secret shapes are excluded, then stems match.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isSensitiveKey(key) {
  if (typeof key !== 'string' || key.length === 0) return false
  const normalized = normalizeKeyName(key)
  if (normalized.length === 0) return false

  // Explicit non-secret shapes win, so `tokenCount` / `keyPath` / `author` stay readable.
  for (const pattern of NON_SECRET_KEY_PATTERNS) {
    if (pattern.test(normalized)) return false
  }

  const segments = normalized.split('-')
  for (const stem of SECRET_KEY_STEMS) {
    if (stem.includes('-')) {
      // Multi-word stems must appear as a contiguous run (`api-key`, `private-key`).
      if (normalized.includes(stem)) return true
    } else if (segments.includes(stem)) {
      return true
    }
  }
  return false
}

/**
 * Strip secrets from a string.
 *
 * Order matters: secrets are removed BEFORE truncation, and truncation is applied only when
 * the value is not already truncated. Doing it the other way round makes the function
 * non-idempotent — a second pass would see a shorter string and rewrite the marker with a
 * different count, so repeated logging of one long value would keep changing it and break any
 * hash/dedupe of log lines.
 *
 * @param {string} input
 * @param {{ maxLength?: number }} [options]
 * @returns {string}
 */
export function redactString(input, options = {}) {
  if (typeof input !== 'string' || input.length === 0) return input
  let out = input
  for (const pattern of VALUE_PATTERNS) {
    out = out.replace(pattern.re, /** @type {any} */ (pattern.replace))
  }
  const maxLength = options.maxLength ?? DEFAULT_MAX_STRING
  if (out.length > maxLength && !TRUNCATION_SUFFIX.test(out)) {
    const head = out.slice(0, maxLength)
    const removed = out.length - maxLength
    out = `${head}${TRUNCATION_MARKER(removed)}`
  }
  return out
}

/**
 * Build a path redactor for a known set of roots.
 *
 * Replacing `E:\DSH\workspaces\AI视频工作流` with `<workspace>` keeps evidence readable while
 * removing the user's real layout, and it is stable across machines so tests can compare.
 *
 * @param {Record<string, string>} roots placeholder -> absolute path
 * @returns {(value: string) => string}
 */
export function createPathRedactor(roots) {
  const entries = Object.entries(roots ?? {})
    .filter(([, root]) => typeof root === 'string' && root.length > 0)
    // Longest first so a nested root wins over its parent.
    .sort((a, b) => b[1].length - a[1].length)

  const normalize = (value) => value.replace(/\\/g, '/')

  return function redactPaths(value) {
    if (typeof value !== 'string' || value.length === 0) return value
    let out = normalize(value)
    for (const [placeholder, root] of entries) {
      const normalizedRoot = normalize(root).replace(/\/+$/, '')
      const re = new RegExp(escapeRegExp(normalizedRoot), 'gi')
      out = out.replace(re, placeholder)
    }
    return out
  }
}

/** Escape a literal string for use inside a RegExp. */
export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const CIRCULAR = '[Circular]'

/**
 * Deep-redact an arbitrary value for logging.
 *
 * @param {unknown} value
 * @param {object} [options]
 * @param {number} [options.maxDepth]
 * @param {number} [options.maxString]
 * @param {(value: string) => string} [options.redactPaths]
 * @param {number} [options.maxArrayLength]
 * @returns {unknown}
 */
export function redactValue(value, options = {}) {
  const maxDepth = options.maxDepth ?? 8
  const maxString = options.maxString ?? DEFAULT_MAX_STRING
  const maxArrayLength = options.maxArrayLength ?? 100
  const redactPaths = options.redactPaths
  const seen = new WeakSet()

  const finish = (text) => (redactPaths ? redactPaths(text) : text)

  const walk = (input, depth, key) => {
    if (key !== undefined && isSensitiveKey(key) && input !== null && input !== undefined && input !== '') {
      return REDACTED
    }
    if (input === null || input === undefined) return input
    const type = typeof input
    if (type === 'string') return finish(redactString(input, { maxLength: maxString }))
    if (type === 'number' || type === 'boolean') return input
    if (type === 'bigint') return `${input.toString()}n`
    if (type === 'function') return '[Function]'
    if (type === 'symbol') return String(input)
    if (input instanceof Date) return Number.isNaN(input.getTime()) ? 'Invalid Date' : input.toISOString()
    if (input instanceof Error) {
      return {
        name: input.name,
        message: finish(redactString(String(input.message ?? ''), { maxLength: maxString })),
        ...(input.isWorkbenchError === true ? { code: input.code, retryable: input.retryable === true } : {}),
      }
    }
    if (depth >= maxDepth) return '[MaxDepth]'
    if (typeof input === 'object') {
      if (seen.has(input)) return CIRCULAR
      seen.add(input)
      if (Array.isArray(input)) {
        const items = input.slice(0, maxArrayLength).map((item) => walk(item, depth + 1, undefined))
        if (input.length > maxArrayLength) items.push(`…[${input.length - maxArrayLength} more]`)
        return items
      }
      if (input instanceof Map) {
        const entries = [...input.entries()].slice(0, maxArrayLength)
        return Object.fromEntries(entries.map(([k, v]) => [String(k), walk(v, depth + 1, String(k))]))
      }
      if (input instanceof Set) return [...input].slice(0, maxArrayLength).map((v) => walk(v, depth + 1, undefined))
      if (ArrayBuffer.isView(input)) return `[${input.constructor?.name ?? 'TypedArray'} ${input.byteLength} bytes]`
      const out = {}
      for (const [childKey, childValue] of Object.entries(input)) {
        out[childKey] = walk(childValue, depth + 1, childKey)
      }
      return out
    }
    return String(input)
  }

  return walk(value, 0, undefined)
}

/**
 * Create a configured redactor that applies value patterns, key rules and path placeholders.
 *
 * @param {{ roots?: Record<string, string>, maxString?: number, maxDepth?: number }} [options]
 * @returns {{
 *   redact: (value: unknown) => unknown,
 *   redactString: (value: string) => string,
 *   redactPaths: (value: string) => string,
 * }}
 */
export function createRedactor(options = {}) {
  const redactPaths = createPathRedactor(options.roots ?? {})
  const config = {
    maxString: options.maxString ?? DEFAULT_MAX_STRING,
    maxDepth: options.maxDepth ?? 8,
    redactPaths,
  }
  return {
    redact: (value) => redactValue(value, config),
    redactString: (value) => redactPaths(redactString(value, { maxLength: config.maxString })),
    redactPaths,
  }
}

/**
 * Assert that a value contains no recognizable secret.
 *
 * Used by tests and by the release gate to prove that an artifact never carries a token.
 * @param {unknown} value
 * @returns {{ clean: boolean, findings: string[] }}
 */
export function findSecrets(value) {
  const findings = []
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  for (const pattern of VALUE_PATTERNS) {
    // Reset lastIndex for global regexes reused across calls.
    pattern.re.lastIndex = 0
    if (pattern.re.test(text)) findings.push(pattern.name)
    pattern.re.lastIndex = 0
  }
  return { clean: findings.length === 0, findings }
}
