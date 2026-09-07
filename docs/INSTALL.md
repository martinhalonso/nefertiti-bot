# Bot de turnos — Nefertiti

Bot de WhatsApp para gestionar turnos de un local de belleza/estética. Permite a los clientes agendar, consultar, cancelar y modificar turnos directamente desde WhatsApp, y al administrador gestionar la agenda completa desde su celular.

---

## Características

- Flujo conversacional guiado: servicio → fecha → horario → confirmación → seña opcional
- Saludo personalizado para clientes que vuelven, con último servicio y opciones adaptadas
- "Mis turnos" aparece en el menú solo si el cliente tiene turnos activos
- Los clientes pueden ver, cancelar y modificar sus propios turnos
- Historial de visitas para cada cliente (servicios, gastos, estadísticas)
- Detección de llegada al local: reenvía al admin sin interrumpir al cliente
- Panel de administración completo vía WhatsApp (segundo número)
- Horario laboral configurable por día (ej: lun-vie distinto al sáb)
- Integración con Google Calendar (eventos automáticos por turno)
- Manejo de señas con comprobantes de transferencia por imagen
- Resumen diario automático al admin (configurable)
- App de bandeja del sistema (system tray) para iniciar/detener el bot sin terminal
- Logging estructurado con Winston
- Reinicio automático con PM2
- Ignora mensajes recibidos mientras el bot estuvo apagado

---

## Requisitos previos

- **Node.js** v18 o superior
- **npm** v9 o superior
- **Google Chrome** instalado (lo usa whatsapp-web.js internamente)
- Dos números de WhatsApp: uno para el bot y uno para el administrador
- Cuenta de Google (opcional, para integración con Calendar)

---

## Instalación

### 1. Instalar dependencias

```bash
npm install
```

### 2. Crear el archivo `.env`

Copiá el ejemplo y completá los valores:

```bash
copy .env.example .env
```

Editá `.env` con tus datos (ver sección **Variables de entorno** más abajo).

### 3. Inicializar la base de datos

```bash
npm run db:init
```

Crea las tablas y carga los servicios y horario laboral de ejemplo.

### 4. Generar íconos de la app de bandeja

```bash
node scripts/generate-icons.js
```

Solo se necesita correr una vez.

### 5. Primer inicio

```bash
npm start
```

Aparecerá un código QR en la terminal. Escanealo con el celular del bot:
**WhatsApp → ⋮ → Dispositivos vinculados → Vincular dispositivo**

Una vez conectado, el bot queda activo.

---

## Variables de entorno

```env
# Número del administrador (con código de país, sin + ni espacios)
# Ejemplo Argentina: 5493416779186
ADMIN_PHONE=5493416779186

# Monto de la seña en pesos
SENA_MONTO=10000

# Datos bancarios para la seña (podés dejar SENA_CBU vacío si solo usás alias)
SENA_CBU=0000003100065268810015
SENA_ALIAS=fernandez.celina.13

# Puerto del servidor Express (health check y OAuth de Google)
PORT=3000

# Google Calendar OAuth2 (dejar vacío si no usás Calendar)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
GOOGLE_CALENDAR_ID=primary

# Zona horaria
TZ=America/Argentina/Buenos_Aires

# Entorno: development | production
NODE_ENV=development
```

> **Nota:** si `SENA_CBU` está vacío, el bot muestra solo el alias en el mensaje de seña. Si ambos están vacíos, avisa al cliente que se comunique directamente. Al iniciar, la terminal muestra un warning si alguno falta.

---

## App de bandeja del sistema (tray)

La app de bandeja permite iniciar y detener el bot desde un ícono en la barra de notificaciones de Windows, sin necesidad de abrir la terminal.

### Iniciar la app de bandeja

```bash
npm run tray
```

El ícono aparece junto al reloj. Clic derecho para ver el menú:

```
🟢 Bot activo

  Detener bot

──────────────
☑ Iniciar con Windows

──────────────
  Salir
```

- El ícono es verde cuando el bot está activo, gris cuando está detenido.
- El bot arranca automáticamente al abrir la app.
- "Iniciar con Windows" registra o elimina el arranque automático con el sistema.
- "Salir" detiene el bot y cierra la app.

