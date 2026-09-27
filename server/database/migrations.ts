import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

type Migration = {
  version: number
  columns: Array<[string, string, string]>
  sql: string
}

const migrations: Migration[] = [
  {
    version: 1,
    columns: [
      ['vehicles', 'vehicle_type', "TEXT NOT NULL DEFAULT 'Carro/picape'"],
      ['vehicles', 'location', "TEXT NOT NULL DEFAULT ''"],
      ['vehicles', 'transmission', "TEXT NOT NULL DEFAULT 'Automático'"],
      ['vehicles', 'fuel_type', "TEXT NOT NULL DEFAULT 'Flex'"],
      ['vehicles', 'body_type', "TEXT NOT NULL DEFAULT 'Sedã'"],
      ['vehicles', 'exterior_color', "TEXT NOT NULL DEFAULT ''"],
      ['vehicles', 'interior_color', "TEXT NOT NULL DEFAULT ''"],
      ['vehicles', 'description', "TEXT NOT NULL DEFAULT ''"],
      ['vehicles', 'vehicle_condition', "TEXT NOT NULL DEFAULT ''"],
      ['publication_jobs', 'fill_report', "TEXT NOT NULL DEFAULT ''"],
      ['publication_jobs', 'extension_version', "TEXT NOT NULL DEFAULT ''"],
      ['publication_jobs', 'started_at', 'TEXT'],
      ['publication_jobs', 'filled_at', 'TEXT'],
      ['publication_jobs', 'removed_at', 'TEXT'],
      ['publication_jobs', 'extension_visible', 'INTEGER NOT NULL DEFAULT 1'],
      ['publication_jobs', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['publication_jobs', 'queue_priority', 'INTEGER NOT NULL DEFAULT 0'],
      ['publication_jobs', 'paused', 'INTEGER NOT NULL DEFAULT 0'],
      ['publication_jobs', 'scheduled_at', 'TEXT'],
      ['publication_jobs', 'lease_token', 'TEXT'],
      ['publication_jobs', 'lease_owner', 'TEXT'],
      ['publication_jobs', 'lease_expires_at', 'TEXT'],
      ['publication_jobs', 'execution_tab_id', 'INTEGER'],
      ['publication_jobs', 'execution_document', 'TEXT'],
      ['publication_job_events', 'details', "TEXT NOT NULL DEFAULT '{}'"],
      ['vehicle_images', 'content_hash', "TEXT NOT NULL DEFAULT ''"],
      ['vehicles', 'sold_at', 'TEXT'],
      ['organization_settings', 'auto_advance', 'INTEGER NOT NULL DEFAULT 0'],
      ['organization_settings', 'fill_groups', 'INTEGER NOT NULL DEFAULT 0'],
      ['organization_settings', 'target_groups', "TEXT NOT NULL DEFAULT '[]'"],
      ['organization_settings', 'auto_publish', 'INTEGER NOT NULL DEFAULT 0'],
      ['organization_settings', 'stuck_timeout_minutes', 'INTEGER NOT NULL DEFAULT 15'],
      ['organization_settings', 'execution_interval_minutes', 'INTEGER NOT NULL DEFAULT 25'],
      ['publication_jobs', 'max_retries', 'INTEGER NOT NULL DEFAULT 3'],
      ['publication_jobs', 'retry_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['organization_settings', 'auto_retry', 'INTEGER NOT NULL DEFAULT 0'],
      ['organization_settings', 'max_retries', 'INTEGER NOT NULL DEFAULT 3'],
      ['organization_settings', 'alert_telegram_token', "TEXT NOT NULL DEFAULT ''"],
      ['organization_settings', 'alert_telegram_chat_id', "TEXT NOT NULL DEFAULT ''"],
      ['organization_settings', 'alert_webhook_url', "TEXT NOT NULL DEFAULT ''"],
      ['organization_settings', 'auto_curate_groups', 'INTEGER NOT NULL DEFAULT 0'],
      ['organization_settings', 'gemini_api_key', "TEXT NOT NULL DEFAULT ''"],
      ['organization_settings', 'openai_api_key', "TEXT NOT NULL DEFAULT ''"],
      ['organization_settings', 'ai_provider', "TEXT NOT NULL DEFAULT 'auto'"],
    ],
    sql: `UPDATE publication_jobs SET queue_priority=id WHERE queue_priority=0;
  CREATE INDEX IF NOT EXISTS idx_publication_job_events_timeline ON publication_job_events (organization_id,publication_job_id,created_at,id);
  CREATE INDEX IF NOT EXISTS idx_vehicle_images_content_hash ON vehicle_images (organization_id,content_hash,vehicle_id);
  CREATE INDEX IF NOT EXISTS idx_publication_jobs_account_queue ON publication_jobs (organization_id,social_account_id,status,paused,queue_priority);
  CREATE INDEX IF NOT EXISTS idx_publication_jobs_vehicle_status ON publication_jobs (organization_id,vehicle_id,status);
  CREATE INDEX IF NOT EXISTS idx_publication_jobs_created ON publication_jobs (organization_id,social_account_id,created_at,status);
  CREATE INDEX IF NOT EXISTS idx_vehicles_org_updated ON vehicles (organization_id,updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_vehicles_status_updated ON vehicles (organization_id,status,updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_vehicle_images_vehicle_position ON vehicle_images (organization_id,vehicle_id,position,id);
  CREATE INDEX IF NOT EXISTS idx_social_accounts_org_user ON social_accounts (organization_id,user_id);
  CREATE INDEX IF NOT EXISTS idx_marketplace_groups_org_active_priority ON marketplace_groups (organization_id,active,priority,id);`,
  },
  { version: 2, columns: [['publication_jobs', 'last_lease_token', 'TEXT']], sql: '' },
  { version: 3, columns: [['publication_jobs', 'execution_document_id', 'TEXT']], sql: '' },
  {
    version: 4,
    columns: [['users', 'active', 'INTEGER NOT NULL DEFAULT 1']],
    sql: `CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, organization_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL, revoked_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (organization_id) REFERENCES organizations(id)
  );
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active ON auth_sessions (user_id,revoked_at,expires_at);`,
  },
  {
    version: 5,
    columns: [],
    sql: `UPDATE organization_settings SET description_template='{ano} {marca} {modelo} {versao} com {km} km. Entre em contato para mais informações.'
    WHERE description_template='{ano} {marca} {modelo} {versao} com {km} km. Entre em contato para consultar disponibilidade.';`,
  },
  // Keep migrations 1–5 immutable for databases already opened by this branch.
  // Main added this checkpoint before schema versioning; ensureColumn handles both bases.
  { version: 6, columns: [['publication_jobs', 'publish_attempt_at', 'TEXT']], sql: '' },
  { version: 7, columns: [], sql: `
    UPDATE organizations SET name='AutoPrime Veículos' WHERE name='AutoPrime Ve'||char(65533)||'culos';
    UPDATE organization_settings SET default_location='São Paulo, SP' WHERE default_location='S'||char(65533)||'o Paulo, SP';
    UPDATE vehicles SET vehicle_type='Carro/picape' WHERE vehicle_type='Carro/Caminhonete';
    UPDATE vehicles SET vehicle_type='Outro' WHERE vehicle_type='Outro veículo';
    UPDATE vehicles SET exterior_color='Prateado' WHERE exterior_color='Prata';
    UPDATE vehicles SET interior_color='Preto' WHERE interior_color='' AND exterior_color!='';
  ` },
  { version: 8, columns: [], sql: `
    CREATE INDEX IF NOT EXISTS idx_publication_jobs_account_priority ON publication_jobs (organization_id,social_account_id,queue_priority,id);
    CREATE INDEX IF NOT EXISTS idx_publication_jobs_account_vehicle ON publication_jobs (organization_id,social_account_id,vehicle_id,status);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions (datetime(expires_at));
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_revoked ON auth_sessions (datetime(revoked_at)) WHERE revoked_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_publication_events_org_id ON publication_job_events (organization_id,id DESC);
  ` },
]

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

export function applyMigrations(db: DatabaseSync) {
  const migrationTableColumns = db.prepare('PRAGMA table_info(schema_migrations)').all() as Array<{ name: string }>
  if (!migrationTableColumns.some(item => item.name === 'checksum')) {
    db.exec('BEGIN')
    try {
      db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''")
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const appliedMigrations = db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number; checksum: string }>
  const appliedByVersion = new Map(appliedMigrations.map(migration => [migration.version, migration]))
  for (const applied of appliedMigrations) {
    if (!migrations.some(migration => migration.version === applied.version)) {
      throw new Error(`O banco foi atualizado para uma versão de schema não suportada: ${applied.version}.`)
    }
  }
  for (const migration of migrations) {
    const checksum = createHash('sha256').update(JSON.stringify({ columns: migration.columns, sql: migration.sql })).digest('hex')
    const applied = appliedByVersion.get(migration.version)
    if (applied?.checksum && applied.checksum !== checksum) {
      throw new Error(`Checksum incompatível para a migration ${migration.version}. Restaure o backup antes de continuar.`)
    }
    if (applied?.checksum === checksum) continue
    db.exec('BEGIN')
    try {
      for (const [table, column, definition] of migration.columns) ensureColumn(db, table, column, definition)
      db.exec(migration.sql)
      if (applied) db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=?').run(checksum, migration.version)
      else db.prepare('INSERT INTO schema_migrations (version,checksum) VALUES (?,?)').run(migration.version, checksum)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
