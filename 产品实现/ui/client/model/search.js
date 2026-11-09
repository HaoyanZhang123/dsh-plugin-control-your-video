/**
 * Project search: the same matcher the project page uses for "名称、内容、状态、时间或标签".
 *
 * Pure and deterministic. A query with several words requires all of them, each matching somewhere
 * in the project's searchable text; ranking prefers a title prefix so typing "键" puts the project
 * actually named 键… above one whose status merely contains the character.
 *
 * @module ui/client/model/search
 */

/**
 * Text a project can be found by. Labels are included because a user who types "暂停" should find
 * the paused project, not be told only titles are searchable.
 * @param {object} project
 */
export function projectSearchText(project) {
  const parts = [
    project?.title,
    project?.phaseLabel,
    project?.executionLabel,
    project?.seriesLabel,
    project?.origin,
    ...(Array.isArray(project?.tags) ? project.tags : []),
  ]
  return normalize(parts.filter((part) => typeof part === 'string' && part.length > 0).join(' '))
}

/** Lowercase, full-width spaces folded, repeated whitespace collapsed. */
export function normalize(text) {
  return String(text ?? '')
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * @param {object[]} projects
 * @param {string} query
 * @returns {object[]} matching projects, best first; original order preserved on ties
 */
export function searchProjects(projects, query) {
  const list = Array.isArray(projects) ? projects.filter(Boolean) : []
  const words = normalize(query).split(' ').filter((word) => word.length > 0)
  if (words.length === 0) return list.slice()

  const scored = []
  list.forEach((project, index) => {
    const text = projectSearchText(project)
    const title = normalize(project.title)
    let score = 0
    for (const word of words) {
      if (!text.includes(word)) return
      if (title.startsWith(word)) score += 6
      else if (title.includes(word)) score += 4
      else if (text.includes(word)) score += 1
    }
    // Recent projects win ties: updatedAt is an ISO string, so string compare is chronological.
    scored.push({ project, score, index, updatedAt: String(project.updatedAt ?? '') })
  })
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.updatedAt !== b.updatedAt) return b.updatedAt.localeCompare(a.updatedAt)
    return a.index - b.index
  })
  return scored.map((row) => row.project)
}

/**
 * Group projects by the phase the Host reports, keeping a stable display order.
 * @param {object[]} projects
 * @returns {Array<{ phase: string, label: string, projects: object[] }>}
 */
export function groupByPhase(projects) {
  const order = ['intake', 'aligning', 'ready-for-production', 'producing', 'initial-review', 'finalizing', 'completed', 'archived', 'recycle-bin']
  const groups = new Map()
  for (const project of Array.isArray(projects) ? projects : []) {
    const phase = String(project?.phase ?? 'unknown')
    if (!groups.has(phase)) groups.set(phase, { phase, label: project?.phaseLabel ?? phase, projects: [] })
    groups.get(phase).projects.push(project)
  }
  return [...groups.values()].sort((a, b) => {
    const ai = order.indexOf(a.phase)
    const bi = order.indexOf(b.phase)
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
  })
}
