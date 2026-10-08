# Microinventarios de recepción

PWA (Progressive Web App) **estática** para auditar la recepción de mercancía: capturar
un folio (a mano o desde el XML/PDF de la factura, o **varios XML a la vez**, uno por
factura), dividir el conteo en anaquel entre **PV** y **BR**, verificar hallazgos y
generar reportes PDF por folio o por día.

Funciona **instalada** en Android y iOS, y **offline** para abrir la app (los datos en
vivo de Firestore siempre requieren red). No hay backend propio: el cliente habla
directo con **Cloud Firestore** y **Firebase Authentication**, protegido por reglas de
seguridad del lado del servidor.

---

## Índice

- [Qué es y para qué sirve](#qué-es-y-para-qué-sirve)
- [Requisitos](#requisitos)
- [Cómo correr en local](#cómo-correr-en-local)
- [Configuración de Firebase (y por qué la apiKey es pública)](#configuración-de-firebase-y-por-qué-la-apikey-es-pública)
- [Cómo desplegar](#cómo-desplegar)
- [Arquitectura](#arquitectura)
- [Integridad de los CDN (SRI)](#integridad-de-los-cdn-sri)
- [Decisiones técnicas](#decisiones-técnicas)
- [Pruebas](#pruebas)
- [Documentación relacionada](#documentación-relacionada)

---

## Qué es y para qué sirve

La app guía al encargado por **cinco pasos**:

1. **Datos de la factura** — fecha, proveedor y folio. El **Responsable** se toma solo de
   tu sesión (correo con el que iniciaste sesión) y se muestra en solo lectura: ya no se
   captura a mano. Puedes cargar el XML/PDF de la factura para tomar los datos (y, si es
   XML, también las partidas) o **elegir varios XML a la vez** (ver más abajo).
2. **Partidas facturadas** — código, descripción y cantidad facturada.
3. **Recepción física** — cantidad recibida por partida.
4. **Conteo en anaquel** — conteo real dividido en **PV** y **BR** (la suma es la
   existencia total contada).
5. **Hallazgos y reporte** — diferencias calculadas y generación del PDF.

Cada cambio se **autoguarda** (respaldo local inmediato + escritura remota con retardo)
para que cerrar la pestaña por error no pierda el conteo.

Cada cambio se **autoguarda** (respaldo local inmediato + escritura remota con retardo)
para que cerrar la pestaña por error no pierda el conteo.

### Carga múltiple de XML (una factura = una auditoría)

En el **Paso 1**, si eliges **dos o más archivos XML a la vez**, cada CFDI se convierte en
una **auditoría aparte** (su propio folio, su fecha de creación y el responsable de tu
sesión) y **todas quedan guardadas en el historial**. Es distinto de elegir un **único**
archivo, que conserva el flujo de siempre: rellena la auditoría en pantalla para que tú la
revises y sigas capturando.

Reglas del lote, pensadas para que un archivo malo **nunca** tumbe al resto:

- **Omitir y seguir.** Si un XML falla (dañado, sin partidas, repetido o demasiado grande)
  no se aborta el lote: se omite y se informa en un resumen (región `aria-live` del Paso 1).
- **Sin partidas → no se guarda.** Un XML que no trae conceptos se omite por completo (no
  crea una auditoría vacía).
- **Duplicados.** Se detecta la factura repetida por su **clave**: el **UUID** del timbre
  fiscal (`TimbreFiscalDigital`) si viene; y si no, `proveedor·folio` en minúsculas. El
  cotejo es **dentro del lote actual**: si dos XML del mismo lote comparten clave, el
  segundo se omite como *repetida* (evita contar dos veces el ajuste de inventario). No es
  un candado contra folios de otro día: para eso está el **aviso de folio ya capturado** que
  aparece al leer un archivo cuando ya existe una auditoría con ese folio.
- **Límites.** Máximo **20 archivos por lote** y **5 MB por archivo** (se comprueba antes de
  leer). Los que exceden se ignoran y se avisa en el resumen.
- **Privado.** Cada XML se lee y procesa **solo en tu navegador**; el archivo nunca se sube
  ni se guarda. Lo que se persiste en Firestore es la auditoría resultante, con el mismo
  esquema (`normalizar()`) y las mismas reglas de seguridad que una captura manual.

## Requisitos
## Requisitos

- **Node.js ≥ 20** (para correr en local, generar iconos y ejecutar las pruebas). Con
  Node 24 verificado.
- **Firebase CLI** (`npm i -g firebase-tools`) para desplegar.
- Un proyecto de Firebase con **Firestore** y **Authentication (correo/contraseña)**.
- Navegador moderno. Para el service worker se necesita **HTTPS** o `localhost`.

## Cómo correr en local

```bash
# Opción 1 — servidor estático rápido (recomendado)
npm run serve          # npx serve .

# Opción 2 — emuladores de Firebase (Firestore/Auth locales)
firebase emulators:start
```

Abre la URL que imprima en consola (por defecto `http://localhost:3000` o el puerto del
emulador). El service worker funciona en `localhost` aunque no haya HTTPS.

> Si abres `index.html` con `file://`, el service worker **no** se registra y algunas
> funciones de la PWA no estarán disponibles. Usa siempre un servidor local.


## Configuración de Firebase (y por qué la apiKey es pública)

La configuración del proyecto vive en `firebase-config.js`, que **SÍ se versiona**
(lo sirve tal cual GitHub Pages y Firebase Hosting). Se creó a partir de la plantilla
`firebase-config.example.js`:

```bash
# 1) Copia la plantilla (solo la primera vez)
Copy-Item firebase-config.example.js firebase-config.js   # PowerShell
# cp firebase-config.example.js firebase-config.js        # bash

# 2) Rellena firebase-config.js con los valores de tu proyecto:
#    Firebase Console → Configuración del proyecto → Tus apps → SDK setup.
```

> **¿Por qué se versiona?** GitHub Pages **solo publica lo que está en el repositorio**.
> Si `firebase-config.js` estuviera en `.gitignore`, la app desplegada en Pages recibiría
> un **404** al importarlo (`app.js` lo carga con
> `import {firebaseConfig} from "./firebase-config.js"`) y rompería. Por eso el archivo
> real entra al repo junto con `firebase-config.example.js` (que se conserva como
> referencia de la forma del objeto).

### ¿No es inseguro versionar/exponer la apiKey en el navegador?

**No.** La `apiKey` web de Firebase es un **identificador público**, no un secreto:
se inyecta en el contenido de cualquier app web de Firebase, así que **siempre** es
visible en DevTools. Versionarla no añade riesgo: el archivo ya viaja al navegador de
cada visitante. Lo que realmente protege los datos es:

- **`firestore.rules`** — deniega todo por defecto y exige usuario **autenticado con
  correo verificado**; solo el dueño puede editar/borrar su auditoría.
- **Restricciones de la apiKey** en Google Cloud (HTTP referrers) y los **dominios
  autorizados** de Authentication.

En pocas palabras: la seguridad la dan **las reglas de Firestore y las restricciones de
la apiKey**, no el ocultamiento del archivo. Por eso se versiona con tranquilidad.

## Cómo desplegar

```bash
# Autenticarse una vez
firebase login

# Desplegar Hosting + reglas de Firestore
firebase deploy

# O solo una parte:
firebase deploy --only hosting
firebase deploy --only firestore:rules
```

`firebase.json` sirve el **directorio raíz** (`.`) como sitio estático. Como
`firebase-config.js` está **versionado**, existe en cualquier checkout: no hace falta
generarlo antes de desplegar. `index.html` lo importa con
`import {firebaseConfig} from "./firebase-config.js"`; el `ignore` actual de
`firebase.json` **no** lo excluye del Hosting, así que se sube como parte del sitio (igual
que en GitHub Pages).

### Cómo se provee `firebase-config.js` en CI / deploy

**Ya no hay que generarlo.** Al estar versionado, viene con el `git checkout` del
pipeline y con cualquier clon local. Basta con desplegar:

```yaml
- name: Desplegar
  run: npx firebase-tools deploy --only hosting
```

No se necesitan secretos para la configuración web de Firebase (ver arriba por qué la
`apiKey` es pública). El único secreto que puede requerir el despliegue es la
autenticación con Firebase (`FIREBASE_SERVICE_ACCOUNT` o `FIREBASE_TOKEN`).

> **Verificación previa al deploy:** `node --check firebase-config.js` (o intentar
> importarlo) falla con un error claro si el archivo está mal formado, evitando publicar
> un sitio sin configuración.

## Integración continua (GitHub Actions)

El workflow `.github/workflows/ci.yml` corre en **cada push y pull request**:

1. `actions/checkout` + `actions/setup-node` (matriz **Node 20 y 22**; el mínimo declarado
   en `engines` es `>=20`).
2. `npm ci` (instalación reproducible desde `package-lock.json`).
3. `node --check` sobre `app.js`, `pwa.js`, `sw.js`, `verificar-pasos.cjs`,
   `eslint.config.js` y `generar-iconos.mjs`.
4. `npm run lint` (ESLint).
5. `npm test` (pruebas de flujo con `node:test`).

> Las pruebas **no requieren secretos**: `verificar-pasos.cjs` inyecta una config de
> Firebase ficticia, así que el job de calidad corre también en PRs desde forks.

**Job de despliegue (incluido pero desactivado):** el job `deploy` está en el YAML con
`if: false` para que no se ejecute por accidente. Para activarlo:
1. Cámbialo a `if: github.ref == 'refs/heads/main'`.
2. Define el secreto de autenticación en *Settings → Secrets and variables → Actions*:
   - `FIREBASE_SERVICE_ACCOUNT` — JSON de una cuenta de servicio (recomendado usar
     **Workload Identity Federation** en lugar de un token de larga vida).
     Alternativa clásica: `FIREBASE_TOKEN` (de `firebase login:ci`).
3. El job **no** necesita reconstruir `firebase-config.js` (está versionado); solo usa
   `FirebaseExtended/action-hosting-deploy`.

## Versionado automático del Service Worker

El `VERSION` de `sw.js` **no se edita a mano**. Lo deriva el script
`scripts/actualizar-version-sw.mjs` a partir del **contenido** del app shell
(`index.html`, `styles.css`, `app.js`, `busqueda.js`, `manifest.webmanifest` y, si
existe, `firebase-config.js`) más el SHA corto del commit de git. El resultado tiene la
forma `h<hash12>-<commit>`.

**Cómo se dispara:**

- `firebase.json` lo ejecuta como **`predeploy`** de Hosting, así que cualquier
  `firebase deploy --only hosting` versiona el SW automáticamente **antes** de subir.
- Manualmente: `npm run build:sw`.
- En CI, `node scripts/actualizar-version-sw.mjs --check` falla si `sw.js` quedaría
  desactualizado (útil para exigir que el SW esté versionado en cada PR).

**Por qué invalida la caché antigua:** al cambiar `VERSION`, el nombre de la caché cambia
(`microinventarios-<VERSION>`). El evento `install` del SW crea esa caché nueva y
precachea el shell con `cache: "reload"` (ignora la caché HTTP, siempre bytes frescos);
el evento `activate` borra todas las cachés `microinventarios-*` que no sean la vigente.
Como el contenido hash cubre `app.js`/`styles.css`, **cualquier** cambio real produce una
versión nueva → nueva caché → limpieza de la anterior. Como bonus, al incluir el commit,
dos builds con idéntico contenido pero distinto commit no colisionan.

## Pruebas de reglas de Firestore (emulador)

`tests/firestore.rules.test.cjs` verifica `firestore.rules` contra el **emulador local**
de Firestore: casos permitidos (dueño crea/lee/actualiza/borra, gerencia borra) y denegados
(sin auth, correo sin verificar, cuenta deshabilitada, uid/email/id suplantados, esquema
inválido, no-dueño, colección no declarada).

**Requisitos:** **JDK 21 o superior** en el PATH (firebase-tools ≥15 rechaza versiones
anteriores a 21: «firebase-tools no longer supports Java version before 21»).

```bash
npm run test:rules
# = firebase emulators:exec --only firestore "node --test tests/firestore.rules.test.cjs"
```

`emulators:exec` levanta el emulador, corre los tests y lo apaga solo. La configuración del
emulador vive en `firebase.json` (`emulators.firestore.port = 8080`). El test **no toca la
nube ni producción**. Estado actual: **20 tests, 20 pass**. En CI (GitHub Actions) corre tras
`actions/setup-java` (Temurin 17→cambiar a **21** para igualar el entorno local).

## Accesibilidad (WCAG 2.1 AA)

La interfaz sigue WCAG 2.1 nivel AA:

- **Semántica de tablas:** cada `<table>` tiene `<caption>` (oculto con `.sr`) y sus `<th>`
  llevan `scope="col"`; las columnas de acción usan un encabezado `.sr`.
- **Etiquetas de formulario:** todos los campos están en un `<label>` (cabecera) o llevan
  `aria-label` dinámico («Cantidad recibida de la partida N») cuando van dentro de celdas.
- **Estado de autoguardado:** el indicador (`#estadoGuardado`) usa `role="status"` +
  `aria-live="polite"` + `aria-atomic="true"`, así los cambios se anuncian sin robar el foco.
- **Foco visible:** `:focus-visible` con contorno de 3px (`.styles.css`).
- **Contraste:** `--mut` (#5d6b78) sobre blanco = **5.47:1** y sobre `--bg` = **4.74:1**;
  `--ok` sobre `--okbg` = **4.61:1**. Todos cumplen AA (≥4.5:1). No se ajustaron colores
  porque no era necesario.

**Cómo verificarlo:**

```bash
# Lighthouse (requiere Chrome). Audita accesibilidad y PWA.
npm run serve        # en otra terminal
npx --yes lighthouse http://localhost:3000 --only-categories=accessibility --view

# axe-core sobre el HTML estático (instalación temporal, no se versiona):
npm install --no-save axe-core jsdom
node --input-type=module -e "
import {JSDOM} from 'jsdom'; import {readFileSync} from 'node:fs'; import axe from 'axe-core';
const dom = new JSDOM(readFileSync('index.html','utf8'), {runScripts:'outside-only'});
dom.window.eval(axe.source);
const r = await dom.window.axe.run(dom.window.document,
  {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}});
console.log(r.violations.length, 'violaciones'); r.violations.forEach(v=>console.log('-',v.id,v.impact));
"
```

> Con el HTML estático (login), axe reporta **0 violaciones** WCAG 2.1 A/AA. Las reglas
> `color-contrast` y `aria-hidden-focus` quedan como «incompletas» en jsdom: la primera
> porque jsdom no aplica `styles.css` (el contraste real se verificó aparte), y la segunda
> porque `#pwaBanner`/`#pwaOffline`/`#pwaInstall` están ocultos con `display:none` cuando
> llevan `aria-hidden="true"` (no enfocables), algo que jsdom no evalúa sin el CSS.


## Búsqueda en el Historial

La vista **Historial y reportes** incluye una **barra de búsqueda única** que filtra la
tabla de auditorías (no afecta al reporte del día ni a su PDF). Escribe y el filtrado se
aplica tras una pausa de ~200 ms, sin perder el foco del campo:

- **Texto libre** por proveedor, folio, responsable (el correo de la sesión), verificador o
  datos de artículo. Ignora mayúsculas, acentos y espacios sobrantes.
- **Fecha** en varios formatos: `2026-10-07`, `07/10/2026`, `7/10`, `10/2026`, `octubre`,
  `oct 2026` (también con `/`, `-` o `.` como separador).
- **Artículos** por código/SKU, descripción y cantidades (facturado, recibido, real). Bajo
  cada registro coincidente se listan las partidas que casaron, con el término resaltado.
- **Varios términos** separados por espacio se combinan con **AND** (deben coincidir todos),
  de modo que teclear más **acota** el resultado, no lo amplía. Un término numérico como
  `12` coincide si casa como fecha **o** como texto de artículo (basta una).
- Un **contador** (`N de M registros`) anuncia los resultados (`aria-live`), hay un botón
  **Limpiar** y la tecla **Esc** vacía el campo. Con la caja vacía se ven todos los registros.

La lógica vive en `busqueda.js` (módulo puro: `normalizarTexto`, `prepararRegistro`,
`interpretarFecha`, `buscarRegistros`) y se prueba en `tests/busqueda.test.cjs` con
`node:test`. El realce del texto se construye con nodos del DOM (`<mark>`, nunca
`innerHTML` con datos del usuario), conforme a la CSP.


## Arquitectura

```
/
├── index.html               Marcado: cabecera, pantallas (login/app) y contenedores PWA
├── styles.css               Estilos de la app (servidos como archivo estático)
├── app.js                   Lógica de la app (módulo ESM: importa Firebase y la config)
├── busqueda.js              Súper buscador del Historial (módulo puro, sin DOM ni red)
├── pwa.js                   Script clásico: instalación, avisos iOS/offline, SW
├── sw.js                    Service worker: precaché del shell + estrategias por host
├── manifest.webmanifest     Metadatos de la PWA (iconos, atajos, colores)
├── firebase-config.js       Config REAL de Firebase (versionada; apiKey pública)
├── firebase-config.example.js  Plantilla versionada
├── firestore.rules          Reglas de seguridad de Firestore (denegar por defecto)
├── firebase.json            Config de Hosting + Firestore + headers
├── icons/                   Iconos (SVG + PNG 192/512/maskable/apple/favicon)
├── generar-iconos.mjs       Genera los PNG del manifest desde icon.svg (usa sharp)
├── eslint.config.js         Reglas de lint (ESLint 9 flat config)
├── .prettierrc.json         Formato de código (Prettier)
├── tests/                    Pruebas unitarias (node:test): busqueda.test.cjs, firestore.rules.test.cjs y fixtures/ (XML CFDI de ejemplo)
├── verificar-pasos.cjs      Pruebas de flujo (node:test): corre app.js en un DOM virtual
└── README-VERIFICACION.md   Verificación de cuentas, migración y despliegue
```

### Rol del service worker (`sw.js`)

- **App shell precacheado**: HTML, manifest e iconos.
- **HTML → network-first** (las actualizaciones llegan rápido), con respaldo a caché y
  un aviso "Sin conexión" si no hay red.
- **Estáticos y CDN (cdnjs, Google Fonts, gstatic) → stale-while-revalidate**.
- **Firestore/Auth/API dinámica y todo lo que no sea `GET`: NUNCA se cachea** (datos en
  vivo y escrituras van siempre a la red).
- Actualización controlada: si hay un SW nuevo esperando, la página muestra "Hay una
  versión nueva · Actualizar" y llama a `skipWaiting` (`VERSION` en `sw.js`).

### Firestore

- Colección única `auditorias`; cada documento es una auditoría completa (cabecera +
  `partidas`).
- Escritura con `setDoc` (reemplaza el documento entero): el cliente **normaliza** el
  objeto al esquema antes de guardar para que las reglas lo acepten.
- Reglas: leer = cualquier usuario verificado; crear/editar = solo el dueño; borrar =
  dueño o gerencia. Ver `firestore.rules` (con referencias a ISO 27001, OWASP ASVS, NIST).

## Integridad de los CDN (SRI)

`index.html` carga pdf.js, jsPDF y jspdf-autotable desde **cdnjs** con **Subresource
Integrity**: el navegador rechaza el script si su contenido no coincide con el hash
declarado. Al **actualizar** una librería cambia su hash; recalcula con:

```bash
curl -s <URL> | openssl dgst -sha384 -binary | openssl base64 -A
# PowerShell equivalente (Node):
node -e "const c=require('crypto'),h=require('https');h.get(process.argv[1],r=>{const x=c.createHash('sha384');r.on('data',d=>x.update(d));r.on('end',()=>console.log('sha384-'+x.digest('base64')))});" <URL>
```

Reemplaza el valor de `integrity="sha384-…"` y fija la versión exacta en la URL.

## Content-Security-Policy (CSP)

`firebase.json` envía una CSP **en modo `Report-Only`** (no bloquea; solo reporta a la
consola del navegador). Sirve para validar la política en producción **antes** de pasarla a
`enforce`. Política actual y por qué de cada directiva:

| Directiva | Valor | Motivo |
|---|---|---|
| `default-src` | `'self'` | Base restrictiva: lo no declarado se limita al propio origen. |
| `script-src` | `'self' https://www.gstatic.com https://cdnjs.cloudflare.com` | Firebase por ESM (`gstatic.com/firebasejs`) + pdf.js/jsPDF (`cdnjs`, con SRI). |
| `style-src` | `'self' https://fonts.googleapis.com` | `styles.css` propio + hoja de Google Fonts. **Sin `'unsafe-inline'`** porque los `style="..."` inline se movieron a clases (`.box-factura`, `.msg-ok`, …). |
| `font-src` | `'self' https://fonts.gstatic.com` | Archivos de fuente los sirve `fonts.gstatic.com`. |
| `img-src` | `'self' data: blob: https://cdnjs.cloudflare.com` | Iconos propios, `data:`/`blob:` (pdf.js, svg) y recursos de cdnjs. |
| `connect-src` | `'self' https://*.googleapis.com https://*.firebaseapp.com https://*.firebaseio.com wss://*.firebaseio.com https://www.gstatic.com` | Firestore (`firestore.googleapis.com`), Auth (`identitytoolkit`/`securetoken.googleapis.com`), canal en vivo (`*.firebaseio.com` + `wss`), `authDomain` (`*.firebaseapp.com`). |
| `worker-src` | `'self' blob: https://cdnjs.cloudflare.com` | Worker de pdf.js (`pdf.worker.min.js` en cdnjs). |
| `object-src` | `'none'` | Sin `<object>`/`<embed>` (vector de XSS clásico). |
| `base-uri` | `'self'` | Impide que un `<base>` inyectado cambie el origen de las URLs relativas. |
| `frame-ancestors` | `'self'` | Anti-clickjacking (nadie puede embeber la app en un iframe ajeno). |
| `form-action` | `'self'` | Los formularios solo pueden enviarse al origen propio. |
| `upgrade-insecure-requests` | — | Fuerza `https://` en recursos que quedaran en `http://`. |

**No se incluye `frame-src`**: la app usa **Firebase Auth por correo/contraseña**
(`signInWithEmailAndPassword`), **no** popups OAuth/Google, por lo que no hay iframes de
`accounts.google.com` que autorizar. Queda fuera de la política a propósito.

> Las **Notas**: `'unsafe-inline'` / `'unsafe-eval'` están **ausentes a propósito**. Al
> separar HTML/CSS/JS y mover los estilos inline a clases, ninguno es necesario. Si al
> pasar a `enforce` apareciera una violación, la política **correcta** es añadir el origen
> específico o una clase CSS, **nunca** `'unsafe-inline'`.

**Pasar a enforce** (solo tras validar en Report-Only): cambia la clave del header de
`Content-Security-Policy-Report-Only` a `Content-Security-Policy`.

## Decisiones técnicas

- **Sin build/framework**: HTML+JS vanilla para mantenerlo simple, cacheable y sin
  dependencias en producción.
- **Manejo de errores explícito**: los códigos de Firebase se traducen a mensajes útiles
  (`firebaseError`, `authError`), incluida la detección de bloqueadores de anuncios
  (`pareceBloqueo`) y un **timeout** (`conLimite`) para no dejar la pantalla colgada.
- **Idempotencia de la captura**: el documento se normaliza en un solo punto
  (`normalizar`) para coincidir con el contrato de las reglas.
- **Sin dependencias en runtime**: todo el JS vive en el repo; los únicos terceros son
  los CDN de PDF (con SRI) y Firebase por ESM.
- **`sharp` es opcional**: solo se usa para generar iconos (`generar-iconos.mjs`), por eso
  está en `optionalDependencies` y no en `dependencies`.

## Pruebas y calidad

```bash
npm test         # pruebas de flujo (node --test verificar-pasos.cjs)
npm run lint     # ESLint (0 errores; avisa de código muerto)
npm run format   # Prettier --write (solo archivos nuevos; ver .prettierignore)
```

`verificar-pasos.cjs` lee `app.js` (el módulo real), lo ejecuta en un DOM mínimo
dentro de un contexto `vm` con `node:test` y comprueba el flujo completo (pasos, conteo
PV/BR, autoguardado, PDF, migración de documentos antiguos y la **carga múltiple de XML**:
clave de duplicados, lote "omitir y seguir", tope de 20 archivos / 5 MB y que un solo
archivo conserva el flujo de siempre). Los casos del lote usan XML reales de
`tests/fixtures/`.

## Documentación relacionada

- [`README-VERIFICACION.md`](./README-VERIFICACION.md) — verificación de correos de
  cuentas, errores de consola que no son fallos de la app, autoguardado, migración y
  prueba automatizada.
