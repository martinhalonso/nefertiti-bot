'use strict';
require('dotenv').config();

const { logger, anonPhone } = require('../utils/logger');

const MESSAGES = require('../config/messages');
const { formatContact, cleanPhone, looksLikePhone } = require('../utils/formatContact');

const {
  getConversation, upsertConversation, setBotActive,
  getAvailableSlots,
  getAppointmentsByPhone,
  getAppointmentsByDateFull, getAppointmentsByClientName, getAppointmentById, createAppointment,
  deleteAppointment, updateAppointment, setCalendarEventId, confirmAppointment,
  blockSlot, getBlockedSlots, removeBlockedSlots,
  getActiveServices, getServicesByCategory, findServiceByName, insertService, updateService, deactivateService,
  getPendingReceipts, getPendingReceiptById, markReceiptReviewed,
  getPausedConversations,
  getSetting, setSetting,
  getClientHistory, getClientStats, getClientFavoriteService, searchClientsByName,
  upsertClient, getClientByPhone, findClientsByName, findClientsByNameOrPhone,
} = require('../db/queries');

const cal  = () => require('./calendarHandler');
const send = () => require('./whatsappHandler');

const ADMIN_PHONE = process.env.ADMIN_PHONE;
const DAYS_ES     = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

const CATEGORIES = [
  { key: 'manos',          label: '💅 Manos'           },
  { key: 'pies',           label: '🦶 Pies'             },
  { key: 'cejas_pestanas', label: '✨ Cejas y Pestañas' },
];

function buildCombinedService(servicesSelected) {
  return {
    name:             servicesSelected.map(s => s.name).join(' + '),
    duration_minutes: servicesSelected.reduce((sum, s) => sum + s.duration_minutes, 0),
    price:            servicesSelected.reduce((sum, s) => sum + s.price, 0),
  };
}

// ── Helpers de fecha ──────────────────────────────────────────────────────────

function toISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function isoToLabel(iso) {
  const d = new Date(`${iso}T12:00:00`); // mediodía evita problemas de DST
  return `${DAYS_ES[d.getDay()]} ${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
}

// "12/05" → "2024-05-12"
function ddmmToISO(ddmm) {
  const [dd, mm] = ddmm.split('/').map(s => s.padStart(2, '0'));
  return `${new Date().getFullYear()}-${mm}-${dd}`;
}

// ── Parser de rango de días ───────────────────────────────────────────────────

const DAY_MAP      = { dom: 0, lun: 1, mar: 2, mie: 3, 'mié': 3, jue: 4, vie: 5, sab: 6, 'sáb': 6 };
const DAY_SEQUENCE = [1, 2, 3, 4, 5, 6, 0]; // lun → sáb → dom

function parseDayRange(str) {
  if (!str.includes('-')) {
    const d = DAY_MAP[str.toLowerCase()];
    return d !== undefined ? [d] : null;
  }
  const [startStr, endStr] = str.split('-');
  const start = DAY_MAP[startStr.toLowerCase()];
  const end   = DAY_MAP[endStr.toLowerCase()];
  if (start === undefined || end === undefined) return null;
  const si = DAY_SEQUENCE.indexOf(start);
  const ei = DAY_SEQUENCE.indexOf(end);
  if (si === -1 || ei === -1) return null;
  return ei >= si ? DAY_SEQUENCE.slice(si, ei + 1)
                  : [...DAY_SEQUENCE.slice(si), ...DAY_SEQUENCE.slice(0, ei + 1)];
}

// ── Estado del admin ──────────────────────────────────────────────────────────

function getAdminState() {
  const conv = getConversation(ADMIN_PHONE);
  return { step: conv?.current_step || 'ADMIN_IDLE', stepData: conv?.step_data || {} };
}

function setAdminStep(step, data = {}) {
  upsertConversation(ADMIN_PHONE, step, data);
}

function resetAdminState() {
  setAdminStep('ADMIN_IDLE', {});
}

// ── Disponibilidad para flujo "agregar turno" ─────────────────────────────────

async function findAdminAvailableDays(serviceDuration, { excludeAppointmentId = null, excludeEventId = null } = {}) {
  const MAX_SCAN  = 21;
  const MAX_SHOWN = 7;
  const result    = [];
  const base      = new Date();
  const scanEnd   = new Date(base);
  scanEnd.setDate(base.getDate() + MAX_SCAN);

  let calEvents = [];
  try { calEvents = await cal().getEventsInRange(toISO(base), toISO(scanEnd)); }
  catch (err) { logger.warn(`Calendar no disponible: ${err.message}`); }

  for (let i = 1; i <= MAX_SCAN && result.length < MAX_SHOWN; i++) {
    const d       = new Date(base);
    d.setDate(base.getDate() + i);
    const dateStr = toISO(d);
    const label   = `${DAYS_ES[d.getDay()]} ${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
    const dbSlots = getAvailableSlots(dateStr, serviceDuration, excludeAppointmentId);
    if (!dbSlots.length) continue;
    const dayEvents = calEvents.filter(ev =>
      ev.start?.dateTime?.startsWith(dateStr) && (!excludeEventId || ev.id !== excludeEventId)
    );
    // Admin ve todos los horarios disponibles, sin límite
    const slots = cal().filterSlotsWithEvents(dbSlots, serviceDuration, dayEvents);
    if (slots.length) result.push({ dateStr, label, slots });
  }
  return result;
}

// ── Formateadores ─────────────────────────────────────────────────────────────

function formatDayTurns(date, appointments) {
  const header = date === toISO(new Date())
    ? `📅 *Hoy — ${isoToLabel(date)}*`
    : `📅 *${isoToLabel(date)}*`;

  if (!appointments.length) return `${header}\n_Sin turnos_`;

  const lines = appointments.map(a =>
    `${a.appointment_time} — ${a.service_name} — ` +
    `${formatContact(a.phone_number, a.client_name)} ` +
    `${a.seña_paid ? '✅' : '⏳'} *#${a.id}*`
  );
  return `${header}\n${lines.join('\n')}`;
}

// ── Texto de ayuda ────────────────────────────────────────────────────────────

const HELP_TEXT =
`🤖 *Comandos disponibles:*

*Turnos*
• ver turnos
• ver turnos DD/MM
• cancelar turno [nombre apellido]
• modificar turno [nombre o número]
• agregar turno

*Disponibilidad*
• ver horarios
• bloquear DD/MM
• bloquear DD/MM HH:MM-HH:MM
• desbloquear DD/MM
• horario laboral lun-vie 09:00-18:00
• horario laboral sab 09:00-15:00
• quitar horario [rango]

*Servicios*
• ver servicios
• agregar servicio
• editar servicio [nombre]
• eliminar servicio [nombre]

*Bot*
• ver pausados
• activar [nombre o número]
• pausar [nombre o número]
• ver comprobantes
• revisar [id]
• resumen diario on/off
• ver cliente [número o nombre]

*Configuración*
• conectar calendar
• ayuda

_Escribí *cancelar* en cualquier momento para salir de un flujo._`;

// ── Comandos de un solo paso ──────────────────────────────────────────────────

async function cmdVerTurnos(targetDate = null) {
  const dates = targetDate
    ? [targetDate]
    : Array.from({ length: 4 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() + i);
        return toISO(d);
      });

  const sections = dates.map(date =>
    formatDayTurns(date, getAppointmentsByDateFull(date))
  );

  await send().sendMessage(ADMIN_PHONE, sections.join('\n\n'));
}

async function cmdVerHorarios() {
  const raw = getSetting('working_hours');
  if (!raw) {
    await send().sendMessage(ADMIN_PHONE, '⚠️ No hay horario laboral configurado.\n\nUsá *horario laboral lun-vie 09:00-18:00* para configurarlo.');
    return;
  }

  const parsed     = JSON.parse(raw);
  const schedules  = Array.isArray(parsed) ? parsed : [parsed];
  const shortNames = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

  const scheduleLines = schedules.map(s => {
    const dayNames = s.days.map(d => shortNames[d]).join(', ');
    return `📅 ${dayNames}: ${s.open} — ${s.close}`;
  });

  let text = `⚙️ *Configuración actual*\n\n${scheduleLines.join('\n')}`;

  const bloqueados = [];
  for (let i = 0; i <= 7; i++) {
    const d    = new Date();
    d.setDate(d.getDate() + i);
    const date = toISO(d);
    for (const b of getBlockedSlots(date)) {
      bloqueados.push(
        `📵 ${isoToLabel(date)}: ${b.full_day ? 'día completo' : `${b.start_time}–${b.end_time}`}`
      );
    }
  }

  text += bloqueados.length
    ? `\n\n*Bloqueos (próximos 7 días):*\n${bloqueados.join('\n')}`
    : '\n\n_Sin bloqueos en los próximos 7 días._';

  await send().sendMessage(ADMIN_PHONE, text);
}

