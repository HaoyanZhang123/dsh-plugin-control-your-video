/**
 * Real-work domain view: what the C15R film actually is, measured.
 *
 * This page exists because C10–C15 shipped technical fixtures: they proved the pipeline, not that
 * the product can make something worth watching. C15R made one real 12-second piece, and this view
 * is the honest read-only record of it — spec, timing, the four measured line/click alignments, the
 * one local repair, and exactly what the AI looked at and never heard.
 *
 * Data comes from `snapshot.js`, which is GENERATED from the evidence JSON in
 * `实施交接/证据/C15R-证据/` by `产品实现/acceptance/real-work/scripts/embed-snapshot.mjs`. It is never
 * hand-edited, so a number here cannot drift away from the file that measured it. When the snapshot
 * is missing or stale the view says so instead of showing a plausible-looking table.
 *
 * @module ui/client/domains/realwork/view
 */

/** A section in the workbench's own card rhythm. */
function RealworkSection(props) {
  return h('section', { className: 'avw-card', style: { marginBottom: '10px' } },
    h('div', { className: 'avw-card__head' },
      h('span', { className: 'avw-card__title' }, props.title),
      props.note ? h('span', { className: 'avw-card__note' }, props.note) : null,
      h('span', { className: 'avw-grow' })),
    h('div', { className: 'avw-card__body', style: { display: 'grid', gap: '6px' } }, props.children))
}

/** A chip matching the design system. */
function RealworkChip(props) {
  return h('span', { className: `avw-chip${props.tone ? ` avw-chip--${props.tone}` : ''}` }, props.text)
}

/** One two-column row. */
function RealworkKV(props) {
  return h('div', { className: 'avw-kv' },
    h('label', null, props.label),
    h('span', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } }, props.children))
}

/** Whether a measurement row passed its own tolerance. */
function passTone(ok) {
  return ok === true ? 'ok' : ok === false ? 'danger' : 'warn'
}

/**
 * The whole domain view.
 *
 * @param {object} props
 * @param {any} [props.snapshot] the generated measurement snapshot
 * @param {string} [props.error] why the snapshot is unusable
 * @param {string} [props.notice] a standing note
 */
