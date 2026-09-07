# Instrucciones: ver, cancelar y modificar turnos (cliente)

Antes de tocar cualquier archivo, leé completos:
- src/handlers/clientHandler.js
- src/config/messages.js
- src/db/queries.js

No modificar el flujo de agendamiento existente. Solo agregar lo que se describe acá.

---

## CAMBIO 1 — src/config/messages.js

Agregar al objeto MESSAGES (sin tocar los mensajes existentes):

```js
MY_TURNS_HEADER: '📋 *Tus turnos:*',

MY_TURNS_LINE: (i, dateLabel, time, service, seña) =>
  `\`${i}\` ${dateLabel} a las *${time}* — ${service} ${seña ? '✅' : '⏳'}`,

MY_TURNS_FOOTER: '\n_✅ seña confirmada · ⏳ seña pendiente_\n\nEscribí *cancelar turno [número]* o *modificar turno [número]*',

CLIENT_CANCEL_CONFIRM: (dateLabel, time, service) =>
  `¿Seguro que querés cancelar este turno?\n\n📅 ${dateLabel} a las *${time}*\n💇 ${service}\n\nRespondé *SI* para confirmar o *NO* para volver.`,

CLIENT_CANCEL_OK: (dateLabel, time) =>
  `✅ Tu turno del *${dateLabel}* a las *${time}* fue cancelado. Escribí *hola* si querés agendar uno nuevo.`,

CLIENT_CANCEL_ABORT: '👌 Cancelación abortada. Tu turno sigue vigente.',

CLIENT_MOD_ASK_FIELD: (dateLabel, time) =>
  `¿Qué querés cambiar del turno del *${dateLabel}* a las *${time}*?\n\n\`1\` Cambiar fecha\n\`2\` Cambiar horario\n\`3\` Cancelar (volver)`,

CLIENT_MOD_CONFIRM: ({ service, duration, price, dateLabel, time }) =>
  `📋 *Nuevo horario del turno*\n\n` +
  `💅 Servicio: ${service} (${duration} min)\n` +
  `📅 Fecha: ${dateLabel}\n` +
  `🕐 Hora: ${time}\n` +
  `💰 Precio: $${Number(price).toLocaleString('es-AR')}\n\n` +
  `¿Confirmás el cambio? Respondé *SI* o *NO*`,

CLIENT_MOD_OK: (dateLabel, time) =>
  `✅ ¡Turno reprogramado! Te esperamos el *${dateLabel}* a las *${time}*. Escribí *hola* si necesitás algo más.`,

