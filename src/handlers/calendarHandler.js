'use strict';
require('dotenv').config();

const path                               = require('path');
const fs                                 = require('fs');
const { google }                         = require('googleapis');
const { logger }                         = require('../utils/logger');
const {
  getSetting, setSetting, getAvailableSlots,
  getFutureAppointmentsWithCalendarEvent, getAllFutureAppointments,
  deleteAppointment, createAppointment, setCalendarEventId,
} = require('../db/queries');

const CALENDAR_ID = () => process.env.GOOGLE_CALENDAR_ID || 'primary';
const TIMEZONE    = 'America/Argentina/Buenos_Aires';
const AR_OFFSET   = -180; // UTC-3 en minutos, fijo (sin DST)

// ── Persistencia del refresh token (fuera de la DB) ───────────────────────────
// El token se guarda en un archivo dentro de USER_DATA_PATH para que sobreviva
// a un reseteo o pérdida de bot.db (ej.: al actualizar la app). Se mantiene una
// copia en la DB por compatibilidad (health check), pero la fuente de verdad es
// el archivo.

function getTokenPath() {
  const base = process.env.USER_DATA_PATH || path.join(__dirname, '../../data');
  return path.join(base, 'google_token.json');
}

function readRefreshToken() {
  // 1) Archivo (sobrevive a la pérdida de la DB)
  try {
    const p = getTokenPath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (data && data.refresh_token) return data.refresh_token;
    }
  } catch (e) {
    logger.warn(`No se pudo leer el token de Google del archivo: ${e.message}`);
  }
  // 2) Fallback a la DB (instalaciones previas / migración)
  return getSetting('google_refresh_token') || null;
}

function writeRefreshToken(token) {
  if (!token) return;
  try {
    fs.writeFileSync(getTokenPath(), JSON.stringify({ refresh_token: token }, null, 2));
  } catch (e) {
    logger.error(`No se pudo guardar el token de Google en archivo: ${e.message}`);
  }
  try { setSetting('google_refresh_token', token); } catch (_) {} // copia en DB (health check)
}

// Copia el token de la DB al archivo si todavía no existe el archivo. Se llama
// al arrancar para asegurar que el token quede a salvo antes de un futuro reseteo.
function ensureTokenPersisted() {
  try {
    const p = getTokenPath();
    if (fs.existsSync(p)) return;
    const dbToken = getSetting('google_refresh_token');
    if (dbToken) {
      fs.writeFileSync(p, JSON.stringify({ refresh_token: dbToken }, null, 2));
      logger.info('Token de Google Calendar migrado a archivo (a salvo de reseteos de la DB).');
    }
  } catch (e) {
    logger.warn(`No se pudo migrar el token de Google a archivo: ${e.message}`);
  }
}

// true si hay token de Google disponible (archivo o DB)
function hasGoogleToken() {
  return !!readRefreshToken();
}

// ── OAuth2 ────────────────────────────────────────────────────────────────────

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback',
  );
}

// Devuelve el cliente OAuth con refresh token cargado, o null si no hay token
function getAuthClient() {
  const token = readRefreshToken();
  if (!token) return null;
  const auth = createOAuthClient();
  auth.setCredentials({ refresh_token: token });
  return auth;
}

function getCalendarApi(auth) {
  return google.calendar({ version: 'v3', auth });
}

// ── Rutas OAuth (Express) ─────────────────────────────────────────────────────

function registerAuthRoutes(app) {
  // Paso 1: redirigir al consentimiento de Google
  app.get('/auth/google', (_req, res) => {
    const url = createOAuthClient().generateAuthUrl({
      access_type: 'offline',
      prompt:      'consent', // fuerza recibir el refresh_token
      scope:       ['https://www.googleapis.com/auth/calendar'],
    });
    res.redirect(url);
  });

  // Paso 2: Google redirige acá con el code
  app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('Falta el parámetro <code> en la URL.');

    try {
      const auth       = createOAuthClient();
      const { tokens } = await auth.getToken(code);

      if (!tokens.refresh_token) {
        return res.status(400).send(
          'No se recibió refresh_token.<br>' +
          'Revocá el acceso en <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> ' +
          'y volvé a abrir <b>/auth/google</b>.',
        );
      }

      writeRefreshToken(tokens.refresh_token);
      logger.info('Google Calendar autorizado. Refresh token guardado en archivo (y copia en DB).');
      res.send('<h2>✅ Autorizado correctamente. Podés cerrar esta pestaña.</h2>');
    } catch (err) {
      logger.error(`Error en OAuth callback: ${err.message}`);
      res.status(500).send('Error al obtener el token. Revisá los logs del servidor.');
    }
  });
}

