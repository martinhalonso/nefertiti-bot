# Instrucciones: historial de cliente

Antes de tocar cualquier archivo, leé completos:
- src/db/initDB.js
- src/db/queries.js
- src/handlers/adminHandler.js
- src/handlers/clientHandler.js
- src/config/messages.js

No modificar nada del flujo de agendamiento, cancelación ni modificación existentes.

---

## CONTEXTO IMPORTANTE

La tabla `appointments` ya guarda todo lo necesario para el historial:
phone_number, client_name, service_name, service_duration, service_price,
appointment_date, appointment_time, seña_paid, created_at.

La función `getAppointmentsByPhone` existente solo devuelve turnos FUTUROS
(WHERE appointment_date >= hoy). Para el historial necesitamos los PASADOS.

No crear ninguna tabla nueva. Todo se resuelve con queries sobre appointments.

---

## CAMBIO 1 — src/db/queries.js

Agregar las siguientes funciones junto a las existentes de appointments
y exportarlas en module.exports:

```js
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

// Devuelve estadísticas agregadas de un cliente
// Incluye turnos pasados Y futuros para el total de visitas
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

// Busca clientes (phone + nombre) que hayan tenido al menos un turno pasado
// Búsqueda parcial e insensible a mayúsculas por nombre
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
```

---

## CAMBIO 2 — src/config/messages.js

Agregar al objeto MESSAGES (sin tocar los existentes):

```js
// ── Historial del cliente ────────────────────────────────────────────────────

CLIENT_HISTORY_HEADER: (nombre) =>
  `📖 *Historial de ${nombre || 'este cliente'}*`,

CLIENT_HISTORY_EMPTY:
  `No tenés visitas anteriores registradas. ¡Esperamos verte pronto! 😊`,

CLIENT_HISTORY_LINE: (apt) => {
  const d = new Date(`${apt.appointment_date}T12:00:00`);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `• ${dd}/${mm}/${yyyy} — ${apt.service_name} — $${Number(apt.service_price).toLocaleString('es-AR')}`;
},

CLIENT_HISTORY_STATS: (stats, favorite) => {
  const lines = [];
  if (stats.total_gastado)
    lines.push(`💰 Total gastado: $${Number(stats.total_gastado).toLocaleString('es-AR')}`);
  if (favorite?.service_name)
    lines.push(`💅 Servicio favorito: ${favorite.service_name} (${favorite.veces}x)`);
  if (stats.primera_visita) {
    const d  = new Date(`${stats.primera_visita}T12:00:00`);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    lines.push(`📅 Primera visita: ${dd}/${mm}/${d.getFullYear()}`);
  }
  return lines.join('\n');
},

// Saludo personalizado para clientes que vuelven
GREETING_RETURNING: (nombre, servicio) =>
  `¡Hola${nombre ? `, ${nombre.split(' ')[0]}` : ''}! ¡Qué bueno verte de nuevo! 😊` +
  (servicio ? `\nLa última vez te hiciste *${servicio}*. ¿Repetimos? 💅\n` : '\n') +
  `\n\`1\` Reservar turno\n\`2\` Esperar y hablar con Celi\n\`3\` Ver mi historial\n\nRespondé con el número de la opción.`,

