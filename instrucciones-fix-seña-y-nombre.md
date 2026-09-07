# Instrucciones: fix CBU vacío y nombre en notificación al admin

Antes de tocar cualquier archivo, leé completos:
- src/handlers/clientHandler.js
- src/config/messages.js
- .env

No modificar nada del flujo de agendamiento ni de historial existentes.
Dos fixes independientes y quirúrgicos.

---

## CONTEXTO

### Problema 1 — CBU vacío en .env
El archivo .env tiene SEÑA_CBU= vacío. El código hace:
  process.env.SEÑA_CBU || '???'
Resultado: el cliente ve el texto ??? donde debería ir el CBU.
La solución tiene dos partes:
a) Hacer el mensaje más robusto: si CBU está vacío, omitir esa línea y mostrar solo el alias.
b) Agregar un warning al arrancar el bot si SEÑA_CBU no está configurado.

### Problema 2 — Nombre no aparece en la notificación al admin
En handleIdle(), el nombre conocido del cliente (tomado de su historial) se calcula
pero NO se guarda en stepData. Cuando el cliente llega a handleConfirming(), el
fallback es stepData.clientName (lo que escribió en ASKING_NAME), pero si ese paso
falla o se salta, no hay nombre disponible.
La solución: guardar el nombre conocido en stepData desde handleIdle() para que
esté disponible como fallback en todo el flujo.

---

## FIX 1 — src/config/messages.js

Reemplazar la función SEÑA_INFO existente por esta versión que maneja CBU vacío:

```js
SEÑA_INFO: (monto, cbu, alias) => {
  const tieneCBU   = cbu && cbu !== '???';
  const tieneAlias = alias && alias !== '???';
  const lines = [`Para dejar tu seña, transferí *$${monto}* a:\n`];
  if (tieneCBU)   lines.push(`🏦 CBU: \`${cbu}\``);
  if (tieneAlias) lines.push(`🏷️ Alias: \`${alias}\``);
  if (!tieneCBU && !tieneAlias)
    lines.push(`⚠️ Los datos de transferencia aún no están configurados. Consultá con nosotros.`);
  lines.push(`\nCuando hagas la transferencia mandame el comprobante 😊`);
  return lines.join('\n');
},
```

---

## FIX 2 — src/handlers/clientHandler.js

### A. Modificar handleIdle() para guardar el nombre conocido en stepData

Reemplazar la función handleIdle() existente por esta versión:

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

### B. Modificar handleConfirming() para usar knownClientName como fallback

Localizar esta línea en handleConfirming():
```js
const clientName = stepData.clientName || contactName || stepData.contactName || null;
```

Reemplazarla por:
```js
const clientName = stepData.clientName || stepData.knownClientName || contactName || stepData.contactName || null;
```

---

## FIX 3 — src/handlers/whatsappHandler.js (warning de configuración)

En la función setup(), dentro del evento client.on('ready', ...), agregar
al final del bloque (después del try/catch del admin WA ID):

```js
// Verificar configuración de datos de seña
const cbu   = process.env.SEÑA_CBU;
const alias = process.env.SEÑA_ALIAS;
if (!cbu)   logger.warn('⚠️  SEÑA_CBU no está configurado en .env — el mensaje de seña mostrará solo el alias.');
if (!alias) logger.warn('⚠️  SEÑA_ALIAS no está configurado en .env — el mensaje de seña estará incompleto.');
```

---

## Verificación

1. Reiniciar el bot → la terminal debe mostrar el warning de SEÑA_CBU no configurado
2. Iniciar un flujo de agendamiento → llegar hasta el paso de seña → elegir "Sí, quiero dejar una seña"
   → el mensaje debe mostrar SOLO el alias (fernandez.celina.13), sin la línea de CBU
3. Completar un agendamiento nuevo → el admin debe recibir la notificación con el
   nombre y apellido del cliente correctamente
4. Completar un agendamiento con un cliente que ya tiene historial → verificar que
   el nombre también aparece correctamente en la notificación al admin
