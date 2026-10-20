import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const demo = JSON.parse(readFileSync(new URL('../workflow-01-demonstracao.json',import.meta.url),'utf8'))
const csv = JSON.parse(readFileSync(new URL('../workflow-02-importar-csv.json',import.meta.url),'utf8'))
assert.equal(demo.active,false)
assert.equal(csv.active,false)
for (const flow of [demo,csv]) {
  assert.ok(flow.nodes[0].type.endsWith('manualTrigger'))
  const steps = flow.nodes.filter(node => node.type === 'n8n-nodes-base.code')
  let input = flow === demo ? [{json:{}}] : new Function('$input',demo.nodes.find(n=>n.name==='Veiculos de exemplo').parameters.jsCode)({all:()=>[]})
  for(const node of steps) {
    input = new Function('$input',node.parameters.jsCode)({all:()=>input})
    assert.ok(Array.isArray(input),'Node must return items')
    assert.ok(input.every(item => item && typeof item.json === 'object'))
  }
  // This synthetic execution is for code-only workflow. For CSV, replace with
  // real examples to verify the processing steps without n8n.
  if(flow===demo) {
    assert.equal(input[0].json.metricas.recebidos,6)
    assert.equal(input[0].json.metricas.aprovados,3)
    assert.equal(input[0].json.metricas.revisar,2)
    assert.equal(input[0].json.metricas.duplicados,1)
  }
}
console.log('Workflow structures and demo Code nodes pass local checks.')