// Admin: ficha completa de un cliente
ADMIN_CLIENT_CARD: (phone, nombre, stats, favorite, history, futuro) => {
  const lines = [
    `👤 *${nombre || 'Sin nombre'}*`,
    `📞 ${phone}`,
    ``,
  ];
  if (stats.turnos_pasados > 0) {
    lines.push(`📊 *Estadísticas*`);
    lines.push(`Visitas: ${stats.turnos_pasados}`);
    if (stats.total_gastado)
      lines.push(`Total gastado: $${Number(stats.total_gastado).toLocaleString('es-AR')}`);
    if (favorite?.service_name)
      lines.push(`Servicio favorito: ${favorite.service_name} (${favorite.veces}x)`);
    if (stats.ultima_visita) {
      const d  = new Date(`${stats.ultima_visita}T12:00:00`);
      lines.push(`Última visita: ${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`);
    }
    lines.push(``);
  }
  if (futuro?.length) {
    lines.push(`📅 *Próximo turno*`);
    lines.push(`${futuro[0].appointment_date} ${futuro[0].appointment_time} — ${futuro[0].service_name}`);
    lines.push(``);
  }
  if (history.length) {
    lines.push(`🗓️ *Últimas visitas*`);
    history.slice(0, 5).forEach(a => {
      const d  = new Date(`${a.appointment_date}T12:00:00`);
      const dd = String(d.getDate()).padStart(2,'0');
      const mm = String(d.getMonth()+1).padStart(2,'0');
      lines.push(`${dd}/${mm}/${d.getFullYear()} ${a.appointment_time} — ${a.service_name} — $${Number(a.service_price).toLocaleString('es-AR')}${a.seña_paid ? ' ✅' : ''}`);
    });
  } else {
    lines.push(`_Sin visitas anteriores registradas._`);
  }
  return lines.join('\n');
},
```

---

## CAMBIO 3 — src/handlers/adminHandler.js

### A. Agregar al destructuring de require('../db/queries'):
`getClientHistory`, `getClientStats`, `getClientFavoriteService`, `searchClientsByName`

### B. Agregar el comando `ver cliente` al bloque de parseo de comandos,
ANTES del comentario `// Default: mostrar ayuda`:

```js
// "ver cliente 5491155555555" → busca por número
const mVerClientePhone = lower.match(/^ver cliente (\d{7,15})$/);
if (mVerClientePhone) return cmdVerCliente(mVerClientePhone[1]);

// "ver cliente Juan Pérez" → busca por nombre
const mVerClienteNombre = lower.match(/^ver cliente (.+)$/);
if (mVerClienteNombre) return cmdVerClienteNombre(mVerClienteNombre[1].trim());
```

### C. Agregar en el texto HELP_TEXT, dentro de la sección *Bot*:
`• ver cliente [número o nombre]`

### D. Agregar las nuevas funciones del admin (antes de handleAdminMessage):

```js
async function cmdVerCliente(phone) {
  const history  = getClientHistory(phone);
  const stats    = getClientStats(phone);
  const favorite = getClientFavoriteService(phone);
  const futuro   = getAppointmentsByPhone(phone); // ya existe en queries

  // Obtener nombre del cliente de su último turno
  const nombre = history[0]?.client_name || futuro[0]?.client_name || null;

  if (!history.length && !futuro.length) {
    await send().sendMessage(ADMIN_PHONE, `❌ No encontré ningún turno registrado para el número ${phone}.`);
    return;
  }

  await send().sendMessage(
    ADMIN_PHONE,
    MESSAGES.ADMIN_CLIENT_CARD(phone, nombre, stats, favorite, history, futuro)
  );
}

async function cmdVerClienteNombre(nombre) {
  const clientes = searchClientsByName(nombre);

  if (!clientes.length) {
    await send().sendMessage(ADMIN_PHONE, `❌ No encontré clientes con el nombre "${nombre}".`);
    return;
  }

  // Si hay uno solo, mostrar su ficha directa
  if (clientes.length === 1) {
    return cmdVerCliente(clientes[0].phone_number);
  }

  // Si hay varios, mostrar lista para que el admin elija
  const lines = clientes.map((c, i) => {
    const d  = new Date(`${c.ultima_visita}T12:00:00`);
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    return `${i + 1}. ${c.client_name || 'Sin nombre'} (${c.phone_number}) — ${c.total_turnos} visitas — última: ${dd}/${mm}/${d.getFullYear()}`;
  });

  setAdminStep('ADMIN_CLIENT_SELECT', { clientes });
  await send().sendMessageWithList(
    ADMIN_PHONE,
    `Encontré ${clientes.length} clientes con ese nombre. ¿Cuál querés ver?`,
    lines
  );
}
```