> Si los íconos no se generaron todavía, corré `node scripts/generate-icons.js` una vez.

---

## Integración con Google Calendar (opcional)

### 1. Crear credenciales OAuth2

1. Ir a [Google Cloud Console](https://console.cloud.google.com)
2. Crear un proyecto nuevo (o usar uno existente)
3. Habilitar la **Google Calendar API**
4. Ir a **APIs y servicios → Credenciales → Crear credenciales → ID de cliente OAuth**
5. Tipo: **Aplicación web**
6. URI de redirección autorizado: `http://localhost:3000/auth/google/callback`
7. Copiar el **Client ID** y **Client Secret** al `.env`

### 2. Autorizar el acceso

Con el bot corriendo, abrí en el navegador:

```
http://localhost:3000/auth/google
```

Iniciá sesión con la cuenta de Google cuyo Calendar querés usar. El refresh token se guarda automáticamente en la base de datos.

### 3. Verificar

```
GET http://localhost:3000/health
```

Debe mostrar `"googleCalendar": "authorized"`.

---

## Deploy con PM2

PM2 mantiene el bot corriendo en segundo plano y lo reinicia si se cae.

### Instalar PM2

```bash
npm install -g pm2
```

### Iniciar el bot

```bash
pm2 start ecosystem.config.js
```

### Comandos útiles

```bash
pm2 logs bot-nefertiti        # Logs en tiempo real
pm2 status                    # Estado del proceso
pm2 restart bot-nefertiti     # Reiniciar
pm2 stop bot-nefertiti        # Detener
pm2 delete bot-nefertiti      # Eliminar de PM2
```

### Arranque automático al reiniciar la PC (Windows)

```bash
pm2 startup
# Ejecutá el comando que te indica (requiere PowerShell como administrador)
pm2 save
```

---

## Flujo del cliente

### Cliente nuevo

Recibe el menú de bienvenida con dos opciones: reservar turno o hablar con Celi.

### Cliente que vuelve — sin turnos activos

Saludo personalizado con nombre y último servicio. Tres opciones:
- `1` Reservar turno
- `2` Hablar con Celi
- `3` Ver mi historial

### Cliente que vuelve — con turnos activos

Mismas opciones más "Mis turnos" como opción 3, historial pasa a opción 4:
- `1` Reservar turno
- `2` Hablar con Celi
- `3` Mis turnos
- `4` Ver mi historial

### Flujo de agendamiento

1. Escribe nombre y apellido
2. Elige categoría de servicio (Manos, Pies, Cejas y Pestañas)
3. Elige servicio (puede combinar varios)
4. Elige fecha de los próximos días disponibles
5. Elige horario (con opción de volver)
6. Decide si deja seña o no
7. Confirma el turno

### Gestión de turnos propios

El cliente puede escribir en cualquier momento:

| Mensaje | Acción |
|---|---|
| `mis turnos` | Ver todos los turnos futuros |
| `cancelar turno` | Cancelar (pide elegir si tiene varios) |
| `cancelar turno 1` | Cancelar el turno número 1 directamente |
| `modificar turno` | Reprogramar fecha u horario |
| `modificar turno 1` | Modificar el turno número 1 directamente |
| `mi historial` | Ver visitas pasadas con estadísticas |

### Detección de llegada al local

Si el cliente manda un mensaje avisando que llegó (ej: "estoy abajo", "llegué", "llegando"), el bot reenvía el mensaje al admin silenciosamente y no responde al cliente ni interrumpe ningún flujo activo.

Lo mismo ocurre si el cliente manda cualquier mensaje dentro de la ventana de **30 minutos antes y 30 minutos después** del horario de su turno del día.

El admin recibe: `📍 *[nombre]* avisa que está llegando: "[mensaje]"`

### Palabras clave que reinician el flujo

`hola`, `menu`, `menú`, `inicio`, `empezar`, `start`, `reiniciar`

---

## Comandos del administrador

Enviá estos mensajes desde el número `ADMIN_PHONE` al número del bot.
Escribí **cancelar** en cualquier momento para salir de un flujo activo.

### Turnos

| Comando | Descripción |
|---|---|
| `ver turnos` | Hoy + próximos 3 días |
| `ver turnos DD/MM` | Turnos de una fecha específica |
| `cancelar turno [nombre apellido]` | Cancela el turno y avisa al cliente |
| `agregar turno` | Flujo guiado para agendar manualmente |

### Disponibilidad

| Comando | Descripción |
|---|---|
| `ver horarios` | Configuración actual + bloqueos vigentes |
| `bloquear DD/MM` | Bloquear día completo |
| `bloquear DD/MM HH:MM-HH:MM` | Bloquear rango horario |
| `desbloquear DD/MM` | Habilitar el día |
| `horario laboral lun-vie 09:00-18:00` | Configurar horario para esos días |
| `horario laboral sab 09:00-15:00` | Configurar horario distinto para el sábado |
| `quitar horario sab` | Quitar el sábado del horario laboral |

> Cada comando de horario actualiza solo los días indicados sin pisar los demás.

### Servicios

| Comando | Descripción |
|---|---|
| `ver servicios` | Listar servicios activos con precios |
| `agregar servicio` | Flujo guiado (nombre → duración → precio) |
| `editar servicio [nombre]` | Modificar precio, duración o nombre |
| `eliminar servicio [nombre]` | Desactivar servicio |

### Bot, pagos y clientes

| Comando | Descripción |
|---|---|
| `ver pausados` | Números con bot pausado (esperando atención humana) |
| `activar [número]` | Reactivar bot para ese número |
| `ver comprobantes` | Señas pendientes de revisión |
| `revisar [id]` | Confirmar seña y notificar al cliente |
| `resumen diario on` | Activar resumen diario automático a las 8:00 AM |
| `resumen diario off` | Desactivar resumen diario |
| `ver cliente [número]` | Ficha completa del cliente por número |
| `ver cliente [nombre]` | Buscar cliente por nombre (parcial) |

---

## Estructura del proyecto

```
├── index.js                   # Punto de entrada
├── tray-app.js                # Punto de entrada de la app de bandeja (Electron)
├── ecosystem.config.js        # Configuración PM2
├── .env                       # Variables de entorno (no commitear)
├── data/
│   └── bot.db                 # Base de datos SQLite
├── logs/
│   └── app.log                # Logs de aplicación
├── uploads/                   # Comprobantes de seña recibidos
├── scripts/
│   └── generate-icons.js      # Genera los íconos PNG de la app de bandeja
├── tray/
│   ├── assets/                # Íconos generados (icon-on.png, icon-off.png)
│   └── tray.js                # Lógica del ícono en la bandeja del sistema
└── src/
    ├── config/
    │   └── messages.js        # Todos los textos del bot (editá acá para cambiar mensajes)
    ├── db/
    │   ├── initDB.js          # Esquema de tablas y migraciones
    │   ├── queries.js         # Acceso a datos (SQL)
    │   └── seed.js            # Datos iniciales (servicios, horario)
    ├── handlers/
    │   ├── adminHandler.js    # Comandos del administrador
    │   ├── calendarHandler.js # Integración Google Calendar
    │   ├── clientHandler.js   # Flujo del cliente (agendamiento, gestión, historial)
    │   ├── messageRouter.js   # Enrutador de mensajes entrantes
    │   └── whatsappHandler.js # Setup del cliente WhatsApp
    └── utils/
        └── logger.js          # Winston logger
```

---

## Checklist de pruebas

### Flujo del cliente — nuevo

- [ ] Enviar "hola" → menú con opciones 1 y 2
- [ ] Elegir 1 → pide nombre y apellido
- [ ] Ingresar nombre → lista de categorías
- [ ] Elegir categoría → lista de servicios con precio y duración
- [ ] Elegir servicio → pregunta si agrega otro
- [ ] Agregar otro servicio de diferente categoría → combina duración y precio
- [ ] Continuar → lista de fechas disponibles
- [ ] Elegir fecha → lista de horarios con opción "⬅️ Volver"
- [ ] Elegir horario → pregunta sobre seña
- [ ] Elegir "sí" → muestra CBU y alias, luego resumen
- [ ] Confirmar con "SI" → turno confirmado, espera comprobante
- [ ] Enviar imagen → "Comprobante recibido"
- [ ] Elegir "no" a la seña → turno confirmado sin seña
- [ ] Admin recibe notificación con nombre y servicio (sin teléfono)

### Flujo del cliente — que vuelve

- [ ] Sin turnos activos → menú con 3 opciones (sin "Mis turnos")
- [ ] Con turnos activos → menú con 4 opciones (incluye "Mis turnos")
- [ ] Elegir historial → lista de visitas con estadísticas
- [ ] Escribir "mi historial" → mismo resultado desde cualquier punto

### Gestión de turnos por el cliente

- [ ] "mis turnos" → lista con ✅/⏳ y instrucciones al pie
- [ ] "cancelar turno" con un solo turno → pide confirmación directa
- [ ] "cancelar turno" con varios → pide elegir número
- [ ] Confirmar cancelación → turno eliminado, admin notificado
- [ ] "modificar turno" → pregunta si cambia fecha o horario
- [ ] Cambiar fecha → nueva lista de días disponibles
- [ ] Cambiar horario (mismo día) → lista de horarios libres
- [ ] Confirmar modificación → turno anterior eliminado, uno nuevo creado

### Detección de llegada

- [ ] Mandar "estoy abajo" → bot no responde, admin recibe notificación
- [ ] Mandar "llegué" → mismo resultado
- [ ] Con turno hoy, mandar cualquier mensaje dentro de ±30 min → reenvía al admin
- [ ] Con turno hoy, mandar mensaje fuera de la ventana → flujo normal

### Panel del administrador

- [ ] `ver turnos` → hoy y próximos 3 días
- [ ] `cancelar turno [nombre]` → cliente recibe aviso
- [ ] `agregar turno` → flujo completo, cliente recibe confirmación
- [ ] `horario laboral lun-vie 09:00-18:00` + `horario laboral sab 09:00-15:00` → ambos conviven
- [ ] `ver horarios` → muestra los dos bloques de horario
- [ ] `quitar horario sab` → sábado deja de tener turnos disponibles
- [ ] `bloquear DD/MM` → esa fecha desaparece de la disponibilidad
- [ ] `agregar servicio` → aparece en el flujo del cliente
- [ ] `editar servicio` → precio actualizado se refleja en el resumen del turno
- [ ] `ver comprobantes` → lista pendientes
- [ ] `revisar [id]` → cliente recibe "Seña confirmada"
- [ ] `ver pausados` → lista números en espera
- [ ] `activar [número]` → cliente recibe "Ya podés escribirnos"
- [ ] `resumen diario on` → llega a las 8:00 en días laborales
- [ ] `ver cliente [número]` → muestra estadísticas e historial completo
- [ ] `ver cliente [nombre parcial]` con varios resultados → lista numerada

### App de bandeja

- [ ] `npm run tray` → ícono aparece en la bandeja del sistema
- [ ] Ícono gris al iniciar, verde cuando el bot está conectado
- [ ] Clic derecho → menú con las opciones correctas
- [ ] "Detener bot" → ícono pasa a gris
- [ ] "Iniciar bot" → ícono vuelve a verde
- [ ] "Iniciar con Windows" → tilde se activa/desactiva correctamente
- [ ] "Salir" → ícono desaparece y el bot se detiene

### Infraestructura

- [ ] `GET /health` responde `{ status: "ok", whatsapp: "connected", db: "ok" }`
- [ ] Detener el bot, enviar mensajes, reiniciar → esos mensajes no generan saludos
- [ ] Matar el proceso → PM2 lo reinicia automáticamente
- [ ] Terminal muestra warning si `SENA_CBU` está vacío al iniciar

### Google Calendar (si está configurado)

- [ ] Agendar turno → evento aparece en Google Calendar
- [ ] Cancelar turno → evento eliminado de Calendar
- [ ] Modificar turno → evento viejo eliminado, uno nuevo creado
- [ ] `GET /health` muestra `"googleCalendar": "authorized"`
