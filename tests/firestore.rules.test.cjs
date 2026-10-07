/* ===========================================================================
 * tests/firestore.rules.test.js — Pruebas de firestore.rules con el emulador.
 * ---------------------------------------------------------------------------
 * Valida, en el EMULADOR de Firestore, qué operaciones permite y cuáles
 * deniega firestore.rules. No toca producción ni la nube.
 *
 * EJECUCIÓN (levanta el emulador, corre los tests y lo apaga):
 *   npm run test:rules
 *   # equivale a:
 *   firebase emulators:exec --only firestore "node --test tests/firestore.rules.test.cjs"
 *
 * DISEÑO: se prueban casos PERMITIDOS y DENEGADOS derivados de las funciones
 * autenticado() / correoVerificado() / activo() / esPropietario() /
 * contenidoValido() / identidadIntacta() de firestore.rules.
 * ======================================================================== */
const { test, before, after, beforeEach } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} = require("@firebase/rules-unit-testing");
const { doc, setDoc, updateDoc, deleteDoc, getDoc } = require("firebase/firestore");

/* El projectId solo etiqueta el entorno del emulador; cualquiera sirve. */
const PROJECT_ID = "microinventarios-rules-test";

/* Correos usados; GERENTE debe coincidir con la lista esDeLaLista() de
   firestore.rules. Si cambia la lista, actualiza aquí. */
const GERENTE = "c.moralesm1997@gmail.com";
const OPERADOR = "operador@ejemplo.com";

let entorno;

/* --- payload de una auditoría válida (según contenidoValido()) --- */
function auditoria(uid, email, over = {}) {
  return {
    id: "aud-1",
    uid,
    email,
    linea: "Volkswagen",
    folio: "F-001",
    proveedor: "Proveedor SA",
    encargado: "Ana",
    verificador: "Beto",
    paso: 3,
    fecha: "2026-06-10",
    creado: 1700000000000,
    partidas: [{ codigo: "A1", real: "5" }],
    ...over
  };
}

before(async () => {
  entorno = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8"),
      host: "127.0.0.1",
      port: 8080
    }
  });
});

after(async () => {
  if (entorno) await entorno.cleanup();
});

beforeEach(async () => {
  if (entorno) await entorno.clearFirestore();
});

/* Helper: contexto autenticado con token personalizable. */
function ctx(uid, email, token = {}) {
  return entorno.authenticatedContext(uid, { email, email_verified: true, ...token });
}
function anon() {
  return entorno.unauthenticatedContext();
}
function sembrar(id, datos) {
  return entorno.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), "auditorias", id), datos);
  });
}

/* ===================== Casos PERMITIDOS ===================== */

test("dueño verificado CREA su auditoría válida (permitido)", async () => {
  const db = ctx("u1", OPERADOR).firestore();
  await assertSucceeds(setDoc(doc(db, "auditorias", "aud-1"), auditoria("u1", OPERADOR)));
});

test("usuario verificado LEE auditorías de otros (permitido)", async () => {
  await sembrar("aud-1", auditoria("u0", "otro@ejemplo.com"));
  const db = ctx("u1", OPERADOR).firestore();
  await assertSucceeds(getDoc(doc(db, "auditorias", "aud-1")));
});

test("dueño ACTUALIZA su auditoría sin cambiar identidad (permitido)", async () => {
  await sembrar("aud-1", auditoria("u1", OPERADOR));
  const db = ctx("u1", OPERADOR).firestore();
  await assertSucceeds(updateDoc(doc(db, "auditorias", "aud-1"), { paso: 4 }));
});

test("dueño BORRA su auditoría (permitido)", async () => {
  await sembrar("aud-1", auditoria("u1", OPERADOR));
  const db = ctx("u1", OPERADOR).firestore();
  await assertSucceeds(deleteDoc(doc(db, "auditorias", "aud-1")));
});

test("GERENTE de la lista borra la auditoría de otro (permitido)", async () => {
  await sembrar("aud-1", auditoria("u9", "otro@ejemplo.com"));
  const db = ctx("ger", GERENTE).firestore();
  await assertSucceeds(deleteDoc(doc(db, "auditorias", "aud-1")));
});

