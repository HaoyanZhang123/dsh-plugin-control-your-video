/**
 * Unit tests for the support catalog and the capability-pack contract under the manual-guidance model.
 *
 * These prove the declarations later cards depend on: a research candidate never becomes usable, an
 * external tool is never presented as plugin MIT, a plugin-internal component must be strictly MIT, and a
 * pack that references an undeclared tool is refused (C06 §4.4, CT-10 §1).
 *
 * They also pin the CR-4 decision in code: there is no downloadable source kind and no artifact integrity
 * field, because the plugin does not fetch tool bytes. A catalog that tries to declare a download is
 * refused — not ignored, so an old declaration cannot quietly come back.
 *
 * @module tests/unit/tools-catalog.test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCatalog, listOfficialTools, listResearchCandidates, requireTool, buildDisclosure, CheckKind } from '../../tools/catalog.js'
import { createDefaultCatalog, PACKS } from '../../tools/packs.js'
import { CatalogClass, InstallOrigin, SupportClass } from '../../tools/schema.js'

/** A minimal valid tool declaration builder. */
function makeTool(overrides = {}) {
  return {
    toolId: 'demo-tool',
    displayName: 'Demo',
    supportClass: 'external',
    catalogClass: 'official',
    channel: 'cli',
    supportedVersions: '>=1.0.0 <2.0.0',
    permissions: ['filesystem'],
    detection: { mode: 'files-only', manifestFiles: ['package.json'] },
    verificationChecks: [
      { id: 'manifest', kind: CheckKind.FILE_EXISTS, relativePath: 'package.json', description: 'exists' },
    ],
    license: {
      spdx: 'Apache-2.0',
      class: 'external',
      conditions: ['不随插件包分发'],
      evidenceRef: 'evidence.md',
    },
    effects: { effects: [], network: false, dataSubmission: false, registration: false, fee: null },
    source: { kind: 'manual-only', obtainFrom: 'https://example.invalid/download' },
    manualGuidance: { steps: ['自行安装'] },
    rollback: { strategy: 'manual-guidance', retainedVersions: 0, instructions: '自行处理' },
    ...overrides,
  }
}

/** A minimal valid pack around one tool. */
function makePack(overrides = {}) {
  return {
    packId: 'demo-pack',
    version: '1.0.0',
    displayName: 'Demo pack',
    pluginCode: { license: 'MIT', components: ['adapter'] },
    tools: [makeTool()],
    capabilities: [
      {
        capabilityId: 'demo-cap',
        displayName: 'Demo capability',
        userOutcome: 'accomplish something',
        requires: [{ toolId: 'demo-tool' }],
      },
    ],
    ...overrides,
  }
}

test('catalog: the shipped catalog is internally consistent and separates the two lists', () => {
  const catalog = createDefaultCatalog()
  const official = listOfficialTools(catalog)
  const research = listResearchCandidates(catalog)
  assert.ok(official.length >= 3, 'expected the three declared official tools')
  assert.equal(research.length, 1)
  assert.equal(
    official.some((entry) => research.some((other) => other.toolId === entry.toolId)),
    false,
    '一份工具不得同时出现在两个清单',
  )
  for (const entry of research) {
    assert.equal(entry.definition.catalogClass, CatalogClass.RESEARCH_CANDIDATE)
  }
})

test('catalog: no tool declares a downloadable source, because the plugin installs nothing', () => {
  const catalog = createDefaultCatalog()
  for (const entry of catalog.toolIndex.values()) {
    const source = entry.definition.source
    assert.equal(source.kind, 'manual-only', `${entry.toolId} 只应有手动来源`)
    assert.equal(source.integrity, undefined, `${entry.toolId} 不应有下载校验和`)
    assert.equal(source.displayUrl, undefined, `${entry.toolId} 不应有下载 URL`)
  }
})

