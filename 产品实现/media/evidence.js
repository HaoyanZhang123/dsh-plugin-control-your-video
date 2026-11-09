/**
 * Evidence identity: source material, actual results and derived proxies stay distinct.
 *
 * Contract (CT-07 §1, CT-06 §2): every evidence object has a stable id, a role (source / result /
 * derived), a file with SHA-256, media facts, provenance and a tool version. A derived proxy must
 * name the source hash and the transform that produced it, so it can never be mistaken for the
 * original. Program measurements, model observation and human acceptance are three separate fields,
 * and an unobserved item stays `not-run` instead of quietly becoming "checked".
 *
 * @module media/evidence
 */

import fs from 'node:fs'
import path from 'node:path'
import { ValidationError, sha256File, writeJsonAtomic } from '../base/index.js'

/** The only roles an evidence object may have. */
export const EVIDENCE_ROLES = Object.freeze(['source', 'result', 'derived'])

/**
 * Registry of media evidence for one project/unit.
 */
export function createEvidenceRegistry({ rootDir, clock, probe }) {
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    throw new ValidationError('证据登记需要根目录', { field: 'rootDir' })
  }
  const root = path.resolve(rootDir)
  /** @type {Map<string, any>} */
  const entries = new Map()

  const assertNewId = (id) => {
    if (typeof id !== 'string' || id.length === 0) throw new ValidationError('证据需要 id')
    if (entries.has(id)) throw new ValidationError('证据 id 已存在，身份不可替换', { id })
  }

  return {
    root,
    /**
     * @param {{ id: string, role: 'source'|'result'|'derived', file: string, label: string, sourceId?: string,
     * transform?: any, rights?: string, retention?: string }} input
     */
    register(input) {
      if (!EVIDENCE_ROLES.includes(input.role)) {
        throw new ValidationError('未知证据角色', { role: String(input.role) })
      }
      assertNewId(input.id)
      const file = path.resolve(input.file)
      if (!fs.existsSync(file)) throw new ValidationError('证据文件不存在', { file: input.file })
      const facts = probe === undefined || probe === null ? null : probe(file)
      const record = {
        id: input.id,
        role: input.role,
        label: input.label,
        file,
        sha256: sha256File(file),
        bytes: fs.statSync(file).size,
        mediaFacts: facts,
        provenance: {
          sourceId: input.sourceId ?? null,
          transform: input.transform ?? null,
          note:
            input.role === 'derived'
              ? '派生对象：必须按 sourceId + transform 才能回溯，不得冒充原始素材'
              : input.role === 'result'
                ? '实际结果：由本产品渲染产生'
                : '原始素材：不可被派生结果替换',
        },
        rights: input.rights ?? null,
        retention: input.retention ?? 'project',
        registeredAt: clock.iso(),
      }
      entries.set(record.id, record)
      return record
    },
    /** @param {string} id */
    get(id) {
      const entry = entries.get(id)
      if (entry === undefined) throw new ValidationError('证据不存在', { id })
      return entry
    },
    /** @param {{ role?: string }} [filter] */
    list(filter = {}) {
      return [...entries.values()].filter((entry) => filter.role === undefined || entry.role === filter.role)
    },
    /**
     * Assert a derived object never claims to be a source.
     * @param {string} id
     */
    assertNotMasquerading(id) {
      const entry = this.get(id)
      if (entry.role === 'derived' && entry.provenance.sourceId === null) {
        throw new ValidationError('派生证据必须声明来源，不能冒充原始', { id })
      }
      return true
    },
    /**
     * Record what a model actually looked at or listened to.
     *
     * @param {{ question: string, evidenceIds: string[], mode: 'viewed'|'listened'|'both'|'none', range?: any, note?:
     * string, limitations?: string[] }} input
     */
    recordObservation(input) {
      for (const id of input.evidenceIds) this.get(id)
      return {
        question: input.question,
        evidenceIds: [...input.evidenceIds],
        viewed: input.mode === 'viewed' || input.mode === 'both',
        listened: input.mode === 'listened' || input.mode === 'both',
        range: input.range ?? null,
        note: input.note ?? null,
        limitations: input.limitations ?? [],
        recordedAt: clock.iso(),
        disclaimer: '只记录实际输入与范围；未输入即未看/未听，程序结果不代为声明',
      }
    },
    /** Persist the whole registry (atomic). */
    save(fileName = 'evidence-registry.json') {
      const target = path.join(root, fileName)
      fs.mkdirSync(root, { recursive: true })
      writeJsonAtomic(target, {
        root,
        savedAt: clock.iso(),
        entries: [...entries.values()],
      })
      return target
    },
  }
}

/**
 * The three-column truth table a receipt must show separately.
 *
 * @param {{ programChecks: any, aiObservation: any, humanAcceptance: any }} input
 */
export function describeEvidenceTruth(input) {
  return {
    programChecks: input.programChecks ?? { status: 'not-run' },
    aiObservation: input.aiObservation ?? { viewed: false, listened: false, range: null, note: 'AI 未看/未听' },
    humanAcceptance: input.humanAcceptance ?? { accepted: false, note: '用户未验收；程序通过不等于验收' },
    rule: '三列不可互相代替：程序测量不冒充看过听过，模型观察不冒充用户验收',
  }
}
