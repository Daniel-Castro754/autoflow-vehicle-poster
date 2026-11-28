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
  const sale=await preview(envelope([{...sourceRow,commercialState:'sold'}]))
  assert.equal(sale.entries[0].reason,'source_sale_requires_review')
  assert.equal(sale.commercialReview.explicitSaleSignals,1)
  assert.equal(sale.commercialReview.items[0].disposition,'review_sale')
  assert.equal(sale.commercialReview.items[0].vehicleId,draft.id)
  assert.equal(sale.commercialReview.items[0].executed,false)
  assert.equal(sale.absence.comparable,false)
  const withWork=await preview({...envelope([{...sourceRow,stockCode:'SYNC-PROTECTED',commercialState:'sold'}]),photos:[{stockCode:'SYNC-PROTECTED',sha256:'6'.repeat(64)}]})
  assert.equal(withWork.commercialReview.items[0].protectedWork,true)
  assert.equal(withWork.commercialReview.items[0].requiresHumanReview,true)
  assert.equal(withWork.photoPreview.counts.new,0)
  const unverified=await preview(envelope([{...sourceRow,stockCode:'SYNC-ABSENT',commercialState:'sold'}]))
  assert.equal(unverified.entries[0].reason,'source_sale_identity_unverified')
  const verified=await preview(envelope([{...sourceRow,stockCode:'SYNC-ABSENT',vin:'SYNCVIN123',commercialState:'sold'}],'partial'))
  assert.equal(verified.commercialReview.items[0].disposition,'review_sale')
  assert.equal(verified.absence.count,null)
  const recycled=await preview(envelope([{...sourceRow,model:'Outro modelo',commercialState:'sold'}]))
  assert.equal(recycled.entries[0].reason,'source_sale_identity_unverified')
  const foreignSale=await preview(envelope([{...newRow,commercialState:'sold'}]))
  assert.equal(foreignSale.entries[0].reason,'source_sale_unknown_vehicle')
  assert.equal(foreignSale.counts.new,0)
  assert.equal(foreignSale.commercialReview.items[0].vehicleId,null)
  const repeatedSale=await preview(envelope([{...sourceRow,commercialState:'sold'},sourceRow]))
  assert.equal(repeatedSale.commercialReview.items[0].disposition,'review_identity')
  assert.equal((await preview(envelope([],'failed'))).commercialReview.explicitSaleSignals,0)
  assert.equal((await preview(envelope([newRow]))).commercialReview.explicitSaleSignals,0)
  await assert.rejects(preview(envelope([{...sourceRow,commercialState:'Vendido'}])),error=>error.status===400)
  assert.equal(snapshot(),beforePreview)
  // Simulate a locally recorded sale only after checking that all prior
  // previews were read-only. Never revive the vehicle on an available signal.
  db.prepare("UPDATE vehicles SET status='Vendido',sold_at=CURRENT_TIMESTAMP WHERE id=?").run(draft.id)
  const soldSnapshot=snapshot()
  const recorded=await preview({...envelope([{...sourceRow,commercialState:'sold'}]),photos:[{stockCode:sourceRow.stockCode,sha256:'7'.repeat(64)}]})
  assert.equal(recorded.entries[0].reason,'source_sale_already_recorded')
  assert.equal(recorded.commercialReview.alreadyRecorded,1)
  assert.equal(recorded.photoPreview.counts.new,0)
  const available=await preview(envelope([{...sourceRow,commercialState:'available'}]))
  assert.equal(available.entries[0].reason,'source_available_local_sold')
  assert.equal(available.commercialReview.items[0].disposition,'review_availability')
  assert.equal(snapshot(),soldSnapshot)
  console.log('✓ Commercial reconciliation: explicit sales, identity verification, protected jobs, no inferred sales or reactivation')

  assert(db.prepare("SELECT COUNT(*) n FROM integration_audit_events WHERE organization_id=? AND action='stock:preview' AND outcome='allowed'").get(org).n>0)
  console.log('✓ Stock synchronization preview: identity, differences, partial/failed/empty sources, protection, tenant scope and no inventory changes')
  // Explicit application grants do not inherit from the existing draft writer.
  const applyGrant=await create({name:'Aplicar novos rascunhos',scopes:['stock:apply','vehicles:read','vehicles:create']})
  const applyClient=createApiClient(server.base,applyGrant.token)
  const apply=(snapshot,client=applyClient,confirm='create_drafts')=>client('/integration/v1/stock/apply-drafts',{method:'POST',body:JSON.stringify({confirm,snapshot})})
  const readyRow={...newRow,...details,stockCode:'SYNC-APPLIED',commercialState:'available'}
  const incompleteRow={...newRow,stockCode:'SYNC-INCOMPLETE',commercialState:'available'}
  const withoutAvailability={...newRow,...details,stockCode:'SYNC-UNDECLARED'}
  const applyBefore=snapshot()
  await assert.rejects(apply(envelope([readyRow]),writeApi),error=>error.status===403)
  await assert.rejects(apply(envelope([readyRow]),integrated),error=>error.status===403)
  await assert.rejects(apply(envelope([readyRow]),applyClient,'publish'),error=>error.status===400)
  await assert.rejects(apply(envelope([readyRow],'partial')),error=>error.status===409)
  await assert.rejects(apply(envelope([],'failed')),error=>error.status===409)
  await assert.rejects(apply(envelope([readyRow,readyRow])),error=>error.status===409)
  await assert.rejects(apply(envelope([readyRow,{...sourceRow,commercialState:'available'}])),error=>error.status===409)
  await assert.rejects(apply({...envelope([readyRow]),photos:[{stockCode:'UNKNOWN-STOCK',sha256:'9'.repeat(64)}]}),error=>error.status===409)
  assert.equal(snapshot(),applyBefore)
  const existingChange={...sourceRow,stockCode:'SYNC-ABSENT',vin:'SYNCVIN123',price:69000,commercialState:'available',...details}
  const applied=await apply(envelope([readyRow,incompleteRow,withoutAvailability,existingChange]))
  assert.equal(applied.applied,true)
  assert.equal(applied.created.length,1)
  assert.equal(applied.created[0].stockCode,'SYNC-APPLIED')
  assert.equal(applied.skipped.length,3)
  assert.equal(applied.status,'Rascunho')
  const newId=applied.created[0].vehicleId
  assert.deepEqual({...db.prepare('SELECT organization_id org,status,stock_code stockCode FROM vehicles WHERE id=?').get(newId)},{org,status:'Rascunho',stockCode:'SYNC-APPLIED'})
  assert.equal(db.prepare('SELECT COUNT(*) n FROM publication_jobs WHERE vehicle_id=?').get(newId).n,0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vehicle_images WHERE vehicle_id=?').get(newId).n,0)
  assert.equal(db.prepare('SELECT price FROM vehicles WHERE id=?').get(absentId).price,68000)
  const appliedSnapshot=snapshot()
  const repeat=await apply(envelope([readyRow]))
  assert.equal(repeat.created.length,0)
  assert.equal(repeat.skipped[0].reason,'already_exists')
  assert.equal(snapshot(),appliedSnapshot)
  const concurrentDraft={...readyRow,stockCode:'SYNC-CONCURRENT'}
  const concurrentApply=await Promise.all([apply(envelope([concurrentDraft])),apply(envelope([concurrentDraft]))])
  assert.equal(concurrentApply.reduce((n,result)=>n+result.created.length,0),1)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM vehicles WHERE organization_id=? AND stock_code='SYNC-CONCURRENT'").get(org).n,1)
  // Reviewed stock actions require distinct grants and a fresh matching state.
  const updateGrant=await create({name:'Revisão de preço e km',scopes:['vehicles:read','stock:update','status:read']})
  const saleGrant=await create({name:'Revisão de vendas',scopes:['vehicles:read','stock:sell']})
  const updateClient=createApiClient(server.base,updateGrant.token)
  const saleClient=createApiClient(server.base,saleGrant.token)
  assert.equal((await updateClient('/integration/v1/status')).readOnly,false)
  const reviewRow={...readyRow,stockCode:'SYNC-REVIEWED',vin:'9BWZZZ377VT004251'}
  const reviewId=(await apply(envelope([reviewRow]))).created[0].vehicleId
  const updateRow={...reviewRow,price:69000,km:81000}
  const changeSnapshot=envelope([updateRow])
  const proposal=(await preview(changeSnapshot)).reviewedActions[0]
  assert.equal(proposal.action,'update_price_km')
  assert.equal(proposal.vehicleId,reviewId)
  assert.deepEqual(proposal.before,{price:68000,km:80000})
  assert.deepEqual(proposal.after,{price:69000,km:81000})
  const submit=(candidate,source,client=updateClient,extra={})=>client('/integration/v1/stock/reviewed-action',{method:'POST',body:JSON.stringify({
    confirm:'apply_reviewed_stock_action',action:candidate.action,vehicleId:candidate.vehicleId,
    reviewedAt:candidate.reviewedAt,digest:candidate.digest,snapshot:source,...extra})})
  const reviewedBefore=snapshot()
  await assert.rejects(submit(proposal,changeSnapshot,writeApi),error=>error.status===403)
  await assert.rejects(submit(proposal,changeSnapshot,saleClient),error=>error.status===403)
  await assert.rejects(submit(proposal,changeSnapshot,updateClient,{confirm:'publish'}),error=>error.status===400)
  await assert.rejects(submit(proposal,changeSnapshot,updateClient,{reviewedAt:Date.now()-300001}),error=>error.status===409)
  await assert.rejects(submit(proposal,changeSnapshot,updateClient,{digest:'a'.repeat(64)}),error=>error.status===409)
  await assert.rejects(submit(proposal,envelope([{...updateRow,price:70000}])),error=>error.status===409)
  assert.equal((await preview(envelope([updateRow],'partial'))).reviewedActions.length,0)
  assert.equal((await preview(envelope([{...updateRow,km:79000}]))).reviewedActions.length,0)
  assert.equal((await preview(envelope([{...updateRow,vin:undefined}]))).reviewedActions.length,0)
  assert.equal((await preview(envelope([{...updateRow,description:'Alteração não permitida'}]))).reviewedActions.length,0)
  assert.equal(snapshot(),reviewedBefore)
  const updated=await submit(proposal,changeSnapshot)
  assert.equal(updated.applied,true)
  assert.deepEqual({...db.prepare('SELECT price,km,status FROM vehicles WHERE id=?').get(reviewId)},{price:69000,km:81000,status:'Rascunho'})
  await assert.rejects(submit(proposal,changeSnapshot),error=>error.status===409)
  const saleSource=envelope([{...updateRow,commercialState:'sold'}])
  const saleProposal=(await preview(saleSource)).reviewedActions[0]
  assert.equal(saleProposal.action,'record_sale')
  await assert.rejects(submit(saleProposal,saleSource,updateClient),error=>error.status===403)
  assert.equal((await preview(envelope([{...updateRow,commercialState:'sold',vin:undefined}]))).reviewedActions.length,0)
  db.prepare("UPDATE vehicles SET status='Pronto' WHERE id=?").run(reviewId)
  await assert.rejects(submit(saleProposal,saleSource,saleClient),error=>error.status===409)
  const freshSale=(await preview(saleSource)).reviewedActions[0]
  assert.equal(freshSale.before.status,'Pronto')
  assert.equal((await submit(freshSale,saleSource,saleClient)).applied,true)
  const soldRow=db.prepare('SELECT status,sold_at soldAt FROM vehicles WHERE id=?').get(reviewId)
  assert.equal(soldRow.status,'Vendido')
  assert(soldRow.soldAt)
  await assert.rejects(submit(freshSale,saleSource,saleClient),error=>error.status===409)
  assert.equal((await preview(envelope([updateRow]))).reviewedActions.length,0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM publication_jobs WHERE vehicle_id=?').get(reviewId).n,0)
  const historicalRow={...reviewRow,stockCode:'SYNC-HISTORICAL',vin:'9BWZZZ377VT004252'}
  const historicalId=(await apply(envelope([historicalRow]))).created[0].vehicleId
  const historicalSource=envelope([{...historicalRow,commercialState:'sold'}])
  const historicalProposal=(await preview(historicalSource)).reviewedActions[0]
  db.prepare("INSERT INTO publication_jobs(organization_id,vehicle_id,status) VALUES(?,?,'canceled')").run(org,historicalId)
  const historicalBefore=snapshot()
  assert.equal((await preview(historicalSource)).reviewedActions.length,0)
  await assert.rejects(submit(historicalProposal,historicalSource,saleClient),error=>error.status===409)
  assert.equal(snapshot(),historicalBefore)
  const reviewedAudit=db.prepare("SELECT action,resource_id resourceId,details FROM integration_audit_events WHERE organization_id=? AND action IN ('stock:update','stock:sell') AND outcome='allowed' ORDER BY id").all(org)
  assert.deepEqual(reviewedAudit.map(a=>[a.action,a.resourceId]),[['stock:update',reviewId],['stock:sell',reviewId]])
  assert(!JSON.stringify(reviewedAudit).includes(reviewRow.vin))
  await api('/integrations/credentials/'+saleGrant.id+'/revoke',{method:'POST'})
  await assert.rejects(submit(historicalProposal,historicalSource,saleClient),error=>error.status===401)
  console.log('✓ Reviewed stock actions: distinct grants, exact VIN, fresh comparison, individual update/sale, no publication history or replay')
  await api('/integrations/credentials/'+applyGrant.id+'/revoke',{method:'POST'})
  await assert.rejects(apply(envelope([{...readyRow,stockCode:'SYNC-REVOKED'}])),error=>error.status===401)
  assert(db.prepare("SELECT COUNT(*) n FROM integration_audit_events WHERE organization_id=? AND action='stock:apply' AND outcome='allowed'").get(org).n>0)
  console.log('✓ Stock draft application: explicit grants, complete source, transactional idempotency, no updates, sales, photos or jobs')
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
