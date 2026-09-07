# Nefertiti Bot 💬📅

> **A full-featured WhatsApp appointment assistant** — customers book, check, reschedule and cancel appointments entirely through a chat conversation, and the owner manages the whole agenda from their phone.
> _Asistente de turnos por WhatsApp — los clientes agendan, consultan, reprograman y cancelan turnos por chat, y el dueño gestiona toda la agenda desde el celular._

**Stack:** Node.js · whatsapp-web.js · SQLite · Express · Google Calendar API · node-cron · Electron

---

## 📸 Screenshots / Capturas

> _Add a screenshot of a real conversation here — el flujo de reserva paso a paso y el panel de administración._

| Booking flow | Admin panel |
|:---:|:---:|
| _(pegar captura de WhatsApp)_ | _(pegar captura)_ |

<!-- Tip: guardá las imágenes en docs/screenshots/ y referencialas: ![Reserva](docs/screenshots/booking.png) -->

---

## 🇬🇧 English

### What is it?
A conversational WhatsApp bot that runs the appointment booking for a beauty/aesthetics business end to end. Customers interact in plain chat; the bot walks them through a **guided conversational flow** (service → date → time → confirmation → optional deposit), remembers returning customers, and keeps the owner's calendar in sync — no app to install, no web form.

Built from scratch and packaged as a **one-click desktop app**: the owner just starts it from the system tray.

### Key features
- **Guided conversational flow** with intent routing and per-conversation **state management** — the bot tracks where each customer is in the booking process and adapts the menu accordingly.
- **Personalized experience** — returning customers get a tailored greeting with their last service; "My appointments" only appears for customers who actually have active bookings.
- **Self-service** — customers can view, cancel and reschedule their own appointments.
- **Full admin panel over WhatsApp** (via a second number) — the owner manages the entire agenda from their phone.
- **Google Calendar integration** — every booking creates/updates a calendar event automatically.
- **Deposit handling** — sends bank details and accepts transfer receipts as images.
- **Per-customer history & stats** — services, spend and visit statistics.
- **Arrival detection** — notifies the admin when a customer says they've arrived, without interrupting the customer's flow.
- **Automated daily summary** to the admin, configurable working hours per day, and structured logging (Winston).
- **Desktop system-tray app** (Electron) — start/stop the bot without touching a terminal; auto-restart with PM2.

### Architecture highlights
- **Clean separation of concerns** — a message router dispatches to dedicated handlers (`clientHandler`, `adminHandler`, `calendarHandler`, `whatsappHandler`), with a data layer (`db/queries.js`) over SQLite (`better-sqlite3`) and centralized message templates.
- **Conversational state machine** — booking is modeled as explicit steps with validation at each stage (working hours, availability, deposit).
- **Third-party integration** — OAuth2 flow against the Google Calendar API through a small Express server, plus scheduled jobs (`node-cron`) for the daily summary and reminders.

> ℹ️ **On AI:** this bot is rule-based (a deterministic conversational state machine), not LLM-powered. It's included here because the architecture — intent routing, integrations and context/state management — is exactly the foundation an agentic-AI assistant is built on.

### Tech stack
| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Messaging | whatsapp-web.js |
| Database | SQLite (`better-sqlite3`) |
| Server / OAuth | Express |
| Integrations | Google Calendar API |
| Scheduling | node-cron |
| Logging | Winston |
| Desktop app | Electron (system tray) + PM2 |

### Setup
Full installation and configuration guide: [`docs/INSTALL.md`](docs/INSTALL.md).
Secrets are **not** included (`.env` is git-ignored) — see `.env.example`.

---

## 🇦🇷 Español

### ¿Qué es?
Un bot conversacional de WhatsApp que gestiona de punta a punta los turnos de un local de belleza/estética. Los clientes interactúan por chat común; el bot los guía con un **flujo conversacional** (servicio → fecha → horario → confirmación → seña opcional), reconoce a los clientes que vuelven y mantiene el calendario del dueño sincronizado — sin app que instalar ni formulario web.

Hecho desde cero y empaquetado como **app de escritorio de un clic**: el dueño lo inicia desde la bandeja del sistema.

### Funcionalidades principales
- **Flujo conversacional guiado** con enrutamiento de intención y **gestión de estado** por conversación — el bot sabe en qué paso está cada cliente y adapta el menú.
- **Experiencia personalizada** — los clientes que vuelven reciben un saludo con su último servicio; "Mis turnos" aparece solo si tienen reservas activas.
- **Autogestión** — los clientes pueden ver, cancelar y reprogramar sus propios turnos.
- **Panel de administración completo por WhatsApp** (segundo número) — el dueño maneja toda la agenda desde el celular.
- **Integración con Google Calendar** — cada turno crea/actualiza un evento automáticamente.
- **Manejo de señas** — envía datos bancarios y recibe comprobantes de transferencia por imagen.
- **Historial y estadísticas por cliente** — servicios, gasto y estadísticas de visitas.
- **Detección de llegada** — avisa al admin cuando el cliente llegó, sin interrumpir su conversación.
- **Resumen diario automático** al admin, horario laboral configurable por día y logging estructurado (Winston).
- **App de bandeja del sistema** (Electron) — iniciar/detener el bot sin terminal; reinicio automático con PM2.

### Aspectos de arquitectura
- **Separación de responsabilidades** — un router de mensajes despacha a handlers dedicados (`clientHandler`, `adminHandler`, `calendarHandler`, `whatsappHandler`), con una capa de datos (`db/queries.js`) sobre SQLite (`better-sqlite3`) y plantillas de mensajes centralizadas.
- **Máquina de estados conversacional** — la reserva se modela como pasos explícitos con validación en cada etapa (horario, disponibilidad, seña).
- **Integración con terceros** — flujo OAuth2 contra la API de Google Calendar mediante un pequeño servidor Express, más tareas programadas (`node-cron`) para el resumen diario y recordatorios.

> ℹ️ **Sobre la IA:** este bot es basado en reglas (una máquina de estados conversacional determinística), no usa un LLM. Se incluye acá porque su arquitectura — enrutamiento de intención, integraciones y manejo de contexto/estado — es justamente la base sobre la que se construye un asistente de IA agéntica.

### Instalación
Guía completa de instalación y configuración: [`docs/INSTALL.md`](docs/INSTALL.md).
Las credenciales **no** se incluyen (`.env` está en `.gitignore`) — ver `.env.example`.

---

_Built with Node.js, whatsapp-web.js & Electron._