test('catalog: a download source kind is not representable any more', () => {
  // The CR-4 decision is enforced by the enum, not by documentation.
  assert.throws(
    () =>
      buildCatalog({
        packs: [
          makePack({
            tools: [
              makeTool({
                source: {
                  kind: 'download',
                  displayUrl: 'https://example.invalid/x.zip',
                  integrity: { algorithm: 'sha256', value: 'a'.repeat(64) },
                },
              }),
            ],
          }),
        ],
      }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
})

test('catalog: every declared external tool keeps its own license and never claims plugin MIT', () => {
  const catalog = createDefaultCatalog()
  for (const entry of catalog.toolIndex.values()) {
    const tool = entry.definition
    if (tool.supportClass === SupportClass.EXTERNAL) {
      assert.notEqual(tool.license.spdx, undefined)
      assert.equal(tool.license.class, SupportClass.EXTERNAL)
      assert.ok(tool.license.conditions.length > 0, `${tool.toolId} 必须记录外部使用条件`)
      assert.equal(tool.license.evidenceRef === null, false, `${tool.toolId} 必须有许可证据位置`)
    }
  }
  const spdx = [...catalog.toolIndex.values()].map((entry) => entry.definition.license.spdx)
  assert.ok(spdx.includes('GPL-3.0-or-later'))
  assert.ok(spdx.includes('Apache-2.0'))
  assert.ok(spdx.includes('Remotion-License'))
})

test('catalog: a plugin-internal object must be strictly MIT', () => {
  assert.throws(
    () => buildCatalog({ packs: [makePack({ pluginCode: { license: 'Apache-2.0' } })] }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
})

test('catalog: plugin-internal licence is recorded per pack, not inferred from the root LICENSE', () => {
  const catalog = createDefaultCatalog()
  for (const pack of catalog.packs) {
    assert.equal(pack.pluginCode.license, 'MIT', `${pack.packId} 的插件内内容必须 MIT`)
  }
})

test('catalog: an external object must state its own conditions and evidence location', () => {
  assert.throws(
    () =>
      buildCatalog({
        packs: [
          makePack({
            tools: [
              makeTool({
                license: { spdx: 'Apache-2.0', class: 'external', conditions: [], evidenceRef: 'x' },
              }),
            ],
          }),
        ],
      }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
})

test('catalog: a research tool inside an official pack is refused', () => {
  assert.throws(
    () => buildCatalog({ packs: [makePack({ tools: [makeTool({ catalogClass: 'research-candidate' })] })] }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
})

test('catalog: an official external tool must carry manual guidance, because guidance IS the install path', () => {
  assert.throws(
    () => buildCatalog({ packs: [makePack({ tools: [makeTool({ manualGuidance: { steps: [] } })] })] }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
})

test('catalog: a capability referencing an undeclared tool is refused', () => {
  assert.throws(
    () =>
      buildCatalog({
        packs: [
          makePack({
            capabilities: [
              {
                capabilityId: 'demo-cap',
                displayName: 'Demo',
                userOutcome: 'x',
                requires: [{ toolId: 'ghost-tool' }],
              },
            ],
          }),
        ],
      }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
})

test('catalog: a tool with no verification check is refused, because it could never become usable', () => {
  assert.throws(
    () => buildCatalog({ packs: [makePack({ tools: [makeTool({ verificationChecks: [] })] })] }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
})

test('catalog: a version-match check must name a bare command, never a path', () => {
  for (const evil of ['..\\evil.exe', 'C:\\Windows\\System32\\cmd.exe', '/usr/bin/env', 'bin/ffmpeg']) {
    assert.throws(
      () =>
        buildCatalog({
          packs: [
            makePack({
              tools: [
                makeTool({
                  verificationChecks: [
                    {
                      id: 'v',
                      kind: CheckKind.VERSION_MATCH,
                      expectedBuild: '1.0.0',
                      command: evil,
                      description: 'x',
                    },
                  ],
                }),
              ],
            }),
          ],
        }),
      `command ${JSON.stringify(evil)} should be refused`,
    )
  }
})

test('catalog: a download-only source must also declare where the data goes when it networks', () => {
  assert.throws(
    () =>
      buildCatalog({
        packs: [
          makePack({
            tools: [
              makeTool({
                effects: { effects: ['network'], network: true, dataSubmission: false, registration: false, fee: null },
              }),
            ],
          }),
        ],
      }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
})

test('catalog: duplicate tool or capability identifiers are refused', () => {
  const duplicatedCapability = {
    capabilityId: 'demo-cap',
    displayName: 'x',
    userOutcome: 'y',
    requires: [{ toolId: 'demo-tool' }],
  }
  assert.throws(
    () => buildCatalog({ packs: [makePack(), makePack({ capabilities: [duplicatedCapability] })] }),
    (error) => error.code === 'VALIDATION_FAILED',
  )
})

test('catalog: requireTool refuses an unknown id instead of returning undefined', () => {
  const catalog = createDefaultCatalog()
  assert.throws(() => requireTool(catalog, 'not-in-catalog'), (error) => error.code === 'VALIDATION_FAILED')
  assert.equal(requireTool(catalog, 'ffmpeg').toolId, 'ffmpeg')
})

test('catalog: the disclosure includes all seven required fields, populated', () => {
  const catalog = createDefaultCatalog()
  const tool = requireTool(catalog, 'ffmpeg')
  const disclosure = buildDisclosure(tool, {
    targetVersion: '9.0.1-full_build-www.gyan.dev',
    installLocation: 'C:\\tools\\ffmpeg',
  })
  for (const field of ['source', 'version', 'location', 'data', 'fee', 'environment', 'rollback']) {
    assert.equal(typeof disclosure[field], 'string', `${field} 必须是字符串`)
    assert.ok(disclosure[field].length > 0, `${field} 不能为空`)
  }
  assert.match(disclosure.version, /9\.0\.1-full_build/)
  assert.match(disclosure.source, /手动指引|自行安装/)
  // The source disclosure tells the user where to get it, which is what replaces a download button.
  assert.match(disclosure.source, /gyan\.dev/)
})

test('catalog: every official external tool records an origin, so no record implies the plugin installed it', () => {
  const catalog = createDefaultCatalog()
  for (const entry of catalog.toolIndex.values()) {
    assert.equal(entry.definition.origin, InstallOrigin.MANUAL, `${entry.toolId} 来源应为手动安装`)
  }
})

test('catalog: the pack list is frozen so a caller cannot mutate the declaration at runtime', () => {
  assert.equal(Object.isFrozen(PACKS), true)
  const catalog = createDefaultCatalog()
  assert.equal(Object.isFrozen(catalog), true)
  assert.equal(Object.isFrozen(catalog.packs[0]), true)
})