async function cmdBloquearDia(ddmm) {
  const date = ddmmToISO(ddmm);
  blockSlot({ date, fullDay: true });
  await send().sendMessage(ADMIN_PHONE, `✅ ${isoToLabel(date)} bloqueado (día completo).`);
}

async function cmdBloquearRango(ddmm, startTime, endTime) {
  const date = ddmmToISO(ddmm);
  blockSlot({ date, startTime, endTime, fullDay: false });
  await send().sendMessage(ADMIN_PHONE, `✅ ${isoToLabel(date)} ${startTime}–${endTime} bloqueado.`);
}

async function cmdDesbloquear(ddmm) {
  const date = ddmmToISO(ddmm);
  removeBlockedSlots(date);
  await send().sendMessage(ADMIN_PHONE, `✅ ${isoToLabel(date)} desbloqueado.`);
}

async function cmdSetHorario(dayRange, open, close) {
  const days = parseDayRange(dayRange);
  if (!days) {
    await send().sendMessage(ADMIN_PHONE, '❌ Rango de días inválido. Ejemplo: *lun-vie* o *sab*');
    return;
  }

  // Cargar configuración existente y normalizar a array
  const raw       = getSetting('working_hours');
  const parsed    = raw ? JSON.parse(raw) : [];
  let   schedules = Array.isArray(parsed) ? parsed : [parsed];

  // Quitar los días indicados de cualquier bloque existente
  schedules = schedules
    .map(s => ({ ...s, days: s.days.filter(d => !days.includes(d)) }))
    .filter(s => s.days.length > 0);

  // Agregar el nuevo bloque para esos días
  schedules.push({ days, open, close });

  // Ordenar por el primer día de cada bloque (más prolijo al mostrar)
  schedules.sort((a, b) => Math.min(...a.days) - Math.min(...b.days));

  setSetting('working_hours', JSON.stringify(schedules));

  const shortNames = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const dayNames   = days.map(d => shortNames[d]).join(', ');
  await send().sendMessage(ADMIN_PHONE, `✅ Horario actualizado:\n📅 ${dayNames}\n🕐 ${open} — ${close}`);
}

async function cmdQuitarHorario(dayRange) {
  const days = parseDayRange(dayRange);
  if (!days) {
    await send().sendMessage(ADMIN_PHONE, '❌ Rango de días inválido. Ejemplo: *quitar horario sab*');
    return;
  }

  const raw    = getSetting('working_hours');
  if (!raw) {
    await send().sendMessage(ADMIN_PHONE, '⚠️ No hay horario configurado.');
    return;
  }

  const parsed    = JSON.parse(raw);
  let   schedules = Array.isArray(parsed) ? parsed : [parsed];

  schedules = schedules
    .map(s => ({ ...s, days: s.days.filter(d => !days.includes(d)) }))
    .filter(s => s.days.length > 0);

  setSetting('working_hours', JSON.stringify(schedules));

  const shortNames = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const dayNames   = days.map(d => shortNames[d]).join(', ');
  await send().sendMessage(ADMIN_PHONE, `✅ ${dayNames} quitado(s) del horario laboral.`);
}

async function cmdVerServicios() {
  const services = getActiveServices();
  if (!services.length) {
    await send().sendMessage(ADMIN_PHONE, '😔 No hay servicios activos.');
    return;
  }
  const lines = services.map(s =>
    `*#${s.id}* ${s.name} — ${s.duration_minutes} min — $${Number(s.price).toLocaleString('es-AR')}`
  );
  await send().sendMessage(ADMIN_PHONE, `💇 *Servicios activos:*\n\n${lines.join('\n')}`);
}

async function cmdVerPausados() {
  const paused = getPausedConversations();
  if (!paused.length) {
    await send().sendMessage(ADMIN_PHONE, '✅ No hay bots pausados actualmente.');
    return;
  }
  const lines = paused.map(c =>
    `• ${formatContact(c.phone_number, c.client_name)} — \`${c.phone_number}\` — desde ${c.updated_at.split(' ')[0]}`
  );
  await send().sendMessage(
    ADMIN_PHONE,
    `🔇 *Bots pausados (${paused.length}):*\n\n${lines.join('\n')}\n\n` +
    `Para reactivar: *activar <nombre>* o *activar <identificador>* (copiá el valor que figura entre comillas).\n` +
    `ℹ️ Ese identificador puede no coincidir con el número de teléfono real del contacto.`
  );
}

async function _activarPhone(phone) {
  const conv   = getConversation(phone);
  const client = getClientByPhone(phone);
  // Si no hay ni conversación ni cliente con ese identificador, no hay nada que
  // reactivar (antes se creaba una fila nueva inútil y se confirmaba en falso).
  // Suele pasar cuando el admin escribe el número de teléfono real, pero WhatsApp
  // identifica a ese contacto con un id interno (@lid) distinto al teléfono.
  if (!conv && !client) {
    await send().sendMessage(ADMIN_PHONE,
      `❌ No encontré ninguna conversación con *${phone}*.\n\n` +
      `Mirá *ver pausados* y reactivá con el *nombre* del cliente o copiando el identificador que figura entre comillas.\n\n` +
      `ℹ️ WhatsApp identifica a algunos contactos con un número interno distinto al de su teléfono, por eso escribir el número real puede no coincidir.`
    );
    return;
  }
  setBotActive(phone, true);
  upsertConversation(phone, 'IDLE', {});
  // La reactivación ya quedó guardada en la DB. El aviso al cliente es opcional:
  // muchas veces el cliente responde el aviso por cordialidad y reingresa al
  // flujo del bot sin querer, así que se le pregunta al admin primero.
  setAdminStep('ADMIN_ACTIVATE_NOTIFY', { phone, name: client?.name || null });
  await send().sendMessage(
    ADMIN_PHONE,
    `✅ Bot reactivado para ${formatContact(phone, client?.name)}.\n\n¿Le aviso al cliente?\n\n1 Sí\n2 No`
  );
}

async function handleActivateNotify(lower, stepData) {
  const choice = lower.trim();

  if (choice === '2' || choice === 'no') {
    resetAdminState();
    await send().sendMessage(ADMIN_PHONE, '👌 Listo, sin aviso al cliente.');
    return;
  }

  if (choice === '1' || choice === 'si' || choice === 'sí') {
    let adminMsg = '✅ Cliente avisado.';
    // Sin bloquear la confirmación al admin si el envío falla (ej.: contacto
    // @lid cuyo waId no está en cache tras reiniciar el bot).
    try {
      await send().sendMessage(
        stepData.phone,
        '¡Hola de nuevo! 😊 Ya podés escribirnos.\n\nEscribí *hola* para ver las opciones disponibles.'
      );
    } catch (e) {
      logger.warn(`No se pudo avisar al cliente ${anonPhone(stepData.phone)} al reactivar: ${e.message}`);
      adminMsg = '⚠️ No se pudo avisar al cliente (el bot igual quedó reactivado).';
    }
    resetAdminState();
    await send().sendMessage(ADMIN_PHONE, adminMsg);
    return;
  }

  await send().sendMessage(ADMIN_PHONE, '¿Le aviso al cliente?\n\n1 Sí\n2 No');
}

async function cmdActivarCliente(rawInput) {
  if (looksLikePhone(rawInput)) {
    return _activarPhone(cleanPhone(rawInput));
  }
  const matches = findClientsByName(rawInput.trim());
  if (!matches.length) {
    await send().sendMessage(ADMIN_PHONE,
      `❌ No encontré ningún cliente con el nombre *${rawInput.trim()}*.`
    );
    return;
  }
  if (matches.length === 1) {
    return _activarPhone(matches[0].phone);
  }
  const lines = matches.map((c, i) => `${i + 1}. ${formatContact(c.phone, c.name)}`).join('\n');
  setAdminStep('ADMIN_ACTIVATE_SELECT', { candidates: matches });
  await send().sendMessage(ADMIN_PHONE,
    `Encontré ${matches.length} clientes:\n\n${lines}\n\nElegí el número para activar.`
  );
}