### E. Agregar el nuevo estado al switch de flujos activos en handleAdminMessage():

```js
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
```

---

## CAMBIO 4 — src/handlers/clientHandler.js

### A. Agregar al destructuring de require('../db/queries'):
`getClientHistory`, `getClientStats`, `getClientFavoriteService`

### B. Modificar handleIdle() para reconocer clientes que vuelven:

Reemplazar la función handleIdle existente por esta versión:

```js
async function handleIdle(phone, contactName) {
  // Verificar si es un cliente con visitas anteriores
  const history = getClientHistory(phone);

  await transitionTo(phone, 'WAITING_OPTION', { contactName });

  if (history.length > 0) {
    // Cliente que vuelve: saludo personalizado
    // history[0] es el turno más reciente (ORDER BY date DESC)
    const nombre         = history[0]?.client_name || contactName || null;
    const ultimoServicio = history[0]?.service_name || null; // solo el nombre, sin precio ni duración
    await send().sendMessage(phone, MESSAGES.GREETING_RETURNING(nombre, ultimoServicio));
  } else {
    // Cliente nuevo: saludo normal existente
    const nameSuffix = contactName ? `, ${contactName.split(' ')[0]}` : '';
    await send().sendMessage(phone, MESSAGES.GREETING(nameSuffix));
  }
}
```

### C. En handleWaitingOption(), agregar detección de la opción 3 (historial),
ANTES de la validación de entrada inválida:

```js
const wantsHistory = ['3', 'historial', 'mis visitas', 'ver historial'].some(w => lower.includes(w));
if (wantsHistory) return handleClienteHistorial(phone);
```

### D. Agregar detección del comando "mi historial" en handleClientMessage(),
junto a los otros comandos de gestión (MIS_TURNOS, etc.):

```js
const HISTORIAL_KEYWORDS = ['mi historial', 'mis visitas', 'ver historial', 'historial'];
if (!GESTION_STATES.includes(step) && HISTORIAL_KEYWORDS.some(k => lower.includes(k)))
  return handleClienteHistorial(phone);
```

### E. Agregar la nueva función antes de module.exports:

```js
async function handleClienteHistorial(phone) {
  const history  = getClientHistory(phone);
  const stats    = getClientStats(phone);
  const favorite = getClientFavoriteService(phone);
  const nombre   = history[0]?.client_name || null;

  if (!history.length) {
    await send().sendMessage(phone, MESSAGES.CLIENT_HISTORY_EMPTY);
    return;
  }

  const lines = history.slice(0, 8).map(a => MESSAGES.CLIENT_HISTORY_LINE(a));
  const statsText = MESSAGES.CLIENT_HISTORY_STATS(stats, favorite);

  await send().sendMessage(
    phone,
    `${MESSAGES.CLIENT_HISTORY_HEADER(nombre)}\n\n` +
    `${lines.join('\n')}\n\n` +
    `${statsText}`
  );
}
```

---

## Verificación final

Probar en orden:

**Admin:**
1. `ver cliente [número con turnos]` → muestra ficha completa con estadísticas e historial
2. `ver cliente [número sin turnos]` → mensaje de no encontrado
3. `ver cliente [nombre exacto]` → ficha directa
4. `ver cliente [nombre parcial con varios resultados]` → lista numerada para elegir
5. `ayuda` → debe incluir `ver cliente [número o nombre]` en la sección Bot

**Cliente:**
1. Número con visitas anteriores escribe "hola" → saludo personalizado con servicio favorito y opción 3
2. Número nuevo escribe "hola" → saludo normal sin cambios
3. Escribir "mi historial" → lista de visitas pasadas con estadísticas
4. En saludo de cliente frecuente, elegir opción 3 → mismo resultado que "mi historial"
5. Flujo de agendamiento original → sigue funcionando exactamente igual
