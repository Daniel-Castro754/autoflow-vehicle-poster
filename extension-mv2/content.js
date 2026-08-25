(function(){
  if(window.__autoflowLoaded)return
  window.__autoflowLoaded=true

  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
  const randomDelay=(min,max)=>sleep(min+Math.random()*(max-min))
  const normalize=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
  const visible=element=>{const box=element.getBoundingClientRect();const style=getComputedStyle(element);return box.width>0&&box.height>0&&style.visibility!=='hidden'&&style.display!=='none'}
  const attributeText=element=>{
    const labelledBy=String(element.getAttribute?.('aria-labelledby')||'').split(/\s+/).filter(Boolean).map(id=>document.getElementById(id)?.textContent||'')
    const ownLabel=element.id?document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent:''
    return normalize([element.getAttribute?.('aria-label'),element.getAttribute?.('placeholder'),element.getAttribute?.('name'),element.getAttribute?.('data-testid'),ownLabel,...labelledBy].filter(Boolean).join(' '))
  }
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
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Unidentified',bubbles:true}))
    input.dispatchEvent(new Event('input',{bubbles:true}))
    input.dispatchEvent(new Event('change',{bubbles:true}))
    input.dispatchEvent(new KeyboardEvent('keyup',{key:'Unidentified',bubbles:true}))
    input.dispatchEvent(new Event('blur',{bubbles:true}))
  }

  function valueMatches(actual,expected){
    const current=normalize(actual),wanted=normalize(expected)
    if(!current||!wanted)return false
    const currentDigits=current.replace(/\D/g,''),wantedDigits=wanted.replace(/\D/g,'')
    if(wantedDigits.length>=3&&currentDigits)return currentDigits===wantedDigits
    return valuesFor(expected).some(candidate=>fuzzyMatch(current,candidate))
  }

  function fieldValue(element){
    if(element instanceof HTMLSelectElement)return element.selectedOptions[0]?.textContent||element.value
    if(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement)return element.value
    return [element.getAttribute?.('aria-valuetext'),element.getAttribute?.('data-value'),element.innerText,element.textContent].filter(Boolean).join(' ')
  }

  async function confirmField(labels,value,selector){
    return Boolean(await waitForDom(()=>{
      const current=findField(labels,selector)
      return current&&valueMatches(fieldValue(current),value)
    },2200))
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
    if(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement){
      setNative(element,value)
      if(await confirmField(labels,value,'input:not([type="file"]),textarea,[contenteditable="true"],[role="textbox"]'))return true
      element.focus()
      element.select?.()
      document.execCommand('insertText',false,String(value))
      element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:String(value)}))
      element.dispatchEvent(new Event('change',{bubbles:true}))
      element.blur()
    }
    else{
      element.focus()
      document.execCommand('selectAll',false)
      document.execCommand('insertText',false,String(value))
      element.dispatchEvent(new Event('input',{bubbles:true}))
      element.dispatchEvent(new Event('change',{bubbles:true}))
      element.dispatchEvent(new Event('blur',{bubbles:true}))
    }
    return confirmField(labels,value,'input:not([type="file"]),textarea,[contenteditable="true"],[role="textbox"]')
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
      trigger.dispatchEvent(new Event('input',{bubbles:true}))
      trigger.dispatchEvent(new Event('change',{bubbles:true}))
      trigger.dispatchEvent(new Event('blur',{bubbles:true}))
      return confirmField(labels,value,'select,[role="combobox"],[aria-haspopup="listbox"],input[aria-autocomplete]')
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
        firePointerClick(match)
        await sleep(420)
        if(await confirmField(labels,value,'select,[role="combobox"],[aria-haspopup="listbox"],input[aria-autocomplete]'))return true
        const checked=match.getAttribute('aria-selected')==='true'||match.getAttribute('aria-checked')==='true'
        if(checked)return true
      }
      if(attempt>0&&attempt%3===0)scrollOpenList(trigger)
      await sleep(140)
    }
    trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}))
    if(trigger instanceof HTMLInputElement){
      trigger.focus()
      setNative(trigger,wanted[0])
      await sleep(500)
      trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true}))
      trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}))
      trigger.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',bubbles:true}))
      if(await confirmField(labels,value,'select,[role="combobox"],[aria-haspopup="listbox"],input[aria-autocomplete]'))return true
    }
    return false
  }

  async function selectOrFill(labels,value){
    if(await selectCustom(labels,value))return true
    const filled=await fillText(labels,value)
    if(!filled)return false
    await sleep(500)
    const suggestions=[...document.querySelectorAll('[role="option"]')].filter(visible)
    const match=suggestions.find(option=>valuesFor(value).some(candidate=>fuzzyMatch(option.textContent,candidate)))
    if(match){firePointerClick(match);await sleep(320)}
    return confirmField(labels,value,'input:not([type="file"]),textarea,[contenteditable="true"],[role="textbox"],[role="combobox"]')
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

  function controlText(element){return normalize([element.innerText,element.textContent,element.getAttribute?.('aria-label'),element.getAttribute?.('title')].filter(Boolean).join(' '))}
  function controlEnabled(element){
    return Boolean(element&&visible(element)&&element.getAttribute('aria-disabled')!=='true'&&!element.disabled&&!element.closest('[aria-disabled="true"]'))
  }

  function actionButton(names){
    const keys=names.map(normalize)
    const candidates=[...document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')].filter(controlEnabled)
    let best=null,bestScore=-Infinity
    for(const button of candidates){
      const text=controlText(button)||normalize(button.value)
      const exact=keys.some(key=>text===key)
      const contained=keys.some(key=>exactOrPrefix(text,key)||text.includes(key))
      if(!exact&&!contained)continue
      const box=button.getBoundingClientRect()
      let score=exact?1000:500
      if(box.left<window.innerWidth*.42)score+=180
      if(box.top>window.innerHeight*.55)score+=120
      if(button.tagName==='BUTTON')score+=40
      if(score>bestScore){best=button;bestScore=score}
    }
    return best
  }

  function firePointerClick(element){
    element.focus?.({preventScroll:true})
    const init={bubbles:true,cancelable:true,composed:true,view:window,button:0,buttons:1}
    try{element.dispatchEvent(new PointerEvent('pointerdown',{...init,pointerId:1,pointerType:'mouse',isPrimary:true}))}catch{/* navegador sem PointerEvent */}
    element.dispatchEvent(new MouseEvent('mousedown',init))
    try{element.dispatchEvent(new PointerEvent('pointerup',{...init,buttons:0,pointerId:1,pointerType:'mouse',isPrimary:true}))}catch{/* navegador sem PointerEvent */}
    element.dispatchEvent(new MouseEvent('mouseup',{...init,buttons:0}))
    element.click()
  }

  function waitForDom(test,timeout=20000){
    const current=test()
    if(current)return Promise.resolve(current)
    return new Promise(resolve=>{
      let settled=false
      const finish=value=>{if(settled)return;settled=true;observer.disconnect();clearInterval(poll);clearTimeout(deadline);resolve(value)}
      const check=()=>{const value=test();if(value)finish(value)}
      const observer=new MutationObserver(check)
      observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-disabled','aria-checked','disabled','href']})
      const poll=setInterval(check,350)
      const deadline=setTimeout(()=>finish(null),timeout)
    })
  }

  function hasHumanChallenge(){
    const text=normalize(document.body.innerText)
    return ['captcha','confirme que voce e humano','verificacao de seguranca','security check'].some(value=>text.includes(value))
  }

  function marketplaceStage(){
    const text=normalize(document.body.innerText)
    if(/\/marketplace\/item\//.test(location.pathname)||text.includes('seu classificado foi publicado'))return 'published'
    if(text.includes('anunciar em mais locais')||text.includes('anunciar nos seus grupos')||actionButton(['Publicar','Publish']))return 'groups'
    if(actionButton(['Avançar','Next']))return 'details'
    return 'unknown'
  }

  async function advanceToGroups(repair){
    if(marketplaceStage()==='groups')return true
    for(let attempt=0;attempt<3;attempt++){
      let button=await waitForDom(()=>actionButton(['Avançar','Next']),attempt===0?8000:5000)
      if(!button&&repair){
        await repair(attempt)
        button=await waitForDom(()=>actionButton(['Avançar','Next']),6000)
      }
      if(!button)continue
      button.scrollIntoView({block:'center',inline:'center',behavior:'auto'})
      await sleep(350)
      firePointerClick(button)
      const advanced=await waitForDom(()=>marketplaceStage()==='groups',9000)
      if(advanced)return true
      if(repair)await repair(attempt)
      await sleep(700)
    }
    return false
  }

  function groupTarget(raw){
    const value=String(raw||'').trim()
    const parts=value.split('|').map(part=>part.trim()).filter(Boolean)
    const urlPart=parts.find(part=>/facebook\.com\/groups\//i.test(part))||(/facebook\.com\/groups\//i.test(value)?value:'')
    const idMatch=urlPart.match(/facebook\.com\/groups\/([^/?#]+)/i)
    const name=parts.find(part=>part!==urlPart)||(!urlPart?value:'')
    return {raw:value,name,normalizedName:normalize(name),groupId:normalize(idMatch?.[1]||'')}
  }

  function checkboxState(checkbox){return checkbox instanceof HTMLInputElement?checkbox.checked:checkbox.getAttribute('aria-checked')==='true'}

  function groupRow(target){
    const candidates=[...document.querySelectorAll('input[type="checkbox"],[role="checkbox"]')].filter(visible)
    let best=null,bestScore=-Infinity
    for(const checkbox of candidates){
      let node=checkbox
      for(let depth=0;node&&depth<9;depth++,node=node.parentElement){
        const text=normalize(node.innerText||node.textContent)
        const links=[...node.querySelectorAll('a[href*="/groups/"]')].map(link=>normalize(link.getAttribute('href')))
        const idMatch=target.groupId&&links.some(href=>href.includes(`groups ${target.groupId}`)||href.includes(target.groupId))
        const nameMatch=target.normalizedName&&(text===target.normalizedName||text.startsWith(target.normalizedName+' ')||text.includes(target.normalizedName))
        if(!idMatch&&!nameMatch)continue
        let score=(idMatch?1200:0)+(nameMatch?600:0)-depth*25-Math.max(0,text.length-target.normalizedName.length)*.15
        if(node.querySelectorAll('input[type="checkbox"],[role="checkbox"]').length===1)score+=120
        if(score>bestScore){best={checkbox,row:node};bestScore=score}
      }
    }
    return best
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
    for(const configured of groups.slice(0,20)){
      const target=groupTarget(configured)
      let scroller=groupsScroller(),match=null,lastTop=-1
      if(scroller)scroller.scrollTop=0
      for(let attempt=0;attempt<90&&!match;attempt++){
        match=groupRow(target)
        if(match)break
        scroller=groupsScroller()
        if(!scroller)break
        const before=scroller.scrollTop
        scroller.scrollTop=Math.min(scroller.scrollHeight,scroller.scrollTop+Math.max(180,scroller.clientHeight*.58))
        scroller.dispatchEvent(new Event('scroll',{bubbles:true}))
        await waitForDom(()=>groupRow(target),350)
        if(scroller.scrollTop===before||scroller.scrollTop===lastTop)break
        lastTop=scroller.scrollTop
      }
      if(!match){missing.push(target.raw);continue}
      if(!checkboxState(match.checkbox)){
        match.row.scrollIntoView({block:'center',behavior:'auto'})
        await sleep(180)
        for(let attempt=0;attempt<2&&!checkboxState(match.checkbox);attempt++){
          firePointerClick(match.checkbox)
          await waitForDom(()=>checkboxState(match.checkbox),1500)
        }
      }
      if(checkboxState(match.checkbox))selected.push(target.raw);else missing.push(target.raw)
    }
    return {selected,missing}
  }

  async function publishListing(beforeClick){
    if(hasHumanChallenge())return false
    if(marketplaceStage()!=='groups')return false
    const button=await waitForDom(()=>actionButton(['Publicar','Publish']),18000)
    if(!button||marketplaceStage()!=='groups')return false
    const initialUrl=location.href
    button.scrollIntoView({block:'center',inline:'center',behavior:'auto'})
    await sleep(400)
    if(beforeClick)await beforeClick()
    if(hasHumanChallenge())return false
    const current=actionButton(['Publicar','Publish'])||button
    if(!controlEnabled(current))return false
    firePointerClick(current)
    return Boolean(await waitForDom(()=>{
      if(hasHumanChallenge())return false
      return location.href!==initialUrl&&/\/marketplace\/item\//.test(location.pathname)||marketplaceStage()==='published'
    },45000))
  }

  async function step(label,run){
    for(let attempt=0;attempt<2;attempt++){
      await randomDelay(attempt?420:260,attempt?760:560)
      try{if(await run())return[label,true]}catch(error){console.warn(`AutoFlow: falha em ${label}`,error)}
    }
    return[label,false]
  }

  async function fill(task){
    const vehicle=task.vehicle||task
    const jobId=task.jobId
    const automation=task.automation||{}
    const fieldSteps=[
      {label:'Tipo de veículo',run:()=>selectCustom(['tipo de veiculo','vehicle type'],vehicle.vehicleType||'Carro/picape'),critical:true},
      {label:'Localização',run:()=>selectOrFill(['localizacao','location'],vehicle.location),critical:true},
      {label:'Ano',run:()=>selectCustom(['ano','year'],String(vehicle.year)),critical:true},
      {label:'Fabricante',run:()=>selectOrFill(['fabricante','marca','make'],vehicle.make),critical:true},
      {label:'Modelo',run:()=>selectOrFill(['modelo','model'],vehicle.model),critical:true},
      {label:'Quilometragem',run:()=>fillText(['quilometragem','mileage','odometro'],vehicle.km),critical:true},
      {label:'Preço',run:()=>fillText(['preco','price'],vehicle.price),critical:true},
      {label:'Câmbio',run:()=>selectCustom(['cambio','transmissao','transmission'],vehicle.transmission),critical:true},
      {label:'Combustível',run:()=>selectCustom(['combustivel','fuel'],vehicle.fuelType),critical:true},
      {label:'Carroceria',run:()=>selectCustom(['estilo da carroceria','carroceria','body style','body type'],vehicle.bodyType),critical:true},
      {label:'Condição do veículo',run:()=>selectCustom(['condicao do veiculo','vehicle condition','condicao'],vehicle.condition),critical:true},
      {label:'Cor externa',run:()=>selectCustom(['cor externa','exterior color'],vehicle.exteriorColor),critical:false},
      {label:'Cor interna',run:()=>selectCustom(['cor interna','interior color'],vehicle.interiorColor),critical:false},
      {label:'Descrição',run:()=>fillText(['descricao','description'],vehicle.description),critical:true},
    ]
    const resultMap=new Map()
    for(const field of fieldSteps)resultMap.set(field.label,await step(field.label,field.run))
    let imageCount=await uploadImages(vehicle.images)
    resultMap.set('Fotos',['Fotos',imageCount>0])
    const repairFields=async attempt=>{
      const failed=fieldSteps.filter(field=>!resultMap.get(field.label)?.[1])
      const candidates=failed.length?failed:fieldSteps.filter(field=>field.critical)
      for(const field of candidates){
        const retried=await step(field.label,field.run)
        if(retried[1])resultMap.set(field.label,retried)
      }
      if(imageCount===0&&attempt===0){
        imageCount=await uploadImages(vehicle.images)
        if(imageCount>0)resultMap.set('Fotos',['Fotos',true])
      }
    }
    let advanced=false,selectedGroups=[],missingGroups=[],published=false,publishAttempted=false
    const flowIssues=[]
    if(automation.autoAdvance){
      advanced=await advanceToGroups(repairFields)
      if(!advanced)flowIssues.push('O Facebook não liberou a segunda etapa após as tentativas de preenchimento e correção.')
      if(advanced&&automation.fillGroups){
        const configuredGroups=Array.isArray(automation.targetGroups)?automation.targetGroups:[]
        if(!configuredGroups.length)flowIssues.push('Nenhum grupo foi configurado.')
        else{
          const groupResult=await selectConfiguredGroups(configuredGroups)
          selectedGroups=groupResult.selected
          missingGroups=groupResult.missing
          if(missingGroups.length)flowIssues.push('A seleção de todos os grupos não foi confirmada.')
        }
      }
      const groupsReady=!automation.fillGroups||(selectedGroups.length>0&&missingGroups.length===0)
      if(advanced&&automation.autoPublish&&groupsReady&&jobId){
        publishAttempted=true
        const currentResults=[...resultMap.values()]
        const reportBeforePublish={filledCount:currentResults.filter(item=>item[1]).length,totalCount:currentResults.length,imageCount,missing:currentResults.filter(item=>!item[1]).map(item=>item[0]),fields:currentResults.map(item=>({name:item[0],ok:Boolean(item[1])})),advanced,selectedGroups,missingGroups:[],flowIssues:[],publishAttempted:true}
        published=await publishListing(()=>runtimeMessage({type:'AUTOFLOW_PUBLISH_STARTED',jobId,report:reportBeforePublish}))
        if(!published){
          flowIssues.push('O clique em Publicar foi feito, mas o Facebook não confirmou o resultado. Verifique Seus classificados antes de liberar uma nova tentativa.')
          chrome.runtime.sendMessage({type:'AUTOFLOW_PUBLISH_ABORTED',jobId})
        }
      }else if(automation.autoPublish&&!advanced)flowIssues.push('Publicação bloqueada porque a etapa de grupos não foi aberta.')
      else if(automation.autoPublish&&!groupsReady)flowIssues.push('Publicação bloqueada porque os grupos não foram confirmados.')
    }
    const results=[...resultMap.values()]
    const missing=results.filter(item=>!item[1]).map(item=>item[0])
    if(advanced&&missing.length)flowIssues.push(`O Facebook aceitou o avanço, mas o diagnóstico interno não confirmou: ${missing.join(', ')}.`)
    showNotice(results,vehicle,{automation,advanced,selectedGroups,missingGroups,published,flowIssues})
    if(jobId){
      chrome.runtime.sendMessage({type:'AUTOFLOW_FILL_RESULT',jobId,report:{filledCount:results.length-missing.length,totalCount:results.length,imageCount,missing,fields:results.map(item=>({name:item[0],ok:Boolean(item[1])})),advanced,selectedGroups,missingGroups,published,publishAttempted,flowIssues,resultUrl:published?location.href:''}})
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
    if(flow.flowIssues?.length)details.push(flow.flowIssues.join(' '))
    const title=document.createElement('strong')
    title.style.cssText='display:block;margin-bottom:4px'
    title.textContent=`AutoFlow: ${count}/${results.length} campos preenchidos`
    const message=document.createElement('span')
    message.style.color='#b9d2cc'
    message.textContent=`${vehicle.year} ${vehicle.make} ${vehicle.model}. ${details.join(' ')}`
    const button=document.createElement('button')
    button.style.cssText='float:right;margin-top:10px;border:0;background:#36d09b;color:#12382f;border-radius:5px;padding:6px 9px;cursor:pointer'
    button.textContent='Entendi'
    button.onclick=()=>box.remove()
    box.append(title,message,button)
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
