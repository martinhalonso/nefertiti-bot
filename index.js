// Cargar .env desde userData si está disponible (app empaquetada),
// o desde la raíz del proyecto (desarrollo)
const path = require('path');
const fs   = require('fs');

// Captura errores de arranque antes de que el logger esté disponible
process.on('uncaughtException', (err) => {
  const logDir  = path.join(process.env.USER_DATA_PATH || '.', 'logs');
  const logFile = path.join(logDir, 'crash.log');
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(logFile,
      `\n[${new Date().toISOString()}] CRASH TEMPRANO:\n${err.stack || err.message}\n`
    );
  } catch (_) {}
  // Una vez que el logger esté disponible, no re-procesar estos errores acá
});

const envPath = process.env.USER_DATA_PATH
  ? path.join(process.env.USER_DATA_PATH, '.env')
  : undefined;

require('dotenv').config(envPath ? { path: envPath } : {});

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode  = require('qrcode-terminal');
const express = require('express');

const whatsappHandler                            = require('./src/handlers/whatsappHandler');
const { startTimeoutCleaner, startDailySummary, startCalendarSync } = require('./src/handlers/clientHandler');
const { registerAuthRoutes, checkCalendarConfig, restoreAppointmentsFromCalendar, ensureTokenPersisted, hasGoogleToken } = require('./src/handlers/calendarHandler');
const { logger }                                 = require('./src/utils/logger');
const { initDB, getDb }                          = require('./src/db/initDB');
const { seed }                                   = require('./src/db/seed');
const { getSetting }                             = require('./src/db/queries');
const { restoreFromBackupIfEmpty, backupNow, startBackupSchedule } = require('./src/db/backup');

// Crear tablas y cargar datos por defecto si es la primera vez
initDB();
// Si la agenda quedó vacía (ej.: bot.db se reseteó al actualizar) y hay un
// backup con turnos, restaurarlo antes de seguir.
restoreFromBackupIfEmpty();
(function seedIfEmpty() {
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) as n FROM services').get().n;
  db.close();
  if (count === 0) {
    logger.info('Base de datos vacía — cargando servicios y configuración inicial...');
    seed();
  }
})();

// ── Express (health check) ────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

let connectionState = 'disconnected';

app.get('/health', (_req, res) => {
  let dbOk = false;
  let db;
  try {
    db = getDb();
    db.prepare('SELECT 1').get();
    dbOk = true;
  } catch (_) {
  } finally {
    try { db?.close(); } catch (_) {}
  }

  const googleAuthorized = hasGoogleToken();

  res.json({
    status:        dbOk && connectionState === 'connected' ? 'ok' : 'degraded',
    whatsapp:      connectionState,
    db:            dbOk ? 'ok' : 'error',
    googleCalendar: googleAuthorized ? 'authorized' : 'not_authorized',
  });
});

registerAuthRoutes(app);

app.listen(PORT, () => {
  logger.info(`Servidor Express escuchando en puerto ${PORT}`);
});

// ── Detección automática de Chrome ────────────────────────────────────────────
function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
    // Microsoft Edge como fallback
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);

  return candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
}

const chromePath = findChrome();
if (!chromePath) {
  logger.error('❌ No se encontró Chrome ni Edge instalado. El bot no puede iniciar.');
  process.exit(1);
}
logger.info(`Chrome detectado: ${chromePath}`);

// ── Ruta de autenticación WhatsApp ────────────────────────────────────────────
const authDataPath = process.env.USER_DATA_PATH || path.join(__dirname, '.');

// ── Cliente WhatsApp ──────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: authDataPath }),
  puppeteer: {
    executablePath: chromePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=VizDisplayCompositor',
      '--disable-extensions',
      '--disable-default-apps',
      '--disable-sync',
      '--no-default-browser-check',
    ],
  },
});

client.on('qr', (qr) => {
  logger.info('Escaneá el QR con WhatsApp → Dispositivos vinculados');
  // En app empaquetada (utilityProcess) enviamos el QR al proceso principal
  if (process.parentPort) {
    process.parentPort.postMessage({ type: 'qr', data: qr });
  } else {
    // En desarrollo: mostrar en terminal
    qrcode.generate(qr, { small: true });
  }
});

client.on('ready', () => {
  connectionState = 'connected';
  const info = client.info;
  logger.info(`WhatsApp conectado como: ${info.pushname} (${info.wid.user})`);
  checkCalendarConfig();
  // Asegurar que el token de Google quede en archivo (a salvo de reseteos de la DB)
  ensureTokenPersisted();
  // Reimportar desde Google Calendar los turnos que falten en la DB (recupera la
  // agenda si bot.db se perdió al actualizar y evita re-ofrecer horarios ocupados)
  restoreAppointmentsFromCalendar()
    .then(n => { if (n) logger.info(`Agenda restaurada desde Calendar: ${n} turno(s).`); })
    .catch(err => logger.warn(`Restauración Calendar→DB falló: ${err.message}`))
    .finally(() => backupNow()); // respaldar el estado bueno tras restaurar
  startTimeoutCleaner();
  startDailySummary();
  startCalendarSync();
  startBackupSchedule();

  if (process.parentPort) {
    process.parentPort.postMessage({ type: 'ready' });
  }
});

client.on('authenticated', () => {
  logger.info('Sesión autenticada. Credenciales guardadas localmente.');
  if (process.parentPort) {
    process.parentPort.postMessage({ type: 'authenticated' });
  }
});

whatsappHandler.setup(client);

client.on('auth_failure', (msg) => {
  connectionState = 'disconnected';
  logger.error(`Error de autenticación: ${msg}. Reiniciá el proceso y volvé a escanear el QR.`);
});

client.on('disconnected', async (reason) => {
  connectionState = 'disconnected';
  logger.warn(`WhatsApp desconectado: ${reason}. Reintentando en 5 segundos...`);
  try { await client.destroy(); } catch (_) {}
  setTimeout(async () => {
    try { await client.initialize(); }
    catch (err) { logger.error(`Error al reinicializar cliente: ${err.message}`); }
  }, 5000);
});

// Captura errores de frames desconectados de Puppeteer durante reconexiones.
// Sin esto, un LOGOUT tira el proceso completo.
process.on('uncaughtException', (err) => {
  if (
    err.message?.includes('detached Frame') ||
    err.message?.includes('detached frame') ||
    err.message?.includes('Attempted to use detached')
  ) {
    logger.warn('Frame de Chrome desconectado durante reconexión — ignorado.');
    return;
  }
  logger.error(`Error no capturado: ${err.message}`);
  process.exit(1);
});

logger.info('Iniciando cliente WhatsApp...');
client.initialize();
