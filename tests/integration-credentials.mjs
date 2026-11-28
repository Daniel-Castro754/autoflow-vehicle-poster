import { jpegBase64 } from './helpers/images.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { startTestServer, createApiClient } from './helpers/server.mjs'

const server = await startTestServer()
const db = new DatabaseSync(join(server.dataDir, 'autoflow.db'))
try {
  const anonymous = createApiClient(server.base, '')
  const login = await anonymous('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: server.email, password: server.password }),
  })
  const api = createApiClient(server.base, login.token)
  const create = (payload) =>
    api('/integrations/credentials', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  const issued = await create({
    name: 'ChatGPT leitura',
    scopes: ['status:read', 'vehicles:read'],
  })
  assert.match(issued.token, /^afi_[A-Za-z0-9_-]{43}$/)
  const org = db.prepare('SELECT organization_id id FROM users WHERE email=?').get(server.email).id
  const stored = db
    .prepare(
      'SELECT token_hash hash,organization_id org,active FROM integration_credentials WHERE id=?',
    )
    .get(issued.id)
  assert.equal(stored.hash, createHash('sha256').update(issued.token).digest('hex'))
  assert.equal(stored.org, org)
  assert.equal(stored.active, 1)
  const listed = await api('/integrations/credentials')
  assert(listed.credentials.some((credential) => credential.id === issued.id))
  assert(!JSON.stringify(listed).includes(issued.token))
  assert(!JSON.stringify(listed).includes(stored.hash))
  const integrated = createApiClient(server.base, issued.token)
  const status = await integrated('/integration/v1/status')
  assert.equal(status.readOnly, true)
  const vehicles = await integrated('/integration/v1/vehicles')
  assert(Array.isArray(vehicles.vehicles))
  await assert.rejects(integrated('/integration/v1/accounts'), (error) => error.status === 403)
  await assert.rejects(integrated('/integrations/credentials'), (error) => error.status === 401)
  await assert.rejects(
    create({ name: 'Invalid', scopes: ['vehicles:write'] }),
    (error) => error.status === 400,
  )
  await assert.rejects(
    create({ name: 'Duplicated', scopes: ['status:read', 'status:read'] }),
    (error) => error.status === 400,
  )
  await assert.rejects(
    create({ name: 'Expired', scopes: ['status:read'], expiresAt: '2020-01-01T00:00:00.000Z' }),
    (error) => error.status === 400,
  )
  const draftPayload = {
    year: 2020,
    make: 'Volkswagen',
    model: 'Saveiro',
    price: 68000,
    km: 80000,
    vehicleType: 'Carro/picape',
    transmission: 'Manual',
    fuelType: 'Flex',
    bodyType: 'Picape',
    condition: 'Bom',
    exteriorColor: 'Branco',
    interiorColor: 'Preto',
    location: 'Criciúma, SC',
    stockCode: 'INTEGRATION-DRAFT-001',
    status: 'Publicado',
  }
  await assert.rejects(
    integrated('/integration/v1/vehicles', {
      method: 'POST',
      body: JSON.stringify(draftPayload),
    }),
    (error) => error.status === 403,
  )
  const writer = await create({
    name: 'Cadastro de rascunhos',
    scopes: ['vehicles:create', 'vehicles:read'],
  })
  const writerStatusCredential = await create({
    name: 'Status com escrita',
    scopes: ['status:read', 'vehicles:create'],
  })
  const writerStatusApi = createApiClient(server.base, writerStatusCredential.token)
  const writerStatus = await writerStatusApi('/integration/v1/status')
  assert.equal(writerStatus.readOnly, false)
  const writeApi = createApiClient(server.base, writer.token)
  const draft = await writeApi('/integration/v1/vehicles', {
    method: 'POST',
    body: JSON.stringify(draftPayload),
  })
  assert.equal(draft.status, 'Rascunho')
  assert.equal(draft.requiresReview, true)
  const storedDraft = db
    .prepare(
      'SELECT organization_id organizationId,status,assigned_user_id assignedUserId FROM vehicles WHERE id=?',
    )
    .get(draft.id)
  assert.equal(storedDraft.organizationId, org)
  assert.equal(storedDraft.status, 'Rascunho')
  assert.equal(
    db.prepare('SELECT COUNT(*) count FROM publication_jobs WHERE vehicle_id=?').get(draft.id)
      .count,
    0,
  )
  await assert.rejects(
    writeApi('/integration/v1/vehicles', {
      method: 'POST',
      body: JSON.stringify(draftPayload),
    }),
    (error) => error.status === 409,
  )
  await assert.rejects(
    writeApi('/integration/v1/vehicles', {
      method: 'POST',
      body: JSON.stringify({ ...draftPayload, stockCode: 'INTEGRATION-INVALID', year: 1800 }),
    }),
    (error) => error.status === 400,
  )
  const ownVehicles = await writeApi('/integration/v1/vehicles')
  assert(ownVehicles.vehicles.some((vehicle) => vehicle.id === draft.id))
  assert(
    db
      .prepare(
        "SELECT COUNT(*) count FROM integration_audit_events WHERE organization_id=? AND action='vehicles:create' AND resource_id=?",
      )
      .get(org, draft.id).count > 0,
  )
  const photo = { mimeType: 'image/jpeg', dataBase64: jpegBase64('integration-photo-1') }
  await assert.rejects(
    writeApi(`/integration/v1/vehicles/${draft.id}/photos`, {
      method: 'POST',
      body: JSON.stringify(photo),
    }),
    (error) => error.status === 403,
  )
  const photoCredential = await create({
    name: 'Upload de fotos',
    scopes: ['photos:write'],
  })
  const photoApi = createApiClient(server.base, photoCredential.token)
  const uploaded = await photoApi(`/integration/v1/vehicles/${draft.id}/photos`, {
    method: 'POST',
    body: JSON.stringify(photo),
  })
  assert.equal(uploaded.vehicleId, draft.id)
  assert.equal(uploaded.requiresReview, true)
  const duplicatePhoto = await photoApi(`/integration/v1/vehicles/${draft.id}/photos`, {
    method: 'POST',
    body: JSON.stringify(photo),
  })
  assert.equal(duplicatePhoto.duplicate, true)
  assert.equal(duplicatePhoto.id, uploaded.id)
  await assert.rejects(
    photoApi(`/integration/v1/vehicles/${draft.id}/photos`, {
      method: 'POST',
      body: JSON.stringify({ ...photo, dataBase64: 'invalid' }),
    }),
    (error) => error.status === 400,
  )
  await assert.rejects(
    photoApi('/integration/v1/vehicles/999999999/photos', {
      method: 'POST',
      body: JSON.stringify(photo),
    }),
    (error) => error.status === 404,
  )
  assert.equal(
    db.prepare('SELECT COUNT(*) count FROM vehicle_images WHERE vehicle_id=?').get(draft.id).count,
    1,
  )
  await assert.rejects(
    integrated('/integration/v1/reports/monthly?month=2026-10'),
    (error) => error.status === 403,
  )
  const reporter = await create({
    name: 'Relatório mensal',
    scopes: ['reports:read'],
  })
  const reportApi = createApiClient(server.base, reporter.token)
  await assert.rejects(
    reportApi('/integration/v1/reports/monthly?month=2026-13'),
    (error) => error.status === 400,
  )
  const report = await reportApi('/integration/v1/reports/monthly?month=2026-10')
  assert.equal(report.month, '2026-10')
  assert.equal(report.period.start, '2026-10-01')
  assert.equal(report.period.endExclusive, '2026-11-01')
  assert(report.currentInventorySnapshot.total >= 1)
  assert(Array.isArray(report.notes) && report.notes.length > 0)
  const foreignOrg = Number(
    db.prepare("INSERT INTO organizations(name) VALUES('Outro tenant')").run().lastInsertRowid,
  )
  const foreign = db
    .prepare(
      'INSERT INTO integration_credentials (organization_id,name,token_hash,scopes) VALUES (?,?,?,?)',
    )
    .run(foreignOrg, 'Segredo externo', 'f'.repeat(64), '["status:read"]')
  assert(!JSON.stringify(await api('/integrations/credentials')).includes('Segredo externo'))
  await assert.rejects(
    api(`/integrations/credentials/${foreign.lastInsertRowid}/revoke`, { method: 'POST' }),
    (error) => error.status === 404,
  )
  // Stock synchronization preview is scoped, non-mutating and never treats
  // absence as a sale. A declared complete snapshot is not verified provenance.
  const stockFixture = db.prepare(
    'INSERT INTO vehicles(organization_id,year,make,model,price,km,stock_code,vin,status) VALUES(?,?,?,?,?,?,?,?,?)',
  )
  const absentId = Number(stockFixture.run(org,2020,'Volkswagen','Saveiro',68000,80000,'SYNC-ABSENT','SYNCVIN123','Rascunho').lastInsertRowid)
  const protectedId = Number(stockFixture.run(org,2020,'Volkswagen','Saveiro',68000,80000,'SYNC-PROTECTED','','Pronto').lastInsertRowid)
  db.prepare("INSERT INTO publication_jobs(organization_id,vehicle_id,status) VALUES(?,?,'pending')").run(org,protectedId)
  stockFixture.run(foreignOrg,2020,'Volkswagen','Saveiro',68000,80000,'SYNC-NEW','FOREIGNVIN123','Rascunho')
  // Explicit identity and hash are rechecked at upload; concurrent retries
  // of identical content must not create two rows.
  const existingHash=createHash('sha256').update(Buffer.from(photo.dataBase64,'base64')).digest('hex')
  const freshPhoto={mimeType:'image/jpeg',dataBase64:jpegBase64('sync-photo-fresh')}
  const freshHash=createHash('sha256').update(Buffer.from(freshPhoto.dataBase64,'base64')).digest('hex')
  const uploadTo=(id,body)=>photoApi('/integration/v1/vehicles/'+id+'/photos',{method:'POST',body:JSON.stringify(body)})
  await assert.rejects(uploadTo(absentId,{...photo,stockCode:'SYNC-ABSENT',sha256:existingHash}),error=>error.status===409)
  await assert.rejects(uploadTo(absentId,{...freshPhoto,stockCode:'WRONG',sha256:freshHash}),error=>error.status===409)
  await assert.rejects(uploadTo(absentId,{...freshPhoto,stockCode:'SYNC-ABSENT',sha256:'a'.repeat(64)}),error=>error.status===400)
  const concurrent=await Promise.all([1,2].map(()=>uploadTo(absentId,{...freshPhoto,stockCode:'sync-absent',sha256:freshHash})))
  assert.equal(concurrent[0].id,concurrent[1].id)
  assert.equal(concurrent.filter(item=>item.duplicate===true).length,1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vehicle_images WHERE vehicle_id=?').get(absentId).n,1)
  db.prepare("UPDATE vehicles SET status='Rascunho' WHERE id=?").run(protectedId)
  await assert.rejects(uploadTo(protectedId,{mimeType:'image/jpeg',dataBase64:jpegBase64('protected-new-photo')}),error=>error.status===409)
  db.prepare("UPDATE vehicles SET status='Pronto' WHERE id=?").run(protectedId)
  const sourceRow={stockCode:draftPayload.stockCode,year:2020,make:'Volkswagen',model:'Saveiro',price:68000,km:80000}
  const snapshot=()=>JSON.stringify({
    vehicles:db.prepare('SELECT * FROM vehicles ORDER BY id').all(),
    jobs:db.prepare('SELECT * FROM publication_jobs ORDER BY id').all(),
    photos:db.prepare('SELECT * FROM vehicle_images ORDER BY id').all(),
  })
  const beforePreview=snapshot()
  const envelope=(rows,sourceState='complete')=>({version:1,source:'sheets',sourceState,rows})
  const preview=(body,client=integrated)=>client('/integration/v1/stock/preview',{method:'POST',body:JSON.stringify(body)})
  const newRow={...sourceRow,stockCode:'sync-new'}
  const plan=await preview(envelope([sourceRow,newRow]))
  assert.equal(plan.readOnly,true)
  assert.deepEqual(plan.counts,{new:1,changed:0,unchanged:1,conflict:0})
  assert.equal(plan.entries[0].vehicleId,draft.id)
  assert.equal(plan.entries[1].stockCode,'SYNC-NEW')
  assert(plan.absence.comparable)
  assert(plan.absence.exampleVehicleIds.includes(absentId))
  const edited=await preview(envelope([{...sourceRow,price:69000}]))
  assert.equal(edited.entries[0].category,'changed')
  assert.deepEqual(edited.entries[0].changedFields,['price'])
  const protectedPlan=await preview(envelope([{...sourceRow,stockCode:'SYNC-PROTECTED',price:69000}]))
  assert.equal(protectedPlan.entries[0].reason,'protected_local_vehicle')
  assert.equal(protectedPlan.absence.comparable,false)
  const duplicate=await preview(envelope([newRow,{...newRow,stockCode:' SYNC-NEW '}]))
  assert.equal(duplicate.counts.conflict,2)
  assert.equal(duplicate.absence.count,null)
  const duplicatedVin=await preview(envelope([{...newRow,vin:'VIN12345'},{...newRow,stockCode:'SYNC-NEW-2',vin:'VIN12345'}]))
  assert.equal(duplicatedVin.counts.conflict,2)
  const identityConflict=await preview(envelope([{...sourceRow,vin:'SYNCVIN123'}]))
  assert.equal(identityConflict.entries[0].reason,'local_identity_conflict')
  const partial=await preview(envelope([sourceRow],'partial'))
  assert.equal(partial.absence.count,null)
  assert.equal((await preview(envelope([]))).absence.comparable,false)
  assert.equal((await preview(envelope([],'failed'))).absence.count,null)
  await assert.rejects(preview(envelope([sourceRow],'failed')),error=>error.status===400)
  await assert.rejects(preview(envelope([{...sourceRow,status:'Vendido'}])),error=>error.status===400)
  await assert.rejects(preview(envelope([{...sourceRow,stockCode:'A'.repeat(65)}])),error=>error.status===400)
  await assert.rejects(preview(envelope([{...sourceRow,price:'68000'}])),error=>error.status===400)
  await assert.rejects(preview({...envelope([sourceRow]),organizationId:foreignOrg}),error=>error.status===400)
  await assert.rejects(preview(envelope([sourceRow]),writerStatusApi),error=>error.status===403)
  const manifest=await preview({...envelope([sourceRow,newRow,{...sourceRow,stockCode:'SYNC-PROTECTED'}]),photos:[
    {stockCode:sourceRow.stockCode,sha256:existingHash},
    {stockCode:'SYNC-NEW',sha256:freshHash},
    {stockCode:'SYNC-NEW',sha256:'1'.repeat(64)},
    {stockCode:'SYNC-NEW',sha256:'1'.repeat(64)},
    {stockCode:'UNKNOWN-STOCK',sha256:'2'.repeat(64)},
    {stockCode:'SYNC-PROTECTED',sha256:'3'.repeat(64)},
    {stockCode:sourceRow.stockCode,sha256:'4'.repeat(64)},
    {stockCode:'SYNC-NEW',sha256:'4'.repeat(64)},
  ]})
  assert.deepEqual(manifest.photoPreview.counts,{new:1,already_present:1,conflict:6})
  assert.deepEqual(manifest.photoPreview.entries.map(p=>p.reason||p.category),[
    'already_present','shared_local_photo','new','duplicate_manifest_photo','vehicle_identity_unresolved',
    'protected_local_vehicle','shared_source_photo','shared_source_photo',
  ])
  const photoLimit=await preview({...envelope([newRow]),photos:Array.from({length:21},(_,i)=>({stockCode:'SYNC-NEW',sha256:(100+i).toString(16).padStart(64,'0')}))})
  assert.equal(photoLimit.photoPreview.counts.new,20)
  assert.equal(photoLimit.photoPreview.entries[20].reason,'photo_limit')
  await assert.rejects(preview({...envelope([newRow]),photos:[{stockCode:'SYNC-NEW',sha256:'invalid'}]}),error=>error.status===400)
  await assert.rejects(preview({...envelope([newRow]),photos:[{stockCode:'SYNC-NEW',sha256:'a'.repeat(64),url:'https://example.test/image.jpg'}]}),error=>error.status===400)
  await assert.rejects(preview({...envelope([],'failed'),photos:[{stockCode:'SYNC-NEW',sha256:'a'.repeat(64)}]}),error=>error.status===400)
  console.log('✓ Photo reconciliation: exact stock identity, hashes, shared photos, gallery limits and concurrent idempotent upload')
  // Source completeness is separate from identity and actual publication readiness.
  const details={vehicleType:'Carro/picape',location:'Criciúma, SC',transmission:'Manual',fuelType:'Flex',bodyType:'Picape',exteriorColor:'Branco',interiorColor:'Preto',condition:'Bom',description:'Descrição fornecida na origem'}
  const validation=await preview({...envelope([{...newRow,...details},sourceRow,{...newRow,stockCode:'SYNC-INVALID-DETAILS',...details,transmission:'invalid-secret-value',location:' ',interiorColor:''}]),photos:[{stockCode:'SYNC-NEW',sha256:'5'.repeat(64)}]})
  assert.equal(validation.validation.total,3)
  assert.equal(validation.validation.completeSourceFields,1)
  assert.equal(validation.validation.incompleteSourceFields,2)
  const [complete,missing,invalid]=validation.validation.items
  assert.equal(complete.sourceFieldsComplete,true)
  assert.deepEqual(complete.missingFields,[])
  assert.deepEqual(complete.invalidFields,[])
  assert.equal(complete.localPhotoCount,0)
  assert.equal(complete.declaredNewPhotos,1)
  assert.equal(complete.requiresPhotoVerification,true)
  assert.equal(complete.needsPhotos,false)
  assert.equal(missing.sourceFieldsComplete,false)
  assert.equal(missing.missingFields.length,9,'Do not infer source fields from existing vehicle or defaults')
  assert.equal(missing.localPhotoCount,1)
  assert.equal(missing.needsPhotos,false)
  assert.deepEqual(invalid.missingFields,['location','interiorColor'])
  assert.deepEqual(invalid.invalidFields,['transmission'])
  assert.equal(invalid.needsPhotos,true)
  assert(!JSON.stringify(validation).includes('invalid-secret-value'))
  const detailChange=await preview(envelope([{...sourceRow,transmission:'Automático'}]))
  assert.equal(detailChange.entries[0].category,'changed')
  assert.deepEqual(detailChange.entries[0].changedFields,['transmission'])
  const identityValidation=await preview(envelope([newRow,newRow]))
  assert(identityValidation.validation.items.every(item=>item.identityConflict&&item.localPhotoCount===null))
  const noPhoto=await preview(envelope([{...newRow,...details}]))
  assert.equal(noPhoto.validation.items[0].sourceFieldsComplete,true)
  assert.equal(noPhoto.validation.items[0].needsPhotos,true)
  await assert.rejects(preview(envelope([{...newRow,...details,condition:{bad:true}}])),error=>error.status===400)
  await assert.rejects(preview(envelope([{...newRow,...details,description:'x'.repeat(4001)}])),error=>error.status===400)
  console.log('✓ Stock source validation: explicit missing/invalid fields, photo evidence, no inferred defaults and no publication authorization')
  assert.equal(snapshot(),beforePreview)
  assert(db.prepare("SELECT COUNT(*) n FROM integration_audit_events WHERE organization_id=? AND action='stock:preview' AND outcome='allowed'").get(org).n>0)
  console.log('✓ Stock synchronization preview: identity, differences, partial/failed/empty sources, protection, tenant scope and no inventory changes')
  const revoked = await api(`/integrations/credentials/${issued.id}/revoke`, { method: 'POST' })
  assert.equal(revoked.revoked, true)
  await assert.rejects(integrated('/integration/v1/status'), (error) => error.status === 401)
  await assert.rejects(
    api(`/integrations/credentials/${issued.id}/revoke`, { method: 'POST' }),
    (error) => error.status === 404,
  )
  const audit = db
    .prepare('SELECT action,outcome FROM integration_audit_events WHERE organization_id=?')
    .all(org)
  assert(audit.some((event) => event.action === 'credential:create'))
  assert(audit.some((event) => event.action === 'credential:revoke'))
  assert(audit.some((event) => event.action === 'accounts:read' && event.outcome === 'denied'))
  console.log('✓ Integration credentials: scope, hashing, tenant isolation, audit and revocation')
} finally {
  db.close()
  await server.close()
}
