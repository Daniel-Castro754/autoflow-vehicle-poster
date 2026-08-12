const currentYear = new Date().getFullYear()

export const VEHICLE_TYPES = [
  'Carro/picape', 'Motocicleta', 'Veículos para esportes', 'Trailer',
  'Reboque', 'Barco', 'Comercial/industrial', 'Outro',
] as const

export const VEHICLE_YEARS = Array.from(
  { length: currentYear + 2 - 1900 },
  (_, index) => currentYear + 1 - index,
)

export const VEHICLE_MAKES = [
  'AM General', 'Agrale', 'Alfa Romeo', 'Aston Martin', 'Audi', 'BMW', 'Bentley',
  'BYD', 'Cadillac', 'Caoa Chery', 'Chery', 'Chevrolet', 'Chrysler', 'Citroën',
  'Cross Lander', 'Cupra', 'DS', 'Daewoo', 'Daihatsu', 'Dodge', 'Effa', 'Ferrari',
  'Fiat', 'Ford', 'Geely', 'GWM', 'Honda', 'Hyundai', 'Iveco', 'JAC', 'Jaecoo',
  'Jaguar', 'Jeep', 'Kia', 'Lamborghini', 'Land Rover', 'Lexus', 'Lifan', 'Maserati',
  'Mazda', 'Mercedes-Benz', 'Mini', 'Mitsubishi', 'Nissan', 'Omoda', 'Peugeot',
  'Porsche', 'RAM', 'Renault', 'Rolls-Royce', 'Seat', 'Smart', 'SsangYong',
  'Subaru', 'Suzuki', 'Tesla', 'Toyota', 'Troller', 'Volkswagen', 'Volvo', 'Outra',
] as const

export const TRANSMISSIONS = ['Automático', 'Manual', 'Automatizado'] as const

export const FUEL_TYPES = [
  'Flex', 'Gasolina', 'Diesel', 'Elétrico', 'Híbrido', 'Etanol', 'GNV', 'Outro',
] as const

export const BODY_TYPES = [
  'Conversível', 'Cupê', 'Hatch', 'Minivan', 'Picape', 'Sedã', 'SUV', 'Perua', 'Van', 'Outro',
] as const

export const VEHICLE_CONDITIONS = ['Excelente', 'Muito bom', 'Bom', 'Regular', 'Ruim'] as const

// Valores exibidos atualmente nos seletores de cor do Marketplace em pt-BR.
export const VEHICLE_COLORS = [
  'Preto', 'Azul', 'Marrom', 'Dourado', 'Verde', 'Cinza', 'Rosa', 'Roxo',
  'Vermelho', 'Prateado', 'Laranja', 'Branco', 'Amarelo', 'Carvão', 'Off-white',
  'Bronze', 'Bege', 'Bordô',
] as const

export const VEHICLE_STATUSES = ['Rascunho', 'Pronto', 'Publicado', 'Atenção', 'Vendido'] as const

export function withLegacyOption(options: readonly string[], current?: string) {
  return current && !options.includes(current) ? [current, ...options] : options
}