async function handleActivateSelect(lower, stepData) {
  const candidates = stepData.candidates || [];
  const idx = parseInt(lower.trim(), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= candidates.length) {
    const lines = candidates.map((c, i) => `${i + 1}. ${formatContact(c.phone, c.name)}`).join('\n');
    await send().sendMessage(ADMIN_PHONE, `❌ Opción inválida:\n\n${lines}`);
    return;
  }
  resetAdminState();
  return _activarPhone(candidates[idx].phone);
}

async function cmdPausarCliente(rawInput) {
  if (looksLikePhone(rawInput)) {
    const phone = cleanPhone(rawInput);
    if (!phone || phone.length < 8) {
      await send().sendMessage(ADMIN_PHONE, '❌ Número inválido. Ejemplo: *pausar 1123456789*');
      return;
    }
    const conv   = getConversation(phone);
    const client = getClientByPhone(phone);
    // Solo se puede pausar una conversación existente. Si no hay fila para ese
    // identificador, pausar no haría nada (el bot seguiría respondiendo). Suele
    // pasar al escribir el número real en vez del id interno (@lid) del contacto.
    if (!conv && !client) {
      await send().sendMessage(ADMIN_PHONE,
        `❌ No encontré ninguna conversación con *${phone}*.\n\n` +
        `Pausá usando el *nombre* del cliente.\n` +
        `ℹ️ WhatsApp identifica a algunos contactos con un número interno distinto al de su teléfono, por eso el número real puede no coincidir.`
      );
      return;
    }
    setBotActive(phone, false);
    await send().sendMessage(
      ADMIN_PHONE,
      `✅ Bot pausado para ${formatContact(phone, client?.name)}.\nPodés retomar con: *activar ${phone}*`
    );
    logger.info(`Admin pausó manualmente al cliente ${anonPhone(phone)}`);
    return;
  }
  const matches = findClientsByName(rawInput.trim());
  if (!matches.length) {
    await send().sendMessage(ADMIN_PHONE,
      `❌ No encontré ningún cliente con el nombre *${rawInput.trim()}*.\nUsá *pausar [número]* o verificá el nombre.`
    );
    return;
  }
  if (matches.length === 1) {
    const client = matches[0];
    setBotActive(client.phone, false);
    await send().sendMessage(
      ADMIN_PHONE,
      `✅ Bot pausado para ${formatContact(client.phone, client.name)}.\nPodés retomar con: *activar ${client.phone}*`
    );
    logger.info(`Admin pausó manualmente al cliente ${anonPhone(client.phone)}`);
    return;
  }
  const lines = matches.map((c, i) => `${i + 1}. ${formatContact(c.phone, c.name)}`).join('\n');
  setAdminStep('ADMIN_PAUSE_SELECT', { candidates: matches });
  await send().sendMessage(ADMIN_PHONE,
    `Encontré ${matches.length} clientes:\n\n${lines}\n\nElegí el número para pausar.`
  );
}

async function handlePauseSelect(lower, stepData) {
  const candidates = stepData.candidates || [];
  const idx = parseInt(lower.trim(), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= candidates.length) {
    const lines = candidates.map((c, i) => `${i + 1}. ${formatContact(c.phone, c.name)}`).join('\n');
    await send().sendMessage(ADMIN_PHONE, `❌ Opción inválida:\n\n${lines}`);
    return;
  }
  const client = candidates[idx];
  setBotActive(client.phone, false);
  resetAdminState();
  await send().sendMessage(
    ADMIN_PHONE,
    `✅ Bot pausado para ${formatContact(client.phone, client.name)}.\nPodés retomar con: *activar ${client.phone}*`
  );
  logger.info(`Admin pausó manualmente al cliente ${anonPhone(client.phone)}`);
}

async function cmdVerComprobantes() {
  const receipts = getPendingReceipts();
  if (!receipts.length) {
    await send().sendMessage(ADMIN_PHONE, '✅ No hay comprobantes pendientes.');
    return;
  }
  const lines = receipts.map(r =>
    `*#${r.id}* — ${formatContact(r.phone_number)}` +
    (r.appointment_id ? ` — Turno #${r.appointment_id}` : ' — Sin turno') +
    ` — ${r.created_at.split(' ')[0]}`
  );
  await send().sendMessage(
    ADMIN_PHONE,
    `💰 *Comprobantes pendientes (${receipts.length}):*\n\n${lines.join('\n')}\n\nUsá *revisar [id]* para aprobar.`
  );
}

async function cmdRevisarComprobante(id) {
  const receipt = getPendingReceiptById(id);
  if (!receipt) {
    await send().sendMessage(ADMIN_PHONE, `❌ No encontré el comprobante #${id}.`);
    return;
  }
  if (receipt.reviewed) {
    await send().sendMessage(ADMIN_PHONE, `ℹ️ El comprobante #${id} ya fue revisado.`);
    return;
  }

  markReceiptReviewed(id);

  let clientMsg = `✅ ¡Tu seña fue confirmada! Tu turno está reservado. ¡Hasta pronto! 🙌`;

  if (receipt.appointment_id) {
    confirmAppointment(receipt.appointment_id);
    const apt = getAppointmentById(receipt.appointment_id);
    if (apt) {
      clientMsg =
        `✅ *¡Seña confirmada!* Tu turno del *${isoToLabel(apt.appointment_date)}* a las ` +
        `*${apt.appointment_time}* está 100% asegurado. ¡Nos vemos! 🙌`;
      // No bloquear la confirmación al admin si el aviso al cliente falla
      // (ej.: contacto @lid no cacheado tras reiniciar).
      try {
        await send().sendMessage(apt.phone_number, clientMsg);
      } catch (e) {
        logger.warn(`No se pudo avisar al cliente ${anonPhone(apt.phone_number)} al revisar comprobante: ${e.message}`);
      }
    }
  }

  await send().sendMessage(
    ADMIN_PHONE,
    `✅ Comprobante #${id} revisado.` +
    (receipt.appointment_id ? ` Seña del turno #${receipt.appointment_id} confirmada y cliente notificado.` : '')
  );
}

// ── Flujo: cancelar turno ─────────────────────────────────────────────────────

function formatAptLine(apt) {
  return (
    `👤 ${formatContact(apt.phone_number, apt.client_name)}\n` +
    `📅 ${isoToLabel(apt.appointment_date)} ${apt.appointment_time}\n` +
    `💇 ${apt.service_name} ${apt.seña_paid ? '✅ seña pagada' : '⏳ seña pendiente'}`
  );
}

async function startCancelarTurno(name) {
  const apts = getAppointmentsByClientName(name);

  if (!apts.length) {
    await send().sendMessage(ADMIN_PHONE, `❌ No encontré turnos futuros para *${name}*.`);
    return;
  }

  if (apts.length === 1) {
    setAdminStep('ADMIN_CANCEL_CONFIRM', { appointmentId: apts[0].id });
    await send().sendMessage(
      ADMIN_PHONE,
      `¿Cancelás este turno?\n\n${formatAptLine(apts[0])}\n\nRespondé *SI* para confirmar o *NO* para cancelar.`
    );
    return;
  }

  setAdminStep('ADMIN_CANCEL_SELECT', { appointments: apts });
  const lines = apts.map((a, i) =>
    `${i + 1}. ${isoToLabel(a.appointment_date)} ${a.appointment_time} — ${a.service_name}`
  );
  await send().sendMessage(
    ADMIN_PHONE,
    `Encontré ${apts.length} turnos para *${name}*:\n\n${lines.join('\n')}\n\nElegí el número del turno a cancelar.`
  );
}

async function handleCancelSelect(lower, stepData) {
  const apts = stepData.appointments || [];
  const idx  = parseInt(lower.trim(), 10) - 1;

  if (isNaN(idx) || idx < 0 || idx >= apts.length) {
    const lines = apts.map((a, i) =>
      `${i + 1}. ${isoToLabel(a.appointment_date)} ${a.appointment_time} — ${a.service_name}`
    );
    await send().sendMessage(ADMIN_PHONE, `❌ Opción inválida. Elegí un número:\n\n${lines.join('\n')}`);
    return;
  }

  const apt = apts[idx];
  setAdminStep('ADMIN_CANCEL_CONFIRM', { appointmentId: apt.id });
  await send().sendMessage(
    ADMIN_PHONE,
    `¿Cancelás este turno?\n\n${formatAptLine(apt)}\n\nRespondé *SI* para confirmar o *NO* para cancelar.`
  );
}

