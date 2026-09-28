import assert from 'node:assert/strict'
import {
  csvVehicles,
  detectCsvDelimiter,
  normalizeInventoryIdentifier,
  parseCsv,
  validateInventoryIdentifiers,
} from '../server/services/vehicle-import.ts'

assert.equal(detectCsvDelimiter('Ano;Marca;Modelo\n2024;Toyota;Corolla'), ';')
assert.equal(detectCsvDelimiter('year,make,model\n2024,Toyota,Corolla'), ',')

const parsed = parseCsv('Ano;Marca;Modelo;Descrição\n2024;Toyota;Corolla;"Completo; revisado"')
assert.deepEqual(parsed[1], ['2024', 'Toyota', 'Corolla', 'Completo; revisado'])

const [vehicle] = csvVehicles(
  'ID Estoque;VIN;Ano;Marca;Modelo;Preço;KM\n lj-42 ; 9bwzzZ377vt004251 ;2024;Toyota;Corolla;120000;1000',
)
assert.equal(vehicle.stockCode, 'LJ-42')
assert.equal(vehicle.vin, '9BWZZZ377VT004251')
assert.equal(vehicle.year, '2024')
assert.equal(vehicle.make, 'Toyota')
assert.equal(vehicle.price, '120000')
assert.equal(normalizeInventoryIdentifier(' ab 12 '), 'AB12')
assert.equal(validateInventoryIdentifiers('LJ-42', '9BWZZZ377VT004251'), '')
assert.match(validateInventoryIdentifiers('INVÁLIDO', ''), /caracteres/)
assert.throws(() => parseCsv('A;B\n"x;y', 10), /aspas não fechadas/)

console.log('✓ Importação: CSV, aliases e normalização de estoque/VIN.')
