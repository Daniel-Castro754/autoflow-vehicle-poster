import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stockRunnerOptions, runPeriodicStockRound, latestStockRound } from '../scripts/stock-sync-runner-lib.mjs'

assert.deepEqual(stockRunnerOptions([],{}),{watch:false,status:false,mode:'preview',intervalMinutes:30})
assert.equal(stockRunnerOptions(['--watch'],{AUTOFLOW_STOCK_SYNC_INTERVAL_MINUTES:'5'}).intervalMinutes,5)
assert.equal(stockRunnerOptions(['--mode=drafts-and-photos'],{AUTOFLOW_STOCK_DRIVE_FOLDER_ID:'fixture'}).mode,'drafts-and-photos')
for(const args of [['--publish'],['--mode='],['--mode=photos'],['--watch','--watch'],['--status','--watch'],['--mode=preview','--mode=drafts']])
  assert.throws(()=>stockRunnerOptions(args,{}))
for(const value of ['0','4','1441','5.5','NaN',''])
  assert.throws(()=>stockRunnerOptions([],{AUTOFLOW_STOCK_SYNC_INTERVAL_MINUTES:value}))

const dir=mkdtempSync(join(tmpdir(),'autoflow-stock-runner-'))
const path=join(dir,'state.sqlite')
let db=new DatabaseSync(path)
const other=new DatabaseSync(path)
try{
  let now=1700000000000
  const clock=()=>now
  const calls=[]
  let failure=null
  const run=async args=>{
    calls.push(args)
    if(failure===args[0])throw new Error('secret-provider-token')
    if(args[0]==='--apply-drafts')return {mode:'CREATE_DRAFTS',created:1,skipped:2,secret:'not-persisted'}
    if(args[0]==='--upload-photos')return {mode:'UPLOAD_PHOTOS',uploaded:3,alreadyPresent:0,deferred:1}
    return {mode:'PREVIEW_ONLY',sourceRows:4,counts:{new:1,changed:1,unchanged:2,conflict:0},
      validation:{complete:4,incomplete:0},explicitSaleSignals:0,requiresReview:0,secret:'not-persisted'}
  }
  const round=mode=>runPeriodicStockRound(db,{mode,intervalMinutes:5,run,clock})
  assert.equal(latestStockRound(db),null)
  let release
  let entered
  const started=new Promise(resolve=>{entered=resolve})
  const gate=new Promise(resolve=>{release=resolve})
  const inProgress=runPeriodicStockRound(db,{intervalMinutes:5,clock,run:async args=>{
    entered()
    await gate
    return run(args)
  }})
  await started
  const overlapping=await runPeriodicStockRound(other,{intervalMinutes:5,clock,run:()=>{throw new Error('Must not run')}})
  assert.deepEqual(overlapping,{status:'busy'})
  release()
  const first=await inProgress
  assert.equal(first.status,'ok')
  assert.equal(first.nextRunAt,now+300000)
  assert.deepEqual(calls,[[]])
  assert.equal(latestStockRound(db).status,'ok')
  db.close()
  db=new DatabaseSync(path)
  assert.equal((await round('drafts')).status,'not_due')
  assert.deepEqual(calls,[[]])
  now=first.nextRunAt
  failure='--apply-drafts'
  const failed=await round('drafts-and-photos')
  assert.equal(failed.status,'error')
  assert.equal(failed.failedPhase,'drafts')
  assert.equal(failed.failureStreak,1)
  assert.equal(failed.nextRunAt,now+600000)
  assert.deepEqual(calls,[[],['--apply-drafts']])
  now=failed.nextRunAt
  failure='--upload-photos'
  const partial=await round('drafts-and-photos')
  assert.equal(partial.failedPhase,'photos')
  assert.equal(partial.steps[0].created,1)
  assert.equal(partial.failureStreak,2)
  assert.equal(partial.nextRunAt,now+1200000)
  now=partial.nextRunAt
  failure=null
  const success=await round('drafts-and-photos')
  assert.equal(success.status,'ok')
  assert.equal(success.failureStreak,0)
  assert.equal(success.nextRunAt,now+300000)
  assert.deepEqual(calls.slice(-2),[['--apply-drafts'],['--upload-photos']])
  assert.equal(latestStockRound(db).steps[1].uploaded,3)
  assert(!JSON.stringify(db.prepare('SELECT * FROM stock_sync_runs').all()).includes('secret'))
  for(let i=0;i<105;i++){
    now+=300000
    assert.equal((await round('preview')).status,'ok')
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_sync_runs').get().n,100)
}finally{
  db.close()
  other.close()
  rmSync(dir,{recursive:true,force:true})
}
console.log('✓ Stock periodic runner: persistent cadence, concurrent exclusion, explicit modes, phase failure, backoff, recovery and bounded secret-free history')
