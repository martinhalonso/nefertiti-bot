# Informe de auditoría — Acciones del admin

> Fecha: 16/06/2026 · Bot Nefertiti (WhatsApp)

## Resumen

Revisé todas las acciones del admin documentadas en `LOGICA.md` y el código de `adminHandler.js`, `clientHandler.js`, `calendarHandler.js`, `whatsappHandler.js` y `queries.js`. El flujo del cliente funciona bien. Encontré **un problema raíz** que afectaba a varios comandos del admin y lo corregí, más dos casos del mismo patrón.

## La causa raíz

Los contactos llegan como identificadores `@lid` de WhatsApp (no teléfonos comunes). El `wa_id` original sólo se guardaba **en memoria**, así que al reiniciar el bot se perdía. Cuando el admin hacía una acción que le avisaba al cliente, el bot armaba la dirección como `…@c.us` (inválida para un `@lid`), el envío fallaba y **la excepción cortaba el resto del comando** — incluyendo la confirmación al admin. Por eso parecía que el comando "no hacía nada" o "no reconocía el número", aunque el cambio en la base ya se había guardado.

## Cambios aplicados

1. **Persistencia del `wa_id`** (raíz del problema)
   - Nueva columna `wa_id` en `conversations` (migración automática en `initDB.js`).
   - Se guarda el `wa_id` real (`@c.us` o `@lid`) cada vez que un contacto escribe (`whatsappHandler.js` + `rememberWaId`/`getWaId` en `queries.js`).
   - `toWaId` ahora recupera el `wa_id` guardado en la base antes de caer al fallback `@c.us`. Así los contactos `@lid` se pueden contactar **incluso después de reiniciar** el bot.

2. **Resiliencia de los avisos al cliente** (3 comandos)
   - `activar [número]` — el aviso al cliente ya no bloquea la confirmación al admin.
   - `revisar [id]` — igual: confirma el comprobante al admin aunque falle el aviso al cliente.
   - `cancelar turno` — además de confirmar al admin, ahora **siempre resetea el flujo** (antes podía quedar trabado en "¿SI/NO?" si el aviso fallaba).

   `calendarHandler.js` (cancelación automática por borrado en Google Calendar) ya tenía esta protección y se beneficia del nuevo `wa_id`.

## Recordatorios y envíos programados

No hay recordatorios automáticos hacia clientes en el proyecto. Los únicos envíos programados son:

- **Resumen diario (8:00)** → va sólo al admin (su `wa_id` se resuelve al conectar). Ya está en try/catch.
- **Limpiador de inactividad (cada 5 min)** → sólo resetea estados en la base, no envía mensajes.
- **Sync de Calendar (cada 2 h)** → cancela turnos borrados; ya avisa al admin primero y al cliente dentro de try/catch.

Todos quedan correctos.

## Verificación

Simulé los comandos con un contacto `@lid` real, antes y después de un reinicio:

- Con `wa_id` guardado: el cliente se contacta bien por `@lid` y el admin recibe confirmación.
- Sin `wa_id` (peor caso): el cliente no recibe el aviso, pero **el admin siempre recibe confirmación y la acción persiste** (bot reactivado / seña marcada / turno borrado), sin quedar trabado.

## Acción requerida

**Reiniciá el bot una vez** para que se cree la columna `wa_id`. Para los 11 clientes ya pausados, su `wa_id` se guardará cuando vuelvan a escribir; mientras tanto, igual vas a recibir la confirmación al activarlos.

## Recomendaciones menores (opcionales, no urgentes)

- `ddmmToISO` siempre asume el año actual. En diciembre, un `bloquear 02/01` o `ver turnos 02/01` apuntaría a enero de **este** año (pasado). Convendría elegir el próximo año si la fecha ya pasó.
- `agregar turno` no le avisa al cliente cuando se le carga un turno, aunque tenga teléfono. Es una decisión de diseño; se podría agregar un aviso si querés.

## Archivos modificados (auditoría admin)

`src/db/initDB.js`, `src/db/queries.js`, `src/handlers/whatsappHandler.js`, `src/handlers/adminHandler.js`.

---

# Pérdida de turnos al actualizar la app

## El problema

Al empaquetar una versión nueva y reinstalarla en la notebook, los turnos agendados desaparecían de la base (`bot.db`), aunque seguían en Google Calendar. Peor: el bot **volvía a ofrecer esos horarios como disponibles**, con riesgo de doble reserva.

## Causa

Dos cosas agravaban el problema:

1. El **token de Google Calendar** (`google_refresh_token`) se guardaba en la tabla `settings`, **dentro de la misma `bot.db`**. Si la base se reseteaba, el bot quedaba **desconectado de Calendar**.
2. La disponibilidad del cliente *sí* cruza con Calendar para evitar choques, pero solo si Calendar está conectado. Al perderse el token con la base, ese filtro dejaba de funcionar → el bot re-ofrecía horarios ocupados.

No existía ninguna reimportación de turnos desde Calendar (solo había sincronización de borrados).

## Solución aplicada

1. **Token fuera de la base.** El `google_refresh_token` ahora se guarda en un archivo (`google_token.json`) dentro de la carpeta de datos (`userData`), que sobrevive a cualquier reseteo de `bot.db`. Se mantiene una copia en la base por compatibilidad, y al arrancar se migra automáticamente el token existente al archivo.

2. **Reimportación Calendar → DB al arrancar.** Cada vez que el bot se conecta, lee los eventos futuros de Google Calendar (próximos 60 días) y reinserta en la base los turnos que falten. Reconstruye nombre, servicio, duración, precio, fecha y hora desde el evento. Es **idempotente**: no duplica (deduplica por id de evento y por fecha/hora/teléfono) y solo importa eventos creados por el bot (ignora eventos personales del calendario).

Con esto, si la base se pierde, al reactivar el bot la agenda se reconstruye sola desde Calendar y los horarios ocupados vuelven a bloquearse correctamente.

## Verificación

Simulé el parseo de eventos y la reimportación: importa los turnos correctos, ignora eventos que no son del bot, y al correr de nuevo no duplica nada.

## Respaldo automático de bot.db (red extra)

Además de la reimportación desde Calendar, se agregó un sistema de backups:

- **Backup automático** de `bot.db` en `userData/backups` al conectar el bot y todos los días a las 23:00. Se conservan los **últimos 10** (rotación automática). No respalda si la agenda está vacía, para no pisar un backup bueno.
- **Autorestauración**: al arrancar, si la agenda quedó vacía pero existe un backup con turnos, se restaura automáticamente el más reciente antes de seguir.

Así hay doble cobertura: si se pierde `bot.db` pero la carpeta de datos persiste, se restaura del backup; y si además se perdieran los backups, la agenda se reconstruye desde Google Calendar.

## Archivos modificados (persistencia)

`index.js`, `src/handlers/calendarHandler.js`, `src/db/queries.js`, `src/db/backup.js` (nuevo).

## Nota sobre la causa de fondo

Indicaste que al reinstalar se pierden *solo los turnos* (la sesión de WhatsApp y la configuración se mantienen). Eso sugiere que la carpeta de datos persiste, así que conviene verificar en la notebook dónde está realmente `bot.db` (debería estar en `%APPDATA%\Bot Nefertiti\bot.db`). De todos modos, esta solución recupera la agenda **sin importar** por qué se reseteó la base. Si querés, en una próxima vuelta puedo agregar un respaldo automático de `bot.db` antes de cada actualización para mayor tranquilidad.
