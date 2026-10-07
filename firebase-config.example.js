/* ===========================================================================
 * firebase-config.example.js — PLANTILLA de configuración de Firebase.
 * ---------------------------------------------------------------------------
 * CÓMO USARLA
 *   1) Copia este archivo a `firebase-config.js` (sin ".example"):
 *          cp firebase-config.example.js firebase-config.js
 *      En PowerShell:
 *          Copy-Item firebase-config.example.js firebase-config.js
 *   2) Rellena los valores con los de TU proyecto:
 *          Firebase Console → Configuración del proyecto → Tus apps → SDK setup.
 *   3) `firebase-config.js` está en .gitignore: NO se sube al repositorio.
 *
 * POR QUÉ LA apiKey NO ES UN SECRETO
 *   La `apiKey` web de Firebase es un IDENTIFICADOR PÚBLICO, no una contraseña:
 *   viaja en el HTML de cualquier app web de Firebase y es visible en el
 *   navegador por diseño. Lo que protege los datos son:
 *     · Las REGLAS de Firestore (firestore.rules): deniegan todo por defecto y
 *       exigen usuario autenticado con correo verificado.
 *     · Las restricciones de la apiKey en Google Cloud (HTTP referrers) y los
 *       dominios autorizados de Authentication.
 *   Aun así, se aísla en su propio archivo para (a) no versionar configuraciones
 *   por entorno y (b) evitar falsos positivos de herramientas que buscan
 *   "credenciales" en los diffs.
 * ======================================================================== */

export const firebaseConfig = {
  apiKey: "TU_API_KEY",
  authDomain: "TU_PROYECTO.firebaseapp.com",
  projectId: "TU_PROYECTO",
  storageBucket: "TU_PROYECTO.firebasestorage.app",
  messagingSenderId: "TU_SENDER_ID",
  appId: "TU_APP_ID"
};
