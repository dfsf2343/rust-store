# Rust Store

Sitio web (en inglés), tienda de kits y plugin para un servidor de Rust 3x.

- `web/`: frontend React. Inicio con estado del server y cuenta regresiva del wipe, tienda, checkout, pedidos, cuenta del jugador, reglas, FAQ, páginas legales y panel de admin.
- `server/`: backend Node.js + TypeScript + SQLite. Login con Steam, catálogo y precios, pagos (Stripe, PayPal, Mercado Pago), webhooks, entregas al plugin y API de admin. Corre en Cloudflare Workers (gratis) o en cualquier VPS con Docker.
- `plugin/WebStore.cs`: plugin para Oxide (uMod) o Carbon. Recibe las compras, aplica cooldowns y entrega los ítems con `/claim`.
- `config/`: todo lo editable sin tocar código (nombre del server, kits, precios, reglas, FAQ, ruteo de pagos).

## Cómo funciona una compra

1. El jugador entra con Steam (así la compra queda en su SteamID).
2. Elige kit y duración. El backend detecta el país del comprador y solo ofrece los métodos de esa región:
   - Estados Unidos: Stripe.
   - Sudamérica: Mercado Pago, cobrado en CLP.
   - Resto del mundo: Stripe y PayPal.
   - Si los métodos de una región no están configurados, se ofrecen los de la lista por defecto.
3. Paga en la página del proveedor. El webhook (o la vuelta al sitio) confirma el pago leyendo el estado real en la API del proveedor y activa el acceso. Si se pierden los dos, un proceso cada 10 minutos revisa los pedidos pendientes.
4. El plugin sincroniza cada 15 s, avisa en el chat y el jugador usa `/claim warlord`.

Comprar el mismo kit otra vez suma tiempo. Un reembolso total, un contracargo o una disputa quitan el acceso automáticamente. Los reembolsos parciales no quitan acceso: el pedido aparece marcado en el panel de admin para que decidas.

## Precios

`config/catalog.json` define 5 kits con precio base de 30 días: 5, 20, 30, 50 y 100 USD. Cada duración multiplica ese precio:

| Kit | 7 días (x0.4) | 30 días (x1) | 90 días (x2.4) | Lifetime (x5) |
|---|---|---|---|---|
| Scrapper | $2 | $5 | $12 | $25 |
| Builder | $8 | $20 | $48 | $100 |
| Ranger | $12 | $30 | $72 | $150 |
| Warlord | $20 | $50 | $120 | $250 |
| Overlord | $40 | $100 | $240 | $500 |

Para fijar un precio exacto en un kit usa `"prices": { "7d": 2.99 }`. Los ítems usan shortnames reales de Rust y solo contenido base del juego con skin 0: las reglas de Facepunch prohíben dar DLC a quien no lo compró.

## Hosting gratis en Cloudflare (recomendado)

El plan gratis de Cloudflare Workers alcanza para la tienda y no pide tarjeta:

- Hosting del sitio con HTTPS en `https://rust-store.TU-SUBDOMINIO.workers.dev`.
- Base de datos SQLite dentro de un Durable Object (5 GB gratis).
- País del comprador detectado por Cloudflare, sin base de datos de IPs.
- Límite de 100.000 peticiones a la API por día. El plugin usa unas 5.800 al día; los archivos del sitio no cuentan.

### 1. Conectar el repositorio

1. En el panel de Cloudflare entra a **Workers & Pages** y elige **Create application**.
2. Elige **GitHub**, autoriza el acceso y selecciona el repositorio `rust-store`.
3. Deja el nombre del Worker como `rust-store` (tiene que coincidir con `wrangler.jsonc`). Deja vacío el Build command y el Deploy command en `npx wrangler deploy`.
4. **Save and Deploy**. El primer despliegue tarda un par de minutos y te muestra la dirección `workers.dev`.

Cada vez que se sube un cambio a la rama principal, Cloudflare vuelve a desplegar solo.

### 2. Variables y secretos

En el Worker: **Settings**, **Variables and Secrets**, **Add**. Usa tipo **Secret** para las claves y **Text** para el resto, y termina con **Deploy**.

