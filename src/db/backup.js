'use strict';

// Respaldo automático de bot.db.
//
// Objetivo: que la agenda no se pierda al actualizar la app. Los backups se
// guardan en USER_DATA_PATH/backups (la misma carpeta de datos que sobrevive a
// una reinstalación). Complementa la reimportación desde Google Calendar:
//   - Si bot.db se resetea pero la carpeta de datos persiste, restauramos el
//     último backup con turnos.
//   - Calendar→DB cubre el caso de que también se pierdan los backups.

const fs   = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');
const { DB_PATH, initDB } = require('./initDB');

const MAX_BACKUPS = 10;

function backupDir() {
  return path.join(path.dirname(DB_PATH), 'backups');
}

function ensureDir() {
  const d = backupDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

// Cuenta turnos futuros en un archivo .db (sin tocar la conexión principal).
// Devuelve 0 si el archivo no existe, no tiene la tabla, o hay cualquier error.
function countFutureAppointments(dbFile) {
  if (!dbFile || !fs.existsSync(dbFile)) return 0;
  let db;
  try {
    const Database = require('better-sqlite3');
    db = new Database(dbFile, { readonly: true, fileMustExist: true });
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM appointments WHERE appointment_date >= date('now','localtime')`
    ).get();
    return row?.n || 0;
  } catch (_) {
    return 0;
  } finally {
    try { db?.close(); } catch (_) {}
  }
}

function listBackups() {
  const d = backupDir();
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d)
    .filter(f => f.startsWith('bot-') && f.endsWith('.db'))
    .sort() // el nombre lleva timestamp YYYYMMDD-HHMMSS, así que ordena cronológicamente
    .map(f => path.join(d, f));
}

function pruneOldBackups() {
  const all = listBackups();
  if (all.length <= MAX_BACKUPS) return;
  for (const f of all.slice(0, all.length - MAX_BACKUPS)) {
    try { fs.unlinkSync(f); } catch (_) {}
  }
}

// Crea un backup del bot.db actual. Solo respalda si hay turnos futuros, para
// no pisar backups buenos con una base vacía o recién reseteada.
function backupNow() {
  try {
    if (!fs.existsSync(DB_PATH)) return null;
    const futureCount = countFutureAppointments(DB_PATH);
    if (futureCount === 0) {
      logger.info('Backup de bot.db omitido: la agenda no tiene turnos futuros.');
      return null;
    }
    ensureDir();
    const now   = new Date();
    const pad   = n => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
                  `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const dest  = path.join(backupDir(), `bot-${stamp}.db`);
    fs.copyFileSync(DB_PATH, dest);
    pruneOldBackups();
    logger.info(`Backup de bot.db creado: ${path.basename(dest)} (${futureCount} turno(s) futuros). Se conservan los últimos ${MAX_BACKUPS}.`);
    return dest;
  } catch (e) {
    logger.warn(`No se pudo crear backup de bot.db: ${e.message}`);
    return null;
  }
}

// Devuelve el backup más reciente que tenga al menos un turno futuro, o null.
function latestGoodBackup() {
  const all = listBackups().reverse(); // del más reciente al más viejo
  for (const f of all) {
    if (countFutureAppointments(f) > 0) return f;
  }
  return null;
}

// Si la agenda actual está vacía pero existe un backup con turnos, restaura ese
// backup sobre bot.db. Debe llamarse después de initDB() (tablas ya creadas).
// Devuelve true si restauró.
function restoreFromBackupIfEmpty() {
  try {
    if (countFutureAppointments(DB_PATH) > 0) return false; // ya hay turnos
    const backup = latestGoodBackup();
    if (!backup) return false;
    const n = countFutureAppointments(backup);
    fs.copyFileSync(backup, DB_PATH);
    initDB(); // re-aplicar migraciones por si el backup es de una versión anterior
    logger.info(`Agenda vacía detectada — restaurada desde backup ${path.basename(backup)} (${n} turno(s)).`);
    return true;
  } catch (e) {
    logger.warn(`No se pudo restaurar desde backup: ${e.message}`);
    return false;
  }
}

// Programa un backup diario.
function startBackupSchedule() {
  try {
    const cron = require('node-cron');
    cron.schedule('0 23 * * *', () => backupNow());
    logger.info('Backups automáticos de bot.db activos — diario a las 23:00.');
  } catch (e) {
    logger.warn(`No se pudo programar el backup diario: ${e.message}`);
  }
}

module.exports = {
  backupNow,
  restoreFromBackupIfEmpty,
  startBackupSchedule,
  latestGoodBackup,
  listBackups,
  backupDir,
};
