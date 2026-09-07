// Lazy para evitar dependencia circular con whatsappHandler
const send        = () => require('./whatsappHandler');
const getClient   = () => require('./clientHandler');
const getAdmin    = () => require('./adminHandler');

/**
 * Punto de entrada de todos los mensajes entrantes.
 *
 * @param {object} params
 * @param {string}  params.phone       - Número normalizado (sin @c.us)
 * @param {string}  params.body        - Texto del mensaje (ya trimmeado)
 * @param {object}  params.msg         - Objeto Message de wwebjs
 * @param {boolean} params.isAdmin     - true si el remitente es el ADMIN_PHONE
 * @param {string}  params.contactName - Nombre del contacto (puede ser null)
 */
async function routeMessage({ phone, body, msg, isAdmin, contactName }) {
  const lower = body.toLowerCase().trim();

  // ── Comando de prueba universal ───────────────────────────────────────────────
  if (lower === 'ping') {
    await send().sendMessage(phone, 'pong 🏓');
    return;
  }

  // ── Administrador ─────────────────────────────────────────────────────────────
  if (isAdmin) {
    console.log(`🔧 [ADMIN] Comando: "${body || '[media]'}"`);
    await getAdmin().handleAdminMessage(phone, body, msg, contactName);
    return;
  }

  // ── Cliente ───────────────────────────────────────────────────────────────────
  await getClient().handleClientMessage(phone, body, msg, contactName);
}

module.exports = { routeMessage };
