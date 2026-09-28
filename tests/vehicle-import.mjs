import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  csvVehicles,
  detectCsvDelimiter,
  findVehicleIdentifierConflicts,
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

const db = new DatabaseSync(':memory:')
db.exec(`
  CREATE TABLE vehicles (
    id INTEGER PRIMARY KEY,
    organization_id INTEGER NOT NULL,
    stock_code TEXT NOT NULL DEFAULT '',
    vin TEXT NOT NULL DEFAULT ''
  );
  INSERT INTO vehicles (id,organization_id,stock_code,vin) VALUES
    (1,1,'EST-1','VIN-ONE'),
    (2,1,'EST-2','VIN-TWO');
`)
assert.deepEqual(
  findVehicleIdentifierConflicts(db, 1, 'EST-1', 'VIN-TWO').map((item) => item.id),
  [1, 2],
  'Stock code and VIN pointing to different vehicles must be treated as an ambiguous import.',
)
assert.deepEqual(
  findVehicleIdentifierConflicts(db, 1, 'EST-1', 'VIN-ONE').map((item) => item.id),
  [1],
)
db.close()

console.log('✓ Importação: CSV, aliases e normalização de estoque/VIN.')
