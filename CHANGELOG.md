# Changelog

Todas las novedades relevantes del bot se registran en este archivo.

## [1.3.1] — 2026-07-13

### Cambiado

- **`activar` ahora pregunta antes de avisar al cliente (1 Sí / 2 No).** El aviso automático de reactivación generaba fricción: el cliente solía responderlo por cordialidad y reingresaba al flujo del bot sin querer. La reactivación se guarda igual en ambos casos; solo el aviso es opcional.

### Archivos

- Modificado: `src/handlers/adminHandler.js`.

## [1.3.0] — 2026-07-13

### Agregado

- **Comando `modificar turno [nombre o número]`.** El admin puede cambiar un turno ya agendado sin cancelarlo: fecha y hora, servicio(s), o todo junto.
  - Reutiliza el mismo flujo de selección de categoría/servicio/fecha/hora de `agregar turno` (misma UX).
  - Muestra resumen *antes/después* y pide confirmación SI/NO.
  - Al buscar horarios disponibles, **excluye el propio turno en edición** (permite, por ej., correrlo 30 minutos el mismo día).
  - Sincroniza con Google Calendar: borra el evento viejo y crea el nuevo.
  - Al confirmar, pregunta al admin si avisa al cliente (1 Sí / 2 No). El aviso incluye el detalle del cambio y nunca bloquea la confirmación al admin si falla.

### Archivos

- Modificados: `src/handlers/adminHandler.js`, `src/db/queries.js` (`updateAppointment` acepta servicio/duración/precio; `getAvailableSlots` y `getAppointmentsByDate` aceptan excluir un turno por id).

## [1.2.1] — 2026-06-18

### Arreglado

- **`activar` reportaba éxito en falso con contactos `@lid`.** Cuando el admin escribía el número de teléfono *real* de un contacto que WhatsApp identifica con un id interno (`@lid`), `activar` no encontraba la conversación, **creaba una fila nueva inútil** y avisaba "reactivado" — pero el bot seguía pausado para ese contacto y no respondía a "hola". Ahora:
  - Si el identificador no coincide con ninguna conversación ni cliente, `activar` (y `pausar`) avisan claramente y explican que el número real puede no coincidir con el id interno del contacto. Ya no se fabrica un éxito falso.
  - `ver pausados` muestra el **identificador exacto** de cada contacto (entre comillas, para copiar) además del nombre, y aclara cómo reactivar.

### Cómo reactivar un contacto correctamente

- Por **nombre**: `activar Martin Alonso`.
- O copiando el **identificador** que figura en `ver pausados`.
- Escribir el número de teléfono real puede **no** funcionar, porque WhatsApp identifica a algunos contactos con un id interno distinto.

### Archivos

- Modificado: `src/handlers/adminHandler.js`.

## [1.2.0] — 2026-06-18

### Arreglado

- **Comandos del admin con contactos `@lid`.** WhatsApp entrega a los clientes como identificadores `@lid` y el `wa_id` solo se guardaba en memoria; al reiniciar el bot, los avisos al cliente fallaban y cortaban el comando antes de confirmarle al admin (parecía que "no reconocía el número"). Ahora:
  - Se persiste el `wa_id` original en la base (nueva columna `wa_id` en `conversations`) y se recupera al responder, de modo que los contactos `@lid` siguen siendo contactables incluso después de reiniciar.
  - `activar`, `revisar` (comprobantes) y `cancelar turno` siempre confirman al admin aunque falle el aviso al cliente.
  - `cancelar turno` ya no queda trabado en el paso "¿SI/NO?" si el aviso al cliente falla.

### Agregado

- **Token de Google Calendar fuera de la base.** El `google_refresh_token` ahora se guarda en un archivo (`google_token.json`) dentro de la carpeta de datos, que sobrevive a un reseteo o pérdida de `bot.db`. Se mantiene una copia en la base por compatibilidad y se migra automáticamente al arrancar.
- **Reimportación de turnos desde Google Calendar al arrancar.** El bot lee los eventos futuros (próximos 60 días) y reinserta en la base los turnos que falten, reconstruyendo nombre, servicio, duración, precio, fecha y hora. Es idempotente (deduplica por id de evento y por fecha/hora/teléfono) e ignora eventos que no son del bot. Evita perder la agenda y el re-ofrecimiento de horarios ya ocupados.
- **Respaldo automático de `bot.db`.** Backups en `userData/backups` al conectar el bot y a diario (23:00), conservando los últimos 10 (rotación automática). No respalda si la agenda está vacía.
- **Autorestauración.** Al arrancar, si la agenda quedó vacía pero existe un backup con turnos, se restaura automáticamente el más reciente.

### Detalle de la causa de fondo

Al perderse `bot.db`, no solo desaparecían los turnos: el token de Calendar vivía en esa misma base, así que el bot quedaba desconectado de Calendar y dejaba de filtrar los horarios ocupados, generando riesgo de doble reserva. Las dos mejoras de persistencia (token en archivo + reimportación + backups) cubren el problema sin importar la causa exacta del reseteo.

### Archivos

- Modificados: `index.js`, `src/handlers/adminHandler.js`, `src/handlers/whatsappHandler.js`, `src/handlers/calendarHandler.js`, `src/db/queries.js`, `src/db/initDB.js`.
- Nuevo: `src/db/backup.js`.
- Documentación: `INFORME-AUDITORIA-ADMIN.md`, `PASOS-EMPAQUETADO.md`.

### Notas de despliegue

- Reiniciar/instalar la versión una vez para que se cree la columna `wa_id`, se migre el token y se reimporte la agenda desde Calendar.
- En esta actualización la recuperación de turnos ya perdidos depende de la reimportación desde Calendar (todavía no hay backups previos). De la próxima actualización en adelante, los backups también protegen la agenda.
- Para los clientes ya pausados, su `wa_id` se guarda cuando vuelvan a escribir; mientras tanto, igual se recibe la confirmación al activarlos.