async function handleCancelConfirm(lower, stepData) {
  if (lower === 'si' || lower === 'sí') {
    const apt = getAppointmentById(stepData.appointmentId);

    if (apt?.calendar_event_id) {
      try { await cal().deleteEvent(apt.calendar_event_id); }
      catch (err) { console.warn('⚠️  No se pudo borrar de Calendar:', err.message); }
    }

    deleteAppointment(stepData.appointmentId);

    let adminMsg = `✅ Turno #${stepData.appointmentId} cancelado.`;
    if (apt && apt.phone_number && apt.phone_number !== 'manual') {
      // El aviso al cliente no debe bloquear el reset del flujo ni la
      // confirmación al admin (ej.: contacto @lid no cacheado tras reiniciar).
      try {
        await send().sendMessage(
          apt.phone_number,
          `😔 Tu turno del *${isoToLabel(apt.appointment_date)}* a las *${apt.appointment_time}* ` +
          `fue cancelado. Escribí *hola* si querés agendar de nuevo.`
        );
        adminMsg = `✅ Turno #${stepData.appointmentId} cancelado y cliente notificado.`;
      } catch (e) {
        logger.warn(`No se pudo avisar al cliente ${anonPhone(apt.phone_number)} al cancelar turno: ${e.message}`);
        adminMsg = `✅ Turno #${stepData.appointmentId} cancelado (no se pudo avisar al cliente).`;
      }
    }

    resetAdminState();
    await send().sendMessage(ADMIN_PHONE, adminMsg);
    return;
  }

  if (lower === 'no') {
    resetAdminState();
    await send().sendMessage(ADMIN_PHONE, '👌 Cancelación abortada.');
    return;
  }

  await send().sendMessage(ADMIN_PHONE, 'Respondé *SI* para confirmar la cancelación o *NO* para abortar.');
}

// ── Flujo: agregar turno ──────────────────────────────────────────────────────

// Resumen de confirmación. Si stepData.editingId existe, muestra antes/después.
function buildTurnConfirmMessage(stepData, time) {
  const s     = stepData.service;
  const nuevo =
    `💇 ${s.name} — ${s.duration_minutes} min\n` +
    `📅 ${stepData.dateLabel}\n` +
    `🕐 ${time}\n` +
    `💰 $${Number(s.price).toLocaleString('es-AR')}`;

  if (!stepData.editingId) {
    return `📋 *Resumen del nuevo turno:*\n\n👤 ${stepData.clientName}\n${nuevo}\n\n¿Confirmás? *SI* / *NO*`;
  }

  const o     = stepData.original;
  const antes =
    `💇 ${o.service_name} — ${o.service_duration} min\n` +
    `📅 ${isoToLabel(o.date)}\n` +
    `🕐 ${o.time}\n` +
    `💰 $${Number(o.service_price).toLocaleString('es-AR')}`;

  return `📋 *Modificación del turno #${stepData.editingId}:*\n\n` +
    `👤 ${stepData.clientName}\n\n` +
    `*Antes:*\n${antes}\n\n*Después:*\n${nuevo}\n\n` +
    `¿Confirmás? *SI* / *NO*`;
}

async function startAgregarTurno() {
  setAdminStep('ADMIN_ADD_TURN_CLIENT', {});
  await send().sendMessage(ADMIN_PHONE, '➕ *Agregar turno*\n\n¿Nombre o teléfono del cliente?\n\n_Escribí *cancelar* para salir._');
}

async function handleAddTurnClient(body, stepData) {
  const query   = body.trim();
  const matches = findClientsByNameOrPhone(query);

  if (matches.length === 0) {
    // Cliente nuevo — pedir teléfono
    setAdminStep('ADMIN_ADD_TURN_NEW_CLIENT_PHONE', { ...stepData, clientName: query });
    await send().sendMessage(ADMIN_PHONE,
      `Cliente nuevo: *${query}*\n\n¿Número de teléfono? (escribí *manual* si no tenés)`
    );
    return;
  }

  if (matches.length === 1) {
    const c = matches[0];
    setAdminStep('ADMIN_ADD_TURN_CLIENT_CONFIRM', {
      ...stepData, clientName: c.name, clientPhone: c.phone,
    });
    await send().sendMessage(ADMIN_PHONE,
      `¿Es para *${c.name}*?\n${formatContact(c.phone, c.name)}\n\n*SI* / *NO*`
    );
    return;
  }

  const lines = matches.map((c, i) => `${i + 1}. ${formatContact(c.phone, c.name)}`).join('\n');
  setAdminStep('ADMIN_ADD_TURN_CLIENT_SELECT', { ...stepData, candidates: matches });
  await send().sendMessage(ADMIN_PHONE,
    `Encontré ${matches.length} clientes:\n\n${lines}\n\nElegí el número o escribí *cancelar*.`
  );
}

async function handleAddTurnClientConfirm(lower, stepData) {
  if (lower === 'si' || lower === 'sí') {
    setAdminStep('ADMIN_ADD_TURN_CATEGORY', stepData);
    await send().sendMessageWithList(
      ADMIN_PHONE,
      `Cliente: *${stepData.clientName}*\n\n¿Categoría de servicio?`,
      CATEGORIES.map(c => c.label)
    );
    return;
  }
  if (lower === 'no') {
    setAdminStep('ADMIN_ADD_TURN_CLIENT', stepData);
    await send().sendMessage(ADMIN_PHONE, '¿Nombre o teléfono del cliente?');
    return;
  }
  await send().sendMessage(ADMIN_PHONE, 'Respondé *SI* o *NO*.');
}

async function handleAddTurnClientSelect(lower, stepData) {
  const candidates = stepData.candidates || [];
  const idx = parseInt(lower.trim(), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= candidates.length) {
    const lines = candidates.map((c, i) => `${i + 1}. ${formatContact(c.phone, c.name)}`).join('\n');
    await send().sendMessage(ADMIN_PHONE, `❌ Opción inválida:\n\n${lines}`);
    return;
  }
  const c = candidates[idx];
  const newData = { ...stepData, clientName: c.name, clientPhone: c.phone };
  delete newData.candidates;
  setAdminStep('ADMIN_ADD_TURN_CATEGORY', newData);
  // Arrancar selección de categoría
  await send().sendMessageWithList(ADMIN_PHONE, `Cliente: *${c.name}*\n\n¿Categoría de servicio?`, CATEGORIES.map(c => c.label));
}

async function handleAddTurnNewClientPhone(body, stepData) {
  const raw = body.trim().toLowerCase();
  let clientPhone = 'manual';
  if (raw !== 'manual') {
    if (!looksLikePhone(raw)) {
      await send().sendMessage(ADMIN_PHONE,
        '❌ Número inválido. Ingresá el teléfono (ej: 1123456789) o escribí *manual*.'
      );
      return;
    }
    clientPhone = cleanPhone(raw);
    upsertClient(clientPhone, stepData.clientName);
  }
  const newData = { ...stepData, clientPhone };
  setAdminStep('ADMIN_ADD_TURN_CATEGORY', newData);
  await send().sendMessageWithList(
    ADMIN_PHONE,
    `Cliente: *${stepData.clientName}*\n\n¿Categoría de servicio?`,
    CATEGORIES.map(c => c.label)
  );
}

async function handleAddTurnCategory(lower, stepData) {
  const idx = parseInt(lower.trim(), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= CATEGORIES.length) {
    await send().sendMessageWithList(ADMIN_PHONE, '❌ Opción inválida. ¿Qué tipo de servicio?', CATEGORIES.map(c => c.label));
    return;
  }
  const category    = CATEGORIES[idx].key;
  const selectedIds = new Set((stepData.servicesSelected || []).map(s => s.id));
  const services    = getServicesByCategory(category).filter(s => !selectedIds.has(s.id));

  if (!services.length) {
    await send().sendMessage(ADMIN_PHONE, '😔 No hay más servicios disponibles en esta categoría.');
    await send().sendMessageWithList(ADMIN_PHONE, '¿Qué tipo de servicio?', CATEGORIES.map(c => c.label));
    return;
  }

  setAdminStep('ADMIN_ADD_TURN_SERVICE', { ...stepData, category, services });
  const options = services.map(s =>
    `${s.name} (${s.duration_minutes} min) $${Number(s.price).toLocaleString('es-AR')}`
  );
  await send().sendMessageWithList(ADMIN_PHONE, '¿Servicio?', options);
}

