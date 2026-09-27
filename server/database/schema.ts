import { logger } from '../lib/logger.ts'
import { businessDate } from '../lib/timezone.ts'
import type { DatabaseSync } from 'node:sqlite'

export function initializeBaseSchema(db: DatabaseSync) {
  db.function('autoflow_day', {deterministic:true}, (value) => value === null ? null : businessDate(String(value)))
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
  `)
  const mode = db.prepare('PRAGMA journal_mode = WAL').get() as {journal_mode: string}
  if (mode.journal_mode !== 'wal' && mode.journal_mode !== 'memory') logger.warn('Schema','WAL indisponível',{mode:mode.journal_mode})
  db.exec('BEGIN')
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS organizations (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL, name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'seller',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES organizations(id)
      );
      CREATE TABLE IF NOT EXISTS social_accounts (
        id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        label TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'facebook', status TEXT NOT NULL DEFAULT 'not_connected',
        browser_profile TEXT, last_seen_at TEXT,
        FOREIGN KEY (organization_id) REFERENCES organizations(id), FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS vehicles (
        id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL, year INTEGER NOT NULL,
        make TEXT NOT NULL, model TEXT NOT NULL, trim TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL DEFAULT 0,
        km INTEGER NOT NULL DEFAULT 0, color TEXT NOT NULL DEFAULT '#dde3e2', status TEXT NOT NULL DEFAULT 'Rascunho',
        assigned_user_id INTEGER, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES organizations(id), FOREIGN KEY (assigned_user_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS publication_jobs (
        id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL, vehicle_id INTEGER NOT NULL,
        social_account_id INTEGER, status TEXT NOT NULL DEFAULT 'pending', result_url TEXT, error_code TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES organizations(id), FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
        FOREIGN KEY (social_account_id) REFERENCES social_accounts(id)
      );
      CREATE TABLE IF NOT EXISTS organization_settings (
        organization_id INTEGER PRIMARY KEY, default_location TEXT NOT NULL DEFAULT '',
        daily_limit INTEGER NOT NULL DEFAULT 10, require_confirmation INTEGER NOT NULL DEFAULT 1,
        description_template TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES organizations(id)
      );
      CREATE TABLE IF NOT EXISTS vehicle_images (
        id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL, vehicle_id INTEGER NOT NULL,
        file_name TEXT NOT NULL, original_name TEXT NOT NULL, mime_type TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES organizations(id), FOREIGN KEY (vehicle_id) REFERENCES vehicles(id)
      );
      CREATE TABLE IF NOT EXISTS marketplace_groups (
        id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL DEFAULT '',
        group_key TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0, last_found_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES organizations(id)
      );
      CREATE TABLE IF NOT EXISTS publication_job_events (
        id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL, publication_job_id INTEGER NOT NULL,
        event_type TEXT NOT NULL, from_account_id INTEGER, to_account_id INTEGER, created_by INTEGER,
        details TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (organization_id) REFERENCES organizations(id), FOREIGN KEY (publication_job_id) REFERENCES publication_jobs(id),
        FOREIGN KEY (from_account_id) REFERENCES social_accounts(id), FOREIGN KEY (to_account_id) REFERENCES social_accounts(id),
        FOREIGN KEY (created_by) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