// ── Helpers internos ──────────────────────────────────────────────────────────

// "HH:MM" + minutos → "HH:MM"
function addMinutes(time, minutes) {
  const [h, m] = time.split(':').map(Number);
  const total  = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// Convierte una dateTime ISO de Calendar a minutos desde medianoche (hora Argentina)
// Google devuelve "2024-05-12T10:00:00-03:00" para eventos creados en AR timezone.
// Usamos UTC + offset fijo para no depender del timezone del servidor.
function calDateTimeToARMinutes(dateTimeStr) {
  const d      = new Date(dateTimeStr);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
  return ((utcMin + AR_OFFSET) + 1440) % 1440; // normalizar a rango 0-1439
}

// Filtra slots de DB contra eventos ya cargados (sin nueva llamada a la API)
function filterSlotsWithEvents(dbSlots, serviceDuration, events) {
  if (!events.length) return dbSlots;

  const blocked = events
    .filter(ev => ev.start?.dateTime && ev.end?.dateTime)
    .map(ev => ({
      start: calDateTimeToARMinutes(ev.start.dateTime),
      end:   calDateTimeToARMinutes(ev.end.dateTime),
    }));

  return dbSlots.filter(slot => {
    const [h, m]    = slot.split(':').map(Number);
    const slotStart = h * 60 + m;
    const slotEnd   = slotStart + serviceDuration;
    return !blocked.some(({ start, end }) => slotStart < end && slotEnd > start);
  });
}

// ── Funciones públicas del calendario ────────────────────────────────────────

// Crea un evento y retorna su id, o null si Calendar no está configurado
async function createEvent(appointment) {
  const auth = getAuthClient();
  if (!auth) {
    console.warn('⚠️  Calendar: sin refresh token. El evento no se creó en Calendar.');
    return null;
  }

  const cal     = getCalendarApi(auth);
  const endTime = addMinutes(appointment.appointment_time, appointment.service_duration);

  const event = {
    summary: `${appointment.client_name || appointment.phone_number} — ${appointment.service_name}`,
    description:
      `📞 Tel: ${appointment.phone_number}\n` +
      `💰 Precio: $${appointment.service_price}\n` +
      `⏱ Duración: ${appointment.service_duration} min`,
    start: {
      dateTime: `${appointment.appointment_date}T${appointment.appointment_time}:00`,
      timeZone: TIMEZONE,
    },
    end: {
      dateTime: `${appointment.appointment_date}T${endTime}:00`,
      timeZone: TIMEZONE,
    },
  };

  const response = await cal.events.insert({ calendarId: CALENDAR_ID(), resource: event });
  return response.data.id;
}

// Eventos de un día específico (YYYY-MM-DD)
async function getEventsByDate(date) {
  const auth = getAuthClient();
  if (!auth) return [];

  const cal      = getCalendarApi(auth);
  const response = await cal.events.list({
    calendarId:   CALENDAR_ID(),
    timeMin:      `${date}T00:00:00-03:00`,
    timeMax:      `${date}T23:59:59-03:00`,
    singleEvents: true,
    orderBy:      'startTime',
  });
  return response.data.items || [];
}

// Eventos en un rango de fechas — una sola llamada para optimizar findAvailableDays
async function getEventsInRange(startDate, endDate) {
  const auth = getAuthClient();
  if (!auth) return [];

  const cal      = getCalendarApi(auth);
  const response = await cal.events.list({
    calendarId:   CALENDAR_ID(),
    timeMin:      `${startDate}T00:00:00-03:00`,
    timeMax:      `${endDate}T23:59:59-03:00`,
    singleEvents: true,
    orderBy:      'startTime',
  });
  return response.data.items || [];
}

// Elimina un evento de Calendar
async function deleteEvent(calendarEventId) {
  const auth = getAuthClient();
  if (!auth) return;
  const cal = getCalendarApi(auth);
  await cal.events.delete({ calendarId: CALENDAR_ID(), eventId: calendarEventId });
}

// true si el slot está libre en Calendar (sin datos de DB)
async function checkAvailability(date, startTime, durationMinutes) {
  const events = await getEventsByDate(date);
  if (!events.length) return true;
  const filtered = filterSlotsWithEvents([startTime], durationMinutes, events);
  return filtered.length > 0;
}

// Versión mejorada de getAvailableSlots: cruza DB con Calendar
// Si Calendar no está configurado o falla, retorna los slots solo de DB
async function getAvailableSlotsFiltered(date, serviceDuration) {
  const dbSlots = getAvailableSlots(date, serviceDuration);
  if (!dbSlots.length) return [];

  const auth = getAuthClient();
  if (!auth) return dbSlots;

  let events;
  try {
    events = await getEventsByDate(date);
  } catch (err) {
    logger.warn(`Calendar no disponible para ${date}: ${err.message}`);
    return dbSlots;
  }

  return filterSlotsWithEvents(dbSlots, serviceDuration, events);
}

// ── Sincronización Calendar → DB ──────────────────────────────────────────────

// Revisa los turnos futuros con evento de Calendar. Si el evento fue borrado en
// Google Calendar, cancela el turno en la DB y notifica al admin y al cliente.
// Retorna la cantidad de turnos cancelados.
async function syncCalendarDeletions() {
  const auth = getAuthClient();
  if (!auth) return 0;
  const appointments = getFutureAppointmentsWithCalendarEvent();
  if (!appointments.length) return 0;

  const calApi = getCalendarApi(auth);
  const send   = () => require('./whatsappHandler');
  const adminPhone = process.env.ADMIN_PHONE;
  let cancelled = 0;

  for (const apt of appointments) {
    try {
      await calApi.events.get({ calendarId: CALENDAR_ID(), eventId: apt.calendar_event_id });
      // Evento existe: OK
    } catch (err) {
      const status = err?.response?.status || err?.code;
      const isGone = status === 404
        || String(err.message).includes('Resource has been deleted')
        || String(err.message).includes('Not Found');
      if (!isGone) continue; // Error de red u otro — no cancelar

      deleteAppointment(apt.id);
      cancelled++;
      logger.info(`Calendar sync: turno #${apt.id} cancelado por borrado en Calendar.`);

      if (adminPhone) {
        await send().sendMessage(
          adminPhone,
          `🗑️ *Turno cancelado automáticamente*\n\n` +
          `El evento fue eliminado desde Google Calendar.\n\n` +
          `*#${apt.id}* — ${apt.appointment_date} ${apt.appointment_time}\n` +
          `💇 ${apt.service_name}\n` +
          `👤 ${apt.client_name || apt.phone_number}`
        );
      }

      if (apt.phone_number && apt.phone_number !== 'manual') {
        try {
          await send().sendMessage(
            apt.phone_number,
            `😔 Tu turno del *${apt.appointment_date}* a las *${apt.appointment_time}* fue cancelado. ` +
            `Escribí *hola* si querés agendar de nuevo.`
          );
        } catch (_) {}
      }
    }
  }
  return cancelled;
}

// ── Verificación al iniciar ───────────────────────────────────────────────────

function checkCalendarConfig() {
  const hasCredentials = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET;

  if (!hasCredentials) {
    logger.warn('Google Calendar: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET no configurados. Los turnos se guardarán solo en la DB local.');
    return;
  }

  const hasToken = hasGoogleToken();
  if (!hasToken) {
    logger.warn(`Google Calendar: credenciales configuradas pero sin autorizar. Abrí http://localhost:${process.env.PORT || 3000}/auth/google para autorizar.`);
    return;
  }

  logger.info('Google Calendar: configurado y autorizado.');
}

// ── Restauración Calendar → DB ────────────────────────────────────────────────
// Reconstruye los turnos en la DB a partir de los eventos de Google Calendar.
// Pensado para recuperar la agenda cuando bot.db se perdió o reseteó (ej.: tras
// actualizar la app). Es idempotente: solo agrega los turnos que faltan.

// Convierte una dateTime ISO de Calendar a fecha y hora locales de Argentina.
function calDateTimeToARDateTime(dateTimeStr) {
  const d   = new Date(dateTimeStr);
  // Hora local AR = UTC + AR_OFFSET (offset negativo → resta 3 h).
  const ar  = new Date(d.getTime() + AR_OFFSET * 60000);
  const pad = n => String(n).padStart(2, '0');
  return {
    date: `${ar.getUTCFullYear()}-${pad(ar.getUTCMonth() + 1)}-${pad(ar.getUTCDate())}`,
    time: `${pad(ar.getUTCHours())}:${pad(ar.getUTCMinutes())}`,
  };
}

// Intenta convertir un evento de Calendar en un turno del bot.
// Devuelve null si el evento no parece haber sido creado por el bot.
function parseEventToAppointment(ev) {
  if (!ev || !ev.id || !ev.start || !ev.start.dateTime || !ev.end || !ev.end.dateTime) return null;

  const summary = (ev.summary || '').trim();
  const desc    = ev.description || '';

  // Firma de los eventos creados por el bot: descripción con "Tel:" o summary "X — Y".
  const hasSignature = /Tel:/i.test(desc) || summary.includes(' — ');
  if (!hasSignature) return null;

  const start = calDateTimeToARDateTime(ev.start.dateTime);
  const end   = calDateTimeToARDateTime(ev.end.dateTime);

  // Nombre y servicio desde el summary "Nombre — Servicio"
  let clientName = null;
  let serviceName = summary || 'Turno';
  const dashIdx = summary.indexOf(' — ');
  if (dashIdx !== -1) {
    clientName  = summary.slice(0, dashIdx).trim() || null;
    serviceName = summary.slice(dashIdx + 3).trim() || 'Turno';
  }

  // Teléfono, precio y duración desde la descripción
  const telMatch   = desc.match(/Tel:\s*([^\n]+)/i);
  const priceMatch = desc.match(/Precio:\s*\$?\s*([\d.]+)/i);
  const durMatch   = desc.match(/Duraci[oó]n:\s*(\d+)/i);

  let phone = telMatch ? telMatch[1].trim() : 'manual';
  if (!phone || phone.toLowerCase() === 'manual') phone = 'manual';
  // Si el nombre del summary coincide con el teléfono, no había nombre real
  if (clientName && phone !== 'manual' && clientName.replace(/\D/g, '') === phone.replace(/\D/g, '')) {
    clientName = null;
  }
  if (clientName && clientName.toLowerCase() === 'manual') clientName = null;

  // Duración: de la descripción, o calculada de start/end como respaldo
  let duration = durMatch ? parseInt(durMatch[1], 10) : null;
  if (!duration || isNaN(duration)) {
    const [sh, sm] = start.time.split(':').map(Number);
    const [eh, em] = end.time.split(':').map(Number);
    duration = (eh * 60 + em) - (sh * 60 + sm);
    if (duration <= 0) duration = 30;
  }

  const price = priceMatch ? parseFloat(priceMatch[1]) : 0;

  return {
    phone_number:     phone,
    client_name:      clientName,
    service_name:     serviceName,
    service_duration: duration,
    service_price:    isNaN(price) ? 0 : price,
    appointment_date: start.date,
    appointment_time: start.time,
  };
}

async function restoreAppointmentsFromCalendar(daysAhead = 60) {
  const auth = getAuthClient();
  if (!auth) {
    logger.info('Restauración Calendar→DB omitida: Google Calendar no está autorizado.');
    return 0;
  }

  const pad     = n => String(n).padStart(2, '0');
  const today   = new Date();
  const end     = new Date(today);
  end.setDate(today.getDate() + daysAhead);
  const toISO   = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  let events;
  try {
    events = await getEventsInRange(toISO(today), toISO(end));
  } catch (e) {
    logger.warn(`Restauración Calendar→DB: no se pudieron leer los eventos: ${e.message}`);
    return 0;
  }
  if (!events.length) {
    logger.info('Restauración Calendar→DB: no hay eventos futuros en Calendar.');
    return 0;
  }

  const existing  = getAllFutureAppointments();
  const byEventId = new Set(existing.map(a => a.calendar_event_id).filter(Boolean));
  const byKey     = new Set(existing.map(a => `${a.appointment_date}|${a.appointment_time}|${a.phone_number}`));

  let imported = 0;
  for (const ev of events) {
    if (byEventId.has(ev.id)) continue;            // ya está por id de evento
    const parsed = parseEventToAppointment(ev);
    if (!parsed) continue;                          // no es un turno del bot
    const key = `${parsed.appointment_date}|${parsed.appointment_time}|${parsed.phone_number}`;
    if (byKey.has(key)) continue;                   // mismo turno (fecha/hora/tel)

    const id = createAppointment(parsed);
    setCalendarEventId(id, ev.id);
    byEventId.add(ev.id);
    byKey.add(key);
    imported++;
  }

  if (imported) logger.info(`Restauración Calendar→DB: ${imported} turno(s) reimportado(s) desde Google Calendar.`);
  else          logger.info('Restauración Calendar→DB: la DB ya estaba al día, no hubo turnos para reimportar.');
  return imported;
}

module.exports = {
  registerAuthRoutes,
  createEvent,
  getEventsByDate,
  getEventsInRange,
  deleteEvent,
  checkAvailability,
  getAvailableSlotsFiltered,
  filterSlotsWithEvents,
  checkCalendarConfig,
  syncCalendarDeletions,
  restoreAppointmentsFromCalendar,
  ensureTokenPersisted,
  hasGoogleToken,
  parseEventToAppointment,
};