async function handleAddTurnService(lower, stepData) {
  const services = stepData.services || [];
  const idx      = parseInt(lower.trim(), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= services.length) {
    const options = services.map(s =>
      `${s.name} (${s.duration_minutes} min) $${Number(s.price).toLocaleString('es-AR')}`
    );
    await send().sendMessageWithList(ADMIN_PHONE, '❌ Opción inválida. ¿Servicio?', options);
    return;
  }
  const existing               = stepData.servicesSelected || [];
  const { services: _, category: __, ...rest } = stepData;
  setAdminStep('ADMIN_ADD_TURN_MORE', { ...rest, servicesSelected: [...existing, services[idx]] });
  await send().sendMessage(
    ADMIN_PHONE,
    '¿Querés agregar otro servicio?\n\n1 Sí, agregar otro\n2 No, continuar'
  );
}

async function handleAddTurnMore(lower, stepData) {
  const wantsMore     = ['1', 'si', 'sí', 'agregar', 'otro'].some(w => lower === w || lower.startsWith(w + ' '));
  const wantsContinue = ['2', 'no', 'continuar', 'listo', 'ya'].some(w => lower === w || lower.startsWith(w + ' '));

  if (wantsMore) {
    const selected = stepData.servicesSelected || [];
    const lines    = selected.map(s => `• ${s.name} (${s.duration_minutes} min)`).join('\n');
    const total    = selected.reduce((sum, s) => sum + s.duration_minutes, 0);
    setAdminStep('ADMIN_ADD_TURN_CATEGORY', stepData);
    await send().sendMessage(ADMIN_PHONE, `Llevás elegido:\n${lines}\n⏱ Total: ${total} min`);
    await send().sendMessageWithList(ADMIN_PHONE, '¿Qué categoría?', CATEGORIES.map(c => c.label));
    return;
  }

  if (wantsContinue) {
    const service = buildCombinedService(stepData.servicesSelected);

    // Modificación de turno manteniendo fecha/hora: saltar directo a confirmar
    if (stepData.editingId && stepData.keepDateTime) {
      const o = stepData.original;
      const newData = {
        ...stepData, service,
        date: o.date, dateLabel: isoToLabel(o.date), time: o.time,
      };
      setAdminStep('ADMIN_ADD_TURN_CONFIRM', newData);
      await send().sendMessage(ADMIN_PHONE, buildTurnConfirmMessage(newData, o.time));
      return;
    }

    setAdminStep('ADMIN_ADD_TURN_MODE', { ...stepData, service });
    await send().sendMessage(
      ADMIN_PHONE,
      `¿Cómo querés elegir la fecha y horario?\n\n1 Horarios disponibles\n2 Fuera de horario`
    );
    return;
  }

  await send().sendMessage(
    ADMIN_PHONE,
    '❌ Opción inválida.\n\n¿Querés agregar otro servicio?\n\n1 Sí, agregar otro\n2 No, continuar'
  );
}

async function handleAddTurnMode(lower, stepData) {
  if (lower === '1') {
    const days = await findAdminAvailableDays(stepData.service.duration_minutes, {
      excludeAppointmentId: stepData.editingId    || null,
      excludeEventId:       stepData.editingEventId || null,
    });
    if (!days.length) {
      await send().sendMessage(ADMIN_PHONE, '😔 No hay horarios disponibles en los próximos días.');
      resetAdminState();
      return;
    }
    setAdminStep('ADMIN_ADD_TURN_DATE', { ...stepData, availableDays: days });
    await send().sendMessageWithList(
      ADMIN_PHONE,
      '¿Fecha?\n\n_También podés escribir una fecha directamente: DD/MM_',
      days.map(d => d.label)
    );
    return;
  }

  if (lower === '2') {
    setAdminStep('ADMIN_ADD_TURN_OOH_DATE', stepData);
    await send().sendMessage(ADMIN_PHONE, '¿Qué fecha? (DD/MM, ej: 20/05)');
    return;
  }

  await send().sendMessage(
    ADMIN_PHONE,
    '❌ Opción inválida.\n\n¿Cómo querés elegir la fecha y horario?\n\n1 Horarios disponibles\n2 Fuera de horario'
  );
}

async function handleAddTurnOohDate(body, stepData) {
  const match = body.trim().match(/^(\d{2})\/(\d{2})$/);
  if (!match) {
    await send().sendMessage(ADMIN_PHONE, '❌ Formato inválido. Ingresá la fecha como DD/MM (ej: 20/05)');
    return;
  }
  const [, dd, mm] = match;
  const year    = new Date().getFullYear();
  const dateStr = `${year}-${mm}-${dd}`;
  const dateLabel = `${DAYS_ES[new Date(`${dateStr}T12:00:00`).getDay()]} ${dd}/${mm}`;
  setAdminStep('ADMIN_ADD_TURN_OOH_TIME', { ...stepData, date: dateStr, dateLabel });
  await send().sendMessage(ADMIN_PHONE, `¿A qué hora? (HH:MM, ej: 10:30)`);
}

async function handleAddTurnOohTime(body, stepData) {
  const match = body.trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    await send().sendMessage(ADMIN_PHONE, '❌ Formato inválido. Ingresá el horario como HH:MM (ej: 10:30)');
    return;
  }
  const time = body.trim();
  setAdminStep('ADMIN_ADD_TURN_CONFIRM', { ...stepData, time });
  await send().sendMessage(ADMIN_PHONE, buildTurnConfirmMessage(stepData, time));
}

async function handleAddTurnDate(lower, stepData) {
  const days = stepData.availableDays || [];

  // Verificar si ingresó una fecha manual DD/MM
  const manualMatch = lower.trim().match(/^(\d{2})\/(\d{2})$/);
  if (manualMatch) {
    const [, dd, mm] = manualMatch;
    const year    = new Date().getFullYear();
    const dateStr = `${year}-${mm}-${dd}`;
    const dateLabel = `${DAYS_ES[new Date(`${dateStr}T12:00:00`).getDay()]} ${dd}/${mm}`;

    // Buscar slots disponibles para esa fecha
    let calEvents = [];
    try { calEvents = await cal().getEventsInRange(dateStr, dateStr); } catch (_) {}
    if (stepData.editingEventId) calEvents = calEvents.filter(ev => ev.id !== stepData.editingEventId);
    const dbSlots  = getAvailableSlots(dateStr, stepData.service.duration_minutes, stepData.editingId || null);
    const slots    = cal().filterSlotsWithEvents(dbSlots, stepData.service.duration_minutes, calEvents);

    if (!slots.length) {
      await send().sendMessageWithList(
        ADMIN_PHONE,
        `😔 No hay horarios disponibles para el *${dateLabel}*. Elegí otra fecha o ingresá una diferente:`,
        days.map(d => d.label)
      );
      return;
    }

    const { availableDays: _, ...rest } = stepData;
    setAdminStep('ADMIN_ADD_TURN_TIME', { ...rest, date: dateStr, dateLabel, availableSlots: slots });
    await send().sendMessageWithList(ADMIN_PHONE, `¿Horario para el *${dateLabel}*?`, slots);
    return;
  }

  // Selección por número de la lista
  const idx = parseInt(lower.trim(), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= days.length) {
    await send().sendMessageWithList(
      ADMIN_PHONE,
      '❌ Opción inválida. Elegí un número o escribí una fecha DD/MM:',
      days.map(d => d.label)
    );
    return;
  }
  const chosen = days[idx];
  const { availableDays: _, ...rest } = stepData;
  setAdminStep('ADMIN_ADD_TURN_TIME', { ...rest, date: chosen.dateStr, dateLabel: chosen.label, availableSlots: chosen.slots });
  await send().sendMessageWithList(ADMIN_PHONE, `¿Horario para el *${chosen.label}*?`, chosen.slots);
}

async function handleAddTurnTime(lower, stepData) {
  const slots = stepData.availableSlots || [];
  const idx   = parseInt(lower.trim(), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= slots.length) {
    await send().sendMessageWithList(ADMIN_PHONE, '❌ Opción inválida. ¿Horario?', slots);
    return;
  }
  const time = slots[idx];
  const { availableSlots: _, ...rest } = stepData;
  setAdminStep('ADMIN_ADD_TURN_CONFIRM', { ...rest, time });
  await send().sendMessage(ADMIN_PHONE, buildTurnConfirmMessage(rest, time));
}

