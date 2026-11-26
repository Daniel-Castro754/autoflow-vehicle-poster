import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { initializeBaseSchema } from '../server/database/schema.ts'
import { applyMigrations } from '../server/database/migrations.ts'
import { commanderQueryCatalog,runCommanderQuery } from '../server/services/commander-query-tools.ts'
const db=new DatabaseSync(':memory:')
initializeBaseSchema(db);applyMigrations(db)
db.exec("INSERT INTO organizations(id,name) VALUES(1,'One'),(2,'Other'); INSERT INTO organization_settings(organization_id,deepseek_api_key) VALUES(1,'secret-credential'),(2,'foreign-secret'); INSERT INTO users(id,organization_id,name,email,password_hash) VALUES(1,1,'Owner','one@local','secret-password'),(2,2,'Owner','two@local','foreign-password'); INSERT INTO social_accounts(id,organization_id,user_id,label,status,last_seen_at) VALUES(1,1,1,'Mae','connected',CURRENT_TIMESTAMP),(2,2,2,'Foreign profile','connected',CURRENT_TIMESTAMP); INSERT INTO vehicles(id,organization_id,year,make,model,price,status,description) VALUES(1,1,2022,'VW','Nivus',108900,'Pronto','raw-secret'),(2,2,2022,'Private','Other',999999,'Pronto','foreign-secret'),(3,1,2022,'Caoa','Tiggo',98900,'Pronto','raw-secret'); INSERT INTO publication_jobs(id,organization_id,vehicle_id,social_account_id,status,fill_report) VALUES(1,1,1,1,'awaiting_confirmation','{\"filledCount\":14,\"totalCount\":15,\"imageCount\":8,\"missing\":[\"Localização\",\"raw-secret\"],\"published\":false,\"publishAttempted\":false}'),(2,2,2,2,'error','{}'); INSERT INTO publication_job_events(organization_id,publication_job_id,event_type,details) VALUES(1,1,'execution_diagnostics','{\"diagnostics\":[{\"code\":\"location_checked\",\"matched\":0,\"secret\":\"raw-secret\"}]}'),(2,2,'fill_error','{}'); INSERT INTO marketplace_groups(organization_id,name,url) VALUES(1,'Cars','https://private-invite/secret'),(2,'Foreign group','');")
const tools=commanderQueryCatalog()
assert.equal(tools.length,12)
assert(tools.every(t=>t.readOnly&&t.parameters.additionalProperties===false))
const before=db.prepare('SELECT total_changes() n').get().n
const args={consultar_veiculo:{vehicleId:1},diagnosticar_trabalho:{jobId:1}}
for(const t of tools){
  const result=runCommanderQuery(db,1,t.name,args[t.name]||{})
  const json=JSON.stringify(result)
  for(const secret of ['secret-credential','secret-password','raw-secret','foreign-secret','Foreign profile','Foreign group','private-invite'])
    assert(!json.includes(secret),t.name+' leaked '+secret)
  assert.equal(result.readOnly,true)
}
const run=(name,a={})=>runCommanderQuery(db,1,name,a).data
assert.equal(run('resumo_operacional').stock.stockValue,207800)
const page=run('listar_veiculos',{limit:1})
assert.equal(page.items[0].id,3)
assert.equal(page.nextBeforeId,3)
assert.equal(run('listar_veiculos',{beforeId:3,limit:1}).items[0].id,1)
const report=run('diagnosticar_trabalho',{jobId:1})
assert.deepEqual(report.report.missing,['Localização'])
assert.equal(report.diagnostics.entries[0].matched,0)
assert.equal(report.job.reviewKind,'fill_incomplete')
assert.equal(run('listar_perfis').items.length,1)
for(const [tool,a] of [['consultar_veiculo',{vehicleId:2}],['diagnosticar_trabalho',{jobId:2}],['listar_veiculos',{limit:31}],['listar_veiculos',{limit:'1'}],['listar_veiculos',{organizationId:2}],['listar_veiculos',{status:"' OR 1=1"}],['resumo_operacional',{sql:'DROP TABLE vehicles'}],['consultar_veiculo',{}],['__proto__',{}],['executar_sql',{}]])assert.throws(()=>run(tool,a))
assert.equal(db.prepare('SELECT total_changes() n').get().n,before,'All query tools must remain read-only')
db.close()
console.log('AI Commander query catalog: 12 tools, strict arguments, scoped results, pagination, safe diagnostics and no database changes.')
