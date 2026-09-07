# Prompt — Implementación: Modelo de Clientes + Calendar Sync

## CONTEXTO (pegar primero en sesión nueva de Claude Code)

Estamos trabajando en "Bot Nefertiti", un bot de WhatsApp para agendamiento de turnos de un salón de belleza. Stack: Node.js, SQLite (better-sqlite3), Electron (app de bandeja para Windows), whatsapp-web.js con Puppeteer, Google Calendar API.

Estructura relevante:
- index.js — entrada, cliente WhatsApp, Express health check
- tray-app.js / tray/ — app Electron (bandeja del sistema, ventana setup)
- src/db/initDB.js — creación de tablas SQLite
- src/db/queries.js — todas las queries
- src/db/seed.js — datos iniciales
- src/handlers/clientHandler.js — FSM del flujo del cliente
- src/handlers/adminHandler.js — comandos del admin por WhatsApp
- src/handlers/calendarHandler.js — integración Google Calendar OAuth2
- src/handlers/whatsappHandler.js — routing de mensajes entrantes
- src/utils/formatContact.js — helper formatContact(phone, name)

Rama activa: master (estable, versión 1.1.0).
Existe también rama feature/agente-ia que NO tocamos en esta sesión.

---

## IMPLEMENTACIÓN

Implementá los siguientes cambios en la rama master. Hacé todo en una sola sesión.

---

## FEATURE 1 — Tabla clients + modelo de clientes

### src/db/initDB.js

Dentro del db.exec() de initDB(), agregar la tabla clients:

```sql
CREATE TABLE IF NOT EXISTS clients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT UNIQUE NOT NULL,
  name       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
```

Después del bloque CREATE TABLE, agregar migración en try/catch:

```js
try {
  db.exec(`
    INSERT OR IGNORE INTO clients (phone, name)
    SELECT DISTINCT phone_number, client_name
    FROM appointments
    WHERE phone_number != 'manual' AND phone_number IS NOT NULL AND phone_number != ''
  `);
} catch (_) {}
```

---

### src/db/queries.js

Agregar estas funciones antes del module.exports:

```js
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
```

Reemplazar getPausedConversations() para incluir nombre desde clients:

```js
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
```

Agregar al module.exports: upsertClient, getClientByPhone, findClientsByName, findClientsByNameOrPhone, getFutureAppointmentsWithCalendarEvent.

---

### src/handlers/clientHandler.js

1. En el bloque require('../db/queries'), agregar: upsertClient, getClientByPhone

2. Modificar handleIdle(phone, contactName) — reemplazar el cálculo de knownClientName:

```js
const dbClient        = getClientByPhone(phone);
const knownClientName = dbClient?.name
  || (history.length > 0 ? (history[0]?.client_name || null) : null);
```

3. Modificar handleAskingName(phone, body, stepData) — después de validar el nombre y ANTES de llamar startSelectingCategory, agregar:

```js
upsertClient(phone, name);
```

---

### src/handlers/adminHandler.js

1. En el bloque require('../db/queries'), agregar: upsertClient, getClientByPhone, findClientsByName

2. Reemplazar cmdVerPausados():

```js
async function cmdVerPausados() {
  const paused = getPausedConversations();
  if (!paused.length) {
    await send().sendMessage(ADMIN_PHONE, '✅ No hay bots pausados actualmente.');
    return;
  }
  const lines = paused.map(c =>
    `• ${formatContact(c.phone_number, c.client_name)} — desde ${c.updated_at.split(' ')[0]}`
  );
  await send().sendMessage(
    ADMIN_PHONE,
    `🔇 *Bots pausados (${paused.length}):*\n\n${lines.join('\n')}\n\nUsá *activar [nombre o número]* para reactivar.`
  );
}
```

3. Reemplazar cmdPausarCliente(rawInput) para aceptar nombre O teléfono:

```js
async function cmdPausarCliente(rawInput) {
  if (looksLikePhone(rawInput)) {
    const phone = cleanPhone(rawInput);
    if (!phone || phone.length < 8) {
      await send().sendMessage(ADMIN_PHONE, '❌ Número inválido. Ejemplo: *pausar 1123456789*');
      return;
    }
    const client = getClientByPhone(phone);
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
      `✅ Bot pausado para ${formatContact(client.phone, client.name)}.\nPodás retomar con: *activar ${client.phone}*`
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
```

4. Reemplazar la lógica de "activar" (actualmente valida solo teléfonos) con una función que acepte nombre O teléfono:

