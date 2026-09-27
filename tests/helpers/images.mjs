import sharp from 'sharp'

const pixel = { create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 0, b: 0 } } }
const jpegFixture = await sharp(pixel).jpeg().toBuffer()
export const pngFixtureBase64 = (await sharp(pixel).png().toBuffer()).toString('base64')
export const webpFixtureBase64 = (await sharp(pixel).webp().toBuffer()).toString('base64')

export function jpegBase64(value) {
  const comment = Buffer.from(String(value))
  if (comment.length > 65533) throw new RangeError('JPEG fixture comment is too long.')
  const segment = Buffer.allocUnsafe(comment.length + 4)
  segment[0] = 0xff
  segment[1] = 0xfe
  segment.writeUInt16BE(comment.length + 2, 2)
  comment.copy(segment, 4)
  return Buffer.concat([jpegFixture.subarray(0, 2), segment, jpegFixture.subarray(2)]).toString('base64')
}
