const { getDb } = require('./initDB');

// ── Helpers internos ──────────────────────────────────────────────────────────

// Convierte "HH:MM" a minutos desde medianoche
function timeToMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

// Convierte minutos desde medianoche a "HH:MM"
function minutesToTime(minutes) {
  const h = Math.floor(minutes / 60).toString().padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

// ── CONVERSATIONS ─────────────────────────────────────────────────────────────

// Devuelve la conversación activa de un número, o null si no existe
function getConversation(phoneNumber) {
  const db = getDb();
  const row = db.prepare(
    `SELECT * FROM conversations WHERE phone_number = ?`
  ).get(phoneNumber);
  db.close();
  if (row?.step_data) row.step_data = JSON.parse(row.step_data);
  return row ?? null;
}

// Crea o actualiza el paso actual de la conversación
function upsertConversation(phoneNumber, currentStep, stepData = {}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO conversations (phone_number, current_step, step_data, updated_at)
    VALUES (@phone, @step, @data, datetime('now','localtime'))
    ON CONFLICT(phone_number) DO UPDATE SET
      current_step = @step,
      step_data    = @data,
      updated_at   = datetime('now','localtime')
  `).run({
    phone: phoneNumber,
    step:  currentStep,
    data:  JSON.stringify(stepData),
  });
  db.close();
}

// Activa o desactiva el bot para un número (admin puede silenciarlo)
function setBotActive(phoneNumber, active) {
  const db = getDb();
  db.prepare(`
    UPDATE conversations SET bot_active = ? WHERE phone_number = ?
  `).run(active ? 1 : 0, phoneNumber);
  db.close();
}

// Guarda el waId original (@c.us o @lid) de un número para poder responderle
// correctamente incluso tras reiniciar el bot. No toca bot_active ni el paso.
function rememberWaId(phoneNumber, waId) {
  if (!phoneNumber || !waId) return;
  const db = getDb();
  db.prepare(`
    INSERT INTO conversations (phone_number, wa_id, updated_at)
    VALUES (@phone, @waId, datetime('now','localtime'))
    ON CONFLICT(phone_number) DO UPDATE SET wa_id = @waId
  `).run({ phone: phoneNumber, waId });
  db.close();
}

// Devuelve el waId original guardado para un número, o null.
function getWaId(phoneNumber) {
  const db  = getDb();
  const row = db.prepare(`SELECT wa_id FROM conversations WHERE phone_number = ?`).get(phoneNumber);
  db.close();
  return row?.wa_id || null;
}

// Reinicia el estado de la conversación al inicio del flujo
function resetConversation(phoneNumber) {
  upsertConversation(phoneNumber, 'IDLE', {});
}

// ── APPOINTMENTS ──────────────────────────────────────────────────────────────

// Crea un nuevo turno y retorna el id generado
function createAppointment(data) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO appointments
      (phone_number, client_name, service_name, service_duration, service_price,
       appointment_date, appointment_time)
    VALUES
      (@phone_number, @client_name, @service_name, @service_duration, @service_price,
       @appointment_date, @appointment_time)
  `).run(data);
  db.close();
  return result.lastInsertRowid;
}

// Devuelve todos los turnos activos de un número (futuros, no cancelados)
function getAppointmentsByPhone(phoneNumber) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM appointments
    WHERE phone_number = ?
      AND appointment_date >= date('now','localtime')
    ORDER BY appointment_date, appointment_time
  `).all(phoneNumber);
  db.close();
  return rows;
}

// Devuelve los turnos de una fecha específica (para calcular disponibilidad).
// excludeId permite ignorar un turno (ej.: el que se está modificando).
function getAppointmentsByDate(date, excludeId = null) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT appointment_time, service_duration FROM appointments
     WHERE appointment_date = ? AND (? IS NULL OR id != ?)`
  ).all(date, excludeId, excludeId);
  db.close();
  return rows;
}