function RealworkDomainView(props) {
  const snapshot = props.snapshot ?? null
  const header = h('div', { className: 'avw-card__head' },
    h('span', { className: 'avw-card__title' }, '真实作品视图'),

    h(RealworkChip, { text: '只读', tone: 'accent' }),
    h('span', { className: 'avw-grow' }),
    h('span', { className: 'avw-card__note' },
      snapshot === null ? '没有证据快照' : `快照生成于 ${snapshot.generatedAt}`))

  if (typeof props.error === 'string' && props.error.length > 0) {
    return h('div', { className: 'avw-card' }, header,
      h('div', { className: 'avw-card__body' },
        h(RealworkChip, { text: '需要处理', tone: 'warn' }),
        h('span', { className: 'avw-hint' }, props.error)))
  }
  if (snapshot === null) {
    return h('div', { className: 'avw-card' }, header,
      h('div', { className: 'avw-card__body' },
        h('span', { className: 'avw-hint' }, '没有真实作品证据快照：这里不显示任何数字。'),
        props.notice ? h('span', { className: 'avw-hint' }, props.notice) : null))
  }

  const film = snapshot.film ?? {}
  const spec = snapshot.spec ?? {}
  const rules = snapshot.rules ?? []
  const repair = snapshot.repair ?? null
  const observation = snapshot.observation ?? {}

  return h('div', { className: 'avw-realwork-domain' },
    h('div', { className: 'avw-card__head', style: { padding: '0 2px 6px' } },
      h('span', { className: 'avw-card__title' }, '真实作品视图'),
      h(RealworkChip, { text: '只读', tone: 'accent' }),
      h('span', { className: 'avw-grow' }),
      h('span', { className: 'avw-card__note' }, `快照生成于 ${snapshot.generatedAt}`)),
    h(RealworkSection, { title: '作品', note: film.title ?? '—' },
      h(RealworkKV, { label: '成片' },
        h(RealworkChip, { text: `${spec.totalFrames} 帧`, tone: 'accent' }),
        h('span', { className: 'avw-mono' }, `${spec.width}×${spec.height} · ${spec.fps} fps · ${spec.videoCodec} · ${spec.pixelFormat}`),
        h('span', { className: 'avw-hint' }, `视频流 ${spec.videoStreamSeconds}s；容器 ${spec.containerSeconds}s（差值是 AAC 尾部填充，不是画面帧）`)),
      h(RealworkKV, { label: '声音' },
        h(RealworkChip, { text: '程序合成', tone: 'ok' }),
        h('span', { className: 'avw-hint' }, `FFmpeg 噪声床＋四声点击＋下行音；${spec.audioCodec} ${spec.audioSampleRate} Hz ${spec.audioChannels} ch；两次渲染哈希一致`)),
      h(RealworkKV, { label: '颜色与字体' },
        h('span', { className: 'avw-hint' }, `${film.palette ?? '—'}；${film.font ?? '—'}（${film.fontLicense ?? '许可未记录'}）`)),
      h(RealworkKV, { label: '运行时' },
        h('span', { className: 'avw-mono' }, `${film.runtime ?? '—'}`),
        h('span', { className: 'avw-hint' }, film.runtimeNote ?? ''))),

    h(RealworkSection, { title: '四条线与点击对齐', note: `容差 ${snapshot.toleranceFrames} 帧` },
      rules.map((rule) => h(RealworkKV, { key: rule.objectId, label: rule.objectId },
        h('span', null, `可见帧 ${rule.measuredFirstVisibleFrame}`),
        h('span', { className: 'avw-mono' }, `点击 ${rule.clickOnsetFrame} 帧`),
        h(RealworkChip, {
          text: `Δ ${rule.deltaFrames} 帧`,
          tone: passTone(Math.abs(rule.deltaFrames ?? 99) <= (snapshot.toleranceFrames ?? 1)),
        }))),
      h('span', { className: 'avw-hint' },
        `最大绝对误差 ${snapshot.maxAbsDeltaFrames} 帧；检测器在源 WAV 与编码后 MP4 上的读数相差 ${snapshot.encodeDelayFrames} 帧，说明编码没有移动点击。`)),

    h(RealworkSection, { title: '一处真实局部修改', note: repair === null ? '未做' : `${repair.planVersionFrom} → ${repair.planVersionTo}` },
      repair === null
        ? h('span', { className: 'avw-hint' }, '本轮还没有做局部修改。')
        : h('div', null,
          h(RealworkKV, { label: '请求' }, h('span', null, repair.request)),
          h(RealworkKV, { label: '内容改动' },
            h(RealworkChip, { text: `内容变化帧 ${repair.changedFrames.join('/')}`, tone: 'ok' }),
            h('span', { className: 'avw-hint' }, '由不经编码的逐像素对照得出')),
          h(RealworkKV, { label: '编码后像素' },
            h('span', { className: 'avw-hint' },
              `目标线 ${repair.targetVisibleSharePercent}% 像素变化；其余区域上限 ${repair.othersVisibleSharePercent}%（H.264 同 GOP 内的重量化漂移）`)),
          h(RealworkKV, { label: '音频' },
            h('span', { className: 'avw-hint' }, repair.audioNote)),
          h(RealworkKV, { label: '用户接受' },
            h(RealworkChip, { text: repair.accepted === true ? '已接受' : '未接受', tone: repair.accepted === true ? 'ok' : 'warn' }),
            repair.accepted === true
              ? h('span', { className: 'avw-hint' }, `${repair.acceptedAt ?? ''} 用户回复「${repair.acceptanceQuote ?? ''}」；接受对象是这一候选版本`)
              : h('span', { className: 'avw-hint' }, '候选尚未被接受时不计为定稿')))),

    h(RealworkSection, { title: 'AI 实际看／听' },
      h(RealworkKV, { label: '画面' },
        h(RealworkChip, { text: observation.saw === true ? '看过' : '未看', tone: observation.saw === true ? 'ok' : 'warn' }),
        h('span', { className: 'avw-hint' }, observation.viewedFrames ?? '')),
      h(RealworkKV, { label: '声音' },
        h(RealworkChip, { text: '未听', tone: 'warn' }),
        h('span', { className: 'avw-hint' }, observation.heard ?? '宿主没有听辨通道；听感只能由用户判断')),
      h('span', { className: 'avw-hint' }, `未验证：${(observation.notVerified ?? []).join('；')}`)),

    props.notice ? h('span', { className: 'avw-hint' }, props.notice) : null)
}
