# Instrucciones: ignorar mensajes recibidos mientras el bot estaba apagado

Antes de tocar cualquier archivo, leé completo:
- src/handlers/whatsappHandler.js

Un solo archivo a modificar. No tocar nada más.

---

## CONTEXTO DEL PROBLEMA

Al reiniciar el bot, whatsapp-web.js entrega todos los mensajes que llegaron
mientras estaba apagado. El bot los procesa como si fueran nuevos, disparando
el flujo de bienvenida una vez por cada mensaje del historial.

Cada mensaje tiene una propiedad `msg.timestamp` con el momento en que fue
enviado (número Unix en segundos). La solución es registrar el momento exacto
en que arranca el bot y descartar cualquier mensaje anterior a ese instante.

---

## CAMBIO — src/handlers/whatsappHandler.js

### A. Agregar la constante BOT_START_TIME al inicio del archivo,
justo después de las líneas de require/dotenv, antes de cualquier función:

```js
// Momento exacto de inicio del bot (segundos Unix).
// Cualquier mensaje con timestamp anterior a este valor se ignora:
// son mensajes que llegaron mientras el bot estaba apagado.
const BOT_START_TIME = Math.floor(Date.now() / 1000);
```

### B. En el handler client.on('message', ...), agregar el filtro
como PRIMERA línea dentro del bloque try, antes de cualquier otra lógica:

```js
// Ignorar mensajes viejos (llegaron mientras el bot estaba apagado)
if (msg.timestamp < BOT_START_TIME) return;
```

El bloque try completo debe quedar así:

```js
client.on('message', async (msg) => {
  try {
    // Ignorar mensajes viejos (llegaron mientras el bot estaba apagado)
    if (msg.timestamp < BOT_START_TIME) return;

    if (msg.fromMe)                      return;
    if (msg.from.includes('@g.us'))      return;
    if (msg.from.includes('@broadcast')) return;

    // ... resto del handler sin cambios ...
```

---

## Verificación

1. Detener el bot (Ctrl+C o pm2 stop)
2. Enviar 3 mensajes desde cualquier número mientras el bot está apagado
3. Iniciar el bot nuevamente
4. Verificar en la terminal que esos 3 mensajes NO generan ningún log de procesamiento
5. Enviar un mensaje nuevo con el bot ya corriendo → debe procesarse normalmente
