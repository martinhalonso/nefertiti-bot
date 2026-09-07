'use strict';
require('dotenv').config();

const cron = require('node-cron');

const {
  getConversation,
  upsertConversation,
  setBotActive,
  resetConversation,
  getServicesByCategory,
  getAvailableSlots,
  createAppointment,
  setCalendarEventId,
  savePendingReceipt,
  getAppointmentsByPhone,
  getAppointmentsByDateFull,
  getAppointmentById,
  deleteAppointment,
  updateAppointment,
  getSetting,
  getClientHistory,
  getClientStats,
  getClientFavoriteService,
  upsertClient,
  getClientByPhone,
} = require('../db/queries');

// Lazy: Calendar es opcional; si no está configurado, las funciones retornan gracefully
const cal = () => require('./calendarHandler');

const { getDb }                    = require('../db/initDB');
const MESSAGES                     = require('../config/messages');
const { logger, anonPhone }        = require('../utils/logger');
const { formatContact }            = require('../utils/formatContact');

// Lazy para evitar dependencia circular con whatsappHandler
const send = () => require('./whatsappHandler');

// ── Mecanismos de protección anti-spam y detección de confusión ───────────────

// Rate limiting en memoria: máximo 5 mensajes por minuto por número.
const rateLimitMap = new Map(); // phone → { count, resetAt }

function isRateLimited(phone) {
  const now   = Date.now();
  const entry = rateLimitMap.get(phone) || { count: 0, resetAt: now + 60_000 };
  if (now > entry.resetAt) {
    entry.count   = 0;
    entry.resetAt = now + 60_000;
  }
  entry.count++;
  rateLimitMap.set(phone, entry);
  return entry.count > 15;
}

