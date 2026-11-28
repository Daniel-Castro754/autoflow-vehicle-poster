#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { JWT } from 'google-auth-library'
import { sheetStockSnapshot, stockSheetUrl } from './stock-sheet-lib.mjs'

async function boundedJson(response,limit){
  if(!response.ok)throw new Error('HTTP '+response.status)
  if(!response.body)throw new Error('Resposta sem conteúdo.')
  const reader=response.body.getReader()
  const chunks=[]
  let size=0
  try{
    for(;;){
      const {done,value}=await reader.read()
      if(done)break
      size+=value.byteLength
      if(size>limit)throw new Error('Resposta excede o limite seguro.')
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }finally{await reader.cancel().catch(()=>{})}
}

async function main(){
  const args=process.argv.slice(2)
  if(args.some(a=>a!=='--apply-drafts')||args.length>1)
    throw new Error('Use sem argumentos para prévia ou --apply-drafts para criar somente rascunhos.')
  const apply=args.includes('--apply-drafts')
  const url=stockSheetUrl(process.env.AUTOFLOW_STOCK_SHEET_ID,process.env.AUTOFLOW_STOCK_SHEET_TAB)
  const base=new URL(process.env.AUTOFLOW_BRIDGE_API_BASE||'http://127.0.0.1:3333')
  if(base.protocol!=='http:'||!['127.0.0.1','localhost'].includes(base.hostname)||
    base.username||base.password||base.search||base.hash||base.pathname!=='/')
    throw new Error('A API local deve usar apenas o loopback HTTP.')
  const token=process.env.AUTOFLOW_INTEGRATION_TOKEN||''
  if(!/^afi_[A-Za-z0-9_-]{43}$/.test(token))throw new Error('Credencial de integração ausente ou inválida.')
  const path=process.env.GOOGLE_APPLICATION_CREDENTIALS
  if(!path)throw new Error('Configure GOOGLE_APPLICATION_CREDENTIALS fora do repositório.')
  let googleToken
  try{
    const credentials=JSON.parse(await readFile(path,'utf8'))
    if(credentials.type!=='service_account'||typeof credentials.client_email!=='string'||
      typeof credentials.private_key!=='string')throw new Error('Credencial inválida.')
    const client=new JWT({email:credentials.client_email,key:credentials.private_key,
      scopes:['https://www.googleapis.com/auth/spreadsheets.readonly']})
    googleToken=(await client.getAccessToken()).token
    if(!googleToken)throw new Error('Token indisponível.')
  }catch{throw new Error('Não foi possível autenticar a conta de serviço Google. Verifique a configuração local.')}
  let sheet
  try{
    sheet=await boundedJson(await fetch(url,{headers:{Authorization:'Bearer '+googleToken},
      redirect:'error',signal:AbortSignal.timeout(30000)}),2*1024*1024)
  }catch{throw new Error('Leitura Google Sheets falhou ou excedeu os limites. Nenhuma aplicação solicitada.')}
  const snapshot=sheetStockSnapshot(sheet.values)
  const body=JSON.stringify(apply?{confirm:'create_drafts',snapshot}:snapshot)
  if(Buffer.byteLength(body)>1024*1024)throw new Error('Snapshot excede 1 MiB.')
  const endpoint=apply?'apply-drafts':'preview'
  let result
  try{
    const response=await fetch(new URL('/api/integration/v1/stock/'+endpoint,base),{
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
      body,redirect:'error',signal:AbortSignal.timeout(30000)})
    result=await boundedJson(response,4*1024*1024)
  }catch{throw new Error('Consulta/aplicação local não confirmada. Confira a API e as permissões; gere nova prévia antes de repetir.')}
  if(apply){
    if(result.applied!==true||!Array.isArray(result.created)||!Array.isArray(result.skipped))
      throw new Error('Resultado da aplicação não confirmado.')
    console.log(JSON.stringify({mode:'CREATE_DRAFTS',created:result.created.length,skipped:result.skipped.length,
      requiresReview:true,note:'Confira os rascunhos no painel. Nenhum trabalho de publicação criado.'},null,2))
  }else{
    if(result.readOnly!==true||!result.counts)throw new Error('Resultado da prévia inválido.')
    console.log(JSON.stringify({mode:'PREVIEW_ONLY',sourceRows:result.sourceRows,counts:result.counts,
      validation:{complete:result.validation?.completeSourceFields,incomplete:result.validation?.incompleteSourceFields},
      explicitSaleSignals:result.commercialReview?.explicitSaleSignals,requiresReview:result.commercialReview?.requiresReview},null,2))
  }
}
main().catch(error=>{console.error('Estoque Sheets: '+error.message);process.exitCode=1})
