# Instrucciones: mostrar "Mis turnos" en el menú solo si hay turnos activos

Leé este archivo completo antes de tocar nada.
Solo se modifican dos archivos. No se toca ningún otro flujo.

---

## CONTEXTO

El menú de bienvenida para clientes que vuelven siempre muestra las mismas
3 opciones sin importar si tienen turnos futuros o no. Se quiere que la opción
"Mis turnos" solo aparezca cuando el cliente tiene al menos un turno reservado.

### Comportamiento nuevo

**Cliente nuevo** (sin historial ni turnos futuros): sin cambios.
```
`1` Reservar turno
`2` Esperar y hablar con Celi
```

**Cliente que vuelve SIN turnos futuros**:
```
¡Hola Martín! ¡Qué bueno verte de nuevo! 😊
La última vez te hiciste *Manicura*. ¿Repetimos? 💅

`1` Reservar turno
`2` Esperar y hablar con Celi
`3` Ver mi historial
```

**Cliente que vuelve CON turnos futuros**:
```
¡Hola Martín! ¡Qué bueno verte de nuevo! 😊
La última vez te hiciste *Manicura*. ¿Repetimos? 💅

`1` Reservar turno
`2` Esperar y hablar con Celi
`3` Mis turnos
`4` Ver mi historial
```

---

## ARCHIVOS A MODIFICAR

1. `src/config/messages.js` — función `GREETING_RETURNING`
2. `src/handlers/clientHandler.js` — funciones `handleIdle` y `handleWaitingOption`

---

## CAMBIO 1 — src/config/messages.js

### Reemplazar `GREETING_RETURNING`

Buscar:
```js
  GREETING_RETURNING: (nombre, servicio) =>
    `¡Hola${nombre ? `, ${nombre.split(' ')[0]}` : ''}! ¡Qué bueno verte de nuevo! 😊` +
    (servicio ? `\nLa última vez te hiciste *${servicio}*. ¿Repetimos? 💅\n` : '\n') +
    `\n\`1\` Reservar turno\n\`2\` Esperar y hablar con Celi\n\`3\` Ver mi historial\n\nRespondá con el número de la opción.`,
```

Reemplazar por:
```js
  GREETING_RETURNING: (nombre, servicio, tieneTurno = false) =>
    `¡Hola${nombre ? `, ${nombre.split(' ')[0]}` : ''}! ¡Qué bueno verte de nuevo! 😊` +
    (servicio ? `\nLa última vez te hiciste *${servicio}*. ¿Repetimos? 💅\n` : '\n') +
    `\n\`1\` Reservar turno\n\`2\` Esperar y hablar con Celi\n` +
    (tieneTurno
      ? `\`3\` Mis turnos\n\`4\` Ver mi historial`
      : `\`3\` Ver mi historial`) +
    `\n\nRespondé con el número de la opción.`,
```

---

## CAMBIO 2 — src/handlers/clientHandler.js

### A. Reemplazar `handleIdle`

Buscar:
```js
async function handleIdle(phone, contactName) {
  const history = getClientHistory(phone);

  // Si el cliente tiene historial, rescatar su nombre para usarlo como fallback
  // en todo el flujo (por si ASKING_NAME falla o se salta)
  const knownClientName = history.length > 0
    ? (history[0]?.client_name || null)
    : null;

  await transitionTo(phone, 'WAITING_OPTION', { contactName, knownClientName });

  if (history.length > 0) {
    const nombre         = knownClientName || contactName || null;
    const ultimoServicio = history[0]?.service_name || null;
    await send().sendMessage(phone, MESSAGES.GREETING_RETURNING(nombre, ultimoServicio));
  } else {
    const nameSuffix = contactName ? `, ${contactName.split(' ')[0]}` : '';
    await send().sendMessage(phone, MESSAGES.GREETING(nameSuffix));
  }
}
```

Reemplazar por:
```js
async function handleIdle(phone, contactName) {
  const history = getClientHistory(phone);
  const futuros = getAppointmentsByPhone(phone);

  const knownClientName = history.length > 0
    ? (history[0]?.client_name || null)
    : null;

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
```

### B. Reemplazar `handleWaitingOption`

Buscar:
```js
async function handleWaitingOption(phone, lower, stepData) {
  const wantsSchedule = ['1', 'agendar', 'turno', 'sacar', 'reservar', 'quiero'].some(w => lower.includes(w));
  const wantsHuman    = ['2', 'esperar', 'hablar', 'persona', 'humano', 'alguien'].some(w => lower.includes(w));

  const wantsHistory  = ['3', 'historial', 'mis visitas', 'ver historial'].some(w => lower.includes(w));

  if (wantsSchedule) {
    await transitionTo(phone, 'ASKING_NAME', stepData);
    return send().sendMessage(phone, MESSAGES.ASK_NAME);
  }
  if (wantsHuman)   return pauseForHuman(phone, stepData);
  if (wantsHistory) return handleClienteHistorial(phone);

  // Entrada inválida: repetir greeting
  const nameSuffix = stepData.contactName ? `, ${stepData.contactName.split(' ')[0]}` : '';
  await send().sendMessage(
    phone,
    MESSAGES.INVALID_OPTION + MESSAGES.GREETING(nameSuffix),
  );
}
```

Reemplazar por:
```js
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

  // Entrada inválida: repetir el saludo correcto según el contexto
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
```

---

## VERIFICACIÓN

1. **Cliente que vuelve con turno futuro** — escribir "hola":
   - El menú debe mostrar 4 opciones: Reservar, Celi, Mis turnos, Historial.
   - Responder `3` → debe mostrar los turnos activos.
   - Responder `4` → debe mostrar el historial.

2. **Cliente que vuelve sin turno futuro** — escribir "hola":
   - El menú debe mostrar 3 opciones: Reservar, Celi, Historial.
   - Responder `3` → debe mostrar el historial.
   - Responder `3` NO debe intentar mostrar "mis turnos".

3. **Cliente nuevo** — escribir "hola":
   - Menú normal de 2 opciones, sin cambios.

4. **Flujo de agendamiento** — completar un turno y volver a escribir "hola":
   - Ahora debe aparecer la opción "Mis turnos" que antes no estaba.

5. **Los comandos de texto libre** (`mis turnos`, `cancelar turno`, `modificar turno`)
   siguen funcionando igual desde cualquier estado, sin cambios.
