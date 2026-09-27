import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { scryptSync } from 'node:crypto'
import { initializeBaseSchema } from '../server/database/schema.ts'
import { applyMigrations } from '../server/database/migrations.ts'
import { calculateBackoff, withRetry } from '../server/lib/retry.ts'
import { hashPassword, verifyPassword } from '../server/lib/passwords.ts'
import { logger, sanitize } from '../server/lib/logger.ts'
import { sendCriticalAlert, escapeMarkdownV2 } from '../server/services/alerting.ts'
import { runAutopilotPipeline, parseVehicleRawText } from '../server/services/ai-agent.ts'
import { findBestAccountForVehicle } from '../server/services/session-manager.ts'
import { createAutomationStatements } from '../server/routes/dashboard.ts'

assert.equal(calculateBackoff(1000,1000,60000),60000)
assert.equal(calculateBackoff(Infinity,0,60000),0)
assert.throws(()=>calculateBackoff(1,-10))
let attempts=0
await assert.rejects(()=>withRetry(async()=>{attempts++;throw new Error('permanent')},{maxAttempts:3,baseDelayMs:0}))
assert.equal(attempts,1)
await assert.rejects(()=>withRetry(async()=>true,{maxAttempts:0,baseDelayMs:0}),RangeError)
const salt='0123456789abcdef0123456789abcdef',password='legacy-test-password'
assert(await verifyPassword(password,`${salt}:${scryptSync(password,salt,64).toString('hex')}`))
const current=await hashPassword(password)
assert(current.startsWith('scrypt-v2:'))
assert(await verifyPassword(password,current))
assert.equal(await verifyPassword('wrong',current),false)
assert.equal(await verifyPassword(password,'scrypt-v999:'+current),false)
const circular={password:'secret-value',token:'secret-token',error:new Error('fetch /botsecret-bot/sendMessage?key=secret-key')};circular.self=circular
const clean=JSON.stringify(sanitize(circular))
assert(!/secret-value|secret-token|secret-bot|secret-key/.test(clean))
assert(clean.includes('message'))
const originalWarn=console.warn,originalInfo=console.info,level=process.env.LOG_LEVEL
const logs=[]
try{
  console.warn=console.info=line=>logs.push(JSON.parse(line));process.env.LOG_LEVEL='warn'
  logger.info('test','hidden');logger.warn('test','visible',circular)
  assert.equal(logs.length,1);assert.equal(logs[0].details.password,'[REDACTED]')
}finally{console.warn=originalWarn;console.info=originalInfo;if(level===undefined)delete process.env.LOG_LEVEL;else process.env.LOG_LEVEL=level}
const originalFetch=globalThis.fetch
try{
  const messages=[]
  globalThis.fetch=async(url,init)=>{messages.push({url,init,body:JSON.parse(init.body)});assert(init.signal instanceof AbortSignal);return Response.json({ok:true})}
  const alert=await sendCriticalAlert({jobId:12,accountLabel:'Perfil_[1]',message:'Falha (x)! . - \\',attemptCount:2},{telegramBotToken:'test-token',telegramChatId:'test-chat',webhookUrl:'https://example.test/hook'})
  assert.deepEqual(alert,{telegram:true,webhook:true})
  assert.equal(messages[0].body.parse_mode,'MarkdownV2')
  assert(messages[0].body.text.includes(escapeMarkdownV2('Perfil_[1]')))
  assert(messages[0].body.text.includes('\\#12'))
  globalThis.fetch=async()=>{throw new Error('timeout')}
  assert.deepEqual(await sendCriticalAlert({message:'x'},{telegramBotToken:'test-token',telegramChatId:'test-chat'}),{telegram:false,webhook:false})
}finally{globalThis.fetch=originalFetch}