| Nombre | Tipo | Valor |
|---|---|---|
| `PLUGIN_SECRET` | Secret | Texto aleatorio de 32+ caracteres. El mismo va en el plugin. |
| `ADMIN_STEAM_IDS` | Text | Tus SteamID64 separados por coma. |
| `STEAM_API_KEY` | Secret | Opcional: nombres y avatares de Steam. https://steamcommunity.com/dev/apikey |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Secret | Credenciales Live de PayPal. |
| `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET` | Secret | Access Token de producción y clave secreta del webhook. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Secret | Clave secreta y secreto del webhook. |

Cada proveedor se activa solo cuando tiene sus dos valores. En producción Stripe y Mercado Pago no se activan sin su secreto de webhook, porque sin él los reembolsos no quitarían el acceso.

La base de datos guarda la dirección del primer acceso a la API. Si después usas un dominio propio, agrega también `BASE_URL` (Text) con esa dirección, por ejemplo `https://tienda.tudominio.com`.

### 3. Dominio propio (opcional)

El dominio tiene que estar en Cloudflare. En el Worker: **Settings**, **Domains & Routes**, **Add**, **Custom Domain**. Después agrega `BASE_URL` como en el paso anterior y actualiza las URLs de los webhooks y del plugin.

### Cambiar kits, precios o textos

Edita los archivos de `config/` en GitHub (se pueden editar desde la web) y guarda el cambio. Cloudflare despliega la nueva versión en un minuto o dos. Si un archivo tiene un error, el despliegue falla y el sitio sigue con la versión anterior.

## Configurar los pagos

Cambia `TU_SITIO` por la dirección del sitio (la de `workers.dev` o tu dominio).

### Stripe

Stripe solo abre cuentas para negocios en países soportados (Chile no está; EE.UU. sí, por ejemplo con una LLC creada con Stripe Atlas). Mientras no esté configurado, los compradores de EE.UU. ven PayPal.

1. Copia la Secret key de https://dashboard.stripe.com/apikeys a `STRIPE_SECRET_KEY`.
2. En Workbench, pestaña **Webhooks**, **Create an event destination**:
   - **Your account**, formato **Snapshot** (no Thin).
   - Eventos: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded` y `charge.dispute.created`.
   - Destino **Webhook endpoint** con la URL `https://TU_SITIO/api/webhooks/stripe`.
   - En la página del endpoint, **Reveal secret** y copia el `whsec_...` a `STRIPE_WEBHOOK_SECRET`.
3. Los métodos de pago (tarjeta, Apple Pay, Google Pay, Link) se activan en la configuración de métodos de pago de Stripe. Opcional en `config/payments.json`: `automaticTax` (requiere Stripe Tax) y `allowPromotionCodes`.

### Mercado Pago

1. En el panel de desarrolladores crea una aplicación de Checkout Pro y copia el Access Token de producción a `MERCADOPAGO_ACCESS_TOKEN`.
2. En los detalles de la aplicación, sección **Webhooks**: URL de producción `https://TU_SITIO/api/webhooks/mercadopago`, evento **Pagos**. Al guardar se genera la clave secreta: cópiala a `MERCADOPAGO_WEBHOOK_SECRET`.
3. En `config/payments.json` ajusta `usdRate` (pesos chilenos por dólar) y `roundTo`. El tipo de cambio no se actualiza solo.

Una cuenta de Mercado Pago Chile cobra en CLP. Compradores de otros países de Sudamérica necesitan una tarjeta habilitada para compras internacionales. Los links de pago vencen a la hora.

### PayPal

1. En developer.paypal.com, **Apps & Credentials** en modo Live: crea una app REST y copia Client ID y Secret a `PAYPAL_CLIENT_ID` y `PAYPAL_CLIENT_SECRET`. En producción se usa la API Live; pon `PAYPAL_ENV=sandbox` solo para pruebas.
2. En la app agrega un webhook `https://TU_SITIO/api/webhooks/paypal` con `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED` y `PAYMENT.CAPTURE.REVERSED`.

El backend no confía en el contenido de los webhooks de PayPal: vuelve a leer cada orden, captura o reembolso desde la API con tus credenciales. Si el banco rechaza la tarjeta al capturar, el comprador vuelve a PayPal para elegir otro medio.

### Ruteo por país

`config/payments.json`, sección `routing`: cada regla tiene países (códigos ISO de 2 letras) y proveedores en orden. Para ofrecer también PayPal en Sudamérica, agrega `"paypal"` a esa regla.

