import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const port = Number(process.env.PORT || 3333)
const dataDir = resolve(process.env.DATA_DIR || './data')
const secretOk = (process.env.AUTH_SECRET?.trim().length || 0) >= 32
const isValidPort = Number.isInteger(port) && port > 0 && port < 65536
const errors = []

console.log('AutoFlow — diagnóstico local (nenhum segredo será exibido)')
if (!existsSync(resolve('.env'))) {
  errors.push('Arquivo .env não encontrado. Crie com: Copy-Item .env.example .env')
} else console.log('✓ Arquivo .env encontrado.')
if (!secretOk) {
  errors.push('AUTH_SECRET ausente ou com menos de 32 caracteres no ambiente carregado.')
} else console.log('✓ AUTH_SECRET presente e com comprimento válido.')
if (!isValidPort) {
  errors.push('PORT inválida: configure um número entre 1 e 65535.')
}
if (!existsSync(join(dataDir, 'autoflow.db'))) {
  if (!process.env.INITIAL_ADMIN_EMAIL?.trim() || (process.env.INITIAL_ADMIN_PASSWORD?.length || 0) < 12)
    errors.push('Banco inicial inexistente e administrador inicial não configurado corretamente.')
  else console.log('✓ Dados do administrador inicial presentes (banco ainda não criado).')
} else console.log('✓ Banco SQLite encontrado.')
if (isValidPort) {
  try {
    const base = `http://127.0.0.1:${port}`
    const response = await fetch(`${base}/health/ready`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) {
      errors.push(`API acessível, porém indisponível (HTTP ${response.status}). Confira o terminal do servidor.`)
    } else {
      const health = await response.json()
      if (health.status !== 'ready')
        errors.push('A API respondeu, mas ainda não está pronta.')
      else console.log(`✓ API respondeu pronta em ${base}.`)
      try {
        const googleResponse = await fetch(`${base}/api/auth/google/config`, {
          signal: AbortSignal.timeout(3000),
        })
        const google = await googleResponse.json()
        if (!googleResponse.ok) errors.push('A consulta da configuração Google falhou.')
        else if (!google.enabled)
          console.log('ℹ Login Google desativado: configure GOOGLE_CLIENT_ID no .env e reinicie a API.')
        else console.log('✓ Login Google habilitado na API (a conta ainda precisa ser vinculada).')
      } catch {
        errors.push('Não foi possível consultar a configuração Google na API.')
      }
    }
  } catch {
    errors.push(
      `API local sem resposta na porta ${port}. Inicie npm run dev e confira erros no terminal [API].`,
    )
  }
}
for (const err of errors) console.error('✗ ' + err)
if (errors.length) {
  console.log('Corrija os itens acima, salve .env e reinicie npm run dev.')
  process.exitCode = 1
} else console.log('Diagnóstico local concluído. Se o login falhar, confira usuário/senha e o console [API].')
