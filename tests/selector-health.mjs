import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  closeSelectorCircuitBreaker,
  openSelectorCircuitBreaker,
  sanitizeSelectorHealth,
} from '../server/services/selector-health.ts'
import { findBestAccountForVehicle } from '../server/services/session-manager.ts'

const health = sanitizeSelectorHealth(
  {
    configVersion: '2026.09.1',
    pageLocale: 'pt-BR',
    criticalTotal: 10,
    missingCount: 3,
    successRate: 0.7,
  },
  ['Preço', 'Modelo', 'Ano'],
)
assert.equal(health.severe, true)
assert.equal(health.missingFields.length, 3)

const db = new DatabaseSync(':memory:')
db.function('autoflow_day', { deterministic: true }, (value) =>
  value === null ? null : String(value).slice(0, 10),
)
db.exec(`
  CREATE TABLE social_accounts (
    id INTEGER PRIMARY KEY,
    organization_id INTEGER NOT NULL,
    label TEXT NOT NULL,
    browser_profile TEXT,
    status TEXT NOT NULL,
    last_seen_at TEXT,
    automation_paused INTEGER NOT NULL DEFAULT 0,
    automation_pause_reason TEXT NOT NULL DEFAULT '',
    automation_paused_at TEXT
  );
  CREATE TABLE publication_jobs (
    id INTEGER PRIMARY KEY,
    organization_id INTEGER NOT NULL,
    social_account_id INTEGER,
    vehicle_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE organization_settings (
    organization_id INTEGER PRIMARY KEY,
    daily_limit INTEGER NOT NULL DEFAULT 10
  );
  INSERT INTO organization_settings (organization_id,daily_limit) VALUES (1,10);
  INSERT INTO social_accounts
    (id,organization_id,label,browser_profile,status,automation_paused)
  VALUES
    (1,1,'Perfil com drift','Profile 1','connected',0),
    (2,1,'Perfil saudável','Profile 2','connected',0);
  INSERT INTO publication_jobs (id,organization_id,social_account_id,vehicle_id,status,paused)
  VALUES
    (1,1,1,10,'pending',0),
    (2,1,1,11,'pending',1);
`)

openSelectorCircuitBreaker(db, 1, 1, 1, ['Preço', 'Modelo', 'Ano'])
const pausedAccount = db
  .prepare(
    'SELECT automation_paused automationPaused,automation_pause_reason reason FROM social_accounts WHERE id=1',
  )
  .get()
assert.equal(pausedAccount.automationPaused, 1)
assert.match(pausedAccount.reason, /Preço/)
assert.deepEqual(
  db
    .prepare('SELECT id,paused FROM publication_jobs ORDER BY id')
    .all()
    .map((row) => ({ ...row })),
  [
    { id: 1, paused: 0 },
    { id: 2, paused: 1 },
  ],
  'Opening the profile circuit breaker must not overwrite manual job pause state.',
)

const best = findBestAccountForVehicle(db, 1, 999)
assert.equal(best?.id, 2, 'Automatic assignment must skip selector-paused profiles.')

closeSelectorCircuitBreaker(db, 1, 1)
assert.equal(
  db.prepare('SELECT automation_paused automationPaused FROM social_accounts WHERE id=1').get()
    .automationPaused,
  0,
)
assert.deepEqual(
  db
    .prepare('SELECT id,paused FROM publication_jobs ORDER BY id')
    .all()
    .map((row) => ({ ...row })),
  [
    { id: 1, paused: 0 },
    { id: 2, paused: 1 },
  ],
  'Closing the profile circuit breaker must preserve manually paused jobs.',
)

db.close()
console.log(
  '✓ Circuit breaker: pausa por perfil sem alterar pausas manuais e autoassign ignora perfil bloqueado.',
)
