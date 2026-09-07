# Roadmap — Modelo de licencias y SaaS

> Registrado: Mayo 2026

---

## Contexto

El bot fue diseñado para un solo salón en una sola computadora. Hay interés de terceros en adquirirlo como servicio. Este documento registra los dos caminos posibles y la estrategia recomendada para monetizarlo.

---

## Camino A — Modelo de licencias (recomendado para empezar)

Cada cliente instala el bot en su propia computadora, igual que ahora. La diferencia es que el bot requiere una clave de activación mensual válida para funcionar. Sin clave activa, no arranca.

### Qué hay que construir

**1. Sistema de licencias**
- API propia (puede ser un servidor Node.js simple en un VPS barato)
- Al arrancar el bot, valida la clave contra la API
- Si la clave es válida y está activa, el bot inicia normalmente
- Si la clave venció o es inválida, muestra un mensaje y no arranca
- La validación puede hacerse una vez al día (no en cada mensaje) para no depender de conexión constante

**2. Panel de gestión (web simple)**
- Lista de clientes activos
- Estado de cada licencia (activa / vencida / suspendida)
- Generación de nuevas claves
- Historial de pagos

**3. Sistema de cobro**
- MercadoPago Subscriptions para Argentina (cobro automático mensual)
- O cobro manual + activación manual de clave (más simple para empezar)

**4. Instalador personalizado por cliente**
- El instalador actual ya funciona bien
- Solo hay que agregar un paso en el wizard donde el cliente ingresa su clave de licencia

### Ventajas
- No requiere infraestructura costosa
- Cada cliente es responsable de su computadora y conexión
- Rápido de implementar (pocas semanas)
- Fácil de escalar: agregar clientes no agrega costo de servidor

### Desventajas
- El bot depende de que la computadora del cliente esté encendida
- Si el cliente tiene problemas de hardware o internet, el bot se cae
- Las actualizaciones hay que distribuirlas (aunque electron-builder tiene auto-update)

---

## Camino B — SaaS real en la nube (para cuando escale)

El bot corre en servidores propios. El cliente no instala nada: paga y usa desde un panel web. Cada salón tiene su sesión de WhatsApp en la infraestructura propia.

### Qué hay que construir

- Servidor Linux (VPS) con múltiples instancias de Chrome/Puppeteer (una por cliente)
- Base de datos separada por cliente (o shared con aislamiento por tenant_id)
- Panel web de administración para cada salón
- Sistema de pagos integrado
- Migración a la **API oficial de WhatsApp Business (Meta Cloud API)**

### Por qué la API oficial de WhatsApp

WhatsApp Web.js es una librería no oficial que simula el navegador. Para uso personal o un solo salón el riesgo es bajo. Pero para un servicio comercial con muchos clientes simultáneos, Meta puede bloquear las cuentas. La API oficial es paga por mensaje pero es estable, legal y diseñada para este uso.

- Costo aproximado: USD 0.02–0.05 por conversación (depende del país y tipo de mensaje)
- Requiere aprobación de Meta y número de teléfono dedicado por cliente
- Soporta plantillas de mensajes aprobadas

### Cuándo tiene sentido pasar al Camino B
A partir de 10–15 clientes activos, cuando el Camino A empiece a mostrar sus limitaciones operativas.

---

## Estrategia recomendada

```
Ahora          →  Camino A: licencias + MercadoPago
10-15 clientes →  Evaluar migración a Camino B con API oficial
```

1. Validar que el mercado paga (Camino A)
2. Con ingresos estables, invertir en infraestructura (Camino B)
3. Migrar clientes existentes al nuevo modelo

---

## Próximos pasos técnicos (Camino A)

- [ ] Definir precio mensual y modelo de cobro (manual vs automático)
- [ ] Crear API de validación de licencias (Node.js + SQLite o PostgreSQL)
- [ ] Agregar paso de "ingreso de clave" en el wizard de setup
- [ ] Integrar validación al arranque del bot en `tray-app.js`
- [ ] Crear panel web básico de gestión de licencias
- [ ] Integrar MercadoPago (cobro automático — ya definido)
- [ ] Configurar auto-update en electron-builder para distribuir actualizaciones

---

## Agente IA (v2 — en diseño)

Antes del modelo SaaS se va a desarrollar una versión del bot con agente IA híbrido
(FSM + Claude Haiku). El diseño completo está documentado en:

`docs/AGENTE-IA-DISEÑO.md`

Esta versión va en rama git `feature/agente-ia` y se fusionará a `main`
cuando esté estable. El modelo SaaS se construirá sobre la v2 con agente.

---

## Notas adicionales

- El bot actual ya está bien estructurado para multi-tenant futuro: toda la config va en `.env` y la DB en `USER_DATA_PATH`, lo que hace fácil aislar datos por cliente.
- El wizard de setup es reutilizable tal como está; solo hay que agregar el campo de clave de licencia.
- Considerar un período de prueba gratuito (7-14 días) para reducir la fricción de entrada.