// Heurística para descartar mensajes que parecen de bots / spam automático.
function looksLikeBot(msg) {
  if (!msg) return true;
  if (msg.from?.endsWith('@g.us')) return true;       // grupos
  if (msg.from === 'status@broadcast') return true;   // estados/broadcast
  const body = (msg.body || '').trim();
  // Vacío sin imagen: spam. (Si trae imagen es un comprobante válido, se permite.)
  if (!body && !msg.hasMedia) return true;
  if (body.length > 500) return true;                 // demasiado largo
  if (/https?:\/\//i.test(body)) return true;         // contiene URLs
  return false;
}

// Detección de cliente confundido: respuestas inválidas consecutivas.
const confusionMap = new Map(); // phone → cantidad de respuestas inválidas

const CONFUSED_LIMIT   = 3;
const CONFUSED_MESSAGE =
  'Parece que estás teniendo dificultades 😊 Voy a pedirle a Celi que te contacte personalmente.';

function trackInvalidResponse(phone) {
  const count = (confusionMap.get(phone) || 0) + 1;
  confusionMap.set(phone, count);
  return count;
}

function resetConfusionCount(phone) {
  confusionMap.delete(phone);
}

// Registra una respuesta inválida del cliente. Si acumula CONFUSED_LIMIT seguidas,
// pausa el bot para ese número, avisa al cliente y notifica al admin.
// Devuelve true si el cliente fue pausado (el handler debe cortar el flujo).
async function registerInvalidResponse(phone) {
  const count = trackInvalidResponse(phone);
  if (count < CONFUSED_LIMIT) return false;

  resetConfusionCount(phone);
  setBotActive(phone, false);
  await send().sendMessage(phone, CONFUSED_MESSAGE);

  const adminPhone = process.env.ADMIN_PHONE;
  if (adminPhone) {
    const conv = getConversation(phone);
    const sd   = conv?.step_data || {};
    const name = sd.clientName || sd.knownClientName || sd.contactName
      || getClientHistory(phone)[0]?.client_name || null;
    const displayName = formatContact(phone, name);
    await send().sendMessage(
      adminPhone,
      `⚠️ Cliente ${displayName} pausado automáticamente por múltiples respuestas inválidas. Revisá la conversación.`,
    );
  }
  logger.warn(`[${anonPhone(phone)}] Pausado por confusión (${CONFUSED_LIMIT} respuestas inválidas).`);
  return true;
}

// Registra el cambio de estado y persiste la conversación.
// Todo avance de estado exitoso resetea el contador de confusión.
function transitionTo(phone, step, data = {}) {
  logger.debug(`[${anonPhone(phone)}] → ${step}`);
  resetConfusionCount(phone);
  upsertConversation(phone, step, data);
}

// ── Constantes ────────────────────────────────────────────────────────────────

const MAX_DAYS_SHOWN   = 7;
const MAX_DAYS_TO_SCAN = 21; // días a revisar para encontrar MAX_DAYS_SHOWN con hueco
const MAX_SLOTS_SHOWN  = 6;

const DAYS_ES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// Palabras clave que siempre reinician el flujo
const RESET_KEYWORDS = ['hola', 'menu', 'menú', 'inicio', 'empezar', 'start', 'reiniciar'];

const GESTION_STATES = [
  'CLIENT_CANCEL_SELECT', 'CLIENT_CANCEL_CONFIRM',
  'CLIENT_MOD_SELECT', 'CLIENT_MOD_FIELD',
  'CLIENT_MOD_DATE', 'CLIENT_MOD_TIME', 'CLIENT_MOD_CONFIRM',
];

// ── Detección de llegada al local ─────────────────────────────────────────────

const ARRIVAL_PHRASES = [
  'estoy abajo', 'abajo', 'llegando', 'estoy llegando',
  'ya llegué',   'ya llegue', 'llegué', 'llegue',
  'ya estoy',    'estoy acá', 'estoy aca',
  'ya llegó',    'ya llego',
  'en la puerta', 'afuera', 'estoy afuera',
  'ya estoy acá', 'ya estoy aca',
  'toc toc', 'estoy aqui', 'estoy aquí',
];

function isArrivalMessage(lower) {
  return ARRIVAL_PHRASES.some(p => lower === p || lower.includes(p));
}

function isInArrivalWindow(phone) {
  const apts    = getAppointmentsByPhone(phone);
  const now     = new Date();
  const today   = toISO(now);
  const nowMins = now.getHours() * 60 + now.getMinutes();

  return apts.some(apt => {
    if (apt.appointment_date !== today) return false;
    const [h, m]  = apt.appointment_time.split(':').map(Number);
    const aptMins = h * 60 + m;
    return nowMins >= aptMins - 30 && nowMins <= aptMins + 30;
  });
}

const CATEGORIES = [
  { key: 'manos',          label: 'Manos 💅'              },
  { key: 'pies',           label: 'Pies 🦶'                },
  { key: 'cejas_pestanas', label: 'Cejas y Pestañas 👁️'   },
];

// ── Helper de servicios combinados ────────────────────────────────────────────

function buildCombinedService(servicesSelected) {
  return {
    name:             servicesSelected.map(s => s.name).join(' + '),
    duration_minutes: servicesSelected.reduce((sum, s) => sum + s.duration_minutes, 0),
    price:            servicesSelected.reduce((sum, s) => sum + s.price, 0),
  };
}

// ── Helpers del carrito ───────────────────────────────────────────────────────

// Categorías que aún tienen al menos un servicio NO presente en el carrito.
function categoriesWithAvailable(servicesSelected = []) {
  const selectedIds = new Set(servicesSelected.map(s => s.id));
  return CATEGORIES.filter(c =>
    getServicesByCategory(c.key).some(s => !selectedIds.has(s.id)),
  );
}

const CART_ACTION_LABELS = {
  add:      'Agregar más servicios',
  remove:   'Quitar un servicio',
  continue: 'Continuar →',
};

// Acciones disponibles en el carrito (mismo orden que se muestran y se parsean).
// Sólo se llama con el carrito NO vacío (startCart redirige si está vacío).
function getCartActions(stepData) {
  const selected = stepData.servicesSelected || [];
  const actions  = [];
  const hayCategorias = categoriesWithAvailable(selected).length > 0;
  if (hayCategorias && !stepData.editMode) actions.push('add');
  actions.push('remove');
  actions.push('continue');
  return actions;
}

// Líneas de un servicio en el formato del carrito: "Manicura — 45 min · $8.500"
function cartServiceLine(s) {
  return `${s.name} — ${s.duration_minutes} min · $${Number(s.price).toLocaleString('es-AR')}`;
}

// Compara dos listas de IDs como conjuntos (mismos elementos, el orden no importa).
function sameIdSet(a = [], b = []) {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every(id => setB.has(id));
}

function buildCartMessage(stepData) {
  const selected = stepData.servicesSelected || [];
  const combined = buildCombinedService(selected);
  const lines    = selected.map(cartServiceLine).join('\n');
  const actions  = getCartActions(stepData);
  const opciones = actions.map((a, i) => `\`${i + 1}\` ${CART_ACTION_LABELS[a]}`).join('\n');
  return (
    `🛒 Tu selección:\n\n` +
    `${lines}\n` +
    `─────────────────────\n` +
    `⏱ Total: ${combined.duration_minutes} min · 💰 $${Number(combined.price).toLocaleString('es-AR')}\n\n` +
    `${opciones}`
  );
}

// ── Helpers de fecha ──────────────────────────────────────────────────────────

function toISO(date) {
  const yyyy = date.getFullYear();
  const mm   = String(date.getMonth() + 1).padStart(2, '0');
  const dd   = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function toLabel(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  return `${DAYS_ES[date.getDay()]} ${dd}/${mm}`;
}

// Retorna hasta MAX_DAYS_SHOWN días con al menos un slot disponible.
// Hace UNA sola llamada a Calendar para todo el rango (optimización).
async function findAvailableDays(serviceDuration) {
  const result  = [];
  const base    = new Date();
  const scanEnd = new Date(base);
  scanEnd.setDate(base.getDate() + MAX_DAYS_TO_SCAN);

  // Pre-fetch de eventos Calendar para el rango completo (1 API call)
  let calEvents = [];
  try {
    calEvents = await cal().getEventsInRange(toISO(base), toISO(scanEnd));
  } catch (err) {
    logger.warn(`Calendar no disponible para disponibilidad: ${err.message}`);
  }

  for (let i = 1; i <= MAX_DAYS_TO_SCAN && result.length < MAX_DAYS_SHOWN; i++) {
    const d       = new Date(base);
    d.setDate(base.getDate() + i);
    const dateStr = toISO(d);

    const dbSlots = getAvailableSlots(dateStr, serviceDuration);
    if (!dbSlots.length) continue;

    // Filtrar con los eventos ya cargados (sin nueva llamada a la API)
    const dayEvents = calEvents.filter(ev => ev.start?.dateTime?.startsWith(dateStr));
    const slots     = cal().filterSlotsWithEvents(dbSlots, serviceDuration, dayEvents);

    if (slots.length) {
      result.push({ dateStr, label: toLabel(d), slots });
    }
  }

  return result;
}

// ── Parsers de entrada ────────────────────────────────────────────────────────

// Devuelve índice 0-based si el usuario eligió una opción numerada válida, o null
function parseChoice(input, max) {
  const n = parseInt(input.trim(), 10);
  return (!isNaN(n) && n >= 1 && n <= max) ? n - 1 : null;
}

function isYes(lower) {
  return ['si', 'sí', 'yes', 'dale', 'ok', 'confirmo', 'confirmar', 'claro', 'bueno'].some(
    w => lower === w || lower.startsWith(w + ' '),
  );
}

function isNo(lower) {
  return ['no', 'cancelar', 'cancel', 'volver', 'nope'].some(
    w => lower === w || lower.startsWith(w + ' '),
  );
}

// Detecta que el cliente escribió "volver" (en vez de elegir el número de la opción Volver)
function isBackWord(lower) {
  return ['volver', 'atras', 'atrás', 'back', 'volver 🔙'].includes(lower);
}

// ── Handlers por estado ───────────────────────────────────────────────────────

async function handleIdle(phone, contactName) {
  const history = getClientHistory(phone);
  const futuros = getAppointmentsByPhone(phone);

  const dbClient        = getClientByPhone(phone);
  const knownClientName = dbClient?.name
    || (history.length > 0 ? (history[0]?.client_name || null) : null);

  const tieneTurno = futuros.length > 0;

  await transitionTo(phone, 'WAITING_OPTION', { contactName, knownClientName, tieneTurno });

  if (history.length > 0) {
    const nombre         = knownClientName || contactName || null;
    const ultimoServicio = history[0]?.service_name || null;
    await send().sendMessage(phone, MESSAGES.GREETING_RETURNING(nombre, ultimoServicio, tieneTurno));
  } else {
    const nameSuffix = contactName ? `, ${contactName.split(' ')[0]}` : '';
    await send().sendMessage(phone, MESSAGES.GREETING(nameSuffix));
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleWaitingOption(phone, lower, stepData) {
  const tieneTurno = stepData.tieneTurno || false;

  const wantsSchedule = ['1', 'agendar', 'turno', 'sacar', 'reservar', 'quiero'].some(w => lower.includes(w));
  const wantsHuman    = ['2', 'esperar', 'hablar', 'persona', 'humano', 'alguien'].some(w => lower.includes(w));

  // Opción "Mis turnos": solo disponible si el cliente tiene turnos activos
  const wantsMisTurnos = tieneTurno &&
    ['3', 'mis turnos', 'mi turno', 'ver turno', 'ver mis turnos'].some(w => lower.includes(w));

  // Opción "Historial": opción 3 si no hay turnos, opción 4 si los hay
  const wantsHistory =
    ['historial', 'mis visitas', 'ver historial'].some(w => lower.includes(w)) ||
    (!tieneTurno && lower === '3') ||
    (tieneTurno  && lower === '4');

  if (wantsSchedule)  {
    await transitionTo(phone, 'ASKING_NAME', stepData);
    return send().sendMessage(phone, MESSAGES.ASK_NAME);
  }
  if (wantsHuman)     return pauseForHuman(phone, stepData);
  if (wantsMisTurnos) return handleMisTurnos(phone);
  if (wantsHistory)   return handleClienteHistorial(phone);

  // Entrada inválida: registrar confusión y repetir el saludo según el contexto
  if (await registerInvalidResponse(phone)) return;
  const nombre         = stepData.knownClientName || stepData.contactName || null;
  const ultimoServicio = null; // no disponible sin nueva consulta a DB
  if (nombre) {
    await send().sendMessage(
      phone,
      MESSAGES.INVALID_OPTION + MESSAGES.GREETING_RETURNING(nombre, ultimoServicio, tieneTurno),
    );
  } else {
    const nameSuffix = stepData.contactName ? `, ${stepData.contactName.split(' ')[0]}` : '';
    await send().sendMessage(
      phone,
      MESSAGES.INVALID_OPTION + MESSAGES.GREETING(nameSuffix),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleAskingName(phone, body, stepData) {
  const name = body.trim();
  if (name.length < 3 || !name.includes(' ')) {
    if (await registerInvalidResponse(phone)) return;
    return send().sendMessage(phone, MESSAGES.INVALID_NAME);
  }
  upsertClient(phone, name);
  return startSelectingCategory(phone, { ...stepData, clientName: name });
}

// ─────────────────────────────────────────────────────────────────────────────

async function startSelectingCategory(phone, stepData) {
  // Cuando viene del carrito, filtrar las categorías cuyos servicios ya están todos elegidos.
  const cats = categoriesWithAvailable(stepData.servicesSelected || []);
  await transitionTo(phone, 'SELECTING_CATEGORY', { ...stepData, categoryKeys: cats.map(c => c.key) });
  await send().sendMessageWithList(
    phone,
    '¿Qué tipo de servicio necesitás?',
    [...cats.map(c => c.label), 'Volver 🔙'],
  );
}

async function handleSelectingCategory(phone, lower, stepData) {
  const keys    = stepData.categoryKeys || CATEGORIES.map(c => c.key);
  const cats    = keys.map(k => CATEGORIES.find(c => c.key === k));
  const backIdx = keys.length;
  const choice  = parseChoice(lower, keys.length + 1);

  // Volver → menú principal
  if (isBackWord(lower) || choice === backIdx) {
    return handleIdle(phone, stepData.contactName);
  }

  if (choice === null) {
    if (await registerInvalidResponse(phone)) return;
    await send().sendMessageWithList(
      phone,
      MESSAGES.INVALID_OPTION + '¿Qué tipo de servicio necesitás?',
      [...cats.map(c => c.label), 'Volver 🔙'],
    );
    return;
  }

  const { categoryKeys: _, ...rest } = stepData;
  return startSelectingService(phone, { ...rest, selectedCategory: keys[choice] });
}

async function startSelectingService(phone, stepData) {
  const selectedIds = new Set((stepData.servicesSelected || []).map(s => s.id));
  const services    = getServicesByCategory(stepData.selectedCategory).filter(s => !selectedIds.has(s.id));

  if (!services.length) {
    await send().sendMessage(phone, '😔 No hay más servicios disponibles en esta categoría.');
    return startSelectingCategory(phone, stepData);
  }

  await transitionTo(phone, 'SELECTING_SERVICE', { ...stepData, services });
  const options = services.map(s =>
    `*${s.name}* (${s.duration_minutes} min) $${Number(s.price).toLocaleString('es-AR')}`,
  );
  await send().sendMessageWithList(phone, MESSAGES.ASK_SERVICE, [...options, 'Volver 🔙']);
}

async function handleSelectingService(phone, lower, stepData) {
  const services = stepData.services || [];
  const backIdx  = services.length;
  const choice   = parseChoice(lower, services.length + 1);

  // Volver → selección de categoría
  if (isBackWord(lower) || choice === backIdx) {
    const { services: _, selectedCategory: __, ...rest } = stepData;
    return startSelectingCategory(phone, rest);
  }

  if (choice === null) {
    if (await registerInvalidResponse(phone)) return;
    const options = services.map(s =>
      `*${s.name}* (${s.duration_minutes} min) $${Number(s.price).toLocaleString('es-AR')}`,
    );
    await send().sendMessageWithList(phone, MESSAGES.INVALID_OPTION + MESSAGES.ASK_SERVICE, [...options, 'Volver 🔙']);
    return;
  }

  const { services: _, selectedCategory: __, ...rest } = stepData;
  const existing = rest.servicesSelected || [];
  return startCart(phone, { ...rest, servicesSelected: [...existing, services[choice]] });
}

// ─────────────────────────────────────────────────────────────────────────────

async function startCart(phone, stepData) {
  const selected = stepData.servicesSelected || [];

  // Carrito vacío → no hay nada que mostrar, mandar a elegir un servicio.
  if (!selected.length) {
    return startSelectingCategory(phone, stepData);
  }

  // Aseguramos no arrastrar el sub-modo "quitar" al entrar al carrito principal.
  const { removing: _, ...clean } = stepData;
  await transitionTo(phone, 'CART', clean);
  await send().sendMessage(phone, buildCartMessage(clean));
}

async function handleCart(phone, lower, stepData) {
  // Sub-flujo "Quitar un servicio": la lista de quitado vive dentro del estado CART.
  if (stepData.removing) {
    return handleRemoveService(phone, lower, stepData);
  }

  const actions = getCartActions(stepData);
  const choice  = parseChoice(lower, actions.length);

  if (choice === null) {
    if (await registerInvalidResponse(phone)) return;
    await send().sendMessage(phone, MESSAGES.INVALID_OPTION + '\n' + buildCartMessage(stepData));
    return;
  }

  const action = actions[choice];

  if (action === 'add') {
    return startSelectingCategory(phone, stepData);
  }
  if (action === 'remove') {
    return startRemoveService(phone, stepData);
  }
  if (action === 'continue') {
    try {
      return await startSelectingDate(phone, { ...stepData, service: buildCombinedService(stepData.servicesSelected) });
    } catch (err) {
      logger.error(`Error en startSelectingDate desde CART: ${err.message}`, err);
      await send().sendMessage(phone, MESSAGES.ERROR_GENERIC);
    }
  }
}

async function startRemoveService(phone, stepData) {
  const selected = stepData.servicesSelected || [];
  await transitionTo(phone, 'CART', { ...stepData, removing: true });
  await send().sendMessageWithList(
    phone,
    '¿Cuál servicio querés quitar?',
    [...selected.map(cartServiceLine), 'Volver 🔙'],
  );
}

async function handleRemoveService(phone, lower, stepData) {
  const selected = stepData.servicesSelected || [];
  const backIdx  = selected.length;
  const choice   = parseChoice(lower, selected.length + 1);

  // Volver → carrito (limpiando el sub-modo)
  if (isBackWord(lower) || choice === backIdx) {
    const { removing: _, ...rest } = stepData;
    return startCart(phone, rest);
  }

  if (choice === null) {
    if (await registerInvalidResponse(phone)) return;
    await send().sendMessageWithList(
      phone,
      MESSAGES.INVALID_OPTION + '¿Cuál servicio querés quitar?',
      [...selected.map(cartServiceLine), 'Volver 🔙'],
    );
    return;
  }

  // Quitar el servicio elegido del carrito.
  const newSelected = selected.filter((_, i) => i !== choice);
  const { removing: _, ...rest } = stepData;

  // Carrito vacío en modo edición → salir de edición y forzar nueva fecha/hora.
  if (newSelected.length === 0 && stepData.editMode) {
    const { editMode: __, date: ___, dateLabel: ____, time: _____, ...cleaned } = rest;
    return startCart(phone, { ...cleaned, servicesSelected: newSelected });
  }

  return startCart(phone, { ...rest, servicesSelected: newSelected });
}

// ─────────────────────────────────────────────────────────────────────────────

async function startSelectingDate(phone, stepData) {
  const days = await findAvailableDays(stepData.service.duration_minutes);

  if (!days.length) {
    await send().sendMessage(phone, MESSAGES.NO_AVAILABILITY);
    return resetConversation(phone);
  }

  await transitionTo(phone, 'SELECTING_DATE', { ...stepData, availableDays: days });
  await send().sendMessageWithList(phone, MESSAGES.ASK_DATE, [...days.map(d => d.label), 'Volver 🔙']);
}

async function handleSelectingDate(phone, lower, stepData) {
  const days    = stepData.availableDays || [];
  const backIdx = days.length;
  const choice  = parseChoice(lower, days.length + 1);

  // Volver → carrito
  if (isBackWord(lower) || choice === backIdx) {
    const { availableDays: _, ...rest } = stepData;
    return startCart(phone, rest);
  }

  if (choice === null || !days[choice]) {
    if (await registerInvalidResponse(phone)) return;
    await send().sendMessageWithList(
      phone,
      MESSAGES.INVALID_OPTION + MESSAGES.ASK_DATE,
      [...days.map(d => d.label), 'Volver 🔙'],
    );
    return;
  }

  const chosen = days[choice];
  // Descartar availableDays del step_data antes de avanzar
  const { availableDays: _, ...rest } = stepData;
  return startSelectingTime(phone, { ...rest, date: chosen.dateStr, dateLabel: chosen.label });
}

// ─────────────────────────────────────────────────────────────────────────────

async function startSelectingTime(phone, stepData) {
  // Refrescar slots por si alguien tomó un horario mientras el usuario decidía.
  // getAvailableSlotsFiltered cruza DB + Calendar; si Calendar falla, usa solo DB.
  const freshSlots = await cal().getAvailableSlotsFiltered(stepData.date, stepData.service.duration_minutes);

  if (!freshSlots.length) {
    await send().sendMessage(
      phone,
      `😔 Ya no hay horarios para el *${stepData.dateLabel}*. Elegí otro día.`,
    );
    return startSelectingDate(phone, stepData);
  }

  await transitionTo(phone, 'SELECTING_TIME', { ...stepData, availableSlots: freshSlots });
  await send().sendMessageWithList(
    phone,
    MESSAGES.ASK_TIME(stepData.dateLabel),
    [...freshSlots, '⬅️ Volver a elegir otro día'],
  );
}

async function handleSelectingTime(phone, lower, stepData) {
  const slots = stepData.availableSlots || [];

  const isBack = ['atras', 'atrás', 'volver', 'back'].includes(lower)
    || parseChoice(lower, slots.length + 1) === slots.length;

  if (isBack) {
    return startSelectingDate(phone, stepData);
  }

  const idx = parseChoice(lower, slots.length);

  if (idx === null || !slots[idx]) {
    if (await registerInvalidResponse(phone)) return;
    await send().sendMessageWithList(
      phone,
      MESSAGES.INVALID_OPTION + MESSAGES.ASK_TIME(stepData.dateLabel),
      [...slots, '⬅️ Volver a elegir otro día'],
    );
    return;
  }

  // originalServiceIds se descarta acá para no contaminar pasos posteriores.
  const { availableSlots: _, originalServiceIds, ...rest } = stepData;
  const updated = { ...rest, time: slots[idx] };

  if (stepData.editMode) {
    const currentIds = (updated.servicesSelected || []).map(s => s.id);
    // Si cambió la selección de servicios cambió el precio → re-preguntar la seña.
    if (!sameIdSet(currentIds, originalServiceIds)) {
      return startAskingSeña(phone, updated);
    }
    // Sólo editó fecha/hora: la seña ya se eligió antes, vamos directo al resumen.
    return startConfirming(phone, updated);
  }
  return startAskingSeña(phone, updated);
}

// ─────────────────────────────────────────────────────────────────────────────

async function startAskingSeña(phone, stepData) {
  await transitionTo(phone, 'ASKING_SEÑA', stepData);
  await send().sendMessage(phone, MESSAGES.ASK_SEÑA);
}

async function handleAskingSeña(phone, lower, stepData) {
  const wantsSeña = lower === '1' || isYes(lower);
  const noSeña    = lower === '2' || isNo(lower);

  if (wantsSeña) {
    await send().sendMessage(
      phone,
      MESSAGES.SEÑA_INFO(
        process.env.SENA_MONTO || '???',
        process.env.SENA_CBU   || '???',
        process.env.SENA_ALIAS || '???',
      ),
    );
    return startConfirming(phone, { ...stepData, wantsSeña: true });
  }

  if (noSeña) {
    return startConfirming(phone, { ...stepData, wantsSeña: false });
  }

  if (await registerInvalidResponse(phone)) return;
  await send().sendMessage(phone, MESSAGES.ASK_SEÑA);
}

// ─────────────────────────────────────────────────────────────────────────────

async function startConfirming(phone, stepData) {
  await transitionTo(phone, 'CONFIRMING', stepData);
  await send().sendMessage(phone, MESSAGES.TURN_SUMMARY({
    service:   stepData.service.name,
    duration:  stepData.service.duration_minutes,
    price:     stepData.service.price,
    dateLabel: stepData.dateLabel,
    time:      stepData.time,
  }));
}

async function handleConfirming(phone, lower, stepData, contactName) {
  // Editar (opción 3) → pantalla de edición
  if (lower === '3' || lower.includes('editar')) {
    return startEditBooking(phone, stepData);
  }

  if (lower === '1' || isYes(lower)) {
    const clientName   = stepData.clientName || stepData.knownClientName || contactName || stepData.contactName || null;
    const appointmentId = createAppointment({
      phone_number:     phone,
      client_name:      clientName,
      service_name:     stepData.service.name,
      service_duration: stepData.service.duration_minutes,
      service_price:    stepData.service.price,
      appointment_date: stepData.date,
      appointment_time: stepData.time,
    });

    // Crear evento en Google Calendar (no bloquea si falla)
    try {
      const eventId = await cal().createEvent({
        phone_number:     phone,
        client_name:      clientName,
        service_name:     stepData.service.name,
        service_duration: stepData.service.duration_minutes,
        service_price:    stepData.service.price,
        appointment_date: stepData.date,
        appointment_time: stepData.time,
      });
      if (eventId) setCalendarEventId(appointmentId, eventId);
    } catch (err) {
      logger.error(`Error creando evento en Calendar: ${err.message}`);
      await send().notifyAdmin(
        `⚠️ Error al crear evento en Calendar para turno #${appointmentId} (${stepData.dateLabel} ${stepData.time}): ${err.message}`,
      );
    }

    if (stepData.wantsSeña) {
      await transitionTo(phone, 'WAITING_RECEIPT', {
        contactName:   clientName,
        appointmentId,
        serviceName:   stepData.service.name,
        date:          stepData.date,
        dateLabel:     stepData.dateLabel,
        time:          stepData.time,
      });
      await send().sendMessage(phone, MESSAGES.SEÑA_PENDIENTE);
    } else {
      await resetConversation(phone);
      await send().sendMessage(phone, MESSAGES.TURNO_CONFIRMADO(stepData.dateLabel, stepData.time));
    }

    await send().notifyAdmin(MESSAGES.ADMIN_NEW_TURN(
      formatContact(phone, clientName),
      stepData.dateLabel,
      stepData.time,
      phone,
      stepData.service.name,
    ));
    return;
  }

  if (lower === '2' || isNo(lower)) {
    await resetConversation(phone);
    await send().sendMessage(
      phone,
      '👌 Okay, no se agendó ningún turno. Escribí *hola* cuando quieras empezar de nuevo.',
    );
    return;
  }

  // No entendió: registrar confusión y repetir el resumen (sin cambiar de estado)
  if (await registerInvalidResponse(phone)) return;
  await send().sendMessage(phone, MESSAGES.TURN_SUMMARY({
    service:   stepData.service.name,
    duration:  stepData.service.duration_minutes,
    price:     stepData.service.price,
    dateLabel: stepData.dateLabel,
    time:      stepData.time,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────

async function startEditBooking(phone, stepData) {
  const selected = stepData.servicesSelected || [];
  await transitionTo(phone, 'EDITING_BOOKING', {
    ...stepData,
    editMode: true,
    originalServiceIds: selected.map(s => s.id),
  });
  await send().sendMessageWithList(
    phone,
    '✏️ ¿Qué querés editar?',
    [...selected.map(cartServiceLine), 'Fecha y hora 📅', 'Volver 🔙'],
  );
}

async function handleEditBooking(phone, lower, stepData) {
  const selected = stepData.servicesSelected || [];
  const dateIdx  = selected.length;       // opción "Fecha y hora"
  const backIdx  = selected.length + 1;   // opción "Volver"
  const choice   = parseChoice(lower, selected.length + 2);

  // Volver → resumen de confirmación, sin cambios (no se tocaron los servicios)
  if (isBackWord(lower) || choice === backIdx) {
    const { originalServiceIds: _, ...rest } = stepData;
    return startConfirming(phone, rest);
  }

  if (choice === null) {
    if (await registerInvalidResponse(phone)) return;
    await send().sendMessageWithList(
      phone,
      MESSAGES.INVALID_OPTION + '✏️ ¿Qué querés editar?',
      [...selected.map(cartServiceLine), 'Fecha y hora 📅', 'Volver 🔙'],
    );
    return;
  }

  // Fecha y hora → flujo de fecha (en modo edición vuelve a confirmar al terminar)
  if (choice === dateIdx) {
    return startSelectingDate(phone, { ...stepData, editMode: true });
  }

  // Eligió un servicio → carrito en modo edición (sin "Agregar más")
  return startCart(phone, { ...stepData, editMode: true });
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleWaitingReceipt(phone, body, msg, stepData) {
  const lower = body.toLowerCase().trim();

  // El cliente decide no dejar seña ahora
  if (['no', 'omitir', 'después', 'despues', 'luego'].includes(lower)) {
    await send().sendMessage(
      phone,
      `¡Perfecto! Tu turno está confirmado igual 😊 Te esperamos el *${stepData.dateLabel}* a las *${stepData.time}*.`,
    );
    return resetConversation(phone);
  }

  if (msg.hasMedia) {
    const media = await send().downloadMedia(msg);

    if (media) {
      savePendingReceipt({
        phoneNumber:   phone,
        imageUrl:      media.path,
        appointmentId: stepData.appointmentId ?? null,
      });

      await send().sendMessage(phone, MESSAGES.SEÑA_RECEIVED);
      await send().notifyAdmin(MESSAGES.ADMIN_SEÑA_RECEIVED(
        formatContact(phone, stepData.contactName),
        phone,
        { dateLabel: stepData.dateLabel, time: stepData.time, serviceName: stepData.serviceName },
      ));
      await resetConversation(phone);
      return;
    }
  }

  // Manda texto en lugar de imagen
  await send().sendMessage(
    phone,
    '📎 Por favor enviá el *comprobante de transferencia como imagen* para confirmar tu turno. ¡Ya falta poco! 🙌',
  );
}

// ─────────────────────────────────────────────────────────────────────────────

async function pauseForHuman(phone, stepData) {
  await transitionTo(phone, 'PAUSED', stepData);
  setBotActive(phone, false);
  await send().sendMessage(phone, MESSAGES.HUMAN_REQUESTED);
  await send().notifyAdmin(MESSAGES.ADMIN_HUMAN_REQUESTED(
    formatContact(phone, stepData.contactName),
    phone,
  ));
}

// ── Función principal ─────────────────────────────────────────────────────────

async function handleClientMessage(phone, body, msg, contactName) {
  // Protección anti-spam: descartar bots/spam y limitar frecuencia
  // ANTES de cualquier lógica de negocio o acceso a la DB.
  if (looksLikeBot(msg)) return;
  if (isRateLimited(phone)) {
    logger.warn(`[${anonPhone(phone)}] Rate limited — mensaje ignorado`);
    return;
  }

  let conv = getConversation(phone);

  if (!conv) {
    await transitionTo(phone, 'IDLE', { contactName });
    conv = { current_step: 'IDLE', step_data: {}, bot_active: 1 };
  }

  // Silencio total si el bot está pausado para este número
  if (!conv.bot_active) return;

  const step     = conv.current_step || 'IDLE';
  const stepData = conv.step_data    || {};
  const lower    = body.toLowerCase().trim();

  // ── Detección de llegada al local ─────────────────────────────────────────
  // Si el mensaje es una frase de llegada O el cliente tiene turno hoy ±30 min,
  // reenviar al admin sin responder ni cambiar el estado de la conversación.
  if (isArrivalMessage(lower) || isInArrivalWindow(phone)) {
    const displayName = formatContact(
      phone,
      contactName || stepData.knownClientName || stepData.contactName,
    );
    await send().notifyAdmin(
      `📍 *${displayName}* avisa que está llegando:\n"${body}"`,
    );
    return;
  }

  // Palabras clave que reinician el flujo desde cualquier estado
  // (excepto WAITING_RECEIPT para no perder el contexto del pago, ni estados de gestión)
  if (step !== 'WAITING_RECEIPT' && !GESTION_STATES.includes(step) && RESET_KEYWORDS.includes(lower)) {
    return handleIdle(phone, contactName);
  }

  if (!GESTION_STATES.includes(step)) {
    const MIS_TURNOS        = ['mis turnos', 'mi turno', 'ver turno', 'ver mis turnos'];
    const HISTORIAL_KEYWORDS = ['mi historial', 'mis visitas', 'ver historial', 'historial'];
    const mCancelar  = lower.match(/^cancelar(?: mi)? turno(?: (\d+))?$/);
    const mModificar = lower.match(/^(?:modificar|cambiar|reprogramar)(?: mi)? turno(?: (\d+))?$/);

    if (MIS_TURNOS.some(k => lower.includes(k)))
      return handleMisTurnos(phone);
    if (HISTORIAL_KEYWORDS.some(k => lower.includes(k)))
      return handleClienteHistorial(phone);
    if (mCancelar)
      return startClientCancel(phone, mCancelar[1] ? parseInt(mCancelar[1]) : null);
    if (mModificar)
      return startClientModify(phone, mModificar[1] ? parseInt(mModificar[1]) : null);
  }

  switch (step) {
    case 'IDLE':
      return handleIdle(phone, contactName);

    case 'WAITING_OPTION':
      return handleWaitingOption(phone, lower, stepData);

    case 'ASKING_NAME':
      return handleAskingName(phone, body, stepData);

    case 'SELECTING_CATEGORY':
      return handleSelectingCategory(phone, lower, stepData);

    case 'SELECTING_SERVICE':
      return handleSelectingService(phone, lower, stepData);

    case 'CART':
      return handleCart(phone, lower, stepData);

    case 'SELECTING_DATE':
      return handleSelectingDate(phone, lower, stepData);

    case 'SELECTING_TIME':
      return handleSelectingTime(phone, lower, stepData);

    case 'ASKING_SEÑA':
      return handleAskingSeña(phone, lower, stepData);

    case 'CONFIRMING':
      return handleConfirming(phone, lower, stepData, contactName);

    case 'EDITING_BOOKING':
      return handleEditBooking(phone, lower, stepData);

    case 'WAITING_RECEIPT':
      return handleWaitingReceipt(phone, body, msg, stepData);

    case 'PAUSED':
      return; // no responder nada

    case 'CLIENT_CANCEL_SELECT':  return handleClientCancelSelect(phone, lower, stepData);
    case 'CLIENT_CANCEL_CONFIRM': return handleClientCancelConfirm(phone, lower, stepData);
    case 'CLIENT_MOD_SELECT':     return handleClientModifySelect(phone, lower, stepData);
    case 'CLIENT_MOD_FIELD':      return handleClientModifyField(phone, lower, stepData);
    case 'CLIENT_MOD_DATE':       return handleClientModifyDate(phone, lower, stepData);
    case 'CLIENT_MOD_TIME':       return handleClientModifyTime(phone, lower, stepData);
    case 'CLIENT_MOD_CONFIRM':    return handleClientModifyConfirm(phone, lower, stepData);

    default:
      await resetConversation(phone);
      return handleIdle(phone, contactName);
  }
}

// ── Gestión de turnos (cliente) ───────────────────────────────────────────────

function formatClientTurnLine(i, apt) {
  const d = new Date(`${apt.appointment_date}T12:00:00`);
  return MESSAGES.MY_TURNS_LINE(i, toLabel(d), apt.appointment_time, apt.service_name, apt.seña_paid);
}

async function handleMisTurnos(phone) {
  const apts = getAppointmentsByPhone(phone);
  if (!apts.length) {
    await send().sendMessage(phone, MESSAGES.NO_TURNS);
    return;
  }
  const lines = apts.map((a, i) => formatClientTurnLine(i + 1, a));
  await send().sendMessage(
    phone,
    `${MESSAGES.MY_TURNS_HEADER}\n\n${lines.join('\n')}${MESSAGES.MY_TURNS_FOOTER}`,
  );
}

async function startClientCancel(phone, turnoIdx = null) {
  const apts = getAppointmentsByPhone(phone);
  if (!apts.length) { await send().sendMessage(phone, MESSAGES.NO_TURNS); return; }

  const goToConfirm = async (apt) => {
    const d = new Date(`${apt.appointment_date}T12:00:00`);
    await transitionTo(phone, 'CLIENT_CANCEL_CONFIRM', {
      appointmentId: apt.id, dateLabel: toLabel(d),
      time: apt.appointment_time, service: apt.service_name,
    });
    await send().sendMessage(phone, MESSAGES.CLIENT_CANCEL_CONFIRM(toLabel(d), apt.appointment_time, apt.service_name));
  };

  if (turnoIdx !== null && apts[turnoIdx - 1]) return goToConfirm(apts[turnoIdx - 1]);
  if (apts.length === 1) return goToConfirm(apts[0]);

  const lines = apts.map((a, i) => formatClientTurnLine(i + 1, a));
  await transitionTo(phone, 'CLIENT_CANCEL_SELECT', { appointments: apts });
  await send().sendMessageWithList(phone, '¿Cuál turno querés cancelar?', lines);
}

async function handleClientCancelSelect(phone, lower, stepData) {
  if (isNo(lower)) {
    await resetConversation(phone);
    await send().sendMessage(phone, MESSAGES.CLIENT_CANCEL_ABORT);
    return;
  }
  const apts = stepData.appointments || [];
  const idx  = parseChoice(lower, apts.length);
  if (idx === null) {
    if (await registerInvalidResponse(phone)) return;
    await send().sendMessageWithList(
      phone,
      `${MESSAGES.INVALID_OPTION}¿Cuál turno querés cancelar?`,
      apts.map((a, i) => formatClientTurnLine(i + 1, a)),
    );
    return;
  }
  const apt = apts[idx];
  const d   = new Date(`${apt.appointment_date}T12:00:00`);
  await transitionTo(phone, 'CLIENT_CANCEL_CONFIRM', {
    appointmentId: apt.id, dateLabel: toLabel(d),
    time: apt.appointment_time, service: apt.service_name,
  });
  await send().sendMessage(phone, MESSAGES.CLIENT_CANCEL_CONFIRM(toLabel(d), apt.appointment_time, apt.service_name));
}

async function handleClientCancelConfirm(phone, lower, stepData) {
  if (isYes(lower)) {
    const apt = getAppointmentById(stepData.appointmentId);
    if (apt?.calendar_event_id) {
      try { await cal().deleteEvent(apt.calendar_event_id); }
      catch (err) { logger.warn(`No se pudo borrar evento Calendar: ${err.message}`); }
    }
    deleteAppointment(stepData.appointmentId);
    await send().notifyAdmin(
      `❌ *Turno cancelado por el cliente*\n\n` +
      `📅 ${stepData.dateLabel} a las ${stepData.time}\n` +
      `💇 ${stepData.service}\n👤 ${formatContact(phone)}`,
    );
    await resetConversation(phone);
    await send().sendMessage(phone, MESSAGES.CLIENT_CANCEL_OK(stepData.dateLabel, stepData.time));
    return;
  }
  if (isNo(lower)) {
    await resetConversation(phone);
    await send().sendMessage(phone, MESSAGES.CLIENT_CANCEL_ABORT);
    return;
  }
  if (await registerInvalidResponse(phone)) return;
  await send().sendMessage(phone, MESSAGES.CLIENT_CANCEL_CONFIRM(stepData.dateLabel, stepData.time, stepData.service));
}

async function startClientModify(phone, turnoIdx = null) {
  const apts = getAppointmentsByPhone(phone);
  if (!apts.length) { await send().sendMessage(phone, MESSAGES.NO_TURNS); return; }

  if (turnoIdx !== null && apts[turnoIdx - 1]) return askClientModifyField(phone, apts[turnoIdx - 1]);
  if (apts.length === 1) return askClientModifyField(phone, apts[0]);

  const lines = apts.map((a, i) => formatClientTurnLine(i + 1, a));
  await transitionTo(phone, 'CLIENT_MOD_SELECT', { appointments: apts });
  await send().sendMessageWithList(phone, '¿Cuál turno querés modificar?', lines);
}

async function handleClientModifySelect(phone, lower, stepData) {
  if (isNo(lower)) {
    await resetConversation(phone);
    await send().sendMessage(phone, MESSAGES.CLIENT_MOD_ABORT);
    return;
  }
  const apts = stepData.appointments || [];
  const idx  = parseChoice(lower, apts.length);
  if (idx === null) {
    if (await registerInvalidResponse(phone)) return;
    await send().sendMessageWithList(
      phone,
      `${MESSAGES.INVALID_OPTION}¿Cuál turno querés modificar?`,
      apts.map((a, i) => formatClientTurnLine(i + 1, a)),
    );
    return;
  }
  return askClientModifyField(phone, apts[idx]);
}

async function askClientModifyField(phone, apt) {
  const d = new Date(`${apt.appointment_date}T12:00:00`);
  await transitionTo(phone, 'CLIENT_MOD_FIELD', {
    appointmentId: apt.id, originalDate: apt.appointment_date,
    originalDateLabel: toLabel(d), originalTime: apt.appointment_time,
    serviceName: apt.service_name, serviceDuration: apt.service_duration,
    servicePrice: apt.service_price, calendarEventId: apt.calendar_event_id,
    clientName: apt.client_name,
  });
  await send().sendMessage(phone, MESSAGES.CLIENT_MOD_ASK_FIELD(toLabel(d), apt.appointment_time));
}

async function handleClientModifyField(phone, lower, stepData) {
  if (lower === '1' || lower.includes('fecha')) {
    const days = await findAvailableDays(stepData.serviceDuration);
    if (!days.length) {
      await send().sendMessage(phone, MESSAGES.NO_AVAILABILITY);
      await resetConversation(phone);
      return;
    }
    await transitionTo(phone, 'CLIENT_MOD_DATE', { ...stepData, availableDays: days });
    await send().sendMessageWithList(phone, MESSAGES.ASK_DATE, days.map(d => d.label));
    return;
  }
  if (lower === '2' || lower.includes('horario') || lower.includes('hora')) {
    const freshSlots = await cal().getAvailableSlotsFiltered(stepData.originalDate, stepData.serviceDuration);
    if (!freshSlots.length) {
      await send().sendMessage(
        phone,
        `😔 No hay otros horarios para el *${stepData.originalDateLabel}*. Podés cambiar la fecha escribiendo *modificar turno*.`,
      );
      await resetConversation(phone);
      return;
    }
    await transitionTo(phone, 'CLIENT_MOD_TIME', {
      ...stepData, newDate: stepData.originalDate,
      newDateLabel: stepData.originalDateLabel, availableSlots: freshSlots,
    });
    await send().sendMessageWithList(phone, MESSAGES.ASK_TIME(stepData.originalDateLabel), [...freshSlots, '⬅️ Volver']);
    return;
  }
  if (lower === '3' || isNo(lower)) {
    await resetConversation(phone);
    await send().sendMessage(phone, MESSAGES.CLIENT_MOD_ABORT);
    return;
  }
  if (await registerInvalidResponse(phone)) return;
  await send().sendMessage(phone, MESSAGES.CLIENT_MOD_ASK_FIELD(stepData.originalDateLabel, stepData.originalTime));
}

async function handleClientModifyDate(phone, lower, stepData) {
  const days   = stepData.availableDays || [];
  const isBack = lower.includes('volver') || lower === 'atras' || lower === 'atrás';
  if (isBack) {
    return askClientModifyField(phone, {
      appointment_date: stepData.originalDate, appointment_time: stepData.originalTime,
      service_name: stepData.serviceName, service_duration: stepData.serviceDuration,
      service_price: stepData.servicePrice, calendar_event_id: stepData.calendarEventId,
      client_name: stepData.clientName, id: stepData.appointmentId,
    });
  }
  const idx = parseChoice(lower, days.length);
  if (idx === null || !days[idx]) {
    if (await registerInvalidResponse(phone)) return;
    await send().sendMessageWithList(phone, `${MESSAGES.INVALID_OPTION}${MESSAGES.ASK_DATE}`, days.map(d => d.label));
    return;
  }
  const chosen     = days[idx];
  const freshSlots = await cal().getAvailableSlotsFiltered(chosen.dateStr, stepData.serviceDuration);
  if (!freshSlots.length) {
    await send().sendMessageWithList(phone, `😔 Ya no hay horarios para el *${chosen.label}*. Elegí otro día.`, days.map(d => d.label));
    return;
  }
  const { availableDays: _, ...rest } = stepData;
  await transitionTo(phone, 'CLIENT_MOD_TIME', {
    ...rest, newDate: chosen.dateStr, newDateLabel: chosen.label, availableSlots: freshSlots,
  });
  await send().sendMessageWithList(phone, MESSAGES.ASK_TIME(chosen.label), [...freshSlots, '⬅️ Volver a elegir otro día']);
}

async function handleClientModifyTime(phone, lower, stepData) {
  const slots  = stepData.availableSlots || [];
  const isBack = lower.includes('volver') || lower === 'atras' || lower === 'atrás'
    || parseChoice(lower, slots.length + 1) === slots.length;
  if (isBack) {
    const days = await findAvailableDays(stepData.serviceDuration);
    await transitionTo(phone, 'CLIENT_MOD_DATE', { ...stepData, availableDays: days });
    await send().sendMessageWithList(phone, MESSAGES.ASK_DATE, days.map(d => d.label));
    return;
  }
  const idx = parseChoice(lower, slots.length);
  if (idx === null || !slots[idx]) {
    if (await registerInvalidResponse(phone)) return;
    await send().sendMessageWithList(
      phone,
      `${MESSAGES.INVALID_OPTION}${MESSAGES.ASK_TIME(stepData.newDateLabel)}`,
      [...slots, '⬅️ Volver a elegir otro día'],
    );
    return;
  }
  const { availableSlots: _, ...rest } = stepData;
  await transitionTo(phone, 'CLIENT_MOD_CONFIRM', { ...rest, newTime: slots[idx] });
  await send().sendMessage(phone, MESSAGES.CLIENT_MOD_CONFIRM({
    service: stepData.serviceName, duration: stepData.serviceDuration,
    price: stepData.servicePrice, dateLabel: stepData.newDateLabel, time: slots[idx],
  }));
}

async function handleClientModifyConfirm(phone, lower, stepData) {
  if (isYes(lower)) {
    if (stepData.calendarEventId) {
      try { await cal().deleteEvent(stepData.calendarEventId); }
      catch (err) { logger.warn(`No se pudo borrar evento Calendar al modificar: ${err.message}`); }
    }
    deleteAppointment(stepData.appointmentId);
    const newId = createAppointment({
      phone_number: phone, client_name: stepData.clientName,
      service_name: stepData.serviceName, service_duration: stepData.serviceDuration,
      service_price: stepData.servicePrice,
      appointment_date: stepData.newDate, appointment_time: stepData.newTime,
    });
    try {
      const eventId = await cal().createEvent({
        phone_number: phone, client_name: stepData.clientName,
        service_name: stepData.serviceName, service_duration: stepData.serviceDuration,
        service_price: stepData.servicePrice,
        appointment_date: stepData.newDate, appointment_time: stepData.newTime,
      });
      if (eventId) setCalendarEventId(newId, eventId);
    } catch (err) {
      logger.error(`Error creando evento Calendar al modificar: ${err.message}`);
    }
    await send().notifyAdmin(
      `🔄 *Turno modificado por el cliente*\n\n` +
      `👤 ${formatContact(phone, stepData.clientName)}\n` +
      `📅 Antes: ${stepData.originalDateLabel} ${stepData.originalTime}\n` +
      `📅 Ahora: ${stepData.newDateLabel} ${stepData.newTime}\n` +
      `💇 ${stepData.serviceName}`,
    );
    await resetConversation(phone);
    await send().sendMessage(phone, MESSAGES.CLIENT_MOD_OK(stepData.newDateLabel, stepData.newTime));
    return;
  }
  if (isNo(lower)) {
    await resetConversation(phone);
    await send().sendMessage(phone, MESSAGES.CLIENT_MOD_ABORT);
    return;
  }
  if (await registerInvalidResponse(phone)) return;
  await send().sendMessage(phone, MESSAGES.CLIENT_MOD_CONFIRM({
    service: stepData.serviceName, duration: stepData.serviceDuration,
    price: stepData.servicePrice, dateLabel: stepData.newDateLabel, time: stepData.newTime,
  }));
}

// ── Limpiador de conversaciones inactivas (cron) ──────────────────────────────

// Revisa cada 5 minutos y resetea conversaciones sin actividad por más de 30 min
function startTimeoutCleaner() {
  cron.schedule('*/5 * * * *', () => {
    const db    = getDb();
    const stale = db.prepare(`
      SELECT phone_number FROM conversations
      WHERE bot_active = 1
        AND (
          (current_step = 'WAITING_RECEIPT'
            AND updated_at < datetime('now', 'localtime', '-2 hours'))
          OR
          (current_step NOT IN ('IDLE', 'PAUSED', 'WAITING_RECEIPT')
            AND updated_at < datetime('now', 'localtime', '-30 minutes'))
        )
    `).all();

    if (stale.length) {
      const stmt = db.prepare(`
        UPDATE conversations
        SET current_step = 'IDLE', step_data = '{}', updated_at = datetime('now','localtime')
        WHERE phone_number = ?
      `);
      const tx = db.transaction((rows) => { for (const r of rows) stmt.run(r.phone_number); });
      tx(stale);
      logger.info(`${stale.length} conversación(es) reseteadas por inactividad.`);
    }

    db.close();
  });

  logger.info('Limpiador de inactividad activo — WAITING_RECEIPT: 2h, resto: 30 min, chequeo: cada 5 min.');
}

// ── Historial del cliente ─────────────────────────────────────────────────────

async function handleClienteHistorial(phone) {
  const history  = getClientHistory(phone);
  const stats    = getClientStats(phone);
  const favorite = getClientFavoriteService(phone);
  const nombre   = history[0]?.client_name || null;

  if (!history.length) {
    await send().sendMessage(phone, MESSAGES.CLIENT_HISTORY_EMPTY);
    return;
  }

  const lines     = history.slice(0, 8).map(a => MESSAGES.CLIENT_HISTORY_LINE(a));
  const statsText = MESSAGES.CLIENT_HISTORY_STATS(stats, favorite);

  await send().sendMessage(
    phone,
    `${MESSAGES.CLIENT_HISTORY_HEADER(nombre)}\n\n` +
    `${lines.join('\n')}\n\n` +
    `${statsText}`,
  );
  // Volver al menú principal directamente
  return handleIdle(phone, nombre);
}

// ── Resumen diario al admin (cron) ────────────────────────────────────────────

function startDailySummary() {
  cron.schedule('0 8 * * *', async () => {
    const enabled = getSetting('daily_summary_enabled');
    if (enabled === '0') return;

    const workingHoursRaw = getSetting('working_hours');
    if (workingHoursRaw) {
      const parsed    = JSON.parse(workingHoursRaw);
      const schedules = Array.isArray(parsed) ? parsed : [parsed];
      const todayDay  = new Date().getDay();
      const isWorkingDay = schedules.some(s => s.days.includes(todayDay));
      if (!isWorkingDay) return;
    }

    const today = toISO(new Date());
    const apts  = getAppointmentsByDateFull(today);
    const label = toLabel(new Date());

    try {
      await send().notifyAdmin(MESSAGES.ADMIN_DAILY_SUMMARY(label, apts));
      logger.info(`Resumen diario enviado (${apts.length} turno(s)).`);
    } catch (err) {
      logger.error(`Error enviando resumen diario: ${err.message}`);
    }
  });

  logger.info('Resumen diario activo — se envía a las 08:00 en días laborales.');
}

// ── Sincronización Calendar → DB (cron) ───────────────────────────────────────

// Cada 2 horas revisa si algún evento futuro fue borrado en Google Calendar
// y, de ser así, cancela el turno correspondiente en la DB.
function startCalendarSync() {
  cron.schedule('0 */2 * * *', async () => {
    try {
      const count = await cal().syncCalendarDeletions();
      if (count > 0) logger.info(`Calendar sync: ${count} turno(s) cancelados por borrado.`);
    } catch (err) {
      logger.warn(`Error en calendar sync: ${err.message}`);
    }
  });

  logger.info('Sincronización Calendar → DB activa — chequeo cada 2 horas.');
}

module.exports = { handleClientMessage, startTimeoutCleaner, startDailySummary, startCalendarSync };
