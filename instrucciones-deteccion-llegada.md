# Instrucciones: detección de llegada al local

Leé este archivo completo antes de tocar nada.
Se modifica un solo archivo. No se toca ningún otro flujo.

---

## CONTEXTO

Cuando un cliente manda un mensaje avisando que llegó al local (ej: "estoy abajo"),
el bot lo intercepta e inicia el flujo de bienvenida, lo cual es molesto.

La solución combina dos mecanismos:

1. **Ventana de tiempo**: si el cliente tiene un turno hoy y el mensaje llega
   entre 30 minutos antes y 30 minutos después del horario del turno,
   el bot reenvía el mensaje al admin y no responde al cliente.

2. **Frases de llegada**: independientemente de si hay turno o ventana de tiempo,
   si el mensaje coincide con una frase de llegada conocida, el bot hace lo mismo.

En ambos casos el bot no responde al cliente y no cambia el estado de la conversación.
El admin recibe una notificación con el nombre del cliente y el mensaje.

---

## ARCHIVO A MODIFICAR

`src/handlers/clientHandler.js` — se agregan dos funciones auxiliares y
un bloque de detección al inicio de `handleClientMessage`.

---

## CAMBIO — src/handlers/clientHandler.js

### A. Agregar las constantes y funciones auxiliares

Agregar el siguiente bloque justo debajo de la constante `GESTION_STATES`
(después de la línea que cierra el array `GESTION_STATES`):

```js
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

// Devuelve true si el mensaje coincide con una frase de llegada conocida
function isArrivalMessage(lower) {
  return ARRIVAL_PHRASES.some(p => lower === p || lower.includes(p));
}

// Devuelve true si el cliente tiene un turno hoy dentro de la ventana ±30 min
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
```

### B. Agregar el bloque de detección en `handleClientMessage`

En la función `handleClientMessage`, localizar estas líneas:

```js
  const step     = conv.current_step || 'IDLE';
  const stepData = conv.step_data    || {};
  const lower    = body.toLowerCase().trim();

  // Palabras clave que reinician el flujo desde cualquier estado
```

Agregar el bloque de detección de llegada ENTRE la línea de `lower` y el comentario
de "Palabras clave que reinician el flujo":

```js
  const step     = conv.current_step || 'IDLE';
  const stepData = conv.step_data    || {};
  const lower    = body.toLowerCase().trim();

  // ── Detección de llegada al local ─────────────────────────────────────────
  // Si el mensaje es una frase de llegada O el cliente tiene turno hoy ±30 min,
  // reenviar al admin sin responder ni cambiar el estado de la conversación.
  if (isArrivalMessage(lower) || isInArrivalWindow(phone)) {
    const displayName = contactName
      || stepData.knownClientName
      || stepData.contactName
      || phone;
    await send().notifyAdmin(
      `📍 *${displayName}* avisa que está llegando:\n"${body}"`,
    );
    return;
  }

  // Palabras clave que reinician el flujo desde cualquier estado
```

---

## VERIFICACIÓN

1. **Frase de llegada sin turno hoy**:
   Mandar "estoy abajo" desde cualquier número.
   - El bot NO debe responder nada al cliente.
   - El admin debe recibir: `📍 *[nombre]* avisa que está llegando: "estoy abajo"`

2. **Ventana de tiempo — dentro**:
   Con un turno agendado para hoy a las 10:00, mandar cualquier mensaje
   entre las 09:30 y las 10:30.
   - El bot NO debe responder.
   - El admin recibe la notificación con el mensaje original.

3. **Ventana de tiempo — fuera**:
   Con un turno agendado para hoy a las 10:00, mandar un mensaje a las 08:00.
   - El bot SÍ debe responder con el flujo normal.

4. **Sin turno hoy, sin frase de llegada**:
   Mandar "hola" sin turno hoy.
   - El bot responde con el flujo normal, sin cambios.

5. **Estado WAITING_RECEIPT + frase de llegada**:
   Si el cliente está esperando mandar un comprobante y manda "llegué",
   - El bot reenvía al admin y no responde.
   - El estado WAITING_RECEIPT se preserva (no se reinicia el flujo).

6. **Nombre en la notificación**:
   - Si el cliente tiene historial, el nombre debe aparecer correctamente.
   - Si es un número desconocido, mostrar el número de teléfono.