Crear helper interno:
```js
async function _activarPhone(phone) {
  const client = getClientByPhone(phone);
  setBotActive(phone, true);
  upsertConversation(phone, 'IDLE', {});
  await send().sendMessage(
    phone,
    '¡Hola de nuevo! 😊 Ya podés escribirnos.\n\nEscribí *hola* para ver las opciones disponibles.'
  );
  await send().sendMessage(ADMIN_PHONE, `✅ Bot reactivado para ${formatContact(phone, client?.name)}.`);
}
```

Reemplazar cmdActivar(phone) por cmdActivarCliente(rawInput):
```js
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
```

En handleAdminMessage, reemplazar el bloque de activar (que valida solo teléfonos):
```js
const mActivar = lower.match(/^activar (.+)$/);
if (mActivar) return cmdActivarCliente(mActivar[1].trim());
```

5. Modificar el flujo "agregar turno" para buscar clientes existentes.

Renombrar el state ADMIN_ADD_TURN_NAME a ADMIN_ADD_TURN_CLIENT. Reemplazar handleAddTurnName por:

```js
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
    return handleAddTurnCategory('', stepData); // ← continúa al flujo normal
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
  const cats = CATEGORIES;
  await send().sendMessageWithList(ADMIN_PHONE, `Cliente: *${c.name}*\n\n¿Categoría de servicio?`, cats.map(c => c.label));
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
  const cats = CATEGORIES;
  await send().sendMessageWithList(
    ADMIN_PHONE,
    `Cliente: *${stepData.clientName}*\n\n¿Categoría de servicio?`,
    cats.map(c => c.label)
  );
}
```

En handleAddTurnConfirm, al crear el turno, usar stepData.clientPhone || 'manual' como phone_number:
```js
const appointmentId = createAppointment({
  phone_number:     stepData.clientPhone || 'manual',
  client_name:      stepData.clientName,
  // ... resto igual
});
```

En startAgregarTurno(), cambiar el primer estado a ADMIN_ADD_TURN_CLIENT y el mensaje a:
"¿Nombre o teléfono del cliente?"

6. Agregar los nuevos cases al switch del step !== 'ADMIN_IDLE':
```js
case 'ADMIN_PAUSE_SELECT':             return handlePauseSelect(lower, stepData);
case 'ADMIN_ACTIVATE_SELECT':          return handleActivateSelect(lower, stepData);
case 'ADMIN_ADD_TURN_CLIENT':          return handleAddTurnClient(body, stepData);
case 'ADMIN_ADD_TURN_CLIENT_CONFIRM':  return handleAddTurnClientConfirm(lower, stepData);
case 'ADMIN_ADD_TURN_CLIENT_SELECT':   return handleAddTurnClientSelect(lower, stepData);
case 'ADMIN_ADD_TURN_NEW_CLIENT_PHONE': return handleAddTurnNewClientPhone(body, stepData);
```

---

## FEATURE 2 — Calendar sync: detectar eventos borrados

### src/handlers/calendarHandler.js

1. En el require('../db/queries'), agregar: getFutureAppointmentsWithCalendarEvent, deleteAppointment

2. Agregar syncCalendarDeletions() antes del module.exports:

```js
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
```

3. Agregar syncCalendarDeletions al module.exports.

### src/handlers/clientHandler.js

Cerca de los otros crons (startDailySummary), agregar un cron que corra cada 2 horas:

```js
cron.schedule('0 */2 * * *', async () => {
  try {
    const count = await cal().syncCalendarDeletions();
    if (count > 0) logger.info(`Calendar sync: ${count} turno(s) cancelados por borrado.`);
  } catch (err) {
    logger.warn(`Error en calendar sync: ${err.message}`);
  }
});
```

---

## FEATURE 3 — Actualizar PENDIENTES.md

Al finalizar todos los cambios, en PENDIENTES.md marcar como implementadas:
- Sección "Modelo de clientes" → agregar `✅ Implementado` al título
- Sección "Identificación de clientes (UX admin)" → agregar `✅ Implementado` al título
- Sección "Sincronización Calendar → DB" → agregar `✅ Implementado` al título

---

## VERIFICACIÓN FINAL

1. node --check src/db/queries.js src/handlers/clientHandler.js src/handlers/adminHandler.js src/handlers/calendarHandler.js
2. node -e "require('./src/db/initDB').initDB()" — sin errores
3. Confirmar que module.exports de queries.js incluye todas las funciones nuevas
4. Commit: git add -A && git commit -m "feat: modelo de clientes, admin por nombre y calendar sync"
