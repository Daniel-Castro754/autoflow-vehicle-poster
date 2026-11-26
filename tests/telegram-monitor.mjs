import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initializeBaseSchema, registerSqliteFunctions } from '../server/database/schema.ts'
import { applyMigrations } from '../server/database/migrations.ts'
import { saveTelegramMonitorSettings, telegramMonitorSettings, runTelegramMonitor } from '../server/services/telegram-monitor.ts'
const db=new DatabaseSync(':memory:')
initializeBaseSchema(db)
registerSqliteFunctions(db)
applyMigrations(db)
db.exec("INSERT INTO organizations(id,name) VALUES(1,'One'),(2,'Two'); INSERT INTO organization_settings(organization_id) VALUES(1),(2); INSERT INTO users(id,organization_id,name,email,password_hash) VALUES(1,1,'Owner','one@local','fixture'),(2,2,'Owner','two@local','fixture'); INSERT INTO social_accounts(id,organization_id,user_id,label,status,last_seen_at) VALUES(1,1,1,'Mae','connected',CURRENT_TIMESTAMP),(2,2,2,'Other','connected',CURRENT_TIMESTAMP); INSERT INTO vehicles(id,organization_id,year,make,model) VALUES(1,1,2022,'VW','Nivus'),(2,2,2022,'Private','Other'); INSERT INTO publication_jobs(id,organization_id,vehicle_id,social_account_id) VALUES(1,1,1,1),(2,2,2,2); INSERT INTO publication_job_events(organization_id,publication_job_id,event_type) VALUES(1,1,'created');")
assert.deepEqual(telegramMonitorSettings(db,1).categories,[])
assert.throws(()=>saveTelegramMonitorSettings(db,1,['unknown']))
saveTelegramMonitorSettings(db,1,['schedule','review','profiles','daily'])
const now=Date.now()
db.exec("INSERT INTO publication_job_events(organization_id,publication_job_id,event_type,details) VALUES(1,1,'filled_waiting_confirmation','{\"missing\":[\"Localização\",\"secret-token\"]}'),(2,2,'created','{}')")
const messages=[]
const sender=async(text,config)=>{messages.push({text,chat:config.telegramChatId});return true}
const credentials=(_db,org)=>({telegramBotToken:'test',telegramChatId:String(org),webhookUrl:''})
await runTelegramMonitor(db,now,sender,credentials)
assert(messages.some(m=>m.text.includes('Localização')))
assert(!messages.some(m=>m.text.includes('secret-token')||m.text.includes('Private')||m.text.includes('Trabalho criado')))
const count=messages.length
await runTelegramMonitor(db,now+1000,sender,credentials)
assert.equal(messages.length,count)
db.exec("UPDATE social_accounts SET status='disconnected' WHERE id=1")
await runTelegramMonitor(db,now+2000,sender,credentials)
assert(messages.some(m=>m.text.includes('sem presença recente')))
db.exec("UPDATE social_accounts SET status='connected',last_seen_at=CURRENT_TIMESTAMP WHERE id=1")
await runTelegramMonitor(db,now+3000,sender,credentials)
assert(messages.some(m=>m.text.includes('reconectado')))
const evening=Date.parse('2026-11-27T00:31:00Z')
await runTelegramMonitor(db,evening,sender,credentials)
await runTelegramMonitor(db,evening+60000,sender,credentials)
assert.equal(messages.filter(m=>m.text.includes('resumo até')&&m.text.includes('26/11/2026')).length,1)
assert(messages.every(m=>m.chat==='1'))
db.close()
console.log('Telegram: scoped configuration, event baseline, deduplication, presence and Brasília daily summary.')
