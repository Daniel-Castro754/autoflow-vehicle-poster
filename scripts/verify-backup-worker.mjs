import { verifyBackup } from './backup.mjs'

const path = process.argv[2]
if (!path || process.argv.length !== 3) {
  process.stdout.write(JSON.stringify({ ok: false, error: 'Identificador inválido.' }))
  process.exitCode = 1
} else {
  try {
    const manifest = verifyBackup(path)
    const response = {
      ok: true,
      createdAt: manifest.createdAt,
      databaseBytes: manifest.database.bytes,
      imageCount: manifest.uploads.length,
      vaultIncluded: Boolean(manifest.vault),
    }
    process.stdout.write(JSON.stringify(response))
  } catch (error) {
    // Do not echo sensitive filenames, absolute paths, content or error stacks.
    const message = error instanceof Error ? error.message : ''
    const category = /integridade SQLite/i.test(message) ? 'A integridade SQLite não foi confirmada.' :
      /cofre/i.test(message) ? 'O arquivo do cofre está ausente ou inválido.' :
      /upload|imagem/i.test(message) ? 'Uma ou mais imagens do backup estão ausentes ou foram alteradas.' :
      /manifesto|formato/i.test(message) ? 'O manifesto está ausente ou é inválido.' :
      /banco/i.test(message) ? 'A cópia do banco está ausente ou não corresponde ao manifesto.' :
      'A cópia não passou na verificação.'
    process.stdout.write(JSON.stringify({ ok: false, error: category }))
    process.exitCode = 1
  }
}