// Busca turnos futuros por nombre de cliente (insensible a mayúsculas, parcial)
function getAppointmentsByClientName(name) {
  const db   = getDb();
  const rows = db.prepare(`
    SELECT * FROM appointments
    WHERE LOWER(client_name) LIKE LOWER(?)
      AND appointment_date >= date('now','localtime')
    ORDER BY appointment_date, appointment_time
  `).all(`%${name}%`);
  db.close();
  return rows;
}

// Devuelve un turno por id
function getAppointmentById(id) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM appointments WHERE id = ?`).get(id);
  db.close();
  return row ?? null;
}

// Elimina un turno (cancelación)
function deleteAppointment(id) {
  const db = getDb();
  db.prepare(`DELETE FROM appointments WHERE id = ?`).run(id);
  db.close();
}

// Guarda el id del evento de Google Calendar en el turno (no toca seña_paid)
function setCalendarEventId(id, calendarEventId) {
  const db = getDb();
  db.prepare(`UPDATE appointments SET calendar_event_id = ? WHERE id = ?`).run(calendarEventId, id);
  db.close();
}

// Marca la seña como pagada (llamado por el admin al confirmar el pago)
function confirmAppointment(id) {
  const db = getDb();
  db.prepare(`UPDATE appointments SET seña_paid = 1 WHERE id = ?`).run(id);
  db.close();
}

// Devuelve turnos de mañana sin recordatorio enviado (para el cron de recordatorios)
function getAppointmentsTomorrow() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM appointments
    WHERE appointment_date = date('now','localtime','+1 day')
    ORDER BY appointment_time
  `).all();
  db.close();
  return rows;
}

// ── BLOCKED SLOTS ─────────────────────────────────────────────────────────────

// Bloquea un día completo o un rango horario
function blockSlot({ date, startTime = null, endTime = null, fullDay = false }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO blocked_slots (date, start_time, end_time, full_day)
    VALUES (?, ?, ?, ?)
  `).run(date, startTime, endTime, fullDay ? 1 : 0);
  db.close();
}

// Devuelve los bloqueos de una fecha
function getBlockedSlots(date) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM blocked_slots WHERE date = ?`
  ).all(date);
  db.close();
  return rows;
}

// ── SERVICES ──────────────────────────────────────────────────────────────────

// Devuelve los servicios activos
function getActiveServices() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM services WHERE active = 1 ORDER BY duration_minutes`
  ).all();
  db.close();
  return rows;
}

// Devuelve los servicios activos de una categoría en el orden definido
function getServicesByCategory(category) {
  const db   = getDb();
  const rows = db.prepare(
    `SELECT * FROM services WHERE active = 1 AND category = ? ORDER BY sort_order`
  ).all(category);
  db.close();
  return rows;
}

// Devuelve un servicio por id
function getServiceById(id) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM services WHERE id = ?`).get(id);
  db.close();
  return row ?? null;
}

// ── PENDING RECEIPTS ──────────────────────────────────────────────────────────

// Guarda un comprobante de pago recibido
function savePendingReceipt({ phoneNumber, imageUrl, appointmentId = null }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO pending_receipts (phone_number, image_url, appointment_id)
    VALUES (?, ?, ?)
  `).run(phoneNumber, imageUrl, appointmentId);
  db.close();
}

// Marca un comprobante como revisado
function markReceiptReviewed(id) {
  const db = getDb();
  db.prepare(`UPDATE pending_receipts SET reviewed = 1 WHERE id = ?`).run(id);
  db.close();
}

// Devuelve comprobantes pendientes de revisión
function getPendingReceipts() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM pending_receipts WHERE reviewed = 0 ORDER BY created_at`
  ).all();
  db.close();
  return rows;
}

// ── SETTINGS ─────────────────────────────────────────────────────────────────

// Lee un valor de configuración
function getSetting(key) {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  db.close();
  return row?.value ?? null;
}

// Guarda o actualiza un valor de configuración
function setSetting(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
  db.close();
}

// ── DISPONIBILIDAD ────────────────────────────────────────────────────────────

