// Pure validation of the Activepieces -> Auto Flow handoff.
// This module intentionally has no network, browser or publication operations.
const choices = {
  vehicleType: new Set(['Carro/picape', 'Motocicleta', 'Veículos para esportes', 'Trailer', 'Reboque', 'Barco', 'Comercial/industrial', 'Outro']),
  transmission: new Set(['Automático', 'Manual', 'Automatizado']),
  fuelType: new Set(['Flex', 'Gasolina', 'Diesel', 'Elétrico', 'Híbrido', 'Etanol', 'GNV', 'Outro']),
  bodyType: new Set(['Conversível', 'Cupê', 'Hatch', 'Minivan', 'Picape', 'Sedã', 'SUV', 'Perua', 'Van', 'Outro']),
  condition: new Set(['Excelente', 'Muito bom', 'Bom', 'Regular', 'Ruim']),
  color: new Set(['Preto', 'Azul', 'Marrom', 'Dourado', 'Verde', 'Cinza', 'Rosa', 'Roxo', 'Vermelho', 'Prateado', 'Laranja', 'Branco', 'Amarelo', 'Carvão', 'Off-white', 'Bronze', 'Bege', 'Bordô']),
};
const aliases = {
  transmission: {automatico:'Automático',automático:'Automático',manual:'Manual',automatizado:'Automatizado'},
  exteriorColor: {prata:'Prateado',prateado:'Prateado'},
};
const string = v => typeof v === 'string' ? v.trim() : '';
const number = v => (v === '' || v === null || v === undefined) ? NaN : Number(v);
const opt = (name,value) => {
  const text = string(value);
  return aliases[name]?.[text.toLocaleLowerCase('pt-BR')] || text;
};

export function parseBridgeEnvelope(value) {
  const document = value?.body?.bridgeVersion === 1 ? value.body : value;
  if (!document || document.bridgeVersion !== 1 || document.mode !== 'draft_only' ||
      document.dryRun !== true || !Array.isArray(document.jobs)) {
    throw new Error('Resposta incompatível: a ponte exige bridgeVersion 1 e modo draft_only.');
  }
  if (document.truncated || document.jobs.length > 50)
    throw new Error('Fila truncada ou grande demais. Reveja os filtros antes de transferir.');
  const seen = new Set();
  for (const job of document.jobs) {
    if (!job || job.source !== 'activepieces' || job.mode !== 'draft_only' ||
      job.platform !== 'facebook_marketplace' || !string(job.jobId) || !job.vehicle) {
      throw new Error('Item da ponte com origem, modo ou identificador inválido.');
    }
    if (seen.has(job.jobId)) throw new Error('jobId repetido na resposta.');
    seen.add(job.jobId);
  }
  return document;
}

export function mapToDraft(job, overrides = {}) {
  const input = job.vehicle || {};
  const vehicleId = string(input.vehicle_id);
  const corrections = overrides[vehicleId] || {};
  const v = { ...input, ...corrections };
  const year = number(v.ano_modelo), price = number(v.preco), km = number(v.quilometragem);
  const body = {
    stockCode: vehicleId,
    vin: string(v.vin),
    year,
    make: string(v.marca),
    model: string(v.modelo),
    trim: string(v.versao),
    price,
    km,
    vehicleType: opt('vehicleType',v.vehicleType),
    transmission: opt('transmission',v.cambio),
    fuelType: opt('fuelType',v.combustivel),
    bodyType: opt('bodyType',v.bodyType),
    condition: opt('condition',v.condition),
    exteriorColor: opt('exteriorColor',v.cor),
    interiorColor: opt('interiorColor',v.interiorColor),
    location: string(v.location) || [string(v.cidade),string(v.estado)].filter(Boolean).join(', '),
    description: string(v.descricao),
    status: 'Rascunho',
  };
  const errors = [];
  if (!vehicleId || vehicleId.length > 100) errors.push('vehicle_id');
  if (!Number.isInteger(year) || year < 1900 || year > new Date().getFullYear()+1) errors.push('ano_modelo');
  if (!Number.isFinite(price) || price <= 0) errors.push('preco');
  if (!Number.isFinite(km) || km < 0) errors.push('quilometragem');
  for (const [property,key] of [['make','marca'],['model','modelo'],['location','cidade/estado'],['description','descricao']]) {
    if (!body[property]) errors.push(key);
  }
  for (const [property,key] of [['vehicleType','vehicleType'],['transmission','cambio'],['fuelType','combustivel'],['bodyType','bodyType'],['condition','condition'],['exteriorColor','cor'],['interiorColor','interiorColor']]) {
    const category = property === 'exteriorColor' || property === 'interiorColor' ? 'color' : property;
    if (!choices[category].has(body[property])) errors.push(key);
  }
  return { jobId:job.jobId, vehicleId, body, errors,
    note: 'Criação de rascunho apenas; fotografias precisam ser importadas e revisadas no Auto Flow.' };
}

export function planDrafts(value, overrides = {}) {
  const doc = parseBridgeEnvelope(value);
  const mapped = doc.jobs.map(job => mapToDraft(job,overrides));
  const seen = new Set();
  for (const item of mapped) {
    if (seen.has(item.vehicleId)) item.errors.push('vehicle_id repetido no lote');
    seen.add(item.vehicleId);
  }
  return {
    total: mapped.length,
    eligible: mapped.filter(item=>item.errors.length === 0),
    blocked: mapped.filter(item=>item.errors.length > 0),
    ignoredAtSource: doc.blocked?.length || 0,
  };
}