const db=new DatabaseSync(':memory:')
try{
  initializeBaseSchema(db);applyMigrations(db)
  const frozen=JSON.parse(await readFile(new URL('./fixtures/schema-v6-checksums.json',import.meta.url),'utf8'))
  assert.deepEqual(db.prepare('SELECT version,checksum FROM schema_migrations WHERE version<=6 ORDER BY version').all().map(row=>({...row})),frozen)
  db.exec(`DELETE FROM schema_migrations WHERE version>=7;
    INSERT INTO organizations(id,name) VALUES(1,'Audit');
    INSERT INTO organization_settings(organization_id,daily_limit,auto_publish,auto_advance) VALUES(1,2,1,1);
    INSERT INTO users(id,organization_id,name,email,password_hash) VALUES(1,1,'Audit','audit@local','fixture');
    INSERT INTO social_accounts(id,organization_id,user_id,label,status) VALUES(1,1,1,'A','connected'),(2,1,1,'B','connected'),(3,1,1,'Offline','not_connected');`)
  for(let id=1;id<=5;id++){
    db.prepare(`INSERT INTO vehicles(id,organization_id,year,make,model,price,km,status,location,description,exterior_color,interior_color,vehicle_condition)
      VALUES(?,1,2023,'Toyota',?,90000,100,'Pronto','São Paulo, SP',?,'Prata','Preto','Excelente')`).run(id,`Corolla ${id}`,'Descrição completa de teste para o veículo em estoque com informações cadastradas suficientes.')
    db.prepare("INSERT INTO vehicle_images(organization_id,vehicle_id,file_name,original_name,mime_type,content_hash) VALUES(1,?,?,?,'image/jpeg',?)").run(id,`photo-${id}.jpg`,`photo-${id}.jpg`,`unique-${id}`)
  }
  applyMigrations(db)
  assert.equal(db.prepare('SELECT exterior_color color FROM vehicles WHERE id=1').get().color,'Prateado')
  db.exec("UPDATE vehicles SET exterior_color='Prata' WHERE id=1")
  applyMigrations(db)
  assert.equal(db.prepare('SELECT exterior_color color FROM vehicles WHERE id=1').get().color,'Prata','Data repair must run once')
  db.exec("UPDATE vehicles SET exterior_color='Prateado' WHERE id=1")
  assert.throws(()=>db.exec('DELETE FROM organizations WHERE id=1'),/FOREIGN KEY/)
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)
  assert.equal(findBestAccountForVehicle(db,1,1).id,1)
  const autopilot=await runAutopilotPipeline(db,1,1)
  assert.equal(autopilot.jobsCreated,4)
  assert.deepEqual(db.prepare('SELECT social_account_id account,COUNT(*) total FROM publication_jobs GROUP BY social_account_id ORDER BY social_account_id').all().map(row=>({...row})),[{account:1,total:2},{account:2,total:2}])
  assert.equal((await runAutopilotPipeline(db,1,1)).jobsCreated,0)
  assert.equal(db.prepare('SELECT auto_publish enabled FROM organization_settings').get().enabled,1)
  db.prepare("UPDATE publication_jobs SET fill_report=? WHERE id=1").run(JSON.stringify({advanced:true,publishAttempted:true,missing:['Ano'],missingGroups:[],flowIssues:['review'],largeDebug:'x'.repeat(100000)}))
  const row=createAutomationStatements(db).latest.all(1).find(job=>job.id===1)
  const report=JSON.parse(row.fillReport)
  assert.equal(Boolean(report.advanced),true);assert.deepEqual(report.missing,['Ano']);assert(!row.fillReport.includes('largeDebug'))
  db.prepare("UPDATE publication_jobs SET fill_report='malformed' WHERE id=1").run()
  assert.equal(createAutomationStatements(db).latest.all(1).find(job=>job.id===1).fillReport,null)
  for(const [text,make,model] of [['Citroen C4 Cactus 2023','Citroën','C4 Cactus'],['Mercedes C180 2022','Mercedes-Benz','C180'],['Toyota Corolla Cross 2024','Toyota','Corolla Cross']]){
    const parsed=parseVehicleRawText(text);assert.equal(parsed.make,make);assert.equal(parsed.model,model)
  }
  assert.equal(parseVehicleRawText('Renault Corolla 2023').model,'','Never assign a model from a different detected brand')
}finally{db.close()}
console.log('✓ Compatibilidade de schema e senhas, limite de retry, logs, alertas, capacidade por conta e polling.')