async function handleAddTurnConfirm(lower, stepData) {
  if (lower !== 'si' && lower !== 'sí') {
    resetAdminState();
    await send().sendMessage(ADMIN_PHONE, stepData.editingId ? '👌 Turno sin cambios.' : '👌 Turno no agendado.');
    return;
  }

  // ── Rama: modificación de turno existente ──
  if (stepData.editingId) {
    const s = stepData.service;
    updateAppointment(stepData.editingId, {
      appointment_date: stepData.date,
      appointment_time: stepData.time,
      service_name:     s.name,
      service_duration: s.duration_minutes,
      service_price:    s.price,
    });

    // Calendar: borrar evento viejo y crear el nuevo
    if (stepData.editingEventId) {
      try { await cal().deleteEvent(stepData.editingEventId); }
      catch (err) { logger.warn(`No se pudo borrar evento viejo de Calendar: ${err.message}`); }
    }
    try {
      const eventId = await cal().createEvent({
        phone_number:     stepData.clientPhone || 'manual',
        client_name:      stepData.clientName,
        service_name:     s.name,
        service_duration: s.duration_minutes,
        service_price:    s.price,
        appointment_date: stepData.date,
        appointment_time: stepData.time,
      });
      if (eventId) setCalendarEventId(stepData.editingId, eventId);
    } catch (err) {
      logger.error(`Error creando evento en Calendar (modificar turno): ${err.message}`);
    }

    // ¿Avisar al cliente? Solo si tiene teléfono real
    if (stepData.clientPhone && stepData.clientPhone !== 'manual') {
      setAdminStep('ADMIN_EDIT_TURN_NOTIFY', {
        editingId:   stepData.editingId,
        clientPhone: stepData.clientPhone,
        clientName:  stepData.clientName,
        original:    stepData.original,
        nuevo: { date: stepData.date, time: stepData.time, service_name: s.name },
      });
      await send().sendMessage(
        ADMIN_PHONE,
        `✅ Turno *#${stepData.editingId}* actualizado.\n\n¿Le aviso al cliente?\n\n1 Sí\n2 No`
      );
    } else {
      resetAdminState();
      await send().sendMessage(ADMIN_PHONE, `✅ Turno *#${stepData.editingId}* actualizado.`);
    }
    return;
  }

  const appointmentId = createAppointment({
    phone_number:     stepData.clientPhone || 'manual',
    client_name:      stepData.clientName,
    service_name:     stepData.service.name,
    service_duration: stepData.service.duration_minutes,
    service_price:    stepData.service.price,
    appointment_date: stepData.date,
    appointment_time: stepData.time,
  });

  try {
    const eventId = await cal().createEvent({
      phone_number:     stepData.clientPhone || 'manual',
      client_name:      stepData.clientName,
      service_name:     stepData.service.name,
      service_duration: stepData.service.duration_minutes,
      service_price:    stepData.service.price,
      appointment_date: stepData.date,
      appointment_time: stepData.time,
    });
    if (eventId) setCalendarEventId(appointmentId, eventId);
  } catch (err) {
    logger.error(`Error creando evento en Calendar (agregar turno): ${err.message}`);
  }

  resetAdminState();
  await send().sendMessage(ADMIN_PHONE, `✅ Turno *#${appointmentId}* creado.`);
}

// ── Flujo: modificar turno ────────────────────────────────────────────────────

function formatAptEditLine(a) {
  return `📅 ${isoToLabel(a.appointment_date)} 🕐 ${a.appointment_time}\n` +
         `💇 ${a.service_name} — ${a.service_duration} min — $${Number(a.service_price).toLocaleString('es-AR')}`;
}

async function startModificarTurno(query) {
  const apts = looksLikePhone(query)
    ? getAppointmentsByPhone(cleanPhone(query))
    : getAppointmentsByClientName(query);

  if (!apts.length) {
    await send().sendMessage(ADMIN_PHONE, `❌ No encontré turnos futuros para *${query}*.`);
    return;
  }

  if (apts.length === 1) return showEditTurnMenu(apts[0]);

  setAdminStep('ADMIN_EDIT_TURN_SELECT', { appointments: apts });
  const lines = apts.map((a, i) =>
    `${i + 1}. ${isoToLabel(a.appointment_date)} ${a.appointment_time} — ${a.service_name} (${a.client_name})`
  );
  await send().sendMessage(
    ADMIN_PHONE,
    `Encontré ${apts.length} turnos para *${query}*:\n\n${lines.join('\n')}\n\nElegí el número del turno a modificar.`
  );
}

async function showEditTurnMenu(apt) {
  setAdminStep('ADMIN_EDIT_TURN_FIELD', {
    editingId:      apt.id,
    editingEventId: apt.calendar_event_id || null,
    clientName:     apt.client_name,
    clientPhone:    apt.phone_number,
    original: {
      date:             apt.appointment_date,
      time:             apt.appointment_time,
      service_name:     apt.service_name,
      service_duration: apt.service_duration,
      service_price:    apt.service_price,
    },
  });
  await send().sendMessage(
    ADMIN_PHONE,
    `✏️ *Modificar turno #${apt.id}*\n\n` +
    `👤 ${apt.client_name}\n${formatAptEditLine(apt)}\n\n` +
    `¿Qué querés cambiar?\n\n1 Fecha y hora\n2 Servicio\n3 Todo (servicio + fecha y hora)\n\n` +
    `_Escribí *cancelar* para salir._`
  );
}

async function handleEditTurnSelect(lower, stepData) {
  const apts = stepData.appointments || [];
  const idx  = parseInt(lower.trim(), 10) - 1;

  if (isNaN(idx) || idx < 0 || idx >= apts.length) {
    const lines = apts.map((a, i) =>
      `${i + 1}. ${isoToLabel(a.appointment_date)} ${a.appointment_time} — ${a.service_name} (${a.client_name})`
    );
    await send().sendMessage(ADMIN_PHONE, `❌ Opción inválida. Elegí un número:\n\n${lines.join('\n')}`);
    return;
  }
  return showEditTurnMenu(apts[idx]);
}

async function handleEditTurnField(lower, stepData) {
  const choice = lower.trim();

  // 1 — Solo fecha y hora: mantener servicio actual, ir a elegir fecha
  if (choice === '1') {
    const o = stepData.original;
    const service = {
      name:             o.service_name,
      duration_minutes: o.service_duration,
      price:            o.service_price,
    };
    setAdminStep('ADMIN_ADD_TURN_MODE', { ...stepData, service });
    await send().sendMessage(
      ADMIN_PHONE,
      `¿Cómo querés elegir la nueva fecha y horario?\n\n1 Horarios disponibles\n2 Fuera de horario`
    );
    return;
  }

  // 2 — Solo servicio (mantiene fecha/hora) · 3 — Servicio + fecha/hora
  if (choice === '2' || choice === '3') {
    const newData = { ...stepData, servicesSelected: [], keepDateTime: choice === '2' };
    setAdminStep('ADMIN_ADD_TURN_CATEGORY', newData);
    await send().sendMessageWithList(
      ADMIN_PHONE,
      `Cliente: *${stepData.clientName}*\n\n¿Categoría del nuevo servicio?`,
      CATEGORIES.map(c => c.label)
    );
    return;
  }

  await send().sendMessage(
    ADMIN_PHONE,
    '❌ Opción inválida.\n\n¿Qué querés cambiar?\n\n1 Fecha y hora\n2 Servicio\n3 Todo (servicio + fecha y hora)'
  );
}

async function handleEditTurnNotify(lower, stepData) {
  const choice = lower.trim();

  if (choice === '2' || choice === 'no') {
    resetAdminState();
    await send().sendMessage(ADMIN_PHONE, '👌 Listo, sin aviso al cliente.');
    return;
  }

  if (choice === '1' || choice === 'si' || choice === 'sí') {
    const o = stepData.original;
    const n = stepData.nuevo;
    let adminMsg = '✅ Cliente notificado del cambio.';
    try {
      await send().sendMessage(
        stepData.clientPhone,
        `🔄 *Tu turno fue reprogramado:*\n\n` +
        `Antes: ${isoToLabel(o.date)} a las ${o.time} — ${o.service_name}\n` +
        `Ahora: *${isoToLabel(n.date)}* a las *${n.time}* — ${n.service_name}\n\n` +
        `Si no podés asistir, avisanos. 😊`
      );
    } catch (e) {
      logger.warn(`No se pudo avisar al cliente ${anonPhone(stepData.clientPhone)} al modificar turno: ${e.message}`);
      adminMsg = '⚠️ No se pudo avisar al cliente (el turno igual quedó actualizado).';
    }
    resetAdminState();
    await send().sendMessage(ADMIN_PHONE, adminMsg);
    return;
  }

  await send().sendMessage(ADMIN_PHONE, '¿Le aviso al cliente?\n\n1 Sí\n2 No');
}

