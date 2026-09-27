import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { servePanel } from '../server/services/static-panel.ts'
import { startTestServer, createApiClient } from './helpers/server.mjs'
import { jpegBase64 } from './helpers/images.mjs'

const server=await startTestServer()
const db=new DatabaseSync(join(server.dataDir,'autoflow.db'))
const anonymous=createApiClient(server.base,'')
const login=()=>anonymous('/auth/login',{method:'POST',body:JSON.stringify({email:server.email,password:server.password})})
try{
  const salt='0123456789abcdef0123456789abcdef'
  const legacy=`${salt}:${scryptSync(server.password,salt,64).toString('hex')}`
  db.prepare('UPDATE users SET password_hash=? WHERE email=?').run(legacy,server.email)
  const first=await login()
  assert(db.prepare('SELECT password_hash hash FROM users WHERE email=?').get(server.email).hash.startsWith('scrypt-v2:'))
  const second=await login()
  const firstSession=JSON.parse(Buffer.from(first.token.split('.')[0],'base64url')).sessionId
  const firstClient=createApiClient(server.base,first.token),secondClient=createApiClient(server.base,second.token)
  db.prepare("UPDATE auth_sessions SET expires_at=datetime('now','-1 second') WHERE id=?").run(firstSession)
  await assert.rejects(()=>firstClient('/me'),error=>error.status===401)
  assert((await secondClient('/me')).user.id)
  await secondClient('/auth/logout',{method:'POST'})
  await assert.rejects(()=>secondClient('/me'),error=>error.status===401)
  const third=await login(),client=createApiClient(server.base,third.token)
  assert.equal(db.prepare('SELECT id FROM auth_sessions WHERE id=?').get(firstSession),undefined,'Login must remove expired sessions')
  const user=(await client('/me')).user
  db.prepare("INSERT INTO auth_sessions (id,user_id,organization_id,expires_at,revoked_at) VALUES ('old-revoked',?,?,datetime('now','1 day'),datetime('now','-31 days'))").run(user.id,user.organizationId)
  await login()
  assert.equal(db.prepare("SELECT id FROM auth_sessions WHERE id='old-revoked'").get(),undefined)
  const plans=db.prepare("EXPLAIN QUERY PLAN DELETE FROM auth_sessions WHERE datetime(expires_at)<=CURRENT_TIMESTAMP OR (revoked_at IS NOT NULL AND datetime(revoked_at)<=datetime('now','-30 days'))").all().map(row=>row.detail).join(' ')
  assert.match(plans,/idx_auth_sessions_expiry/)
  assert.match(plans,/idx_auth_sessions_revoked/)
  const vehicle=(await client('/vehicles/paged?limit=1')).vehicles[0]
  const image=await client(`/vehicles/${vehicle.id}/images`,{method:'POST',body:JSON.stringify({name:'stream.jpg',mimeType:'image/jpeg',dataBase64:jpegBase64('stream')})})
  const response=await fetch(image.url)
  assert.equal(response.status,200)
  assert.equal(response.headers.get('x-content-type-options'),'nosniff')
  const body=Buffer.from(await response.arrayBuffer())
  assert.equal(body.length,Number(response.headers.get('content-length')))
  assert(body.equals(Buffer.from(jpegBase64('stream'),'base64')))
  const dist=await mkdtemp(join(tmpdir(),'autoflow-static-'))
  await writeFile(join(dist,'index.html'),'<html lang="pt-BR"><body>Fixture</body></html>')
  const web=createServer(async(req,res)=>{
    if(!await servePanel(req,res,new URL(req.url,'http://localhost'),dist)){res.writeHead(404);res.end()}
  })
  await new Promise(resolve=>web.listen(0,'127.0.0.1',resolve))
  try{
    const origin=`http://127.0.0.1:${web.address().port}`
    const panel=await fetch(origin+'/')
    assert.equal(panel.status,200);assert.match(await panel.text(),/<html lang="pt-BR">/)
    assert.equal((await fetch(origin+'/.env')).status,404)
    assert.equal((await fetch(origin+'/assets/source.js.map')).status,404)
    assert.equal((await fetch(origin+'/index.html',{method:'HEAD'})).status,200)
  }finally{await new Promise(resolve=>web.close(resolve));await rm(dist,{recursive:true,force:true})}
  const jobId=Number(db.prepare("INSERT INTO publication_jobs(organization_id,vehicle_id,status) VALUES(?,?,'error')").run(user.organizationId,vehicle.id).lastInsertRowid)
  for(let i=0;i<51;i++)db.prepare("INSERT INTO publication_job_events(organization_id,publication_job_id,event_type,details) VALUES(?,?,'fill_error',?)").run(user.organizationId,jobId,JSON.stringify({error:`Failure ${i}`}))
  const issues=await client('/reports/issues')
  assert.equal(issues.issues.length,50);assert.equal(issues.page.hasMore,true)
  const older=await client(`/reports/issues?before=${issues.page.nextCursor}`)
  assert.equal(older.issues.length,1);assert.equal(older.page.hasMore,false)
  assert(!issues.issues.some(issue=>issue.eventId===older.issues[0].eventId))
  console.log('✓ Login legado atualizado, expiração e revogação isoladas, limpeza indexada, streaming e painel compilado.')
}finally{db.close();await server.close()}