## Plugin del servidor de Rust

1. Copia `plugin/WebStore.cs` a `oxide/plugins/` (o `carbon/plugins/`).
2. Al cargar crea `oxide/config/WebStore.json`. Completa:
   - `Store URL`: la dirección del sitio, sin `/` al final.
   - `Shared secret`: el mismo valor de `PLUGIN_SECRET`.
   - `Chat command`: por defecto `claim`. Si otro plugin ya usa ese comando, cámbialo y pon el mismo valor en `config/site.json` (`store.inGameCommand`).
3. `oxide.reload WebStore`. En la consola debe aparecer `Loaded 5 kits from the store`.

En el juego: `/claim` lista tus kits y cooldowns; `/claim <kit>` lo entrega si tienes espacio en el inventario. Desde la consola o RCON, `webstore.sync` fuerza una sincronización. Si la web se cae, el plugin sigue entregando con los datos guardados y manda los reclamos pendientes cuando vuelve.

Todas las peticiones van firmadas con HMAC-SHA256 en los dos sentidos. El reloj del servidor de Rust tiene que estar en hora (máximo 5 minutos de diferencia).

## Panel de admin

Entra con un SteamID listado en `ADMIN_STEAM_IDS` y abre `/admin`:

- Ventas por período, kit y proveedor.
- Pedidos con búsqueda y revisión manual contra el proveedor (**Recheck**).
- **Needs attention**: pedidos en disputa, en revisión o marcados (reembolso parcial, segundo pago del mismo pedido).
- Pedidos en `review`: el monto pagado no coincidió con el pedido. Revisa el pago en el panel del proveedor y usa **Approve** para entregar el kit.
- Regalar kits, revocar accesos, buscar jugadores y banearlos de la tienda.

## Antes de abrir la tienda

- Cambia el nombre de ejemplo `Scrapyard 3x`, la dirección `play.example.com:28015`, el Discord, el horario de wipe y el email en `config/site.json`.
- Revisa los textos de Terms, Refund policy y Privacy (`web/src/pages/Legal.tsx`) con alguien que conozca la normativa que te aplica. Son una base razonable, no asesoría legal.
- Haz una compra de prueba con cada proveedor en modo test o sandbox.

## Alternativa: VPS con Docker

Necesitas un VPS con Docker, un dominio o subdominio apuntando a su IP y los puertos 80 y 443 abiertos.

```bash
cp .env.example .env      # completa los valores
docker compose up -d --build
```

Caddy saca el certificado HTTPS solo. En este modo los archivos de `config/` se recargan desde el panel de admin sin reiniciar, y el país sale de una base de IPs pública que se descarga sola (o de `cf-ipcountry` si pones Cloudflare delante con `GEOIP_HEADER=cf-ipcountry`).

Sin Docker: Node 22.22 o más nuevo, `npm run install:all`, `npm run build:node` y `npm start` con las variables de `.env` cargadas, detrás de un proxy con HTTPS.

## Desarrollo local

```bash
npm run install:all
npm test                     # tests del backend
npm run typecheck            # Node, Worker y frontend
```

Vista previa sin backend: `npm --prefix web run build:demo` genera `web/dist-demo/preview.html`, el sitio completo en un solo archivo con datos de ejemplo y pagos simulados (sirve para mostrarlo antes de publicar).

Como en Cloudflare (Worker y Durable Object locales): crea `.dev.vars` con `NODE_ENV=development`, `DEV_LOGIN=true` y las claves de prueba, y corre `STATIC_HEADERS_HTTP=1 npm run dev:cloudflare`. La cabecera `X-Dev-Country: CL` simula un comprador de otro país.

Con Node:

```bash
# Terminal 1 (backend en :3000)
cd server && DEV_LOGIN=true DEV_FORCE_COUNTRY=US BASE_URL=http://localhost:5173 npm run dev
# Terminal 2 (frontend en :5173 con proxy a /api)
cd web && npm run dev
```

- `DEV_LOGIN=true` muestra un login falso en `/account` (ignorado en producción).
- `DEV_FORCE_COUNTRY=CL` simula un comprador de otro país (ignorado en producción).
- `STRIPE_API_BASE` apunta el SDK de Stripe a un mock local (ignorado en producción).
