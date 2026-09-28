;(function () {
  const fields = {
    vehicleType: {
      critical: true,
      control: 'select',
      labels: {
        'pt-BR': ['tipo de veículo', 'tipo de veiculo'],
        'en-US': ['vehicle type'],
        'es-ES': ['tipo de vehículo', 'tipo de vehiculo'],
      },
    },
    location: {
      critical: true,
      control: 'text',
      humanTyping: true,
      labels: {
        'pt-BR': ['localização', 'localizacao'],
        'en-US': ['location'],
        'es-ES': ['ubicación', 'ubicacion'],
      },
    },
    year: {
      critical: true,
      control: 'select',
      labels: { 'pt-BR': ['ano'], 'en-US': ['year'], 'es-ES': ['año', 'ano'] },
    },
    make: {
      critical: true,
      control: 'text',
      labels: {
        'pt-BR': ['fabricante', 'marca'],
        'en-US': ['make', 'manufacturer'],
        'es-ES': ['marca', 'fabricante'],
      },
    },
    model: {
      critical: true,
      control: 'text',
      humanTyping: true,
      labels: { 'pt-BR': ['modelo'], 'en-US': ['model'], 'es-ES': ['modelo'] },
    },
    mileage: {
      critical: true,
      control: 'text',
      humanTyping: true,
      labels: {
        'pt-BR': ['quilometragem', 'odômetro', 'odometro'],
        'en-US': ['mileage', 'odometer'],
        'es-ES': ['kilometraje', 'odómetro', 'odometro'],
      },
    },
    price: {
      critical: true,
      control: 'text',
      humanTyping: true,
      labels: { 'pt-BR': ['preço', 'preco'], 'en-US': ['price'], 'es-ES': ['precio'] },
    },
    transmission: {
      critical: true,
      control: 'select',
      labels: {
        'pt-BR': ['câmbio', 'cambio', 'transmissão', 'transmissao'],
        'en-US': ['transmission'],
        'es-ES': ['transmisión', 'transmision'],
      },
    },
    fuelType: {
      critical: true,
      control: 'select',
      labels: {
        'pt-BR': ['combustível', 'combustivel'],
        'en-US': ['fuel', 'fuel type'],
        'es-ES': ['combustible', 'tipo de combustible'],
      },
    },
    bodyType: {
      critical: true,
      control: 'select',
      labels: {
        'pt-BR': ['estilo da carroceria', 'carroceria'],
        'en-US': ['body style', 'body type'],
        'es-ES': ['tipo de carrocería', 'tipo de carroceria', 'carrocería', 'carroceria'],
      },
    },
    condition: {
      critical: true,
      control: 'select',
      labels: {
        'pt-BR': ['condição do veículo', 'condicao do veiculo', 'condição', 'condicao'],
        'en-US': ['vehicle condition', 'condition'],
        'es-ES': ['estado del vehículo', 'estado del vehiculo', 'condición', 'condicion'],
      },
    },
    exteriorColor: {
      critical: false,
      control: 'select',
      labels: {
        'pt-BR': ['cor externa'],
        'en-US': ['exterior color'],
        'es-ES': ['color exterior'],
      },
    },
    interiorColor: {
      critical: false,
      control: 'select',
      labels: {
        'pt-BR': ['cor interna'],
        'en-US': ['interior color'],
        'es-ES': ['color interior'],
      },
    },
    description: {
      critical: true,
      control: 'text',
      labels: {
        'pt-BR': ['descrição', 'descricao'],
        'en-US': ['description'],
        'es-ES': ['descripción', 'descripcion'],
      },
    },
  }

  globalThis.AUTOFLOW_SELECTOR_CONFIG = Object.freeze({
    version: '2026.09.1',
    fallbackLocale: 'pt-BR',
    supportedLocales: ['pt-BR', 'en-US', 'es-ES'],
    aliases: {
      'carro caminhonete': ['Carro/picape', 'Carro/Caminhonete'],
      'carro picape': ['Carro/picape', 'Carro/Caminhonete'],
      'outro veiculo': ['Outro'],
      hatch: ['Hatchback', 'Hatch'],
      perua: ['Perua/Station wagon', 'Perua'],
      automatico: ['Automático'],
      prateado: ['Prateado', 'Prata'],
    },
    fields,
  })
})()
