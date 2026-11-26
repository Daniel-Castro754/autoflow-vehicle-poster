import {useEffect,useState} from 'react'
type Api=<T=Record<string,unknown>>(path:string,options?:RequestInit)=>Promise<T>
type Tool={name:string;description:string;readOnly:boolean;sources:string[];parameters:{required:string[];properties:Record<string,{type:string;description:string;enum?:string[]}>}}
export function CommanderQueryCatalog({api}:{api:Api}){
  const [tools,setTools]=useState<Tool[]>([])
  const [error,setError]=useState('')
  useEffect(()=>{
    let active=true
    void api<{tools:Tool[]}>('/ai/query-tools').then(r=>{if(active)setTools(r.tools)}).catch(()=>{if(active)setError('Não foi possível carregar o catálogo.')})
    return()=>{active=false}
  },[api])
  return <article className="module-card ai-card">
    <div className="module-head"><div><h2>AI Commander — catálogo de consultas</h2><span>{tools.length} ferramentas · somente leitura</span></div></div>
    <p>Consultas estruturadas disponíveis para o futuro agente. Não enviam dados à IA nesta etapa e não alteram o sistema.</p>
    {error&&<p role="status">{error}</p>}
    <details><summary>Ver ferramentas e parâmetros</summary>
      <table><thead><tr><th>Ferramenta</th><th>Finalidade</th><th>Parâmetros</th></tr></thead><tbody>
        {tools.map(t=><tr key={t.name}><td>{t.name}</td><td>{t.description}</td><td>{Object.keys(t.parameters.properties).map(k=>k+(t.parameters.required.includes(k)?' (obrigatório)':'')).join(', ')||'Nenhum'}</td></tr>)}
      </tbody></table>
    </details>
  </article>
}
