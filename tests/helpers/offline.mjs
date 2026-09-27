// Every child API inherits this guard. Fixtures can replace fetch with explicit mocks.
const networkFetch = globalThis.fetch
for (const key of ['TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','ALERT_WEBHOOK_URL','GEMINI_API_KEY','OPENAI_API_KEY']) delete process.env[key]
const preload=`--import=${import.meta.url}`
if(!(process.env.NODE_OPTIONS||'').includes(preload))process.env.NODE_OPTIONS=`${process.env.NODE_OPTIONS||''} ${preload}`.trim()
globalThis.fetch = (input,options) => {
  const target=new URL(typeof input==='string'||input instanceof URL?input:input.url)
  if(target.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(target.hostname))return Promise.reject(new Error('External HTTP disabled during tests'))
  return networkFetch(input,options)
}
