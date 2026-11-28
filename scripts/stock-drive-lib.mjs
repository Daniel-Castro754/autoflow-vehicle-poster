import { createHash } from 'node:crypto'

const folderMime='application/vnd.google-apps.folder'
const photoMimes=new Set(['image/jpeg','image/png','image/webp'])
const maxPhotoBytes=12*1024*1024
const maxTotalBytes=256*1024*1024
const api='https://www.googleapis.com/drive/v3/'
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{10,200}$/.test(id)
function code(value){
  if(typeof value!=='string')throw new Error('Código de estoque inválido.')
  const normalized=value.trim().toUpperCase().replace(/\s+/g,'')
  if(!/^[A-Z0-9._/-]{1,64}$/.test(normalized))throw new Error('Código de estoque inválido.')
  return normalized
}
export async function boundedBytes(response,limit){
  if(!response.ok||!response.body)throw new Error('Resposta externa inválida: HTTP '+response.status)
  const reader=response.body.getReader()
  const chunks=[]
  let size=0
  try{
    for(;;){
      const {done,value}=await reader.read()
      if(done)break
      size+=value.byteLength
      if(size>limit)throw new Error('Resposta excede o limite seguro.')
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  }finally{await reader.cancel().catch(()=>{})}
}
function fileUrl(id,media=false){
  if(!validId(id))throw new Error('ID Drive inválido.')
  const url=new URL('files/'+id,api)
  url.searchParams.set('supportsAllDrives','true')
  if(media)url.searchParams.set('alt','media')
  else url.searchParams.set('fields','id,mimeType,trashed')
  return url
}
async function request(url,token,fetcher){
  return fetcher(url,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(30000)})
}
async function json(url,token,fetcher){
  return JSON.parse((await boundedBytes(await request(url,token,fetcher),2*1024*1024)).toString('utf8'))
}
async function children(parent,token,fetcher,max){
  if(!validId(parent))throw new Error('ID da pasta Drive inválido.')
  const files=[]
  const pages=new Set()
  const ids=new Set()
  let pageToken
  do{
    const url=new URL('files',api)
    url.searchParams.set('q',"'"+parent+"' in parents and trashed = false")
    url.searchParams.set('fields','nextPageToken,incompleteSearch,files(id,name,mimeType,size,parents,trashed)')
    url.searchParams.set('pageSize','100')
    url.searchParams.set('supportsAllDrives','true')
    url.searchParams.set('includeItemsFromAllDrives','true')
    if(pageToken)url.searchParams.set('pageToken',pageToken)
    const result=await json(url,token,fetcher)
    if(!result||result.incompleteSearch!==false&&result.incompleteSearch!==undefined||!Array.isArray(result.files))
      throw new Error('Listagem Drive incompleta.')
    for(const file of result.files){
      if(!file||!validId(file.id)||ids.has(file.id)||typeof file.name!=='string'||
        typeof file.mimeType!=='string'||file.trashed!==false||!Array.isArray(file.parents)||!file.parents.includes(parent))
        throw new Error('Metadados Drive inconsistentes.')
      ids.add(file.id)
      files.push(file)
      if(files.length>max)throw new Error('Limite de arquivos ou pastas excedido.')
    }
    pageToken=result.nextPageToken
    if(pageToken!==undefined&&pageToken!==null&&pageToken!==''){
      if(typeof pageToken!=='string'||pageToken.length>8192||pages.has(pageToken)||pages.size>=25)
        throw new Error('Paginação Drive inválida.')
      pages.add(pageToken)
    }
  }while(pageToken)
  return files
}
export async function readDrivePhoto(file,token,fetcher=fetch){
  if(!photoMimes.has(file.mimeType)||!Number.isSafeInteger(file.size)||file.size<1||file.size>maxPhotoBytes)
    throw new Error('Formato ou tamanho da foto inválido.')
  const bytes=await boundedBytes(await request(fileUrl(file.id,true),token,fetcher),file.size)
  if(bytes.length!==file.size)throw new Error('Tamanho da foto mudou durante a leitura.')
  const sha256=createHash('sha256').update(bytes).digest('hex')
  if(file.sha256&&file.sha256!==sha256)throw new Error('Conteúdo da foto mudou após a prévia.')
  return {bytes,sha256}
}

// Dedicated folder: one direct child folder per stable stock code.
// No shortcut traversal, recursive guesses or downloads outside this hierarchy.
export async function readDriveManifest(snapshot,rootId,token,fetcher=fetch){
  if(!validId(rootId))throw new Error('Configure AUTOFLOW_STOCK_DRIVE_FOLDER_ID.')
  if(!snapshot||snapshot.sourceState!=='complete'||!Array.isArray(snapshot.rows))
    throw new Error('Leitura de estoque incompleta.')
  const stock=new Map()
  for(const row of snapshot.rows){
    const key=code(row.stockCode)
    if(stock.has(key))throw new Error('Código de estoque repetido na planilha.')
    stock.set(key,row)
  }
  const root=await json(fileUrl(rootId),token,fetcher)
  if(root.id!==rootId||root.mimeType!==folderMime||root.trashed!==false)
    throw new Error('Pasta raiz Drive inválida.')
  const folders=await children(rootId,token,fetcher,500)
  const seen=new Set()
  const files=[]
  let totalBytes=0
  for(const folder of folders){
    if(folder.mimeType!==folderMime)throw new Error('A raiz dedicada deve conter apenas pastas de veículos.')
    const stockCode=code(folder.name)
    if(seen.has(stockCode)||!stock.has(stockCode))throw new Error('Pasta sem código único correspondente na planilha.')
    seen.add(stockCode)
    if(stock.get(stockCode).commercialState!=='available')continue
    const images=await children(folder.id,token,fetcher,100)
    for(const image of images){
      if(image.name==='anuncio.txt'&&image.mimeType==='text/plain')continue
      if(!photoMimes.has(image.mimeType))throw new Error('Arquivo não suportado na pasta de veículo.')
      if(typeof image.size!=='string'||!/^\d{1,9}$/.test(image.size))throw new Error('Tamanho Drive não confirmado.')
      const size=Number(image.size)
      if(size<1||size>maxPhotoBytes||files.length>=2000||totalBytes+size>maxTotalBytes)
        throw new Error('Limite seguro de fotos ou bytes excedido.')
      const file={id:image.id,stockCode,mimeType:image.mimeType,size}
      const {sha256}=await readDrivePhoto(file,token,fetcher)
      files.push({...file,sha256})
      totalBytes+=size
    }
  }
  return {files,photos:files.map(({stockCode,sha256})=>({stockCode,sha256})),totalBytes}
}