// ── Flujo: agregar servicio ───────────────────────────────────────────────────

async function startAgregarServicio() {
  setAdminStep('ADMIN_ADD_SERVICE_NAME', {});
  await send().sendMessage(ADMIN_PHONE, '➕ *Agregar servicio*\n\n¿Nombre del servicio?\n\n_Escribí *cancelar* para salir._');
}

async function handleAddServiceName(body) {
  const name = body.trim();
  setAdminStep('ADMIN_ADD_SERVICE_DURATION', { name });
  await send().sendMessage(ADMIN_PHONE, `Duración en minutos para *${name}* (ej: 30):`);
}

async function handleAddServiceDuration(body, stepData) {
  const min = parseInt(body.trim(), 10);
  if (isNaN(min) || min < 5 || min > 480) {
    await send().sendMessage(ADMIN_PHONE, '❌ Duración inválida. Ingresá los minutos (ej: 30)');
    return;
  }
  setAdminStep('ADMIN_ADD_SERVICE_PRICE', { ...stepData, duration_minutes: min });
  await send().sendMessage(ADMIN_PHONE, `Precio en $ para *${stepData.name}* (ej: 3000):`);
}

async function handleAddServicePrice(body, stepData) {
  const price = parseFloat(body.replace(/[.$\s,]/g, '').trim());
  if (isNaN(price) || price <= 0) {
    await send().sendMessage(ADMIN_PHONE, '❌ Precio inválido. Ingresá el monto sin símbolos (ej: 3000)');
    return;
  }
  const id = insertService({ name: stepData.name, duration_minutes: stepData.duration_minutes, price });
  resetAdminState();
  await send().sendMessage(
    ADMIN_PHONE,
    `✅ Servicio creado:\n\n` +
    `*${stepData.name}* — ${stepData.duration_minutes} min — $${price.toLocaleString('es-AR')}\n` +
    `ID: #${id}`
  );
}

// ── Flujo: editar servicio ────────────────────────────────────────────────────

async function startEditarServicio(name) {
  const service = findServiceByName(name);
  if (!service) {
    await send().sendMessage(ADMIN_PHONE, `❌ No encontré el servicio "${name}". Verificá con *ver servicios*.`);
    return;
  }
  setAdminStep('ADMIN_EDIT_SERVICE_FIELD', { serviceId: service.id, serviceName: service.name, service });
  await send().sendMessage(
    ADMIN_PHONE,
    `✏️ *Editando: ${service.name}*\n\n¿Qué querés cambiar?\n\n` +
    `\`1\` Precio — actual: $${Number(service.price).toLocaleString('es-AR')}\n` +
    `\`2\` Duración — actual: ${service.duration_minutes} min\n` +
    `\`3\` Nombre — actual: ${service.name}`
  );
}

async function handleEditServiceField(lower, stepData) {
  const fieldMap = {
    '1': 'price', 'precio': 'price',
    '2': 'duration_minutes', 'duracion': 'duration_minutes', 'duración': 'duration_minutes',
    '3': 'name', 'nombre': 'name',
  };
  const field = fieldMap[lower];
  if (!field) {
    await send().sendMessage(ADMIN_PHONE, '❌ Elegí 1 (precio), 2 (duración) o 3 (nombre).');
    return;
  }
  const labels = { price: 'precio ($)', duration_minutes: 'duración (minutos)', name: 'nombre' };
  setAdminStep('ADMIN_EDIT_SERVICE_VALUE', { ...stepData, field });
  await send().sendMessage(ADMIN_PHONE, `Nuevo ${labels[field]}:`);
}

async function handleEditServiceValue(body, stepData) {
  const { serviceId, serviceName, field } = stepData;
  let value;

  if (field === 'price') {
    value = parseFloat(body.replace(/[.$\s,]/g, '').trim());
    if (isNaN(value) || value <= 0) {
      await send().sendMessage(ADMIN_PHONE, '❌ Monto inválido. Ej: 3500');
      return;
    }
  } else if (field === 'duration_minutes') {
    value = parseInt(body.trim(), 10);
    if (isNaN(value) || value < 5) {
      await send().sendMessage(ADMIN_PHONE, '❌ Duración inválida. Ej: 45');
      return;
    }
  } else {
    value = body.trim();
    if (!value.length) {
      await send().sendMessage(ADMIN_PHONE, '❌ El nombre no puede estar vacío.');
      return;
    }
  }

  updateService(serviceId, { [field]: value });
  resetAdminState();
  await send().sendMessage(ADMIN_PHONE, `✅ *${serviceName}* actualizado correctamente.`);
}

// ── Flujo: eliminar servicio ──────────────────────────────────────────────────

async function startEliminarServicio(name) {
  const service = findServiceByName(name);
  if (!service) {
    await send().sendMessage(ADMIN_PHONE, `❌ No encontré el servicio "${name}". Verificá con *ver servicios*.`);
    return;
  }
  setAdminStep('ADMIN_DELETE_SERVICE_CONFIRM', { serviceId: service.id, serviceName: service.name });
  await send().sendMessage(
    ADMIN_PHONE,
    `¿Eliminás *${service.name}* (${service.duration_minutes} min — $${Number(service.price).toLocaleString('es-AR')})?\n\nRespondé *SI* para confirmar.`
  );
}

async function handleDeleteServiceConfirm(lower, stepData) {
  if (lower === 'si' || lower === 'sí') {
    deactivateService(stepData.serviceId);
    resetAdminState();
    await send().sendMessage(ADMIN_PHONE, `✅ Servicio *${stepData.serviceName}* desactivado.`);
    return;
  }
  resetAdminState();
  await send().sendMessage(ADMIN_PHONE, '👌 Eliminación cancelada.');
}

// ── Historial de cliente ──────────────────────────────────────────────────────

async function cmdVerCliente(phone) {
  const history  = getClientHistory(phone);
  const stats    = getClientStats(phone);
  const favorite = getClientFavoriteService(phone);
  const futuro   = getAppointmentsByPhone(phone);
  const nombre   = history[0]?.client_name || futuro[0]?.client_name || null;

  if (!history.length && !futuro.length) {
    await send().sendMessage(ADMIN_PHONE, `❌ No encontré ningún turno registrado para ${formatContact(phone)}.`);
    return;
  }

  await send().sendMessage(
    ADMIN_PHONE,
    MESSAGES.ADMIN_CLIENT_CARD(phone, nombre, stats, favorite, history, futuro),
  );
}

async function cmdVerClienteNombre(nombre) {
  const clientes = searchClientsByName(nombre);

  if (!clientes.length) {
    await send().sendMessage(ADMIN_PHONE, `❌ No encontré clientes con el nombre "${nombre}".`);
    return;
  }

  if (clientes.length === 1) return cmdVerCliente(clientes[0].phone_number);

  const lines = clientes.map((c, i) => {
    const d  = new Date(`${c.ultima_visita}T12:00:00`);
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    return `${i + 1}. ${c.client_name || 'Sin nombre'} (${formatContact(c.phone_number)}) — ${c.total_turnos} visitas — última: ${dd}/${mm}/${d.getFullYear()}`;
  });

  setAdminStep('ADMIN_CLIENT_SELECT', { clientes });
  await send().sendMessageWithList(
    ADMIN_PHONE,
    `Encontré ${clientes.length} clientes con ese nombre. ¿Cuál querés ver?`,
    lines,
  );
}

// ── Conectar Google Calendar ──────────────────────────────────────────────────

async function cmdConectarCalendar() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    await send().sendMessage(ADMIN_PHONE,
      `❌ *Google Calendar no configurado.*\n\n` +
      `No se encontraron las credenciales. Reinstalá el bot y completá los campos de Google Calendar en el formulario de configuración.`
    );
    return;
  }
  await send().sendMessage(ADMIN_PHONE,
    `🔗 *Conectar Google Calendar*\n\n` +
    `Abrí este link en el navegador de la PC donde corre el bot:\n\n` +
    `http://localhost:3000/auth/google\n\n` +
    `Iniciá sesión con tu cuenta de Google y autorizá el acceso. ` +
    `Una vez hecho, los turnos se sincronizarán automáticamente.`
  );
}

// ── Resumen diario ────────────────────────────────────────────────────────────

