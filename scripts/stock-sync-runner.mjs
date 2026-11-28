#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { runStockSheet } from './stock-sheet.mjs'
import { stockRunnerOptions, runPeriodicStockRound, latestStockRound } from './stock-sync-runner-lib.mjs'

async function main(){
  const options=stockRunnerOptions(process.argv.slice(2))
  // Keep runtime state out of the application database and source control.
  const path=fileURLToPath(new URL('../data/stock-sync-runner.sqlite',import.meta.url))
  if(options.status){
    if(!existsSync(path)){console.log(JSON.stringify({status:'never_run'}));return}
    const db=new DatabaseSync(path,{readOnly:true})
    try{console.log(JSON.stringify(latestStockRound(db)??{status:'never_run'},null,2))}
    finally{db.close()}
    return
  }
  mkdirSync(dirname(path),{recursive:true})
  const db=new DatabaseSync(path)
  const stop=new AbortController()
  const onStop=()=>stop.abort()
  process.on('SIGINT',onStop)
  process.on('SIGTERM',onStop)
  try{
    do{
      const result=await runPeriodicStockRound(db,{...options,run:runStockSheet})
      if(result.status!=='not_due'||!options.watch)console.log(JSON.stringify(result,null,2))
      if(!options.watch){
        if(result.status==='error')process.exitCode=1
        break
      }
      if(stop.signal.aborted)break
      const delay=result.status==='busy'?15000:Math.max(1000,Math.min(60000,(result.nextRunAt??Date.now())-Date.now()))
      await sleep(delay,undefined,{signal:stop.signal}).catch(error=>{if(!stop.signal.aborted)throw error})
    }while(!stop.signal.aborted)
  }finally{
    process.off('SIGINT',onStop)
    process.off('SIGTERM',onStop)
    db.close()
  }
}
main().catch(error=>{
  // Configuration errors are fixed strings; suppress unexpected provider details.
  console.error('Sincronização de estoque interrompida. Confira configuração e estado local.')
  if(error instanceof Error&&/^Use --watch|^Modo inválido|^Configure a pasta Drive/.test(error.message))console.error(error.message)
  process.exitCode=1
})
