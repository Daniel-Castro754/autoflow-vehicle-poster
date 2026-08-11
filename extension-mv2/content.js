(function(){
  if(window.__autoflowLoaded)return;window.__autoflowLoaded=true
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
  const normalize=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
  const visible=el=>{const box=el.getBoundingClientRect();const style=getComputedStyle(el);return box.width>0&&box.height>0&&style.visibility!=='hidden'&&style.display!=='none'}
  const textOf=el=>normalize([el.getAttribute?.('aria-label'),el.getAttribute?.('placeholder'),el.getAttribute?.('name'),el.textContent].filter(Boolean).join(' '))
  function setNative(input,value){const proto=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;setter?.call(input,String(value));input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));input.dispatchEvent(new Event('blur',{bubbles:true}))}
  function candidates(selector='input,textarea,[contenteditable="true"],[role="textbox"]'){return [...document.querySelectorAll(selector)].filter(visible)}
  function findField(labels,selector){const keys=labels.map(normalize);return candidates(selector).find(el=>keys.some(key=>textOf(el).includes(key)))||[...document.querySelectorAll('label')].filter(visible).map(label=>({label,field:label.querySelector(selector)})).find(item=>item.field&&keys.some(key=>textOf(item.label).includes(key)))?.field}
  async function waitField(labels,selector,attempts=18){for(let i=0;i<attempts;i++){const field=findField(labels,selector);if(field)return field;await sleep(250)}return null}
  async function fillText(labels,value){if(value===undefined||value===null||value==='')return false;const el=await waitField(labels,'input:not([type="file"]),textarea,[contenteditable="true"],[role="textbox"]');if(!el)return false;if(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement)setNative(el,value);else{el.focus();document.execCommand('selectAll',false);document.execCommand('insertText',false,String(value));el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('blur',{bubbles:true}))}return true}
  function fuzzyMatch(text,value){const a=normalize(text),b=normalize(value);if(a===b||a.includes(b)||b.includes(a))return true;const tokens=b.split(' ').filter(t=>t.length>2);return tokens.length>0&&tokens.every(token=>a.includes(token))}
  async function selectCustom(labels,value){if(value===undefined||value===null||value==='')return false;const selectors='[role="combobox"],[aria-haspopup="listbox"],button,div[tabindex="0"]';const trigger=await waitField(labels,selectors);if(!trigger)return false;trigger.click();await sleep(350);for(let attempt=0;attempt<12;attempt++){const options=[...document.querySelectorAll('[role="option"],[role="menuitemradio"],[role="menuitem"],div[tabindex="0"]')].filter(visible);const match=options.find(option=>fuzzyMatch(option.textContent,value));if(match){match.click();await sleep(350);return true}await sleep(200)}document.body.click();return false}
  async function uploadImages(images){if(!Array.isArray(images)||!images.length)return 0;const input=await waitField(['foto','photo'],'input[type="file"]',20)||candidates('input[type="file"]')[0];if(!input)return 0;const transfer=new DataTransfer();for(const image of images.slice(0,20)){try{const response=await fetch(image.url);if(!response.ok)continue;const blob=await response.blob();transfer.items.add(new File([blob],image.name||`veiculo-${transfer.files.length+1}.jpg`,{type:image.mimeType||blob.type||'image/jpeg'}))}catch(error){console.warn('AutoFlow: não foi possível carregar uma foto',error)}}if(!transfer.files.length)return 0;Object.defineProperty(input,'files',{configurable:true,value:transfer.files});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));await sleep(600);return transfer.files.length}
  async function fill(task){
    const vehicle=task.vehicle||task
    const jobId=task.jobId
    const results=[]
    results.push(['Tipo de veículo',await selectCustom(['tipo de veiculo','vehicle type'],vehicle.vehicleType||'Carro/Caminhonete')])
    const imageCount=await uploadImages(vehicle.images)
    results.push(['Fotos',imageCount>0])
    results.push(['Localização',await fillText(['localizacao','location'],vehicle.location)])
    results.push(['Ano',await selectCustom(['ano','year'],String(vehicle.year))])
    results.push(['Fabricante',await fillText(['fabricante','marca','make'],vehicle.make)])
    results.push(['Modelo',await fillText(['modelo','model'],vehicle.model)])
    results.push(['Preço',await fillText(['preco','price'],vehicle.price)])
    results.push(['Quilometragem',await fillText(['quilometragem','mileage','odometro'],vehicle.km)])
    results.push(['Câmbio',await selectCustom(['cambio','transmissao','transmission'],vehicle.transmission)])
    results.push(['Combustível',await selectCustom(['combustivel','fuel'],vehicle.fuelType)])
    results.push(['Carroceria',await selectCustom(['carroceria','body style','body type'],vehicle.bodyType)])
    results.push(['Cor',await selectCustom(['cor externa','exterior color','cor'],vehicle.exteriorColor)])
    results.push(['Descrição',await fillText(['descricao','description'],vehicle.description)])
    showNotice(results,vehicle)
    if(jobId){const missing=results.filter(item=>!item[1]).map(item=>item[0]);chrome.runtime.sendMessage({type:'AUTOFLOW_FILL_RESULT',jobId,report:{filledCount:results.length-missing.length,totalCount:results.length,imageCount,missing,fields:results.map(item=>({name:item[0],ok:Boolean(item[1])}))}})}
  }
  function showNotice(results,vehicle){document.getElementById('autoflow-notice')?.remove();const count=results.filter(item=>item[1]).length;const missing=results.filter(item=>!item[1]).map(item=>item[0]);const box=document.createElement('div');box.id='autoflow-notice';box.style.cssText='position:fixed;right:20px;bottom:20px;z-index:2147483647;background:#153b32;color:#fff;padding:14px 16px;border-radius:10px;box-shadow:0 8px 30px #0005;font:13px Arial;max-width:380px';box.innerHTML=`<strong style="display:block;margin-bottom:4px">AutoFlow: ${count}/${results.length} grupos preenchidos</strong><span style="color:#b9d2cc">${vehicle.year} ${vehicle.make} ${vehicle.model}. ${missing.length?'Revise: '+missing.join(', ')+'.':'Todos os grupos foram encontrados.'} Confirme tudo antes de publicar.</span><button style="float:right;margin-top:10px;border:0;background:#36d09b;color:#12382f;border-radius:5px;padding:6px 9px;cursor:pointer">Entendi</button>`;box.querySelector('button').onclick=()=>box.remove();document.body.appendChild(box)}
  function run(task){return fill(task).catch(error=>{console.error('AutoFlow: falha no preenchimento',error);if(task?.jobId)chrome.runtime.sendMessage({type:'AUTOFLOW_FILL_ERROR',jobId:task.jobId,error:error.message||String(error)})})}
  chrome.storage.local.get(['pendingJob','pendingVehicle'],data=>{const task=data.pendingJob||data.pendingVehicle;if(!task)return;let attempts=0;const timer=setInterval(()=>{attempts++;if(document.querySelector('input,textarea,[role="combobox"],[contenteditable="true"]')){clearInterval(timer);run(task).finally(()=>chrome.storage.local.remove(['pendingJob','pendingVehicle']))}else if(attempts>30){clearInterval(timer);if(task?.jobId)chrome.runtime.sendMessage({type:'AUTOFLOW_FILL_ERROR',jobId:task.jobId,error:'O formulário do Marketplace não ficou disponível.'})}},500)})
  chrome.runtime.onMessage.addListener(msg=>{if(msg.type==='FILL_VEHICLE')run(msg.task||msg.vehicle)})
})()
