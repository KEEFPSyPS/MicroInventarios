# Microinventarios — verificación de cuentas y despliegue

## Por qué aparece «Firestore rechazó la operación (permission-denied)»

Las reglas exigen **correo verificado** (`email_verified == true`). Las cuentas
creadas a mano en la consola de Firebase nacen con `emailVerified = false`, por
eso el login entra pero Firestore rechaza leer o guardar.

## Cómo verificarlo (elige una opción)

### Opción A — Desde la propia app (recomendada, ya implementada)
El usuario solo tiene que iniciar sesión con su correo y contraseña. La app:

1. Detecta que el correo no está verificado.
2. **Envía el correo de verificación automáticamente** con `sendEmailVerification`.
3. Muestra la pantalla «Verifica tu correo para continuar» con:
   - **Reenviar correo** (con cuenta atrás de 60 s, por el límite de Firebase).
   - **Ya verifiqué mi correo** (recarga el token y entra sin re-login).
   - **Usar otra cuenta** (cierra la sesión).

El enlace del correo regresa a la app (`continueUrl` = URL de la página). No hace
falta tocar la consola de Firebase.

> **Requisito de dominio:** en Firebase → Authentication → Settings → *Dominios
> autorizados* deben figurar los dominios desde donde se abre la app (por ejemplo
> `localhost` y el dominio de producción). Si falta, el SDK devuelve
> `auth/unauthorized-continue-uri` y la app lo indica con ese mensaje.


### Opción B — Desde la consola de Firebase (si el correo no llega)
1. Abre https://console.firebase.google.com/project/microinventarios-a7998/authentication/users
2. Menú de tres puntos (⋮) del usuario → **Send email verification**.
3. Revisa la plantilla del correo en Authentication → Templates si no llega.

### Opción C — Crear la cuenta ya verificada por Admin SDK
Requiere una clave de servicio (**nunca** la pongas en el HTML):

```js
// script local, con: npm i firebase-admin
const admin = require("firebase-admin");
admin.initializeApp({ credential: admin.credential.applicationDefault() });

await admin.auth().createUser({
  email: "usuario@dominio.com",
  password: "ContraseñaTemporal123",
  emailVerified: true,
});
```
Ejecuta con `GOOGLE_APPLICATION_CREDENTIALS=ruta/clave-servicio.json node alta.js`.

## Errores de consola que NO son fallas de la app

### `Access to fetch at 'https://cdn.tailwindcss.com/' blocked by CORS`
Este proyecto **no usa Tailwind** (verificado: 0 referencias en el repositorio).
El error lo produce una **extensión del navegador** (Tailwind DevTools, React
DevTools, Wappalyzer u otra) que intenta descargar ese CDN en cada página.
Además, `cdn.tailwindcss.com` es solo para desarrollo, nunca para producción.
**Se comprueba así:** abre la app en incógnito (Ctrl+Shift+N); el error desaparece.

### `net::ERR_BLOCKED_BY_CLIENT` en `firestore.googleapis.com`
Código que emite el navegador cuando **una extensión cancela la petición**.
No lo puede generar la aplicación. Causa habitual: bloqueador de anuncios
(uBlock, AdBlock, Brave Shields, Privacy Badger) que corta el canal del
WebChannel de Firestore por confundirlo con un rastreador.

**Efecto real:** Firebase reintenta sin rendirse y la operación se queda
esperando. La app ahora **corta a los 15 s** con un mensaje claro en lugar de
dejar la pantalla trabada.

**Soluciones, de más simple a más completa:**
1. Abrir la app en **incógnito** o desactivar extensiones en ese sitio.
2. Poner `firestore.googleapis.com` y `*.googleapis.com` en la lista blanca
   del bloqueador para el dominio de la app.
3. En equipos de la empresa, usar un navegador con perfil limpio o desplegar
   la app como **PWA** (los bloqueadores no interfieren igual).

> Las peticiones `.../Terminate` que aparecen en el log son **normales**:
> Firestore cierra sus canales abiertos al descargar la página. Solo son
> preocupantes si van acompañadas de un error de escritura.

### Códigos de estado de transporte
`400` y `404` en las peticiones a `google.firestore.v1.Firestore` son
**respuestas normales** del protocolo de streaming (apertura y cierre de
canales). No indican fallo por sí mismos.

## Seguridad del despliegue

La `apiKey` de Firebase es **pública por diseño**: va incrustada en el HTML de
cualquier app web de Firebase. Identifica el proyecto, no autoriza nada. Lo que
realmente protege los datos son las **reglas de Firestore**, que sí exigen
sesión y correo verificado.

**Lo que NUNCA debe subirse al repositorio:** claves de servicio del Admin SDK
(`clave-servicio.json`), archivos `.env` con secretos, o cualquier credencial de
cuenta de servicio. `firestore.rules` está en `.gitignore`, lo cual está bien
para no exponer la topología, pero conviene mantener una copia de respaldo
privada porque es la única barrera entre los datos y el público.

## Despliegue de reglas

```bash
cd "c:\Users\Keep On Code\Documents\MicroInventarios"
firebase login
firebase deploy --only firestore:rules
```

Comprueba que subieron: Firebase → Firestore → Reglas (debe verse el bloque
de `auditorias` con `correoVerificado()`).

## Límites que imponen las reglas

| Límite | Valor | Motivo |
|---|---|---|
| Partidas por auditoría | 20 | Sin recursión ni bucles en el lenguaje de reglas |
| Longitud de `codigo` | 60 | Validación de entrada (OWASP ASVS V5) |
| Longitud de `desc` | 300 | Igual |
| Longitud de cantidades | 12 | Igual |
| Longitud de nombres | 120 | Igual |

## Lectura vs escritura

- **Leer** auditorías: cualquier usuario autenticado y verificado.
- **Crear**: usuario autenticado y verificado, con su propio `uid`/`email`.
- **Editar**: solo el dueño del registro.
- **Borrar**: solo el dueño, o el correo listado en `esDeLaLista()` de
  `firestore.rules`.
