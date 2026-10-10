import { error as logError, log } from 'node:console'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  createPortableRecoveryPackage,
  restorePortableRecoveryPackage,
  verifyPortableRecoveryPackage,
} from '../server/services/credential-vault.ts'

/**
 * Read a secret without printing it to the console and without passing it
 * through argv, environment variables, URLs or a shell history.
 */
async function readSecret(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode)
    throw new Error('Use o PowerShell interativo para informar a senha de recuperação com segurança.')
  return new Promise((resolvePassword, rejectPassword) => {
    const stdin = process.stdin
    const rawBefore = stdin.isRaw
    let collected = ''
    process.stdout.write(label)
    stdin.setEncoding('utf8')
    stdin.setRawMode(true)
    stdin.resume()
    const release = () => {
      stdin.off('data', onData)
      stdin.setRawMode(Boolean(rawBefore))
      stdin.pause()
      process.stdout.write('\n')
    }
    const onData = (text) => {
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          release()
          resolvePassword(collected)
          return
        }
        if (ch === '\u0003') {
          release()
          rejectPassword(new Error('Operação cancelada.'))
          return
        }
        if (ch === '\b' || ch === '\u007f') {
          collected = collected.slice(0, -1)
          continue
        }
        if (ch >= ' ' && collected.length < 1024) collected += ch
      }
    }
    stdin.on('data', onData)
  })
}

function checkFileName(path) {
  if (!path.toLowerCase().endsWith('.autoflow-recovery'))
    throw new Error('O arquivo de recuperação deve terminar em .autoflow-recovery.')
  return path
}

async function run(args) {
  const [action, destination, ...extra] = args
  if (!['export', 'import', 'verify'].includes(action) || !destination || extra.length)
    throw new Error(
      'Uso: npm run vault:recovery -- export|import|verify <arquivo.autoflow-recovery>',
    )
  const filePath = resolve(checkFileName(destination))
  const dataDir = resolve(process.env.DATA_DIR || 'data')
  const dbPath = join(dataDir, 'autoflow.db')
  if (action === 'verify') {
    if (!existsSync(filePath) || statSync(filePath).size > 8192)
      throw new Error('Arquivo de recuperação ausente ou inválido.')
    const password = await readSecret('Senha de recuperação (não aparece na tela): ')
    verifyPortableRecoveryPackage(readFileSync(filePath, 'utf8'), password)
    log('Pacote de recuperação válido. Nenhum dado foi alterado.')
    return
  }
  if (!existsSync(dbPath))
    throw new Error('Banco AutoFlow não encontrado em DATA_DIR: ' + dataDir)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    if (action === 'export') {
      if (existsSync(filePath))
        throw new Error('O arquivo já existe. Escolha outro nome para não sobrescrever uma recuperação.')
      const password = await readSecret('Crie uma senha FORTE de recuperação (mínimo 16 caracteres): ')
      const again = await readSecret('Repita a senha de recuperação: ')
      if (password !== again) throw new Error('As senhas não conferem. Nada foi salvo.')
      const content = createPortableRecoveryPackage(db, dataDir, password)
      writeFileSync(filePath, content, { flag: 'wx', mode: 0o600 })
      log('Pacote de recuperação protegido criado em: ' + filePath)
      log('Mantenha esse arquivo e a senha em locais SEPARADOS do backup do banco.')
      return
    }
    if (!existsSync(filePath) || statSync(filePath).size > 8192)
      throw new Error('Arquivo de recuperação ausente ou inválido.')
    log('ATENÇÃO: o servidor deve estar parado e um backup do DATA_DIR deve existir.')
    log('A operação substituirá apenas o invólucro DPAPI do cofre, não os dados do SQLite.')
    const confirmed = await readSecret('Digite IMPORTAR para confirmar: ')
    if (confirmed !== 'IMPORTAR') throw new Error('Operação cancelada sem mudanças.')
    const password = await readSecret('Senha de recuperação (não aparece na tela): ')
    const outcome = restorePortableRecoveryPackage(
      db, dataDir, readFileSync(filePath, 'utf8'), password,
    )
    log('Recuperação concluída: ' + outcome.verifiedCredentials + ' chave(s) verificada(s).')
    log('O invólucro DPAPI anterior foi preservado em: ' + outcome.previousVaultFile)
    log('Inicie o AutoFlow sob esta conta Windows, usando o MESMO DATA_DIR.')
  } finally {
    db.close()
  }
}

run(process.argv.slice(2)).catch((error) => {
  logError(error instanceof Error ? error.message : 'Falha na recuperação.')
  process.exitCode = 1
})
