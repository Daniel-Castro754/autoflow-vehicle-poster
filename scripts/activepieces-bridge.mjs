#!/usr/bin/env node
// Outbound-only bridge. Activepieces Cloud never reaches localhost and no
// Facebook credentials, cookies, login sessions or publication commands flow here.
import { readFile } from 'node:fs/promises'
import { planDrafts } from './activepieces-bridge-lib.mjs'

const args = process.argv.slice(2)
function argument(flag) {
  const n = args.indexOf(flag)
  if (n === -1) return null
  if (!args[n+1] || args[n+1].startsWith('--')) throw new Error(flag+' precisa de um caminho.')
  return args[n+1]
}
async function jsonFile(path) { return JSON.parse(await readFile(path,'utf8')) }
function allowedWebhook(value) {
  const url = new URL(value)
  const expectedHost = process.env.ACTIVEPIECES_BRIDGE_HOST || 'cloud.activepieces.com'
  if (url.protocol !== 'https:' || url.hostname !== expectedHost ||
    url.username || url.password || url.search || url.hash ||
    !/^\/api\/v1\/webhooks\/[^/]+\/sync\/?$/.test(url.pathname)) {
    throw new Error('Webhook inválido: use HTTPS, host configurado e URL /api/v1/webhooks/.../sync.')
  }
  return url
}
async function requestJson(url,options) {
  const response = await fetch(url,{...options,signal:AbortSignal.timeout(20000)})
  const data = await response.json().catch(()=>{throw new Error('O servidor não retornou JSON.')})
  if (!response.ok) {
    throw new Error('HTTP '+response.status+': '+String(data?.error || 'Requisição recusada').slice(0,220))
  }
  return data
}
async function main() {
  const fixture = argument('--fixture'), overridesPath = argument('--overrides')
  const create = args.includes('--create-drafts'), confirm = args.includes('--confirm-drafts')
  if (create && (!confirm || fixture))
    throw new Error('Para cadastrar rascunhos reais, use --create-drafts --confirm-drafts e não use --fixture.')
  const overrides = overridesPath ? await jsonFile(overridesPath) : {}
  let envelope
  if (fixture) envelope = await jsonFile(fixture)
  else {
    const key = process.env.ACTIVEPIECES_BRIDGE_KEY
    const endpoint = process.env.ACTIVEPIECES_BRIDGE_URL
    if (!endpoint || !key || key.length < 24)
      throw new Error('Configure ACTIVEPIECES_BRIDGE_URL e ACTIVEPIECES_BRIDGE_KEY (mínimo 24 caracteres).')
    envelope = await requestJson(allowedWebhook(endpoint), {
      method:'POST',
      headers:{'Content-Type':'application/json','X-AutoFlow-Bridge-Key':key},
      body:JSON.stringify({intent:'list_draft_candidates',dryRun:true}),
    })
  }
  const plan = planDrafts(envelope,overrides)
  console.log(JSON.stringify({
    mode:create?'CREATE_LOCAL_DRAFTS':'PREVIEW_ONLY',
    sourceJobs:plan.total,
    eligible:plan.eligible.map(item=>({jobId:item.jobId,stockCode:item.vehicleId})),
    blocked:plan.blocked.map(item=>({jobId:item.jobId,stockCode:item.vehicleId,missingOrInvalid:item.errors})),
    ignoredAtSource:plan.ignoredAtSource,
    note:'Nenhum anúncio será publicado nem enviado diretamente ao Facebook.',
  },null,2))
  if (!create) return
  const token = process.env.AUTOFLOW_INTEGRATION_TOKEN || ''
  if (!/^afi_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Token de integração afi_ ausente ou inválido.')
  const base = new URL(process.env.AUTOFLOW_BRIDGE_API_BASE || 'http://127.0.0.1:3333')
  if (base.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(base.hostname) ||
    base.username || base.password || base.search || base.hash || base.pathname !== '/')
    throw new Error('A API do Auto Flow deve ser acessada apenas pelo loopback do Windows.')
  for (const item of plan.eligible) {
    try {
      const response = await fetch(new URL('/api/integration/v1/vehicles',base),{
        method:'POST',
        signal:AbortSignal.timeout(20000),
        headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify(item.body),
      })
      const data = await response.json()
      if (response.status===201 && data.status==='Rascunho')
        console.log(JSON.stringify({stockCode:item.vehicleId,createdDraftId:data.id,requiresReview:true}))
      else if (response.status===409)
        console.log(JSON.stringify({stockCode:item.vehicleId,skipped:'already_exists_or_conflict'}))
      else throw new Error('HTTP '+response.status+' '+String(data.error||'Erro de cadastro').slice(0,150))
    } catch (error) {
      console.error(JSON.stringify({stockCode:item.vehicleId,error:error.message}))
      process.exitCode=1
    }
  }
}
main().catch(error=>{
  console.error('Ponte Activepieces: '+error.message)
  process.exitCode=1
})
