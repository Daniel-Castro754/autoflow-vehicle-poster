// Strict mapping of a dedicated stock tab. No locale guesses, generated
// descriptions, row truncation or implicit commercial state.
const required=['stockCode','year','make','model','price','km','commercialState','vehicleType','location','transmission','fuelType','bodyType','exteriorColor','interiorColor','condition','description']
const optional=['vin','trim']
const empty=value=>value===undefined||value===null||value===''
export function sheetStockSnapshot(values){
  if(!Array.isArray(values)||!values.length||values.length>501||!values.every(Array.isArray))
    throw new Error('A aba deve ter cabeçalho e até 500 linhas; não há leitura parcial automática.')
  const headers=values[0].map(value=>typeof value==='string'?value.trim():'')
  if(headers.length>required.length+optional.length||new Set(headers).size!==headers.length||
    !required.every(field=>headers.includes(field))||headers.some(field=>![...required,...optional].includes(field)))
    throw new Error('Cabeçalho da aba incompatível com o contrato de estoque.')
  const rows=[]
  for(const [i,cells] of values.slice(1).entries()){
    if(cells.every(empty))continue
    if(cells.length>headers.length)throw new Error('Colunas não identificadas na linha '+(i+2)+'.')
    const row={}
    for(const [j,field] of headers.entries()){
      const value=cells[j]
      if(optional.includes(field)&&empty(value))continue
      if(['year','price','km'].includes(field)){
        if(typeof value!=='number'||!Number.isFinite(value))throw new Error('Número inválido na linha '+(i+2)+': '+field+'.')
        row[field]=value
      }else{
        if(typeof value!=='string')throw new Error('Texto obrigatório na linha '+(i+2)+': '+field+'.')
        row[field]=value.trim()
      }
    }
    if(!row.stockCode||!['available','sold'].includes(row.commercialState))
      throw new Error('Identidade ou situação comercial inválida na linha '+(i+2)+'.')
    rows.push(row)
  }
  return {version:1,source:'sheets',sourceState:'complete',rows}
}

export function stockSheetUrl(id,tab){
  if(typeof id!=='string'||!/^[A-Za-z0-9_-]{10,200}$/.test(id)||
     typeof tab!=='string'||!tab.trim()||tab.length>100||Array.from(tab).some(c=>c.charCodeAt(0)<32))
    throw new Error('Configure o ID da planilha e o nome exato da aba.')
  const range="'"+tab.replace(/'/g,"''")+"'"
  const url=new URL('https://sheets.googleapis.com/v4/spreadsheets/'+id+'/values/'+encodeURIComponent(range))
  url.searchParams.set('majorDimension','ROWS')
  url.searchParams.set('valueRenderOption','UNFORMATTED_VALUE')
  return url
}