CLIENT_MOD_ABORT: '👌 El turno quedó sin cambios.',
```

---

## CAMBIO 2 — src/handlers/clientHandler.js

### A. Agregar al destructuring de require('../db/queries'):
`getAppointmentsByPhone`, `updateAppointment`

### B. Definir la constante GESTION_STATES cerca de RESET_KEYWORDS:

```js
const GESTION_STATES = [
  'CLIENT_CANCEL_SELECT', 'CLIENT_CANCEL_CONFIRM',
  'CLIENT_MOD_SELECT', 'CLIENT_MOD_FIELD',
  'CLIENT_MOD_DATE', 'CLIENT_MOD_TIME', 'CLIENT_MOD_CONFIRM',
];
```

### C. En handleClientMessage(), modificar el bloque de RESET_KEYWORDS:

Reemplazar la condición actual:
```js
if (step !== 'WAITING_RECEIPT' && RESET_KEYWORDS.includes(lower))
```
Por:
```js
if (step !== 'WAITING_RECEIPT' && !GESTION_STATES.includes(step) && RESET_KEYWORDS.includes(lower))
```

### D. En handleClientMessage(), agregar detección de nuevos comandos:

Pegar DESPUÉS del bloque de RESET_KEYWORDS y ANTES del switch():

```js
if (!GESTION_STATES.includes(step)) {
  const MIS_TURNOS  = ['mis turnos', 'mi turno', 'ver turno', 'ver mis turnos'];
  const mCancelar   = lower.match(/^cancelar(?: mi)? turno(?: (\d+))?$/);
  const mModificar  = lower.match(/^(?:modificar|cambiar|reprogramar)(?: mi)? turno(?: (\d+))?$/);

  if (MIS_TURNOS.some(k => lower.includes(k)))
    return handleMisTurnos(phone);
  if (mCancelar)
    return startClientCancel(phone, mCancelar[1] ? parseInt(mCancelar[1]) : null);
  if (mModificar)
    return startClientModify(phone, mModificar[1] ? parseInt(mModificar[1]) : null);
}
```

### E. Agregar los nuevos casos al switch de handleClientMessage(), ANTES del default:

```js
case 'CLIENT_CANCEL_SELECT':  return handleClientCancelSelect(phone, lower, stepData);
case 'CLIENT_CANCEL_CONFIRM': return handleClientCancelConfirm(phone, lower, stepData);
case 'CLIENT_MOD_SELECT':     return handleClientModifySelect(phone, lower, stepData);
case 'CLIENT_MOD_FIELD':      return handleClientModifyField(phone, lower, stepData);
case 'CLIENT_MOD_DATE':       return handleClientModifyDate(phone, lower, stepData);
case 'CLIENT_MOD_TIME':       return handleClientModifyTime(phone, lower, stepData);
case 'CLIENT_MOD_CONFIRM':    return handleClientModifyConfirm(phone, lower, stepData);
```

### F. Agregar las nuevas funciones al final del archivo, antes de module.exports:

```js
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
    `${MESSAGES.MY_TURNS_HEADER}\n\n${lines.join('\n')}${MESSAGES.MY_TURNS_FOOTER}`
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
  const apts = stepData.appointments || [];
  const idx  = parseChoice(lower, apts.length);
  if (idx === null) {
    await send().sendMessageWithList(phone, `${MESSAGES.INVALID_OPTION}¿Cuál turno querés cancelar?`, apts.map((a, i) => formatClientTurnLine(i + 1, a)));
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
      `💇 ${stepData.service}\n📞 ${phone}`
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
  const apts = stepData.appointments || [];
  const idx  = parseChoice(lower, apts.length);
  if (idx === null) {
    await send().sendMessageWithList(phone, `${MESSAGES.INVALID_OPTION}¿Cuál turno querés modificar?`, apts.map((a, i) => formatClientTurnLine(i + 1, a)));
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
      await send().sendMessage(phone, `😔 No hay otros horarios para el *${stepData.originalDateLabel}*. Podés cambiar la fecha escribiendo *modificar turno*.`);
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
    await send().sendMessageWithList(phone, `${MESSAGES.INVALID_OPTION}${MESSAGES.ASK_TIME(stepData.newDateLabel)}`, [...slots, '⬅️ Volver a elegir otro día']);
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
      `👤 ${stepData.clientName || phone}\n` +
      `📅 Antes: ${stepData.originalDateLabel} ${stepData.originalTime}\n` +
      `📅 Ahora: ${stepData.newDateLabel} ${stepData.newTime}\n` +
      `💇 ${stepData.serviceName}`
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
  await send().sendMessage(phone, MESSAGES.CLIENT_MOD_CONFIRM({
    service: stepData.serviceName, duration: stepData.serviceDuration,
    price: stepData.servicePrice, dateLabel: stepData.newDateLabel, time: stepData.newTime,
  }));
}
```

---

## CAMBIO 3 — src/db/queries.js

Agregar junto a las funciones de appointments y exportar en module.exports:

```js
function updateAppointment(id, { appointment_date, appointment_time }) {
  const db = getDb();
  db.prepare(`
    UPDATE appointments
    SET appointment_date = ?, appointment_time = ?, calendar_event_id = NULL
    WHERE id = ?
  `).run(appointment_date, appointment_time, id);
  db.close();
}
```

---

## Verificación final

Probar en orden:
1. Escribir "mis turnos" sin turnos activos → responde MESSAGES.NO_TURNS
2. Escribir "mis turnos" con turnos → muestra lista con formato correcto
3. "cancelar turno" → SI → turno eliminado de DB y Calendar, admin notificado
4. "cancelar turno" → NO → turno intacto
5. "modificar turno" → cambiar fecha → elegir nueva fecha → elegir hora → SI → evento viejo eliminado, nuevo creado en Calendar
6. Escribir "hola" en medio de un flujo de modificación → NO lo resetea
7. Flujo de agendamiento original → sigue funcionando exactamente igual
