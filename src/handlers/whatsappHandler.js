require('dotenv').config();

const path = require('path');
const fs   = require('fs');
const { logger, anonPhone } = require('../utils/logger');

const ADMIN_PHONE = process.env.ADMIN_PHONE;
const UPLOADS_DIR = process.env.USER_DATA_PATH
  ? path.join(process.env.USER_DATA_PATH, 'uploads')
  : path.join(__dirname, '../../uploads');

// Momento exacto de inicio del bot (segundos Unix).
// Cualquier mensaje con timestamp anterior a este valor se ignora:
// son mensajes que llegaron mientras el bot estaba apagado.
const BOT_START_TIME = Math.floor(Date.now() / 1000);
const RETRY_COUNT = 2;
const RETRY_DELAY = 3000; // ms entre reintentos

let _client     = null;
let _adminWaUser = ADMIN_PHONE; // se actualiza al LID del admin en el evento ready

// Mapea phone normalizado → waId original (puede ser @c.us o @lid)
const waIdMap = new Map();

// ── Helpers de número ─────────────────────────────────────────────────────────

function normalizePhone(from) {
  return from.replace(/@c\.us$/, '').replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '');
}

function toWaId(phone) {
  if (waIdMap.has(phone)) return waIdMap.get(phone);
  if (phone.includes('@')) return phone;
  // Tras reiniciar el bot la cache en memoria está vacía. Recuperar el waId
  // original (@c.us o @lid) persistido en la DB para no romper el envío a
  // contactos @lid (que NO funcionan con el fallback @c.us).
  try {
    const { getWaId } = require('../db/queries');
    const stored = getWaId(phone);
    if (stored) {
      waIdMap.set(phone, stored);
      return stored;
    }
  } catch (_) {}
  return `${phone}@c.us`;
}

// ── Setup: registra el evento message en el cliente ───────────────────────────

function setup(client) {
  _client = client;

  // Resolver LID del admin para que notifyAdmin funcione con cuentas LID
  client.on('ready', async () => {
    if (!ADMIN_PHONE) return;
    try {
      const numberId = await client.getNumberId(ADMIN_PHONE);
      if (numberId?.user) {
        _adminWaUser = numberId.user;
        waIdMap.set(_adminWaUser, `${numberId.user}@${numberId.server}`);
        logger.info(`Admin WA ID resuelto: ****${_adminWaUser.slice(-4)}`);
      }
    } catch (e) {
      logger.warn(`No se pudo resolver LID del admin: ${e.message}`);
    }

    // Verificar configuración de datos de seña
    const cbu   = process.env.SENA_CBU;
    const alias = process.env.SENA_ALIAS;
    if (!cbu)   logger.warn('⚠️  SEÑA_CBU no está configurado en .env — el mensaje de seña mostrará solo el alias.');
    if (!alias) logger.warn('⚠️  SEÑA_ALIAS no está configurado en .env — el mensaje de seña estará incompleto.');
  });

  client.on('message', async (msg) => {
    try {
      // Ignorar mensajes viejos (llegaron mientras el bot estaba apagado)
      if (msg.timestamp < BOT_START_TIME) return;

      if (msg.fromMe)                      return;
      if (msg.from.includes('@g.us'))      return;
      if (msg.from.includes('@broadcast')) return;

      const phone = normalizePhone(msg.from);
      waIdMap.set(phone, msg.from); // cachear waId original para respuestas correctas
      // Persistir el waId para poder responder aún tras reiniciar el bot
      try { require('../db/queries').rememberWaId(phone, msg.from); } catch (_) {}
      const body  = (msg.body || '').trim();

      let contactName = null;
      try {
        const contact = await msg.getContact();
        contactName = contact.pushname || contact.name || null;
      } catch (_) {}

      const isAdmin = phone === ADMIN_PHONE || phone === _adminWaUser;

      const label   = isAdmin ? 'ADMIN' : 'CLIENTE';
      const preview = body || (msg.hasMedia ? '[media]' : '[sin texto]');
      logger.info(`[${label}] ${anonPhone(phone)}: ${preview}`);

      const { routeMessage } = require('./messageRouter');
      await routeMessage({ phone, body, msg, isAdmin, contactName });

    } catch (err) {
      logger.error(`Error procesando mensaje entrante: ${err.message}`, err);

      // Intentar notificar al admin si parece un error de base de datos
      const isDbError = err.message?.toLowerCase().includes('sqlite') ||
                        err.message?.toLowerCase().includes('database') ||
                        String(err.code).startsWith('SQLITE');
      if (isDbError) {
        try {
          await notifyAdmin(`⚠️ Error crítico en DB: ${err.message}`);
        } catch (_) {}
      }
    }
  });
}

// ── Envío de mensajes con reintentos ──────────────────────────────────────────

async function sendMessage(phone, text) {
  if (!_client) throw new Error('Cliente WhatsApp no inicializado. Llamá setup() primero.');

  const waId    = toWaId(phone);
  let   lastErr;

  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    try {
      await _client.sendMessage(waId, text);
      logger.debug(`Mensaje enviado a ${anonPhone(phone)}`);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_COUNT) {
        logger.warn(`Reintento ${attempt + 1}/${RETRY_COUNT} enviando a ${anonPhone(phone)}: ${err.message}`);
        await new Promise(r => setTimeout(r, RETRY_DELAY));
      }
    }
  }

  logger.error(`Falló envío a ${anonPhone(phone)} tras ${RETRY_COUNT + 1} intentos: ${lastErr.message}`);
  throw lastErr;
}

async function sendMessageWithList(phone, title, options) {
  const list = options.map((opt, i) => `\`${i + 1}\` ${opt}`).join('\n');
  await sendMessage(phone, `${title}\n\n${list}`);
}

async function notifyAdmin(text) {
  if (!ADMIN_PHONE) {
    logger.warn('ADMIN_PHONE no configurado en .env');
    return;
  }
  await sendMessage(ADMIN_PHONE, text);
}

// ── Descarga de media ─────────────────────────────────────────────────────────

async function downloadMedia(msg) {
  if (!msg.hasMedia) return null;

  const media = await msg.downloadMedia();
  if (!media?.data) return null;

  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }

  const ext      = (media.mimetype.split('/')[1] || 'jpg').split(';')[0];
  const filename = `${Date.now()}_${normalizePhone(msg.from)}.${ext}`;
  const filepath = path.join(UPLOADS_DIR, filename);

  fs.writeFileSync(filepath, Buffer.from(media.data, 'base64'));

  return { path: filepath, base64: media.data, mimetype: media.mimetype };
}

module.exports = {
  setup,
  sendMessage,
  sendMessageWithList,
  notifyAdmin,
  downloadMedia,
};