async function cmdResumenDiario(toggle) {
  const enabled = ['on', 'activar'].includes(toggle);
  setSetting('daily_summary_enabled', enabled ? '1' : '0');
  await send().sendMessage(
    ADMIN_PHONE,
    enabled
      ? '✅ Resumen diario activado. Lo recibirás cada día laboral a las 8:00 AM.'
      : '🔕 Resumen diario desactivado.',
  );
}

// ── Función principal ─────────────────────────────────────────────────────────

async function handleAdminMessage(phone, body, msg, contactName) {
  const lower              = body.toLowerCase().trim();
  const { step, stepData } = getAdminState();

  // "cancelar" sale de cualquier flujo activo
  if (lower === 'cancelar' && step !== 'ADMIN_IDLE') {
    resetAdminState();
    await send().sendMessage(ADMIN_PHONE, '👌 Flujo cancelado. Escribí *ayuda* para ver los comandos.');
    return;
  }

  // Continuar flujo activo
  if (step !== 'ADMIN_IDLE') {
    switch (step) {
      case 'ADMIN_CANCEL_SELECT':          return handleCancelSelect(lower, stepData);
      case 'ADMIN_CANCEL_CONFIRM':         return handleCancelConfirm(lower, stepData);
      case 'ADMIN_EDIT_TURN_SELECT':       return handleEditTurnSelect(lower, stepData);
      case 'ADMIN_EDIT_TURN_FIELD':        return handleEditTurnField(lower, stepData);
      case 'ADMIN_EDIT_TURN_NOTIFY':       return handleEditTurnNotify(lower, stepData);
      case 'ADMIN_PAUSE_SELECT':              return handlePauseSelect(lower, stepData);
      case 'ADMIN_ACTIVATE_SELECT':           return handleActivateSelect(lower, stepData);
      case 'ADMIN_ACTIVATE_NOTIFY':           return handleActivateNotify(lower, stepData);
      case 'ADMIN_ADD_TURN_CLIENT':           return handleAddTurnClient(body, stepData);
      case 'ADMIN_ADD_TURN_CLIENT_CONFIRM':   return handleAddTurnClientConfirm(lower, stepData);
      case 'ADMIN_ADD_TURN_CLIENT_SELECT':    return handleAddTurnClientSelect(lower, stepData);
      case 'ADMIN_ADD_TURN_NEW_CLIENT_PHONE': return handleAddTurnNewClientPhone(body, stepData);
      case 'ADMIN_ADD_TURN_CATEGORY':      return handleAddTurnCategory(lower, stepData);
      case 'ADMIN_ADD_TURN_SERVICE':       return handleAddTurnService(lower, stepData);
      case 'ADMIN_ADD_TURN_MORE':          return handleAddTurnMore(lower, stepData);
      case 'ADMIN_ADD_TURN_MODE':          return handleAddTurnMode(lower, stepData);
      case 'ADMIN_ADD_TURN_OOH_DATE':      return handleAddTurnOohDate(body, stepData);
      case 'ADMIN_ADD_TURN_OOH_TIME':      return handleAddTurnOohTime(body, stepData);
      case 'ADMIN_ADD_TURN_DATE':          return handleAddTurnDate(lower, stepData);
      case 'ADMIN_ADD_TURN_TIME':          return handleAddTurnTime(lower, stepData);
      case 'ADMIN_ADD_TURN_CONFIRM':       return handleAddTurnConfirm(lower, stepData);
      case 'ADMIN_ADD_SERVICE_NAME':       return handleAddServiceName(body);
      case 'ADMIN_ADD_SERVICE_DURATION':   return handleAddServiceDuration(body, stepData);
      case 'ADMIN_ADD_SERVICE_PRICE':      return handleAddServicePrice(body, stepData);
      case 'ADMIN_EDIT_SERVICE_FIELD':     return handleEditServiceField(lower, stepData);
      case 'ADMIN_EDIT_SERVICE_VALUE':     return handleEditServiceValue(body, stepData);
      case 'ADMIN_DELETE_SERVICE_CONFIRM': return handleDeleteServiceConfirm(lower, stepData);
      case 'ADMIN_CLIENT_SELECT': {
        const clientes = stepData.clientes || [];
        const idx      = parseInt(lower.trim(), 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= clientes.length) {
          await send().sendMessage(ADMIN_PHONE, '❌ Número inválido. Elegí un número de la lista.');
          return;
        }
        resetAdminState();
        return cmdVerCliente(clientes[idx].phone_number);
      }
      default:
        resetAdminState();
    }
  }

  // ── Parsear comandos (sin flujo activo) ────────────────────────────────────

  if (lower === 'ver turnos' || lower === 'turnos')
    return cmdVerTurnos();

  const mVerFecha = lower.match(/^ver turnos (\d{2}\/\d{2})$/);
  if (mVerFecha) return cmdVerTurnos(ddmmToISO(mVerFecha[1]));

  const mCancelar = lower.match(/^cancelar turno (.+)$/);
  if (mCancelar) return startCancelarTurno(mCancelar[1].trim());

  const mModificar = lower.match(/^modificar turno (.+)$/);
  if (mModificar) return startModificarTurno(mModificar[1].trim());

  if (lower === 'modificar turno')
    return send().sendMessage(ADMIN_PHONE, '✏️ Indicá el cliente: *modificar turno [nombre o número]*');

  if (lower === 'agregar turno') return startAgregarTurno();

  if (lower === 'ver horarios' || lower === 'horarios') return cmdVerHorarios();

  const mBloquearDia = lower.match(/^bloquear (\d{2}\/\d{2})$/);
  if (mBloquearDia) return cmdBloquearDia(mBloquearDia[1]);

  const mBloquearRango = lower.match(/^bloquear (\d{2}\/\d{2}) (\d{2}:\d{2})-(\d{2}:\d{2})$/);
  if (mBloquearRango) return cmdBloquearRango(mBloquearRango[1], mBloquearRango[2], mBloquearRango[3]);

  const mDesbloquear = lower.match(/^desbloquear (\d{2}\/\d{2})$/);
  if (mDesbloquear) return cmdDesbloquear(mDesbloquear[1]);

  const mHorario = lower.match(/^horario laboral (\S+) (\d{2}:\d{2})-(\d{2}:\d{2})$/);
  if (mHorario) return cmdSetHorario(mHorario[1], mHorario[2], mHorario[3]);

  const mQuitarHorario = lower.match(/^quitar horario (\S+)$/);
  if (mQuitarHorario) return cmdQuitarHorario(mQuitarHorario[1]);

  if (lower === 'ver servicios' || lower === 'servicios') return cmdVerServicios();
  if (lower === 'agregar servicio')                       return startAgregarServicio();

  const mEditar = lower.match(/^editar servicio (.+)$/);
  if (mEditar) return startEditarServicio(mEditar[1].trim());

  const mEliminar = lower.match(/^eliminar servicio (.+)$/);
  if (mEliminar) return startEliminarServicio(mEliminar[1].trim());

  if (lower === 'ver pausados' || lower === 'pausados') return cmdVerPausados();

  const mActivar = lower.match(/^activar (.+)$/);
  if (mActivar) return cmdActivarCliente(mActivar[1].trim());

  const mPausar = lower.match(/^pausar (.+)$/);
  if (mPausar) return cmdPausarCliente(mPausar[1].trim());

  if (lower === 'ver comprobantes' || lower === 'comprobantes') return cmdVerComprobantes();

  const mRevisar = lower.match(/^revisar (\d+)$/);
  if (mRevisar) return cmdRevisarComprobante(parseInt(mRevisar[1]));

  const mResumen = lower.match(/^resumen diario (on|off|activar|desactivar)$/);
  if (mResumen) return cmdResumenDiario(mResumen[1]);

  if (lower === 'conectar calendar' || lower === 'conectar calendario')
    return cmdConectarCalendar();

  const mVerCliente = lower.match(/^ver cliente (.+)$/);
  if (mVerCliente) {
    const arg = mVerCliente[1].trim();
    // Si el argumento parece un número (aunque venga formateado con +, espacios
    // o guiones como en las notificaciones), se normaliza a solo dígitos.
    if (looksLikePhone(arg)) return cmdVerCliente(cleanPhone(arg));
    return cmdVerClienteNombre(arg);
  }

  // Default: mostrar ayuda
  await send().sendMessage(ADMIN_PHONE, HELP_TEXT);
}

module.exports = { handleAdminMessage };
