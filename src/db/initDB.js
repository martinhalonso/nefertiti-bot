const Database = require('better-sqlite3');
const path     = require('path');
const { logger } = require('../utils/logger');

const DB_PATH = process.env.USER_DATA_PATH
  ? path.join(process.env.USER_DATA_PATH, 'bot.db')
  : path.join(__dirname, '../../data/bot.db');

function getDb() {
  return new Database(DB_PATH);
}

function initDB() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number    TEXT NOT NULL UNIQUE,
      bot_active      INTEGER NOT NULL DEFAULT 1,
      current_step    TEXT,
      step_data       TEXT,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number      TEXT NOT NULL,
      client_name       TEXT,
      service_name      TEXT NOT NULL,
      service_duration  INTEGER NOT NULL,
      service_price     REAL NOT NULL,
      appointment_date  TEXT NOT NULL,
      appointment_time  TEXT NOT NULL,
      seña_paid         INTEGER NOT NULL DEFAULT 0,
      receipt_image_url TEXT,
      calendar_event_id TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS blocked_slots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date        TEXT NOT NULL,
      start_time  TEXT,
      end_time    TEXT,
      full_day    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS services (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      price            REAL NOT NULL,
      active           INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS pending_receipts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number   TEXT NOT NULL,
      image_url      TEXT NOT NULL,
      appointment_id INTEGER,
      reviewed       INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (appointment_id) REFERENCES appointments(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clients (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      phone      TEXT UNIQUE NOT NULL,
      name       TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `);

  // Migraciones: agregar columnas si no existen
  try { db.exec(`ALTER TABLE services ADD COLUMN category TEXT`);    } catch (_) {}
  try { db.exec(`ALTER TABLE services ADD COLUMN sort_order INTEGER`); } catch (_) {}
  // waId original del contacto (@c.us o @lid). Necesario para responderle
  // correctamente incluso tras reiniciar el bot (la cache en memoria se pierde).
  try { db.exec(`ALTER TABLE conversations ADD COLUMN wa_id TEXT`); } catch (_) {}
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_services_name ON services(name)`);

  // Migración: poblar clients con los datos existentes de appointments
  try {
    db.exec(`
      INSERT OR IGNORE INTO clients (phone, name)
      SELECT DISTINCT phone_number, client_name
      FROM appointments
      WHERE phone_number != 'manual' AND phone_number IS NOT NULL AND phone_number != ''
    `);
  } catch (_) {}

  logger.info('Tablas creadas/verificadas correctamente.');
  db.close();
}

module.exports = { initDB, getDb, DB_PATH };