/**
 * Retorna los horarios disponibles para una fecha y duración de servicio dadas.
 *
 * Algoritmo:
 * 1. Verifica que el día esté dentro del horario laboral.
 * 2. Genera slots cada 30 minutos dentro del horario de apertura/cierre.
 * 3. Elimina slots ocupados por appointments existentes.
 * 4. Elimina slots bloqueados por blocked_slots (rangos o día completo).
 * 5. Elimina slots cuya ventana de tiempo se solapa con cualquiera de los anteriores.
 *
 * @param {string} date            - Fecha en formato YYYY-MM-DD
 * @param {number} serviceDuration - Duración del servicio en minutos
 * @returns {string[]}             - Array de horarios disponibles ["HH:MM", ...]
 */
function getAvailableSlots(date, serviceDuration, excludeAppointmentId = null) {
  const workingHoursRaw = getSetting('working_hours');
  if (!workingHoursRaw) return [];

  // Compatibilidad: formato viejo (objeto) → nuevo (array)
  const parsed    = JSON.parse(workingHoursRaw);
  const schedules = Array.isArray(parsed) ? parsed : [parsed];

  const dayOfWeek = new Date(`${date}T00:00:00`).getDay();

  // Buscar el bloque de horario que incluye este día
  const schedule = schedules.find(s => s.days.includes(dayOfWeek));
  if (!schedule) return [];

  const { open, close } = schedule;
  const openMin  = timeToMinutes(open);
  const closeMin = timeToMinutes(close);

  // Bloques ocupados: [{ start, end }] en minutos
  const occupied = [];

  // Turnos existentes (excluyendo el turno en edición, si corresponde)
  const appointments = getAppointmentsByDate(date, excludeAppointmentId);
  for (const apt of appointments) {
    const start = timeToMinutes(apt.appointment_time);
    occupied.push({ start, end: start + apt.service_duration });
  }

  // Slots bloqueados
  const blocked = getBlockedSlots(date);
  for (const b of blocked) {
    if (b.full_day) {
      occupied.push({ start: openMin, end: closeMin });
    } else {
      occupied.push({
        start: timeToMinutes(b.start_time),
        end:   timeToMinutes(b.end_time),
      });
    }
  }

  // Generar candidatos cada 30 minutos
  const slots = [];
  for (let t = openMin; t + serviceDuration <= closeMin; t += 30) {
    const slotEnd = t + serviceDuration;
    const overlaps = occupied.some(
      ({ start, end }) => t < end && slotEnd > start
    );
    if (!overlaps) slots.push(minutesToTime(t));
  }

  return slots;
}

// ── QUERIES ADICIONALES (admin) ───────────────────────────────────────────────

// Todos los campos de los turnos de un día (para la vista del admin)
function getAppointmentsByDateFull(date) {
  const db   = getDb();
  const rows = db.prepare(
    `SELECT * FROM appointments WHERE appointment_date = ? ORDER BY appointment_time`
  ).all(date);
  db.close();
  return rows;
}

// Elimina todos los bloqueos de una fecha (desbloquear día)
function removeBlockedSlots(date) {
  const db = getDb();
  db.prepare(`DELETE FROM blocked_slots WHERE date = ?`).run(date);
  db.close();
}

// Inserta un nuevo servicio y retorna su id
function insertService({ name, duration_minutes, price }) {
  const db     = getDb();
  const result = db.prepare(
    `INSERT INTO services (name, duration_minutes, price) VALUES (?, ?, ?)`
  ).run(name, duration_minutes, price);
  db.close();
  return result.lastInsertRowid;
}

// Actualiza uno o más campos de un servicio
function updateService(id, { name, duration_minutes, price }) {
  const db = getDb();
  if (name             !== undefined) db.prepare(`UPDATE services SET name             = ? WHERE id = ?`).run(name, id);
  if (duration_minutes !== undefined) db.prepare(`UPDATE services SET duration_minutes = ? WHERE id = ?`).run(duration_minutes, id);
  if (price            !== undefined) db.prepare(`UPDATE services SET price            = ? WHERE id = ?`).run(price, id);
  db.close();
}

