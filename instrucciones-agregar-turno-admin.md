# Mejora: flujo "agregar turno" del admin

## Objetivo

Rediseñar el flujo `agregar turno` del admin para que sea idéntico al flujo del cliente:
selección de categoría → selección de servicio(s) → fecha → horario → confirmar.

Además, **eliminar el paso del número de teléfono** porque el admin no tiene el número
del cliente a mano (está en el celular del bot). Los turnos creados manualmente usarán
`phone_number = "manual"` como placeholder.

---

## Cambios requeridos

### Archivo: `src/handlers/adminHandler.js`

#### Estados del flujo actual (a reemplazar)

```
ADMIN_ADD_TURN_NAME
ADMIN_ADD_TURN_PHONE      ← eliminar
ADMIN_ADD_TURN_SERVICE    ← reemplazar por categoría + servicio
ADMIN_ADD_TURN_DATE
ADMIN_ADD_TURN_TIME
ADMIN_ADD_TURN_CONFIRM
```

#### Estados del nuevo flujo

```
ADMIN_ADD_TURN_NAME           ← pedir nombre del cliente (igual que antes)
ADMIN_ADD_TURN_CATEGORY       ← nuevo: mostrar categorías (manos / pies / cejas y pestañas)
ADMIN_ADD_TURN_SERVICE        ← servicios filtrados por categoría elegida
ADMIN_ADD_TURN_MORE           ← nuevo: "¿agregar otro servicio?" (Sí / No)
ADMIN_ADD_TURN_DATE
ADMIN_ADD_TURN_TIME
ADMIN_ADD_TURN_CONFIRM
```

---

## Implementación detallada

### Paso 1 — `startAgregarTurno()` (sin cambios)

Pedir nombre del cliente, transicionar a `ADMIN_ADD_TURN_NAME`.

### Paso 2 — `handleAddTurnName(body, stepData)`

Guardar `clientName`. Transicionar a `ADMIN_ADD_TURN_CATEGORY`.

Mostrar las categorías igual que el flujo del cliente.
Las categorías deben obtenerse dinámicamente desde la DB
(`SELECT DISTINCT category FROM services WHERE active = 1 AND category IS NOT NULL ORDER BY category`).

Mapear internamente a etiquetas legibles, igual que en `clientHandler.js`:
```js
const CATEGORY_LABELS = {
  manos:          '💅 Manos',
  pies:           '🦶 Pies',
  cejas_pestanas: '✨ Cejas y Pestañas',
};
```

Usar `sendMessageWithList` para mostrar las opciones.

### Paso 3 — `handleAddTurnCategory(lower, stepData)`

- Parsear la opción elegida (índice numérico)
- Obtener servicios activos de esa categoría: `getServicesByCategory(category)`
- Transicionar a `ADMIN_ADD_TURN_SERVICE` con `{ ...stepData, category, services }`
- Mostrar lista de servicios con nombre, duración y precio

Formato de cada opción:
```
Semipermanente en manos (45 min) $17.000
```

### Paso 4 — `handleAddTurnService(lower, stepData)`

- Parsear la opción elegida
- Guardar el servicio seleccionado en `servicesSelected: [service]`
- Transicionar a `ADMIN_ADD_TURN_MORE`
- Preguntar: `¿Querés agregar otro servicio?\n\n1 Sí, agregar otro\n2 No, continuar`

### Paso 5 — `handleAddTurnMore(lower, stepData)`

**Si elige agregar otro:**
- Volver a `ADMIN_ADD_TURN_CATEGORY` (sin perder `servicesSelected`)
- Si ya hay servicios seleccionados, mostrarlos antes de pedir la categoría:
  ```
  Llevás elegido:
  • Semipermanente en manos (45 min)
  ⏱ Total: 45 min
  
  ¿Qué categoría?
  ```

**Si elige continuar:**
- Calcular `service` combinado igual que `buildCombinedService` en `clientHandler.js`:
  ```js
  {
    name: services.map(s => s.name).join(' + '),
    duration_minutes: sum of all,
    price: sum of all,
  }
  ```
- Buscar días disponibles con `findAdminAvailableDays(service.duration_minutes)`
- Transicionar a `ADMIN_ADD_TURN_DATE`

### Paso 6 — `handleAddTurnDate(lower, stepData)` (sin cambios)

Igual que antes.

### Paso 7 — `handleAddTurnTime(lower, stepData)` (sin cambios)

Igual que antes.

### Paso 8 — `handleAddTurnConfirm(lower, stepData)`

**Cambios respecto al actual:**

1. En el resumen NO mostrar número de teléfono (no lo tenemos)
2. Al crear el appointment usar `phone_number: 'manual'`
3. NO enviar mensaje de WhatsApp al cliente (era `send().sendMessage(stepData.clientPhone, ...)`)
4. El mensaje de confirmación al admin: `✅ Turno *#${appointmentId}* creado.`

Formato del resumen:
```
📋 *Resumen del nuevo turno:*

👤 [nombre cliente]
💇 [servicio(s)] — [duración] min
📅 [fecha]
🕐 [horario]
💰 $[precio]

¿Confirmás? *SI* / *NO*
```

---

## Cambio en `handleCancelConfirm`

Cuando se cancela un turno manual (`phone_number === 'manual'`), NO enviar
mensaje al cliente porque no hay número real. Agregar este chequeo antes del
`sendMessage` al cliente:

```js
if (apt && apt.phone_number && apt.phone_number !== 'manual') {
  await send().sendMessage(apt.phone_number, `😔 Tu turno...`);
}
```

---

## Función auxiliar necesaria

Agregar en `adminHandler.js` (similar a `buildCombinedService` de `clientHandler.js`):

```js
function buildCombinedService(servicesSelected) {
  return {
    name:             servicesSelected.map(s => s.name).join(' + '),
    duration_minutes: servicesSelected.reduce((sum, s) => sum + s.duration_minutes, 0),
    price:            servicesSelected.reduce((sum, s) => sum + s.price, 0),
  };
}
```

---

## Función `getServicesByCategory` en queries.js

Verificar que ya existe en `src/db/queries.js`. Si no existe, agregarla:

```js
function getServicesByCategory(category) {
  const db   = getDb();
  const rows = db.prepare(
    `SELECT * FROM services WHERE active = 1 AND category = ? ORDER BY sort_order`
  ).all(category);
  db.close();
  return rows;
}
```

Asegurarse de que está exportada.

---

## Switch/case en el dispatcher del admin

Agregar los nuevos estados en el bloque que despacha según `adminStep`:

```js
case 'ADMIN_ADD_TURN_CATEGORY': return handleAddTurnCategory(lower, stepData);
case 'ADMIN_ADD_TURN_MORE':     return handleAddTurnMore(lower, stepData);
```

Remover `ADMIN_ADD_TURN_PHONE` del switch.

---

## Verificación final

1. Agendar un turno desde admin sin número de teléfono: flujo categoría → servicio → más servicios → fecha → horario → confirmar
2. Verificar que aparece en `ver turnos`
3. Verificar que al cancelar ese turno no intenta enviar WhatsApp a "manual"
4. Probar turno con un solo servicio y con dos servicios combinados
5. Verificar que el evento se crea en Google Calendar con el nombre del cliente

---

## Archivos a modificar

- `src/handlers/adminHandler.js` — flujo completo de agregar turno
- `src/db/queries.js` — verificar/agregar `getServicesByCategory`
