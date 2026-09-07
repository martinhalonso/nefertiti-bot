# Debug: "ver turnos" no muestra turnos agendados

## Contexto del problema

El bot de WhatsApp permite a clientes agendar turnos. El flujo funciona correctamente:
el cliente recibe el mensaje de confirmación "tu turno fue agendado". Sin embargo,
cuando el admin envía `ver turnos` o `ver turnos DD/MM`, el bot responde "Sin turnos"
aunque deberían existir turnos en la base de datos.

El problema se detectó en la app empaquetada (instalador .exe) corriendo en una notebook,
pero debe verificarse también en modo desarrollo (`npm run tray`).

## Stack técnico

- **Runtime bot**: Node.js (dev) / Electron utilityProcess (empaquetado)
- **DB**: SQLite via `better-sqlite3` (síncrono)
- **DB path dev**: `data/bot.db` (raíz del proyecto)
- **DB path empaquetado**: `%APPDATA%\bot-turnos-whatsapp\bot.db`
- **Archivos clave**:
  - `src/handlers/clientHandler.js` — flujo del cliente, llama `createAppointment`
  - `src/handlers/adminHandler.js` — comando `ver turnos`, llama `getAppointmentsByDateFull`
  - `src/db/queries.js` — implementación de `createAppointment` y `getAppointmentsByDateFull`
  - `src/db/initDB.js` — path de la DB, función `getDb()`

## Pasos de investigación

### 1. Verificar que la DB tiene datos reales

Agendar un turno de prueba con un número de WhatsApp cualquiera y luego consultar
la DB directamente para confirmar si el registro existe:

```bash
node -e "
const { getDb } = require('./src/db/initDB');
const db = getDb();
const rows = db.prepare('SELECT * FROM appointments ORDER BY id DESC LIMIT 5').all();
console.log(JSON.stringify(rows, null, 2));
db.close();
"
```

Si no hay filas → el problema es en la escritura (`createAppointment`).
Si hay filas → el problema es en la lectura (`getAppointmentsByDateFull`).

### 2. Verificar el formato de fecha en la DB

El campo `appointment_date` debe estar en formato `YYYY-MM-DD` (ej: `2026-05-14`).
La función `getAppointmentsByDateFull` también usa ese formato. Si hay inconsistencia,
los SELECT no retornan nada.

```bash
node -e "
const { getDb } = require('./src/db/initDB');
const db = getDb();
const rows = db.prepare('SELECT id, appointment_date, appointment_time, client_name FROM appointments').all();
console.log(rows);
db.close();
"
```

### 3. Reproducir el bug con logs temporales

Agregar `console.log` temporales en los puntos críticos para trazar el problema:

**En `src/db/queries.js`, función `createAppointment`:**
```js
function createAppointment(data) {
  console.log('[DEBUG createAppointment] data:', JSON.stringify(data));
  const db = getDb();
  const result = db.prepare(`...`).run(data);
  console.log('[DEBUG createAppointment] insertedId:', result.lastInsertRowid);
  db.close();
  return result.lastInsertRowid;
}
```

**En `src/db/queries.js`, función `getAppointmentsByDateFull`:**
```js
function getAppointmentsByDateFull(date) {
  console.log('[DEBUG getAppointmentsByDateFull] querying date:', date);
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM appointments WHERE appointment_date = ?`).all(date);
  console.log('[DEBUG getAppointmentsByDateFull] rows found:', rows.length);
  db.close();
  return rows;
}
```

### 4. Verificar la función `ddmmToISO` en adminHandler

El comando `ver turnos 13/05` pasa por esta función antes de hacer el SELECT.
Verificar que convierte correctamente:

```bash
node -e "
function ddmmToISO(ddmm) {
  const [dd, mm] = ddmm.split('/').map(s => s.padStart(2, '0'));
  return \`\${new Date().getFullYear()}-\${mm}-\${dd}\`;
}
console.log(ddmmToISO('13/05')); // debe mostrar 2026-05-13
console.log(ddmmToISO('14/05')); // debe mostrar 2026-05-14
"
```

### 5. Verificar el `DB_PATH` en uso

Confirmar que tanto escritura como lectura usan exactamente el mismo archivo:

```bash
node -e "
require('dotenv').config();
const { DB_PATH } = require('./src/db/initDB');
console.log('DB_PATH:', DB_PATH);
const fs = require('fs');
console.log('Existe:', fs.existsSync(DB_PATH));
console.log('Tamaño (bytes):', fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 'N/A');
"
```

## Correcciones esperadas

Según lo que se encuentre en la investigación:

- **Si el formato de fecha es incorrecto**: corregir `toISO()` en `clientHandler.js`
  o el INSERT en `createAppointment` para que use exactamente `YYYY-MM-DD`.

- **Si el DB_PATH es diferente entre escritura y lectura**: revisar que `USER_DATA_PATH`
  sea consistente en ambos contextos (bot process y admin handler corren en el mismo proceso,
  pero verificar que `process.env.USER_DATA_PATH` no cambia entre llamadas).

- **Si `createAppointment` falla silenciosamente**: agregar try/catch explícito en
  `handleConfirming` alrededor de `createAppointment` y loguear el error.

## Flujo del comando "ver turnos"

```
Admin WhatsApp → adminHandler.js handleAdminMessage()
  → lower.match(/^ver turnos (\d{2}\/\d{2})$/)
  → ddmmToISO("13/05") → "2026-05-13"
  → cmdVerTurnos("2026-05-13")
  → getAppointmentsByDateFull("2026-05-13")
  → SELECT * FROM appointments WHERE appointment_date = "2026-05-13"
  → formatDayTurns(date, rows)
  → send message to admin
```

## Flujo de creación de turno

```
Cliente confirma con "Sí" → clientHandler.js handleConfirming()
  → createAppointment({ appointment_date: stepData.date, ... })
  → stepData.date viene de: days[idx].dateStr = toISO(d) = "YYYY-MM-DD"
  → INSERT INTO appointments (appointment_date, ...) VALUES (?, ...)
```

## Después de corregir

1. Probar end-to-end: agendar turno → `ver turnos DD/MM` → verificar que aparece
2. Eliminar los `console.log` de debug agregados
3. Reconstruir el instalador: `npx electron-rebuild -f -w better-sqlite3 && npm run build && npm rebuild better-sqlite3`