// Desactiva un servicio sin eliminarlo
function deactivateService(id) {
  const db = getDb();
  db.prepare(`UPDATE services SET active = 0 WHERE id = ?`).run(id);
  db.close();
}

// Devuelve los turnos PASADOS de un número, del más reciente al más antiguo
function getClientHistory(phoneNumber) {
  const db   = getDb();
  const rows = db.prepare(`
    SELECT * FROM appointments
    WHERE phone_number = ?
      AND appointment_date < date('now','localtime')
    ORDER BY appointment_date DESC, appointment_time DESC
  `).all(phoneNumber);
  db.close();
  return rows;
}

// Devuelve estadísticas agregadas de un cliente (pasados + futuros)
function getClientStats(phoneNumber) {
  const db  = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*)                                          AS total_turnos,
      SUM(CASE WHEN appointment_date < date('now','localtime') THEN 1 ELSE 0 END) AS turnos_pasados,
      SUM(CASE WHEN appointment_date >= date('now','localtime') THEN 1 ELSE 0 END) AS turnos_futuros,
      SUM(CASE WHEN appointment_date < date('now','localtime') THEN service_price ELSE 0 END) AS total_gastado,
      MAX(CASE WHEN appointment_date < date('now','localtime') THEN appointment_date END) AS ultima_visita,
      MIN(appointment_date)                             AS primera_visita
    FROM appointments
    WHERE phone_number = ?
  `).get(phoneNumber);
  db.close();
  return row;
}

// Busca clientes (phone + nombre) por nombre, búsqueda parcial e insensible a mayúsculas
function searchClientsByName(name) {
  const db   = getDb();
  const rows = db.prepare(`
    SELECT
      phone_number,
      client_name,
      COUNT(*) AS total_turnos,
      MAX(appointment_date) AS ultima_visita
    FROM appointments
    WHERE LOWER(client_name) LIKE LOWER(?)
    GROUP BY phone_number
    ORDER BY ultima_visita DESC
  `).all(`%${name}%`);
  db.close();
  return rows;
}

// Devuelve el servicio más solicitado por un cliente (entre sus turnos pasados)
function getClientFavoriteService(phoneNumber) {
  const db  = getDb();
  const row = db.prepare(`
    SELECT service_name, COUNT(*) AS veces
    FROM appointments
    WHERE phone_number = ?
      AND appointment_date < date('now','localtime')
    GROUP BY service_name
    ORDER BY veces DESC
    LIMIT 1
  `).get(phoneNumber);
  db.close();
  return row ?? null;
}

// Actualiza fecha y hora de un turno y limpia el calendar_event_id.
// Opcionalmente actualiza también servicio, duración y precio (modificar turno).
function updateAppointment(id, { appointment_date, appointment_time, service_name, service_duration, service_price }) {
  const db = getDb();
  if (service_name !== undefined) {
    db.prepare(`
      UPDATE appointments
      SET appointment_date = ?, appointment_time = ?,
          service_name = ?, service_duration = ?, service_price = ?,
          calendar_event_id = NULL
      WHERE id = ?
    `).run(appointment_date, appointment_time, service_name, service_duration, service_price, id);
  } else {
    db.prepare(`
      UPDATE appointments
      SET appointment_date = ?, appointment_time = ?, calendar_event_id = NULL
      WHERE id = ?
    `).run(appointment_date, appointment_time, id);
  }
  db.close();
}

// Busca un servicio activo por nombre (insensible a mayúsculas)
function findServiceByName(name) {
  const db  = getDb();
  const row = db.prepare(
    `SELECT * FROM services WHERE LOWER(name) = LOWER(?) AND active = 1`
  ).get(name);
  db.close();
  return row ?? null;
}

// Conversaciones con bot pausado (para "ver pausados"), con nombre desde clients
function getPausedConversations() {
  const db   = getDb();
  const rows = db.prepare(`
    SELECT c.phone_number, c.updated_at, cl.name AS client_name
    FROM conversations c
    LEFT JOIN clients cl ON cl.phone = c.phone_number
    WHERE c.bot_active = 0
    ORDER BY c.updated_at DESC
  `).all();
  db.close();
  return rows;
}

// Comprobante por id
function getPendingReceiptById(id) {
  const db  = getDb();
  const row = db.prepare(`SELECT * FROM pending_receipts WHERE id = ?`).get(id);
  db.close();
  return row ?? null;
}

// ── CLIENTS ───────────────────────────────────────────────────────────────────

function upsertClient(phone, name) {
  if (!phone || phone === 'manual') return;
  const db = getDb();
  db.prepare(`
    INSERT INTO clients (phone, name) VALUES (?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      name = CASE WHEN excluded.name IS NOT NULL AND excluded.name != ''
                  THEN excluded.name ELSE clients.name END
  `).run(phone, name || null);
  db.close();
}

function getClientByPhone(phone) {
  const db  = getDb();
  const row = db.prepare(`SELECT * FROM clients WHERE phone = ?`).get(phone);
  db.close();
  return row ?? null;
}

function findClientsByName(name) {
  const db   = getDb();
  const rows = db.prepare(
    `SELECT * FROM clients WHERE LOWER(name) LIKE LOWER(?) ORDER BY name`
  ).all(`%${name}%`);
  db.close();
  return rows;
}

function findClientsByNameOrPhone(query) {
  const db = getDb();
  const byPhone = db.prepare(`SELECT * FROM clients WHERE phone = ?`).get(query);
  if (byPhone) { db.close(); return [byPhone]; }
  const byName = db.prepare(
    `SELECT * FROM clients WHERE LOWER(name) LIKE LOWER(?) ORDER BY name`
  ).all(`%${query}%`);
  db.close();
  return byName;
}

function getFutureAppointmentsWithCalendarEvent() {
  const db   = getDb();
  const rows = db.prepare(`
    SELECT * FROM appointments
    WHERE calendar_event_id IS NOT NULL AND calendar_event_id != ''
      AND appointment_date >= date('now','localtime')
    ORDER BY appointment_date, appointment_time
  `).all();
  db.close();
  return rows;
}

// Todos los turnos futuros (con o sin evento de Calendar). Sirve para
// deduplicar al reimportar desde Google Calendar tras una pérdida de la DB.
function getAllFutureAppointments() {
  const db   = getDb();
  const rows = db.prepare(`
    SELECT * FROM appointments
    WHERE appointment_date >= date('now','localtime')
    ORDER BY appointment_date, appointment_time
  `).all();
  db.close();
  return rows;
}

module.exports = {
  // Conversations
  getConversation,
  upsertConversation,
  setBotActive,
  rememberWaId,
  getWaId,
  resetConversation,
  // Appointments
  createAppointment,
  getAppointmentsByPhone,
  getAppointmentsByDate,
  getAppointmentsByClientName,
  getAppointmentById,
  deleteAppointment,
  updateAppointment,
  getClientHistory,
  getClientStats,
  getClientFavoriteService,
  searchClientsByName,
  setCalendarEventId,
  confirmAppointment,
  getAppointmentsTomorrow,
  // Appointments (admin)
  getAppointmentsByDateFull,
  // Blocked slots
  blockSlot,
  getBlockedSlots,
  removeBlockedSlots,
  // Services
  getActiveServices,
  getServicesByCategory,
  getServiceById,
  insertService,
  updateService,
  deactivateService,
  findServiceByName,
  // Pending receipts
  savePendingReceipt,
  markReceiptReviewed,
  getPendingReceipts,
  getPendingReceiptById,
  // Conversations (admin)
  getPausedConversations,
  // Clients
  upsertClient,
  getClientByPhone,
  findClientsByName,
  findClientsByNameOrPhone,
  getFutureAppointmentsWithCalendarEvent,
  getAllFutureAppointments,
  // Settings
  getSetting,
  setSetting,
  // Disponibilidad
  getAvailableSlots,
};
