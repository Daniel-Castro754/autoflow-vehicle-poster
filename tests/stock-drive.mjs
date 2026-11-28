import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readDriveManifest, readDrivePhoto, planDriveUploads, boundedBytes } from '../scripts/stock-drive-lib.mjs'

const root='root_folder_123'
const folder='vehicle_folder_123'
const soldFolder='sold_folder_123'
const id='photo_file_123'
const textId='text_file_123'
const folderMime='application/vnd.google-apps.folder'
const mimeType='image/jpeg'
const bytes=Buffer.from('fixture photo bytes')
const hash=createHash('sha256').update(bytes).digest('hex')
const snapshot={sourceState:'complete',rows:[
  {stockCode:'0012',commercialState:'available'},
  {stockCode:'0013',commercialState:'sold'},
]}
const item=(id,name,mimeType,parent,extra={})=>({id,name,mimeType,parents:[parent],trashed:false,...extra})
const json=value=>new Response(JSON.stringify(value))
const calls=[]
function fake(options={}){
  return async(url,init)=>{
    assert.equal(url.origin,'https://www.googleapis.com')
    assert.equal(init.headers.Authorization,'Bearer test-token')
    assert.equal(init.redirect,'error')
    calls.push(url.pathname+url.search)
    if(url.pathname.endsWith('/files/'+root))return json({id:root,mimeType:folderMime,trashed:false})
    if(url.pathname.endsWith('/files/'+id)){
      assert.equal(url.searchParams.get('alt'),'media')
      return new Response(options.changed?Buffer.alloc(bytes.length,1):bytes)
    }
    assert(url.pathname.endsWith('/files'))
    const q=url.searchParams.get('q')
    if(q.includes(root)){
      if(options.incomplete)return json({incompleteSearch:true,files:[]})
      if(url.searchParams.get('pageToken')){
        if(options.loop)return json({nextPageToken:'next',files:[]})
        return json({files:[item(soldFolder,'0013',folderMime,root)]})
      }
      return json({nextPageToken:'next',files:[item(folder,options.unknown?'UNKNOWN':' 0012 ',options.shortcut?'application/vnd.google-apps.shortcut':folderMime,root)]})
    }
    assert(q.includes(folder),'Do not inspect sold folders or arbitrary children')
    return json({files:[
      item(id,'01.jpg',mimeType,folder,{size:String(bytes.length)}),
      item(textId,'anuncio.txt','text/plain',folder),
    ]})
  }
}
const manifest=await readDriveManifest(snapshot,root,'test-token',fake())
assert.deepEqual(manifest.photos,[{stockCode:'0012',sha256:hash}])
assert.equal(manifest.totalBytes,bytes.length)
assert.equal(manifest.files[0].id,id)
assert(calls.some(c=>c.includes('pageToken=next')))
assert(!calls.some(c=>c.includes(textId)))
assert.deepEqual((await readDrivePhoto(manifest.files[0],'test-token',fake())).bytes,bytes)
await assert.rejects(readDrivePhoto(manifest.files[0],'test-token',fake({changed:true})),/mudou/)
for(const opt of [{unknown:true},{shortcut:true},{incomplete:true},{loop:true}]){
  await assert.rejects(readDriveManifest(snapshot,root,'test-token',fake(opt)))
}
await assert.rejects(readDriveManifest({...snapshot,rows:[...snapshot.rows,{stockCode:' 0012 ',commercialState:'available'}]},root,'test-token',fake()),/repetido/)
await assert.rejects(readDriveManifest({...snapshot,sourceState:'partial'},root,'test-token',fake()),/incompleta/)
await assert.rejects(boundedBytes(new Response('abc'),2),/limite/)
const preview={readOnly:true,sourceState:'complete',counts:{conflict:0},entries:[
  {stockCode:'0012',category:'unchanged',vehicleId:7},{stockCode:'0013',category:'unchanged',vehicleId:8}
],validation:{items:[{stockCode:'0012',sourceFieldsComplete:true,identityConflict:false},{stockCode:'0013',sourceFieldsComplete:true,identityConflict:false}]},
photoPreview:{counts:{conflict:0},entries:[{row:1,stockCode:'0012',category:'new'}]}}
assert.deepEqual(planDriveUploads(snapshot,manifest,preview),{uploads:[{file:manifest.files[0],vehicleId:7}],deferred:0})
const edited=structuredClone(preview)
edited.entries[0].category='changed'
assert.deepEqual(planDriveUploads(snapshot,manifest,edited),{uploads:[],deferred:1})
edited.entries[0].category='new'
assert.deepEqual(planDriveUploads(snapshot,manifest,edited),{uploads:[],deferred:1})
edited.entries[0].category='unchanged'
edited.validation.items[0].sourceFieldsComplete=false
assert.deepEqual(planDriveUploads(snapshot,manifest,edited),{uploads:[],deferred:1})
const existing=structuredClone(preview)
existing.photoPreview.entries[0].category='already_present'
assert.deepEqual(planDriveUploads(snapshot,manifest,existing),{uploads:[],deferred:0})
const conflict=structuredClone(preview)
conflict.photoPreview.counts.conflict=1
assert.throws(()=>planDriveUploads(snapshot,manifest,conflict))
const wrong=structuredClone(preview)
wrong.photoPreview.entries[0].stockCode='0013'
assert.throws(()=>planDriveUploads(snapshot,manifest,wrong))
console.log('✓ Drive connector: bounded paginated reads, exact folders, photo hashes, fail-closed conflicts and restricted upload plan')
