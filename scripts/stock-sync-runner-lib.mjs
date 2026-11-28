// Isolated local SQLite journal. Never hold a transaction in autoflow.db
// while fetching Google resources. All runner instances must share this file.
const modes=['preview','drafts','photos','drafts-and-photos']
const minute=60000
const safeCount=value=>Number.isSafeInteger(value)&&value>=0?value:null

export function stockRunnerOptions(args,env=process.env){
  const watch=args.includes('--watch')
  const status=args.includes('--status')
  const modeArg=args.filter(arg=>arg.startsWith('--mode='))
  if(new Set(args).size!==args.length||modeArg.length>1||
    args.some(arg=>arg!=='--watch'&&arg!=='--status'&&!arg.startsWith('--mode='))||
    (status&&args.length!==1))throw new Error('Use --watch, --mode=preview|drafts|photos|drafts-and-photos ou --status isolado.')
  const mode=modeArg.length?modeArg[0].slice(7):'preview'
  const raw=env.AUTOFLOW_STOCK_SYNC_INTERVAL_MINUTES??'30'
  const intervalMinutes=Number(raw)
  if(!modes.includes(mode)||!/^\d+$/.test(raw)||!Number.isInteger(intervalMinutes)||intervalMinutes<5||intervalMinutes>1440)
    throw new Error('Modo inválido ou intervalo fora de 5 a 1440 minutos.')
  if(!status&&mode.includes('photos')&&!env.AUTOFLOW_STOCK_DRIVE_FOLDER_ID)
    throw new Error('Configure a pasta Drive antes de habilitar envio de fotos.')
  return {watch,status,mode,intervalMinutes}
}
function cleanSummary(result,expected){
  if(result?.mode!==expected)throw new Error('Resultado da rodada não confirmado.')
  if(expected==='PREVIEW_ONLY'){
    if(!result.counts)throw new Error('Prévia não confirmada.')
    return {mode:expected,sourceRows:safeCount(result.sourceRows),
      counts:Object.fromEntries(['new','changed','unchanged','conflict'].map(k=>[k,safeCount(result.counts[k])])),
      complete:safeCount(result.validation?.complete),incomplete:safeCount(result.validation?.incomplete),
      saleSignals:safeCount(result.explicitSaleSignals),requiresReview:safeCount(result.requiresReview),
      photos:result.photos?Object.fromEntries(['new','already_present','conflict'].map(k=>[k,safeCount(result.photos[k])])):null}
  }
  if(expected==='CREATE_DRAFTS')return {mode:expected,created:safeCount(result.created),skipped:safeCount(result.skipped)}
  return {mode:expected,uploaded:safeCount(result.uploaded),alreadyPresent:safeCount(result.alreadyPresent),deferred:safeCount(result.deferred)}
}
function busy(error){
  return typeof error?.errcode==='number'&&[5,6].includes(error.errcode&255)
}
export async function runPeriodicStockRound(db,{mode='preview',intervalMinutes=30,run,clock=Date.now}){
  if(!modes.includes(mode)||!Number.isInteger(intervalMinutes)||intervalMinutes<5||intervalMinutes>1440||typeof run!=='function')
    throw new Error('Configuração de sincronização inválida.')
  db.exec('PRAGMA busy_timeout=0')
  try{db.exec('BEGIN IMMEDIATE')}catch(error){
    if(busy(error))return {status:'busy'}
    throw error
  }
  try{
    db.exec(`CREATE TABLE IF NOT EXISTS stock_sync_runs(
      id INTEGER PRIMARY KEY,started_at INTEGER NOT NULL,finished_at INTEGER NOT NULL,
      next_run_at INTEGER NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,
      failure_streak INTEGER NOT NULL,summary_json TEXT NOT NULL)`)
    const previous=db.prepare('SELECT next_run_at,failure_streak FROM stock_sync_runs ORDER BY id DESC LIMIT 1').get()
    const startedAt=clock()
    if(previous&&previous.next_run_at>startedAt){
      db.exec('COMMIT')
      return {status:'not_due',nextRunAt:previous.next_run_at}
    }
    const summaries=[]
    let phase='preview',status='ok'
    try{
      if(mode==='preview')summaries.push(cleanSummary(await run([]),'PREVIEW_ONLY'))
      if(mode==='drafts'||mode==='drafts-and-photos'){
        phase='drafts'
        summaries.push(cleanSummary(await run(['--apply-drafts']),'CREATE_DRAFTS'))
      }
      if(mode==='photos'||mode==='drafts-and-photos'){
        phase='photos'
        summaries.push(cleanSummary(await run(['--upload-photos']),'UPLOAD_PHOTOS'))
      }
    }catch{
      // Do not persist raw provider errors, response bodies, filenames or secrets.
      status='error'
    }
    const finishedAt=clock()
    const failureStreak=status==='error'?Math.min(10,Number(previous?.failure_streak||0)+1):0
    const delay=Math.min(1440,intervalMinutes*2**failureStreak)*minute
    const nextRunAt=finishedAt+delay
    const summary={steps:summaries,failedPhase:status==='error'?phase:null}
    db.prepare('INSERT INTO stock_sync_runs(started_at,finished_at,next_run_at,mode,status,failure_streak,summary_json) VALUES(?,?,?,?,?,?,?)')
      .run(startedAt,finishedAt,nextRunAt,mode,status,failureStreak,JSON.stringify(summary))
    db.exec('DELETE FROM stock_sync_runs WHERE id NOT IN (SELECT id FROM stock_sync_runs ORDER BY id DESC LIMIT 100)')
    db.exec('COMMIT')
    return {status,mode,startedAt,finishedAt,nextRunAt,failureStreak,...summary}
  }catch(error){
    db.exec('ROLLBACK')
    throw error
  }
}
export function latestStockRound(db){
  const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='stock_sync_runs'").get()
  if(!table)return null
  const row=db.prepare('SELECT started_at startedAt,finished_at finishedAt,next_run_at nextRunAt,mode,status,failure_streak failureStreak,summary_json summary FROM stock_sync_runs ORDER BY id DESC LIMIT 1').get()
  if(!row)return null
  const {summary,...meta}=row
  return {...meta,...JSON.parse(summary)}
}
