# Instrucciones: horario laboral diferente por día

Leé este archivo completo antes de tocar nada.

No se crea ninguna tabla nueva. El cambio es solo en cómo se guarda y se lee
el valor `working_hours` en la tabla `settings`.

---

## CONTEXTO

### Problema actual
El comando `horario laboral lun-sab 09:00-18:00` guarda UN solo bloque para
todos los días. Si después escribís `horario laboral sab 09:00-15:00`,
sobreescribe el anterior y se pierde la configuración de lunes a viernes.

Formato actual (objeto único):
```json
{ "days": [1,2,3,4,5,6], "open": "09:00", "close": "18:00" }
```

### Solución
Cambiar el formato a un array de bloques, uno por grupo de días:
```json
[
  { "days": [1,2,3,4,5], "open": "09:00", "close": "18:00" },
  { "days": [6],          "open": "09:00", "close": "15:00" }
]
```

Cada llamada a `horario laboral` actualiza SOLO los días mencionados,
sin tocar los demás. El formato viejo (objeto único) se convierte
automáticamente la primera vez que se lee.

### Nuevo comando agregado
`quitar horario [rango]` — elimina días del horario laboral (los deja sin turno):
```
quitar horario sab
quitar horario dom
```

---

## ARCHIVOS A MODIFICAR

1. `src/db/queries.js` — función `getAvailableSlots`
2. `src/handlers/adminHandler.js` — `cmdSetHorario`, `cmdVerHorarios`, nuevo `cmdQuitarHorario`, HELP_TEXT, router de comandos
3. `src/handlers/clientHandler.js` — función `startDailySummary`

---

## CAMBIO 1 — src/db/queries.js

### Reemplazar la función `getAvailableSlots` completa

Buscar:
```js
function getAvailableSlots(date, serviceDuration) {
  const workingHoursRaw = getSetting('working_hours');
  if (!workingHoursRaw) return [];

  const { days, open, close } = JSON.parse(workingHoursRaw);

  // Día de la semana de la fecha pedida (0=domingo ... 6=sábado)
  const dayOfWeek = new Date(`${date}T00:00:00`).getDay();
  if (!days.includes(dayOfWeek)) return [];

  const openMin  = timeToMinutes(open);
  const closeMin = timeToMinutes(close);
```

Reemplazar por:
```js
function getAvailableSlots(date, serviceDuration) {
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
```

El resto de la función queda igual, sin ningún cambio más.

---

## CAMBIO 2 — src/handlers/adminHandler.js

### A. Reemplazar la función `cmdSetHorario` completa

Buscar:
```js
async function cmdSetHorario(dayRange, open, close) {
  const days = parseDayRange(dayRange);
  if (!days) {
    await send().sendMessage(ADMIN_PHONE, '❌ Rango de días inválido. Ejemplo: *lun-sab*');
    return;
  }
  setSetting('working_hours', JSON.stringify({ days, open, close }));
  const shortNames = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const dayNames   = days.map(d => shortNames[d]).join(', ');
  await send().sendMessage(ADMIN_PHONE, `✅ Horario actualizado:\n📅 ${dayNames}\n🕐 ${open} — ${close}`);
}
```

Reemplazar por:
```js
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
```

### B. Reemplazar la función `cmdVerHorarios` completa

Buscar:
```js
async function cmdVerHorarios() {
  const raw              = getSetting('working_hours');
  const { days, open, close } = JSON.parse(raw);
  const shortNames       = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const dayNames         = days.map(d => shortNames[d]).join(', ');

  let text = `⚙️ *Configuración actual*\n\n📅 Días: ${dayNames}\n🕐 Horario: ${open} — ${close}`;
```

Reemplazar por:
```js
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
```

El resto de la función (bloqueos) queda exactamente igual.

### C. Agregar la función `cmdQuitarHorario` justo después de `cmdSetHorario`

```js
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
```

### D. Agregar el comando `quitar horario` al router de comandos

Buscar el bloque:
```js
  const mHorario = lower.match(/^horario laboral (\S+) (\d{2}:\d{2})-(\d{2}:\d{2})$/);
  if (mHorario) return cmdSetHorario(mHorario[1], mHorario[2], mHorario[3]);
```

Agregar DEBAJO de esa línea:
```js
  const mQuitarHorario = lower.match(/^quitar horario (\S+)$/);
  if (mQuitarHorario) return cmdQuitarHorario(mQuitarHorario[1]);
```

### E. Actualizar HELP_TEXT

En la sección `*Disponibilidad*`, reemplazar:
```
• horario laboral lun-sab 09:00-18:00
```
Por:
```
• horario laboral lun-vie 09:00-18:00
• horario laboral sab 09:00-15:00
• quitar horario [rango]
```

---

## CAMBIO 3 — src/handlers/clientHandler.js

### Actualizar el chequeo de día laboral en `startDailySummary`

Buscar:
```js
    const workingHoursRaw = getSetting('working_hours');
    if (workingHoursRaw) {
      const { days } = JSON.parse(workingHoursRaw);
      if (!days.includes(new Date().getDay())) return;
    }
```

Reemplazar por:
```js
    const workingHoursRaw = getSetting('working_hours');
    if (workingHoursRaw) {
      const parsed    = JSON.parse(workingHoursRaw);
      const schedules = Array.isArray(parsed) ? parsed : [parsed];
      const todayDay  = new Date().getDay();
      const isWorkingDay = schedules.some(s => s.days.includes(todayDay));
      if (!isWorkingDay) return;
    }
```

---

## VERIFICACIÓN

1. Reiniciar el bot.

2. Desde el admin, configurar horarios separados:
   ```
   horario laboral lun-vie 09:00-18:00
   ```
   Respuesta esperada: `✅ Horario actualizado: Lun, Mar, Mié, Jue, Vie — 09:00 — 18:00`

   ```
   horario laboral sab 09:00-15:00
   ```
   Respuesta esperada: `✅ Horario actualizado: Sáb — 09:00 — 15:00`

3. Verificar que se muestran ambos bloques:
   ```
   ver horarios
   ```
   Respuesta esperada:
   ```
   ⚙️ Configuración actual

   📅 Lun, Mar, Mié, Jue, Vie: 09:00 — 18:00
   📅 Sáb: 09:00 — 15:00
   ```

4. Desde el cliente, verificar que el sábado muestra horarios hasta las 15:00
   y que el lunes muestra horarios hasta las 18:00.

5. Quitar el sábado:
   ```
   quitar horario sab
   ```
   Verificar con `ver horarios` que solo queda lun-vie.

6. Verificar que si el bot ya tenía el formato viejo guardado en DB,
   lo lee correctamente sin errores (compatibilidad hacia atrás).
