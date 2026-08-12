(function(){
  if(window.__autoflowLoaded)return
  window.__autoflowLoaded=true

  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
  const randomDelay=(min,max)=>sleep(min+Math.random()*(max-min))
  const normalize=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
  const visible=element=>{const box=element.getBoundingClientRect();const style=getComputedStyle(element);return box.width>0&&box.height>0&&style.visibility!=='hidden'&&style.display!=='none'}
  const attributeText=element=>normalize([element.getAttribute?.('aria-label'),element.getAttribute?.('placeholder'),element.getAttribute?.('name'),element.getAttribute?.('data-testid')].filter(Boolean).join(' '))
  const exactOrPrefix=(text,key)=>text===key||text.startsWith(key+' ')||text.endsWith(' '+key)
  const fuzzyMatch=(text,value)=>{const a=normalize(text),b=normalize(value);if(!a||!b)return false;if(a===b||a.includes(b)||b.includes(a))return true;const tokens=b.split(' ').filter(token=>token.length>2);return tokens.length>0&&tokens.every(token=>a.includes(token))}

  const aliases={
    'carro caminhonete':['Carro/picape','Carro/Caminhonete'],
    'carro picape':['Carro/picape','Carro/Caminhonete'],
    'outro veiculo':['Outro'],
    'hatch':['Hatchback','Hatch'],
    'perua':['Perua/Station wagon','Perua'],
    'automatico':['Automático'],
    'prateado':['Prateado','Prata'],
  }
  function valuesFor(value){const key=normalize(value);return aliases[key]||[String(value)]}

  function setNative(input,value){
    const proto=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype
    const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set
    setter?.call(input,String(value))
    input.dispatchEvent(new Event('input',{bubbles:true}))
    input.dispatchEvent(new Event('change',{bubbles:true}))
    input.dispatchEvent(new Event('blur',{bubbles:true}))
  }

  function labelNodes(labels){
    const keys=labels.map(normalize)
    return [...document.querySelectorAll('label,span,div')].filter(element=>{
      if(!visible(element))return false
      const text=normalize(element.textContent)
      if(!text||text.length>80)return false
      return keys.some(key=>exactOrPrefix(text,key))
    }).sort((a,b)=>String(a.textContent).length-String(b.textContent).length)
  }

  function commonAncestorBonus(label,control){
    let node=label
    for(let depth=0;node&&depth<5;depth++,node=node.parentElement){
      if(node.contains(control))return 300-depth*35
    }
    return 0
  }

  function findField(labels,selector,{allowHidden=false}={}){
    const keys=labels.map(normalize)
    const controls=[...document.querySelectorAll(selector)].filter(element=>allowHidden||visible(element))
    const direct=controls.find(element=>keys.some(key=>attributeText(element).includes(key)))
    if(direct)return direct
    const labelsFound=labelNodes(labels)
    let best=null,bestScore=-Infinity
    for(const control of controls){
      const controlBox=control.getBoundingClientRect()
      for(const label of labelsFound){
        const labelBox=label.getBoundingClientRect()
        const ancestor=commonAncestorBonus(label,control)
        const horizontalGap=Math.max(0,Math.max(labelBox.left-controlBox.right,controlBox.left-labelBox.right))
        const verticalGap=Math.max(0,controlBox.top-labelBox.bottom,labelBox.top-controlBox.bottom)
        const sameColumn=horizontalGap<Math.max(35,controlBox.width*.4)
        const score=ancestor+(sameColumn?180:0)-horizontalGap*1.5-verticalGap*2
        if(verticalGap<150&&score>bestScore){best=control;bestScore=score}
      }
    }
    return bestScore>40?best:null
  }

  async function waitField(labels,selector,options,attempts=24){
    for(let attempt=0;attempt<attempts;attempt++){
      const field=findField(labels,selector,options)
      if(field)return field
      await sleep(250)
    }
    return null
  }

  async function fillText(labels,value){
    if(value===undefined||value===null||value==='')return false
    const element=await waitField(labels,'input:not([type="file"]),textarea,[contenteditable="true"],[role="textbox"]')
    if(!element)return false
    element.scrollIntoView({block:'center',behavior:'auto'})
    await sleep(180)
    if(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement)setNative(element,value)
    else{
      element.focus()
      document.execCommand('selectAll',false)
      document.execCommand('insertText',false,String(value))
      element.dispatchEvent(new Event('input',{bubbles:true}))
      element.dispatchEvent(new Event('change',{bubbles:true}))
      element.dispatchEvent(new Event('blur',{bubbles:true}))
    }
    return true
  }

  function optionCandidates(trigger){
    const controlledId=trigger.getAttribute?.('aria-controls')||trigger.getAttribute?.('aria-owns')
    const controlled=controlledId?document.getElementById(controlledId):null
    const roots=controlled&&visible(controlled)?[controlled]:[...document.querySelectorAll('[role="listbox"],[role="menu"]')].filter(visible)
    const roleOptions=roots.flatMap(root=>[...root.querySelectorAll('[role="option"],[role="menuitemradio"],[role="menuitem"]')]).filter(visible)
    if(roleOptions.length)return roleOptions
    return [...document.querySelectorAll('[role="option"],[role="menuitemradio"]')].filter(visible)
  }

  function scrollOpenList(trigger){
    const controlledId=trigger.getAttribute?.('aria-controls')||trigger.getAttribute?.('aria-owns')
    const controlled=controlledId?document.getElementById(controlledId):null
    const host=controlled||[...document.querySelectorAll('[role="listbox"]')].filter(visible).at(-1)
    if(!host)return false
    const scrollable=[host,...host.querySelectorAll('div')].filter(element=>element.scrollHeight>element.clientHeight+8).sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight))[0]
    if(!scrollable)return false
    const before=scrollable.scrollTop
    scrollable.scrollTop=Math.min(scrollable.scrollHeight,scrollable.scrollTop+Math.max(120,scrollable.clientHeight*.75))
    scrollable.dispatchEvent(new Event('scroll',{bubbles:true}))
    return scrollable.scrollTop!==before
  }

  async function selectCustom(labels,value){
    if(value===undefined||value===null||value==='')return false
    const trigger=await waitField(labels,'select,[role="combobox"],[aria-haspopup="listbox"],input[aria-autocomplete]')
    if(!trigger)return false
    const wanted=valuesFor(value)
    if(trigger instanceof HTMLSelectElement){
      const option=[...trigger.options].find(item=>wanted.some(candidate=>fuzzyMatch(item.textContent,candidate)))
      if(!option)return false
      trigger.value=option.value
      trigger.dispatchEvent(new Event('change',{bubbles:true}))
      return true
    }
    trigger.scrollIntoView({block:'center',behavior:'auto'})
    await sleep(180)
    trigger.click()
    await sleep(420)
    for(let attempt=0;attempt<36;attempt++){
      const options=optionCandidates(trigger)
      const exact=options.find(option=>wanted.some(candidate=>normalize(option.textContent)===normalize(candidate)))
      const match=exact||options.find(option=>wanted.some(candidate=>fuzzyMatch(option.textContent,candidate)))
      if(match){
        match.scrollIntoView({block:'nearest',behavior:'auto'})
        match.click()
        await sleep(420)
        return true
      }
      if(attempt>0&&attempt%3===0)scrollOpenList(trigger)
      await sleep(140)
    }
    trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}))
    return false
  }

  async function selectOrFill(labels,value){
    if(await selectCustom(labels,value))return true
    const filled=await fillText(labels,value)
    if(!filled)return false
    await sleep(500)
    const suggestions=[...document.querySelectorAll('[role="option"]')].filter(visible)
    const match=suggestions.find(option=>valuesFor(value).some(candidate=>fuzzyMatch(option.textContent,candidate)))
    if(match){match.click();await sleep(320)}
    return true
  }

  function runtimeMessage(message){
    return new Promise((resolve,reject)=>chrome.runtime.sendMessage(message,response=>{
      const error=chrome.runtime.lastError
      if(error)return reject(new Error(error.message))
      if(!response?.ok)return reject(new Error(response?.error||'A extensão não conseguiu carregar a imagem.'))
      resolve(response)
    }))
  }

  function photoCount(){
    const match=(document.body.innerText||'').match(/Fotos?\s*(?:[\u00b7:-]\s*)?(\d+)\s*\/\s*20/i)
    return match?Number(match[1]):null
  }

  function photoInput(){
    const inputs=[...document.querySelectorAll('input[type="file"]')]
    let best=null,bestScore=-Infinity
    for(const input of inputs){
      let score=0
      const accept=normalize(input.getAttribute('accept'))
      if(accept.includes('image'))score+=300
      if(input.multiple)score+=120
      let node=input.parentElement
      for(let depth=0;node&&depth<9;depth++,node=node.parentElement){
        const text=normalize(node.innerText||node.textContent)
        if(text.includes('upload de fotos'))score+=600-depth*30
        else if(text.includes('adicione fotos')||text.includes('adicionar foto'))score+=420-depth*25
        const box=node.getBoundingClientRect()
        if(box.width>0&&box.height>0&&box.left<window.innerWidth*.45)score+=30
      }
      if(score>bestScore){best=input;bestScore=score}
    }
    return bestScore>=300?best:null
  }

  function fileFromBase64(dataBase64,name,mimeType){
    const binary=atob(dataBase64)
    const bytes=new Uint8Array(binary.length)
    for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index)
    return new File([bytes],name,{type:mimeType||'image/jpeg'})
  }

  async function uploadImages(images){
    if(!Array.isArray(images)||!images.length)return 0
    const alreadyUploaded=photoCount()
    if(alreadyUploaded>0)return alreadyUploaded
    let input=null
    for(let attempt=0;attempt<24&&!input;attempt++){input=photoInput();if(!input)await sleep(250)}
    if(!input)return 0
    const transfer=new DataTransfer()
    for(const image of images.slice(0,20)){
      try{
        const response=await runtimeMessage({type:'AUTOFLOW_FETCH_IMAGE',url:image.url})
        transfer.items.add(fileFromBase64(response.dataBase64,image.name||`veiculo-${transfer.files.length+1}.jpg`,image.mimeType||response.mimeType))
      }catch(error){console.warn('AutoFlow: não foi possível carregar uma foto',error)}
    }
    if(!transfer.files.length)return 0
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'files')?.set
    if(setter)setter.call(input,transfer.files)
    else Object.defineProperty(input,'files',{configurable:true,value:transfer.files})
    input.dispatchEvent(new Event('input',{bubbles:true}))
    input.dispatchEvent(new Event('change',{bubbles:true}))
    const deadline=Date.now()+30000
    while(Date.now()<deadline){
      await sleep(500)
      const accepted=photoCount()
      if(accepted!==null&&accepted>0)return accepted
    }
    return 0
  }

  function exactButton(names){
    const keys=names.map(normalize)
    return [...document.querySelectorAll('button,[role="button"]')].filter(visible).find(button=>{
      const text=normalize(button.innerText||button.textContent||button.getAttribute('aria-label'))
      return keys.includes(text)&&button.getAttribute('aria-disabled')!=='true'&&!button.disabled
    })
  }

  async function waitUntil(test,timeout=20000){
    const deadline=Date.now()+timeout
    while(Date.now()<deadline){const value=test();if(value)return value;await sleep(300)}
    return null
  }

  function hasHumanChallenge(){
    const text=normalize(document.body.innerText)
    return ['captcha','confirme que voce e humano','verificacao de seguranca','security check'].some(value=>text.includes(value))
  }

  async function advanceToGroups(){
    const button=await waitUntil(()=>exactButton(['Avançar','Next']),12000)
    if(!button)return false
    button.scrollIntoView({block:'center',behavior:'auto'})
    await sleep(250)
    button.click()
    return Boolean(await waitUntil(()=>{
      const text=normalize(document.body.innerText)
      return text.includes('anunciar em mais locais')||text.includes('anunciar nos seus grupos')||exactButton(['Publicar','Publish'])
    },20000))
  }

  function groupCheckbox(groupName){
    const wanted=normalize(groupName)
    const labels=[...document.querySelectorAll('span,div,label')].filter(element=>{
      if(!visible(element))return false
      const text=normalize(element.innerText||element.textContent)
      return text===wanted&&text.length>0
    }).sort((a,b)=>(a.innerText||a.textContent).length-(b.innerText||b.textContent).length)
    for(const label of labels){
      let node=label
      for(let depth=0;node&&depth<8;depth++,node=node.parentElement){
        const checkbox=node.querySelector('input[type="checkbox"],[role="checkbox"]')
        if(checkbox&&visible(checkbox))return checkbox
      }
    }
    return null
  }

  function groupsScroller(){
    const candidates=[...document.querySelectorAll('div')].filter(element=>{
      if(!visible(element)||element.scrollHeight<=element.clientHeight+30)return false
      const box=element.getBoundingClientRect()
      return box.left<window.innerWidth*.4&&box.height>200
    })
    return candidates.sort((a,b)=>(b.scrollHeight-b.clientHeight)-(a.scrollHeight-a.clientHeight))[0]||document.scrollingElement
  }

  async function selectConfiguredGroups(groups){
    const selected=[],missing=[]
    const scroller=groupsScroller()
    for(const group of groups.slice(0,20)){
      if(scroller)scroller.scrollTop=0
      let checkbox=null,lastTop=-1
      for(let attempt=0;attempt<80&&!checkbox;attempt++){
        checkbox=groupCheckbox(group)
        if(checkbox)break
        if(!scroller)break
        const before=scroller.scrollTop
        scroller.scrollTop=Math.min(scroller.scrollHeight,scroller.scrollTop+Math.max(220,scroller.clientHeight*.65))
        scroller.dispatchEvent(new Event('scroll',{bubbles:true}))
        await sleep(180)
        if(scroller.scrollTop===before||scroller.scrollTop===lastTop)break
        lastTop=scroller.scrollTop
      }
      if(!checkbox){missing.push(group);continue}
      const checked=checkbox instanceof HTMLInputElement?checkbox.checked:checkbox.getAttribute('aria-checked')==='true'
      if(!checked){checkbox.scrollIntoView({block:'center',behavior:'auto'});await sleep(140);checkbox.click();await sleep(220)}
      const confirmed=checkbox instanceof HTMLInputElement?checkbox.checked:checkbox.getAttribute('aria-checked')==='true'
      if(confirmed)selected.push(group);else missing.push(group)
    }
    return {selected,missing}
  }

  async function publishListing(beforeClick){
    if(hasHumanChallenge())return false
    const button=await waitUntil(()=>exactButton(['Publicar','Publish']),12000)
    if(!button)return false
    const initialUrl=location.href
    button.scrollIntoView({block:'center',behavior:'auto'})
    await sleep(300)
    if(beforeClick)await beforeClick()
    button.click()
    return Boolean(await waitUntil(()=>location.href!==initialUrl||!exactButton(['Publicar','Publish'])||hasHumanChallenge(),30000))&&!hasHumanChallenge()
  }

  async function step(label,run){await randomDelay(260,560);try{return[label,await run()]}catch(error){console.warn(`AutoFlow: falha em ${label}`,error);return[label,false]}}

  async function fill(task){
    const vehicle=task.vehicle||task
    const jobId=task.jobId
    const automation=task.automation||{}
    const results=[]
    results.push(await step('Tipo de veículo',()=>selectCustom(['tipo de veiculo','vehicle type'],vehicle.vehicleType||'Carro/picape')))
    const imageCount=await uploadImages(vehicle.images)
    results.push(['Fotos',imageCount>0])
    results.push(await step('Localização',()=>selectOrFill(['localizacao','location'],vehicle.location)))
    results.push(await step('Ano',()=>selectCustom(['ano','year'],String(vehicle.year))))
    results.push(await step('Fabricante',()=>selectOrFill(['fabricante','marca','make'],vehicle.make)))
    results.push(await step('Modelo',()=>selectOrFill(['modelo','model'],vehicle.model)))
    results.push(await step('Quilometragem',()=>fillText(['quilometragem','mileage','odometro'],vehicle.km)))
    results.push(await step('Preço',()=>fillText(['preco','price'],vehicle.price)))
    results.push(await step('Câmbio',()=>selectCustom(['cambio','transmissao','transmission'],vehicle.transmission)))
    results.push(await step('Combustível',()=>selectCustom(['combustivel','fuel'],vehicle.fuelType)))
    results.push(await step('Carroceria',()=>selectCustom(['estilo da carroceria','carroceria','body style','body type'],vehicle.bodyType)))
    results.push(await step('Condição do veículo',()=>selectCustom(['condicao do veiculo','vehicle condition','condicao'],vehicle.condition)))
    results.push(await step('Cor externa',()=>selectCustom(['cor externa','exterior color'],vehicle.exteriorColor)))
    results.push(await step('Cor interna',()=>selectCustom(['cor interna','interior color'],vehicle.interiorColor)))
    results.push(await step('Descrição',()=>fillText(['descricao','description'],vehicle.description)))
    const missing=results.filter(item=>!item[1]).map(item=>item[0])
    let advanced=false,selectedGroups=[],missingGroups=[],published=false
    if(automation.autoAdvance&&missing.length===0){
      advanced=await advanceToGroups()
      if(advanced&&automation.fillGroups){
        const groupResult=await selectConfiguredGroups(Array.isArray(automation.targetGroups)?automation.targetGroups:[])
        selectedGroups=groupResult.selected
        missingGroups=groupResult.missing
      }
      if(advanced&&automation.autoPublish&&missingGroups.length===0&&jobId){
        const reportBeforePublish={filledCount:results.length,totalCount:results.length,imageCount,missing:[],fields:results.map(item=>({name:item[0],ok:Boolean(item[1])})),advanced,selectedGroups,missingGroups:[]}
        published=await publishListing(()=>runtimeMessage({type:'AUTOFLOW_PUBLISH_STARTED',jobId,report:reportBeforePublish}))
      }
    }
    showNotice(results,vehicle,{automation,advanced,selectedGroups,missingGroups,published})
    if(jobId){
      chrome.runtime.sendMessage({type:'AUTOFLOW_FILL_RESULT',jobId,report:{filledCount:results.length-missing.length,totalCount:results.length,imageCount,missing,fields:results.map(item=>({name:item[0],ok:Boolean(item[1])})),advanced,selectedGroups,missingGroups,published,resultUrl:published?location.href:''}})
    }
  }

  function showNotice(results,vehicle,flow){
    document.getElementById('autoflow-notice')?.remove()
    const count=results.filter(item=>item[1]).length
    const missing=results.filter(item=>!item[1]).map(item=>item[0])
    const box=document.createElement('div')
    box.id='autoflow-notice'
    box.style.cssText='position:fixed;right:20px;bottom:20px;z-index:2147483647;background:#153b32;color:#fff;padding:14px 16px;border-radius:10px;box-shadow:0 8px 30px #0005;font:13px Arial;max-width:380px'
    const details=[]
    if(missing.length)details.push('Revise: '+missing.join(', ')+'.')
    else details.push('Todos os campos foram encontrados.')
    if(flow.automation.autoAdvance)details.push(flow.advanced?'Etapa de grupos aberta.':'Não foi possível avançar.')
    if(flow.automation.fillGroups)details.push(flow.missingGroups.length?'Grupos não encontrados: '+flow.missingGroups.join(', ')+'.':`${flow.selectedGroups.length} grupo(s) selecionado(s).`)
    if(flow.automation.autoPublish)details.push(flow.published?'Publicação confirmada.':'Publicação automática interrompida; revise manualmente.')
    else details.push('Publicação final manual.')
    box.innerHTML=`<strong style="display:block;margin-bottom:4px">AutoFlow: ${count}/${results.length} campos preenchidos</strong><span style="color:#b9d2cc">${vehicle.year} ${vehicle.make} ${vehicle.model}. ${details.join(' ')}</span><button style="float:right;margin-top:10px;border:0;background:#36d09b;color:#12382f;border-radius:5px;padding:6px 9px;cursor:pointer">Entendi</button>`
    box.querySelector('button').onclick=()=>box.remove()
    document.body.appendChild(box)
  }

  function run(task){return fill(task).catch(error=>{console.error('AutoFlow: falha no preenchimento',error);if(task?.jobId)chrome.runtime.sendMessage({type:'AUTOFLOW_FILL_ERROR',jobId:task.jobId,error:error.message||String(error)})})}
  chrome.storage.local.get(['pendingJob','pendingVehicle'],data=>{
    const task=data.pendingJob||data.pendingVehicle
    if(!task)return
    let attempts=0
    const timer=setInterval(()=>{
      attempts++
      if(document.querySelector('input,textarea,[role="combobox"],[contenteditable="true"]')){
        clearInterval(timer)
        run(task).finally(()=>chrome.storage.local.remove(['pendingJob','pendingVehicle']))
      }else if(attempts>40){
        clearInterval(timer)
        if(task?.jobId)chrome.runtime.sendMessage({type:'AUTOFLOW_FILL_ERROR',jobId:task.jobId,error:'O formulário do Marketplace não ficou disponível.'})
      }
    },500)
  })
  chrome.runtime.onMessage.addListener(message=>{if(message.type==='FILL_VEHICLE')run(message.task||message.vehicle)})
})()
