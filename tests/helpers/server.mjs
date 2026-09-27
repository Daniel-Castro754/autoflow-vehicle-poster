import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'

export async function pickFreePort(){
  const socket=createServer()
  await new Promise((resolve,reject)=>{socket.once('error',reject);socket.listen(0,'127.0.0.1',resolve)})
  const port=socket.address().port
  await new Promise((resolve,reject)=>socket.close(error=>error?reject(error):resolve()))
  return port
}
export function createApiClient(base,token,{bindDocument=true,tabId=101,documentId='test_document_id'}={}){
  return async function call(path,options={}){
    const init={...options}
    if(init.body&&/^\/extension\/jobs\/\d+\//.test(path)){
      const body=JSON.parse(init.body)
      body.tabId??=tabId
      body.document??='/marketplace/create/vehicle'
      body.documentId??=documentId
      init.body=JSON.stringify(body)
    }
    const response=await fetch(base+path,{...init,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...init.headers}})
    const data=await response.json()
    if(!response.ok)throw Object.assign(new Error(`${response.status} ${path}: ${data.error}`),{status:response.status,body:data})
    const prepare=path.match(/^\/extension\/jobs\/(\d+)\/prepare$/)
    if(bindDocument&&prepare&&data.leaseToken){
      await call(`/extension/jobs/${prepare[1]}/bind-document`,{method:'POST',body:JSON.stringify({leaseToken:data.leaseToken,tabId:data.tabId,document:data.document,documentId})})
      data.documentId=documentId
    }
    return data
  }
}
export async function startTestServer(overrides={}){
  const port=await pickFreePort(),dataDir=await mkdtemp(join(tmpdir(),'autoflow-audit-'))
  const base=`http://127.0.0.1:${port}/api`
  const email='audit@test.local',password='audit-test-password'
  const child=spawn(process.execPath,['server/server.ts'],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dataDir,
    AUTH_SECRET:'audit-test-secret-at-least-32-characters',INITIAL_ADMIN_EMAIL:email,INITIAL_ADMIN_PASSWORD:password,...overrides},stdio:['ignore','pipe','pipe']})
  let output=''
  child.stdout.on('data',chunk=>{output+=chunk})
  child.stderr.on('data',chunk=>{output+=chunk})
  const close=async()=>{
    if(child.exitCode===null&&!child.killed){const exited=once(child,'exit');child.kill();await exited}
    await rm(dataDir,{recursive:true,force:true})
  }
  try{
    for(let i=0;i<100;i++){
      if(child.exitCode!==null)throw new Error(`Test API exited: ${output}`)
      try{if((await fetch(base+'/health')).ok)return {base,dataDir,email,password,child,close}}
      catch{/* starting */}
      await new Promise(resolve=>setTimeout(resolve,100))
    }
    throw new Error(`Test API did not start: ${output}`)
  }catch(error){await close();throw error}
}
