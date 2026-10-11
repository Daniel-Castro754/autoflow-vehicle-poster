import sharp from 'sharp'

export type CategorizedPhoto<T> = T & { category?: string }

// Keep the approved cover first and the order *within* each category. Only
// category blocks may move. Never invent additional photographs.
export function pickRandomOrderedSubset<T extends { category?: string }>(
  approvedPhotos: readonly T[],
  maximum = 20,
  random: () => number = Math.random,
): T[] {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 20)
    throw new Error('Limite de fotos inválido.')
  if (!approvedPhotos.length) return []
  const [cover, ...remainder] = approvedPhotos
  const groups = new Map<string, T[]>()
  for (const photo of remainder) {
    const category = photo.category || 'other'
    const group = groups.get(category) || []
    group.push(photo)
    groups.set(category, group)
  }
  const blocks = [...groups.values()]
  for (let i = blocks.length - 1; i > 0; i--) {
    const sample = random()
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1)
      throw new Error('Fonte de aleatoriedade inválida.')
    const j = Math.floor(sample * (i + 1))
    ;[blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!]
  }
  return [cover!, ...blocks.flat()].slice(0, maximum)
}

// Stable order across retries and worker restarts. Avoid unapproved photo
// substitutions in the middle of an active publication.
export function publicationPhotoRandom(jobId: number): () => number {
  if (!Number.isSafeInteger(jobId) || jobId < 1)
    throw new Error('Identificador da publicação inválido.')
  let state = jobId >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// For low-photo listings, permit only faithful delivery optimization of REAL
// photos (autorotation, scaling and encoding). Do not fabricate new camera
// angles, mirror registration plates or create near-duplicate fake photos.
export async function optimizeFaithfulPhoto(buffer: Buffer): Promise<Buffer> {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Fotografia inválida.')
  return sharp(buffer, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer()
}