/* ===================== Casos DENEGADOS ===================== */

test("SIN AUTENTICAR: no lee (denegado)", async () => {
  const db = anon().firestore();
  await assertFails(getDoc(doc(db, "auditorias", "aud-1")));
});

test("SIN AUTENTICAR: no crea (denegado)", async () => {
  const db = anon().firestore();
  await assertFails(setDoc(doc(db, "auditorias", "aud-1"), auditoria("u1", OPERADOR)));
});

test("correo NO verificado: no lee (denegado)", async () => {
  const db = entorno
    .authenticatedContext("u1", { email: OPERADOR, email_verified: false })
    .firestore();
  await assertFails(getDoc(doc(db, "auditorias", "aud-1")));
});

test("cuenta DESHABILITADA (custom=disabled): no crea (denegado)", async () => {
  const db = entorno
    .authenticatedContext("u1", { email: OPERADOR, email_verified: true, custom: "disabled" })
    .firestore();
  await assertFails(setDoc(doc(db, "auditorias", "aud-1"), auditoria("u1", OPERADOR)));
});

test("crea con uid ajeno al token (denegado)", async () => {
  const db = ctx("u1", OPERADOR).firestore();
  await assertFails(setDoc(doc(db, "auditorias", "aud-1"), auditoria("u2", OPERADOR)));
});

test("crea con email ajeno al token (denegado)", async () => {
  const db = ctx("u1", OPERADOR).firestore();
  await assertFails(setDoc(doc(db, "auditorias", "aud-1"), auditoria("u1", "otro@ejemplo.com")));
});

test("crea con id distinto al de la ruta (denegado)", async () => {
  const db = ctx("u1", OPERADOR).firestore();
  await assertFails(setDoc(doc(db, "auditorias", "ruta-distinta"), auditoria("u1", OPERADOR)));
});

test("esquema inválido: línea fuera de la lista (denegado)", async () => {
  const db = ctx("u1", OPERADOR).firestore();
  await assertFails(
    setDoc(doc(db, "auditorias", "aud-1"), auditoria("u1", OPERADOR, { linea: "Nissan" }))
  );
});

test("esquema inválido: paso fuera de rango (denegado)", async () => {
  const db = ctx("u1", OPERADOR).firestore();
  await assertFails(setDoc(doc(db, "auditorias", "aud-1"), auditoria("u1", OPERADOR, { paso: 9 })));
});

test("esquema inválido: partidas vacías (denegado)", async () => {
  const db = ctx("u1", OPERADOR).firestore();
  await assertFails(
    setDoc(doc(db, "auditorias", "aud-1"), auditoria("u1", OPERADOR, { partidas: [] }))
  );
});

test("esquema inválido: fecha mal formada (denegado)", async () => {
  const db = ctx("u1", OPERADOR).firestore();
  await assertFails(
    setDoc(doc(db, "auditorias", "aud-1"), auditoria("u1", OPERADOR, { fecha: "10/06/2026" }))
  );
});

test("no-dueño actualiza auditoría ajena (denegado)", async () => {
  await sembrar("aud-1", auditoria("u9", "otro@ejemplo.com"));
  const db = ctx("u1", OPERADOR).firestore();
  await assertFails(updateDoc(doc(db, "auditorias", "aud-1"), { paso: 4 }));
});

test("actualización que cambia la identidad uid/id (denegado)", async () => {
  await sembrar("aud-1", auditoria("u1", OPERADOR));
  const db = ctx("u1", OPERADOR).firestore();
  await assertFails(updateDoc(doc(db, "auditorias", "aud-1"), { id: "otro-id" }));
});

test("no-dueño y no-gerente borra auditoría ajena (denegado)", async () => {
  await sembrar("aud-1", auditoria("u9", "otro@ejemplo.com"));
  const db = ctx("u1", OPERADOR).firestore();
  await assertFails(deleteDoc(doc(db, "auditorias", "aud-1")));
});

test("colección no declarada queda denegada (denegado)", async () => {
  const db = ctx("u1", OPERADOR).firestore();
  await assertFails(setDoc(doc(db, "otra_coleccion", "x"), { hola: 1 }));
});
