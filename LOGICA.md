# Bot Nefertiti — Documentación técnica

> Última actualización: Mayo 2026

---

## Índice

1. [Visión general](#1-visión-general)
2. [Arquitectura del proyecto](#2-arquitectura-del-proyecto)
3. [Base de datos](#3-base-de-datos)
4. [Flujo del cliente](#4-flujo-del-cliente)
5. [Flujo del admin](#5-flujo-del-admin)
6. [Protecciones anti-spam y anti-confusión](#6-protecciones-anti-spam-y-anti-confusión)
7. [Integración con Google Calendar](#7-integración-con-google-calendar)
8. [Sistema de horarios y disponibilidad](#8-sistema-de-horarios-y-disponibilidad)
9. [Seña y comprobantes](#9-seña-y-comprobantes)
10. [Aplicación de escritorio (Electron)](#10-aplicación-de-escritorio-electron)
11. [Configuración y variables de entorno](#11-configuración-y-variables-de-entorno)
12. [Decisiones de diseño relevantes](#12-decisiones-de-diseño-relevantes)

---

## 1. Visión general

Bot de WhatsApp para la gestión de turnos de un salón de belleza. Permite a los clientes agendar, cancelar y modificar turnos de forma autónoma. El admin (Celi) gestiona la agenda, servicios y configuración directamente desde WhatsApp.

**Stack:**
- **WhatsApp Web.js** — cliente de WhatsApp vía Puppeteer
- **better-sqlite3** — base de datos embebida (sin servidor)
- **Google Calendar API** — sincronización de turnos
- **Electron** — empaquetado como aplicación de escritorio Windows
- **Express** — endpoint `/health` para monitoreo

---

## 2. Arquitectura del proyecto

```
asistente para nefertiti/
├── index.js                    # Punto de entrada del bot
├── tray-app.js                 # Punto de entrada de Electron
├── tray/
│   ├── tray.js                 # Ícono de bandeja y control del proceso bot
│   ├── setup-window.js         # Wizard de configuración inicial
│   ├── qr-window.js            # Ventana QR para reconexiones
│   ├── setup.html              # UI del wizard (3 pasos)
│   └── qr.html                 # UI de la ventana QR
├── src/
│   ├── handlers/
│   │   ├── whatsappHandler.js  # Punto de entrada de mensajes WhatsApp
│   │   ├── clientHandler.js    # Lógica del flujo del cliente
│   │   ├── adminHandler.js     # Lógica del flujo del admin
│   │   └── calendarHandler.js  # Integración Google Calendar
│   ├── db/
│   │   ├── initDB.js           # Creación de tablas y migraciones
│   │   ├── queries.js          # Todas las consultas SQL
│   │   └── seed.js             # Datos iniciales (servicios)
│   ├── config/
│   │   └── messages.js         # Todos los textos del bot (centralizado)
│   └── utils/
│       ├── logger.js           # Winston logger con rotación de archivos
│       └── formatContact.js    # Helpers de formato de teléfonos y nombres
└── data/
    └── bot.db                  # SQLite (en desarrollo; en producción va a %APPDATA%)
```

### Flujo de arranque (app empaquetada)

```
tray-app.js
  └─ ¿Existe .env en userData?
       NO → openSetup() → wizard 3 pasos → escribe .env
       SÍ → initTray(userData)
                └─ startBot() → utilityProcess.fork(index.js)
                                    └─ index.js se inicializa
                                         ├─ initDB()
                                         ├─ seedIfEmpty()
                                         ├─ Express en puerto 3000
                                         └─ WhatsApp client.initialize()
```

### Comunicación Electron ↔ Bot

El bot corre como `utilityProcess` (Node.js embebido en Electron). La comunicación es unidireccional (bot → main) vía `process.parentPort.postMessage()`:

| Evento        | Cuándo se emite                         | Qué hace el main process         |
|---------------|----------------------------------------|----------------------------------|
| `qr`          | WhatsApp pide escanear QR              | Abre ventana QR o la actualiza   |
| `authenticated` | Sesión autenticada exitosamente      | Cierra ventana QR                |
| `ready`       | Bot conectado y listo                  | Cierra wizard de setup si está abierto |

---

## 3. Base de datos

SQLite embebida. En producción se guarda en `%APPDATA%\bot-turnos-whatsapp\bot.db`.

### Tablas

**`conversations`** — estado de cada conversación activa
```sql
phone_number  TEXT UNIQUE   -- número normalizado (solo dígitos, sin +)
bot_active    INTEGER       -- 1 = bot responde, 0 = pausado
current_step  TEXT          -- estado actual del FSM
step_data     TEXT          -- JSON con datos del paso actual
updated_at    TEXT
```

**`appointments`** — turnos confirmados
```sql
phone_number      TEXT      -- "manual" si lo agregó el admin sin teléfono
client_name       TEXT
service_name      TEXT
service_duration  INTEGER   -- en minutos
service_price     REAL
appointment_date  TEXT      -- formato YYYY-MM-DD
appointment_time  TEXT      -- formato HH:MM
seña_paid         INTEGER   -- 0/1
calendar_event_id TEXT      -- ID del evento en Google Calendar
```

**`services`** — catálogo de servicios
```sql
name             TEXT UNIQUE
duration_minutes INTEGER
price            REAL
active           INTEGER    -- 0 = desactivado pero no borrado
category         TEXT       -- 'manos', 'pies', 'cejas_pestanas'
sort_order       INTEGER
```

**`blocked_slots`** — bloqueos manuales de horario
```sql
date        TEXT            -- YYYY-MM-DD
start_time  TEXT            -- HH:MM (null si full_day)
end_time    TEXT
full_day    INTEGER         -- 1 = día completo bloqueado
```

**`pending_receipts`** — comprobantes de seña pendientes de revisión
```sql
phone_number    TEXT
image_url       TEXT
appointment_id  INTEGER
reviewed        INTEGER     -- 0/1
```

**`settings`** — configuración dinámica (clave-valor)

Claves relevantes:
- `working_hours` — JSON con los bloques de horario laboral
- `google_refresh_token` — token OAuth para Calendar
- `daily_summary` — `"on"` o `"off"`

---

## 4. Flujo del cliente

El flujo es una **máquina de estados finitos (FSM)**. El estado se persiste en la tabla `conversations` por número de teléfono.

### Estados y transiciones

```
IDLE / sin registro
    │
    ▼
WAITING_OPTION          ← "hola", "menú", palabras de reset
    │
    ├─ "1" / agendar ──► ASKING_NAME
    ├─ "2" / hablar  ──► bot pausado, notifica admin
    ├─ "3" / mis turnos (si tiene) ──► lista de turnos
    └─ "3"/"4" / historial ──► muestra historial

ASKING_NAME
    └─ nombre y apellido ──► SELECTING_CATEGORY

SELECTING_CATEGORY
    └─ "1"/"2"/"3" ──► SELECTING_SERVICE (filtra por categoría)

SELECTING_SERVICE
    ├─ número de servicio ──► ASKING_MORE_SERVICES
    └─ selección múltiple acumulada ──► SELECTING_DATE

ASKING_MORE_SERVICES
    ├─ "sí" ──► SELECTING_SERVICE (misma categoría, sin los ya elegidos)
    └─ "no"  ──► SELECTING_DATE

SELECTING_DATE
    └─ número de día ──► SELECTING_TIME

SELECTING_TIME
    └─ número de horario ──► ASKING_SEÑA

ASKING_SEÑA
    ├─ "1" / sí ──► WAITING_RECEIPT (envía datos de transferencia)
    └─ "2" / no ──► CONFIRMING

WAITING_RECEIPT
    └─ imagen recibida ──► CONFIRMING (guarda comprobante)

CONFIRMING
    ├─ "sí" ──► turno creado en DB + Calendar, bot vuelve a IDLE
    └─ "no" ──► reinicia flujo
```

### Disponibilidad de días

- Se escanean los próximos **21 días** buscando hasta **7 días** con al menos un slot libre.
- Se hace **una sola llamada a Calendar** para todo el rango (optimización).
- Los slots se filtran cruzando: horario laboral + turnos existentes en DB + eventos de Calendar.
- No hay límite en la cantidad de horarios mostrados por día.

### Detección de llegada al local

Si un cliente con turno ese día (±30 min) manda frases como "estoy abajo", "llegué", "ya estoy", el bot notifica al admin con el nombre y turno del cliente.

### Historial y cliente recurrente

- Al iniciar el flujo, el bot consulta el historial del cliente.
- Si ya tiene visitas anteriores, el saludo es personalizado e incluye el último servicio.
- Si tiene turnos futuros activos, aparece la opción "Mis turnos".

---

## 5. Flujo del admin

El admin se identifica por su número (`ADMIN_PHONE` en `.env`). Los mensajes del admin se procesan en `adminHandler.js`.

### Comandos disponibles

#### Turnos
| Comando | Descripción |
|---------|-------------|
| `ver turnos` | Muestra turnos de hoy y los próximos 3 días |
| `ver turnos DD/MM` | Muestra turnos de un día específico |
| `cancelar turno [nombre apellido]` | Busca y cancela un turno; notifica al cliente (excepto turnos manuales) |
| `agregar turno` | Inicia el flujo interactivo de carga manual |

#### Disponibilidad
| Comando | Descripción |
|---------|-------------|
| `ver horarios` | Muestra horario laboral actual y bloqueos próximos 7 días |
| `bloquear DD/MM` | Bloquea un día completo |
| `bloquear DD/MM HH:MM-HH:MM` | Bloquea un rango horario |
| `desbloquear DD/MM` | Quita todos los bloqueos de un día |
| `horario laboral [rango] HH:MM-HH:MM` | Configura o actualiza el horario laboral (ej: `horario laboral lun-vie 09:00-18:00`) |
| `quitar horario [rango]` | Elimina días del horario laboral |

#### Servicios
| Comando | Descripción |
|---------|-------------|
| `ver servicios` | Lista todos los servicios activos con precio y duración |
| `agregar servicio` | Flujo interactivo para crear un servicio |
| `editar servicio [nombre]` | Modifica precio o duración |
| `eliminar servicio [nombre]` | Desactiva un servicio |

#### Clientes y bot
| Comando | Descripción |
|---------|-------------|
| `ver pausados` | Lista clientes con bot pausado |
| `activar [número]` | Reactiva el bot para un cliente y lo notifica |
| `pausar [número]` | Pausa manualmente el bot para un cliente |
| `ver cliente [número o nombre]` | Muestra historial, estadísticas y próximo turno |
| `ver comprobantes` | Lista comprobantes de seña pendientes de revisión |
| `revisar [id]` | Marca un comprobante como revisado y notifica al cliente |
| `resumen diario on/off` | Activa o desactiva el resumen automático de cada mañana |

#### Configuración
| Comando | Descripción |
|---------|-------------|
| `conectar calendar` | Genera URL de autorización OAuth para Google Calendar |
| `ayuda` | Muestra este menú |

### Flujo "agregar turno" (admin)

Estados del FSM interno del admin:

```
ADMIN_IDLE
    └─ "agregar turno" ──► ADMIN_ADD_TURN_NAME

ADMIN_ADD_TURN_NAME      (pide nombre del cliente)
    └─ nombre ──► ADMIN_ADD_TURN_CATEGORY

ADMIN_ADD_TURN_CATEGORY  (elige categoría)
    └─ número ──► ADMIN_ADD_TURN_SERVICE

ADMIN_ADD_TURN_SERVICE   (elige servicio de la categoría)
    └─ número ──► ADMIN_ADD_TURN_MORE

ADMIN_ADD_TURN_MORE      (¿agregar otro servicio?)
    ├─ "sí" ──► ADMIN_ADD_TURN_SERVICE
    └─ "no"  ──► ADMIN_ADD_TURN_MODE

ADMIN_ADD_TURN_MODE      (¿horario normal o fuera de horario?)
    ├─ "1" normal ──► ADMIN_ADD_TURN_DATE
    └─ "2" fuera  ──► ADMIN_ADD_TURN_OOH_DATE

ADMIN_ADD_TURN_DATE      (muestra días disponibles)
    └─ número ──► ADMIN_ADD_TURN_TIME (o ingreso manual DD/MM)

ADMIN_ADD_TURN_OOH_DATE  (ingreso libre de fecha DD/MM)
    └─ DD/MM ──► ADMIN_ADD_TURN_OOH_TIME

ADMIN_ADD_TURN_TIME / ADMIN_ADD_TURN_OOH_TIME
    └─ horario ──► ADMIN_ADD_TURN_CONFIRM

ADMIN_ADD_TURN_CONFIRM   (resumen + confirmación)
    ├─ "sí" ──► turno creado, phone_number = 'manual'
    └─ "no"  ──► cancelado
```

**Nota importante:** Los turnos agregados por el admin tienen `phone_number = 'manual'`. Al cancelarlos, el bot **no intenta enviarles un mensaje** de WhatsApp.

---

## 6. Protecciones anti-spam y anti-confusión

Implementadas en `clientHandler.js`. Todas son en memoria (se resetean al reiniciar el bot).

### Detección de bots (`looksLikeBot`)

Descarta mensajes antes de procesarlos si:
- Provienen de grupos (`@g.us`)
- Son mensajes de estado/broadcast
- El cuerpo está vacío **y** no hay imagen adjunta (excepción para comprobantes)
- El cuerpo supera 500 caracteres
- El cuerpo contiene URLs (`https?://`)

### Rate limiting (`isRateLimited`)

- Límite: **5 mensajes por minuto** por número
- Si se supera, el mensaje se ignora silenciosamente (sin respuesta al cliente)
- La ventana se resetea automáticamente cada 60 segundos

### Detección de cliente confundido (`registerInvalidResponse`)

- Conteo de respuestas inválidas consecutivas por número (en memoria)
- Al llegar a **3 respuestas inválidas seguidas**:
  1. Envía al cliente: *"Parece que estás teniendo dificultades 😊 Voy a pedirle a Celi que te contacte personalmente."*
  2. Pausa el bot para ese número (`setBotActive(phone, false)`)
  3. Notifica al admin con el nombre/número del cliente
- El contador se resetea automáticamente con cada avance de estado exitoso (dentro de `transitionTo`)
- Cobertura: 14 puntos de entrada inválida en los estados WAITING_OPTION, ASKING_NAME, SELECTING_CATEGORY, SELECTING_SERVICE, ASKING_MORE_SERVICES, SELECTING_DATE, SELECTING_TIME, ASKING_SEÑA, CONFIRMING y los 5 estados de gestión de turnos

---

## 7. Integración con Google Calendar

### Autorización OAuth

1. Admin escribe `conectar calendar`
2. El bot genera una URL de autorización y la envía al admin
3. Admin abre la URL en el navegador, autoriza el acceso
4. Google redirige a `http://localhost:3000/auth/google/callback` con un código
5. El bot intercambia el código por un `refresh_token` y lo guarda en la tabla `settings`
6. A partir de ese momento, el bot usa el token automáticamente (lo renueva cuando expira)

### Operaciones implementadas

- **Crear evento**: al confirmar un turno, se crea un evento en el calendario primario con nombre del cliente, servicio y duración
- **Borrar evento**: al cancelar un turno (si tiene `calendar_event_id`)
- **Listar eventos**: para filtrar disponibilidad cruzando con la agenda de Calendar
- **`filterSlotsWithEvents`**: descarta slots de DB que se solaparían con eventos existentes en Calendar

### Fallback sin Calendar

Si Calendar no está configurado o hay un error de red, el bot continúa funcionando usando solo la DB. El error se loguea como `warn` (no rompe el flujo).

---

## 8. Sistema de horarios y disponibilidad

### Horario laboral

Se guarda en `settings` bajo la clave `working_hours` como un array JSON:

```json
[
  { "days": [1, 2, 3, 4, 5], "open": "09:00", "close": "18:00" },
  { "days": [6],              "open": "09:00", "close": "15:00" }
]
```

Los días usan el formato de JavaScript: `0 = domingo, 1 = lunes, ..., 6 = sábado`.

### Cálculo de slots disponibles

La función `getAvailableSlots(date, durationMinutes)` en `queries.js`:
1. Obtiene el horario laboral del día
2. Genera todos los slots posibles cada 30 minutos en ese rango
3. Descarta slots donde ya hay un turno (con solapamiento por duración)
4. Descarta slots bloqueados manualmente
5. Descarta el último slot del día si la duración del servicio lo haría terminar fuera del horario

**Regla para turnos fuera de horario (admin):** Los turnos cargados en modo "fuera de horario" se guardan directamente sin pasar por el filtro de disponibilidad. No afectan a los clientes (no ocupan slots visibles en el flujo cliente).

---

## 9. Seña y comprobantes

### Flujo de seña

1. Al confirmar el turno, se ofrece al cliente dejar una seña
2. Si acepta, se le envían los datos de transferencia (monto, CBU, alias desde `.env`)
3. El cliente manda el comprobante como imagen
4. El comprobante se guarda en `pending_receipts`
5. El admin recibe notificación y puede escribir `revisar [id]`
6. Al revisar, se actualiza `seña_paid = 1` en el turno y se notifica al cliente

### Resumen diario

Si `daily_summary = "on"` en settings, cada día a las 8:00 AM el bot envía al admin un resumen con todos los turnos del día, incluyendo nombre del cliente, servicio, horario, precio y estado de seña.

---

## 10. Aplicación de escritorio (Electron)

### Empaquetado

```bash
npx electron-rebuild -f -w better-sqlite3   # ANTES del build
npm run build                                # genera instalador en /dist
npm rebuild better-sqlite3                   # restaurar para desarrollo
```

### Rutas de datos (producción)

| Archivo | Ruta |
|---------|------|
| `.env` | `%APPDATA%\bot-turnos-whatsapp\.env` |
| `bot.db` | `%APPDATA%\bot-turnos-whatsapp\bot.db` |
| Sesión WhatsApp | `%APPDATA%\bot-turnos-whatsapp\.wwebjs_auth\` |
| Logs | `%APPDATA%\bot-turnos-whatsapp\logs\` |

La variable `USER_DATA_PATH` se pasa al proceso bot para que sepa dónde leer/escribir todos los archivos.

### Wizard de configuración (primer arranque)

Al instalar por primera vez, si no existe el `.env`, se abre automáticamente un wizard de 3 pasos:
1. **Datos básicos**: teléfono del admin, monto de seña, CBU, alias
2. **Google Calendar** (opcional): Client ID y Client Secret
3. **QR de WhatsApp**: escanear para vincular la cuenta

### Opción "Configuración" en la bandeja

Disponible haciendo clic derecho en el ícono de la bandeja. Abre el mismo wizard con los valores actuales precargados. Al guardar, el bot se reinicia automáticamente.

---

## 11. Configuración y variables de entorno

Archivo `.env` (en `%APPDATA%\bot-turnos-whatsapp\` en producción):

```env
ADMIN_PHONE=549XXXXXXXXXX          # Número del admin con código de país
SENA_MONTO=10000                   # Monto de la seña en pesos
SENA_CBU=                          # CBU para transferencias
SENA_ALIAS=                        # Alias para transferencias
PORT=3000
NODE_ENV=production
TZ=America/Argentina/Buenos_Aires

# Google Calendar OAuth2 (opcional)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
GOOGLE_CALENDAR_ID=primary
```

---

## 12. Decisiones de diseño relevantes

### Por qué `phone_number = 'manual'` para turnos admin
Los turnos cargados por el admin no tienen número de WhatsApp del cliente. Usar la cadena literal `'manual'` como valor permite identificar estos casos y evitar intentar enviar mensajes a un número inválido al cancelar.

### Por qué no hay límite de slots mostrados
Originalmente había un `MAX_SLOTS = 6`. Se eliminó porque en días con mucha disponibilidad el cliente no podía ver todos los horarios. Ahora se muestran todos los horarios libres del día.

### Por qué `looksLikeBot` no descarta imágenes sin texto
Los comprobantes de seña llegan como imágenes con `msg.body` vacío. Descartar todos los mensajes con cuerpo vacío hubiera roto el flujo de pago.

### Por qué `resetConfusionCount` vive dentro de `transitionTo`
Así cualquier avance de estado real resetea automáticamente el contador de confusión, sin tener que agregarlo manualmente en cada handler.

### Por qué se usa `utilityProcess` en lugar de `child_process.spawn`
`utilityProcess` es el mecanismo nativo de Electron para procesos Node.js auxiliares. Tiene acceso a los módulos nativos del runtime de Electron (mismo ABI), lo que evita el problema de versión de `better-sqlite3`. En desarrollo se usa `spawn` normal para simplicidad.

### Normalización de teléfonos
Los números se almacenan y comparan siempre sin el `+` y sin espacios (solo dígitos). `cleanPhone()` en `formatContact.js` normaliza cualquier formato de entrada. `formatContact()` formatea para mostrar al admin como `+54 9 11 XXXX-XXXX` o el nombre si está disponible.
