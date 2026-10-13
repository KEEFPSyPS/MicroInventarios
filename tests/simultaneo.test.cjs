/* ===========================================================================
 * tests/simultaneo.test.cjs — Edición SIMULTÁNEA del mismo folio (emulador).
 * ---------------------------------------------------------------------------
 * Dos clientes autenticados con cuentas DISTINTAS editan el mismo folio a la vez.
 * Se usa el emulador de Firestore con las reglas REALES (firestore.rules) y la
 * política de fusión REAL (fusion.js). Es el escenario que en producción perdería
 * datos con el antiguo setDoc().
 *
 * EJECUCIÓN:
 *   npm run test:rules
 *   # equivale a:
 *   firebase emulators:exec --only firestore "node --test tests/simultaneo.test.cjs"
 *
 * CASOS CUBIERTOS (los exigidos para el trabajo en dos dispositivos):
 *   1. Partidas DISTINTAS: cada usuario toca su propia fila → no se pierde ninguna.
 *   2. La MISMA partida: ganan los números más recientes.
 *   3. ALTAS simultáneas: una fila nueva de cada lado sobrevive.
 *   4. BAJA contra EDICIÓN: gana la acción más reciente.
 *   5. ESTADO VIEJO contra NUEVO: el `paso` no retrocede.
 *   6. El guardado NUNCA copia `actualizadoEn` ni `rev` del documento LEÍDO.
 * ======================================================================== */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  initializeTestEnvironment,
  assertSucceeds
} = require("@firebase/rules-unit-testing");
const { doc, setDoc, getDoc, runTransaction, serverTimestamp } = require("firebase/firestore");

/* fusion.js es un módulo ES; se importa en dinámico (este archivo es CJS). */
let fusionar, asignarPids, marcarBorrada;

const PROJECT_ID = "microinventarios-simultaneo-test";
const ANA = "ana@ejemplo.mx";
const BETO = "beto@ejemplo.mx";

let entorno;

before(async () => {
  ({ fusionar, asignarPids, marcarBorrada } = await import("../fusion.js"));
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

/* Cliente autenticado (una cuenta por "dispositivo"). */
const cliente = (uid, email) =>
  entorno.authenticatedContext(uid, { email, email_verified: true }).firestore();

/* Siembra el documento inicial sin pasar por las reglas (para preparar el estado). */
async function sembrar(datos) {
  await entorno.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), "auditorias", datos.id), datos);
  });
}

/* --- La MISMA función de guardado que usa app.js (store.save()):
   lectura + fusión + escritura dentro de UNA transacción. Aquí se replica para
   probarla contra el emulador real, incluida la parte que NO debe copiar sellos. */
async function guardar(db, local, sello) {
  await assertSucceeds(
    runTransaction(db, async (tx) => {
      const ref = doc(db, "auditorias", local.id);
      const snap = await tx.get(ref);
      const remoto = snap.exists() ? snap.data() : null;
      const docFinal = fusionar(remoto, local, sello);
      docFinal.actualizadoEn = serverTimestamp();
      docFinal.partidas = asignarPids(docFinal.partidas).map((p) => {
        const copia = Object.assign({}, p);
        delete copia._t;
        return copia;
      });
      tx.set(ref, docFinal);
    })
  );
}

/* Documento base válido según las reglas (contenidoValido()). */
function base(id, uid, email, over = {}) {
  return {
    id,
    uid,
    email,
    fecha: "2026-06-10",
    proveedor: "Proveedor SA",
    folio: id,
    verificador: "Ana",
    paso: 3,
    creado: 1700000000000,
    actualizado: hace(1),
    actualizadoEn: hace(1),
    actualizadoPor: email,
    rev: 1,
    partidas: [{ pid: "p1", codigo: "A1", desc: "Uno", fact: "10", recib: "8", realPV: "4", realBR: "4", real: "8" }],
    ...over
  };
}

const leer = (db, id) => getDoc(doc(db, "auditorias", id)).then((s) => s.data());
const partida = (datos, pid) => (datos.partidas || []).find((p) => p.pid === pid);

/* Marcas de tiempo COHERENTES con el reloj real: en producción el cliente envía
   `Date.now()` y el servidor sella con su propia hora. Comparar contra fechas de
   2023 mediría mal la recencia porque cualquier guardado del servidor (hoy)
   parecería "más nuevo". Por eso aquí se usan marcas relativas al reloj actual,
   con márgenes amplios (horas) para que el orden sea inequívoco pese al tiempo
   que tarde la prueba en correr. */
const ahora = () => Date.now();
const hace = (horas) => ahora() - horas * 3600000;   /* el "más viejo" */
const dentro = (horas) => ahora() + horas * 3600000; /* el "más nuevo" */

/* ============ 1) Partidas DISTINTAS ============ */
test("dos usuarios editan partidas DISTINTAS: no se pierde ninguna partida", async () => {
  const id = "sim-distintas";
  await sembrar(
    base(id, "u-ana", ANA, {
      rev: 4,
      partidas: [
        { pid: "p1", codigo: "A1", desc: "Uno", fact: "10", recib: "8", realPV: "4", realBR: "4", real: "8" },
        { pid: "p2", codigo: "B2", desc: "Dos", fact: "5", recib: "5", realPV: "5", realBR: "", real: "5" }
      ]
    })
  );
  const ana = cliente("u-ana", ANA);
  const beto = cliente("u-beto", BETO);

  /* Ana AGREGA una partida nueva (p3) y Beto AGREGA otra (p4) partiendo los dos de
     un estado que ignora al del otro. Ninguna de las dos altas puede perderse. */
  const estadoAna = base(id, "u-ana", ANA, {
    actualizado: dentro(1),
    actualizadoEn: dentro(1),
    partidas: [
      { pid: "p1", codigo: "A1", desc: "Uno", fact: "10", recib: "8", realPV: "4", realBR: "4", real: "8" },
      { pid: "p2", codigo: "B2", desc: "Dos", fact: "5", recib: "5", realPV: "5", realBR: "", real: "5" },
      { pid: "p3", codigo: "A3", desc: "De Ana", fact: "2", recib: "2", realPV: "2", realBR: "", real: "2" }
    ]
  });
  const estadoBeto = base(id, "u-ana", ANA, {
    actualizado: dentro(2),
    actualizadoEn: dentro(2),
    partidas: [
      { pid: "p1", codigo: "A1", desc: "Uno", fact: "10", recib: "8", realPV: "4", realBR: "4", real: "8" },
      { pid: "p2", codigo: "B2", desc: "Dos", fact: "5", recib: "5", realPV: "5", realBR: "", real: "5" },
      { pid: "p4", codigo: "B4", desc: "De Beto", fact: "3", recib: "3", realPV: "3", realBR: "", real: "3" }
    ]
  });

  await guardar(ana, estadoAna, { por: ANA, en: dentro(1) });
  await guardar(beto, estadoBeto, { por: BETO, en: dentro(2) });

  const final = await leer(beto, id);
  const pids = final.partidas.map((p) => p.pid).sort();
  assert.deepEqual(
    pids,
    ["p1", "p2", "p3", "p4"],
    "ninguna partida se pierde: ni las del otro usuario ni las de uno mismo"
  );
  assert.equal(final.partidas.length, 4, "el folio conserva las cuatro partidas");
});

/* ============ 2) La MISMA partida ============ */
test("dos usuarios editan la MISMA partida: gana el guardado más reciente", async () => {
  const id = "sim-misma";
  await sembrar(base(id, "u-ana", ANA, { rev: 2 }));

  const ana = cliente("u-ana", ANA);
  const beto = cliente("u-beto", BETO);

  const deAna = base(id, "u-ana", ANA, {
    partidas: [{ pid: "p1", codigo: "A1", desc: "Uno", fact: "10", recib: "6", realPV: "6", realBR: "", real: "6" }]
  });
  const deBeto = base(id, "u-ana", ANA, {
    actualizado: dentro(2),
    actualizadoEn: dentro(2),
    partidas: [{ pid: "p1", codigo: "A1", desc: "Uno", fact: "10", recib: "9", realPV: "2", realBR: "3", real: "5" }]
  });

  await guardar(ana, deAna, { por: ANA, en: dentro(1) });    /* antes */
  await guardar(beto, deBeto, { por: BETO, en: dentro(2) }); /* después */

  const final = await leer(beto, id);
  assert.equal(partida(final, "p1").recib, "9", "gana el conteo del guardado más reciente (Beto)");
  assert.equal(partida(final, "p1").real, "5", "`real` se recalcula de PV+BR");
  assert.equal(final.actualizadoPor, BETO, "el sello de autor es el del último que guardó");
});

/* ============ 3) ALTAS simultáneas ============ */
test("dos usuarios dan de alta una partida nueva a la vez: sobreviven las dos", async () => {
  const id = "sim-altas";
  await sembrar(base(id, "u-ana", ANA));

  const ana = cliente("u-ana", ANA);
  const beto = cliente("u-beto", BETO);

  const deAna = base(id, "u-ana", ANA, {
    actualizado: dentro(1),
    actualizadoEn: dentro(1),
    partidas: [
      { pid: "p1", codigo: "A1", desc: "Uno", fact: "10", recib: "8", realPV: "4", realBR: "4", real: "8" },
      { pid: "pNuevoAna", codigo: "NA", desc: "Nueva de Ana", fact: "3", recib: "3", realPV: "3", realBR: "", real: "3" }
    ]
  });
  const deBeto = base(id, "u-ana", ANA, {
    actualizado: dentro(2),
    actualizadoEn: dentro(2),
    partidas: [
      { pid: "p1", codigo: "A1", desc: "Uno", fact: "10", recib: "8", realPV: "4", realBR: "4", real: "8" },
      { pid: "pNuevoBeto", codigo: "NB", desc: "Nueva de Beto", fact: "4", recib: "4", realPV: "4", realBR: "", real: "4" }
    ]
  });

  await guardar(ana, deAna, { por: ANA, en: dentro(1) });
  await guardar(beto, deBeto, { por: BETO, en: dentro(2) });

  const final = await leer(beto, id);
  const pids = final.partidas.map((p) => p.pid).sort();
  assert.deepEqual(pids, ["p1", "pNuevoAna", "pNuevoBeto"], "las dos altas simultáneas se conservan");
});

/* ============ 4) BAJA contra EDICIÓN ============ */
test("baja contra edición: gana la acción más reciente", async () => {
  const id = "sim-baja";
  await sembrar(
    base(id, "u-ana", ANA, {
      partidas: [
        { pid: "p1", codigo: "A1", desc: "Uno", fact: "10", recib: "8", realPV: "4", realBR: "4", real: "8" },
        { pid: "p2", codigo: "B2", desc: "Dos", fact: "5", recib: "5", realPV: "5", realBR: "", real: "5" }
      ]
    })
  );
  const ana = cliente("u-ana", ANA);
  const beto = cliente("u-beto", BETO);

  /* Beto BORRA p2 a T=3000 (queda registrado en `borradas`). */
  const borrado = base(id, "u-ana", ANA, {
    actualizado: dentro(3),
    actualizadoEn: dentro(3),
    borradas: marcarBorrada([], "p2", dentro(3)),
    partidas: [{ pid: "p1", codigo: "A1", desc: "Uno", fact: "10", recib: "8", realPV: "4", realBR: "4", real: "8" }]
  });
  await guardar(beto, borrado, { por: BETO, en: dentro(3) });

  /* Ana, con una pantalla VIEJA (sin saber del borrado), EDITA p2 a T=2000. */
  const editadoAntes = base(id, "u-ana", ANA, {
    actualizado: dentro(2),
    actualizadoEn: dentro(2),
    partidas: [
      { pid: "p1", codigo: "A1", desc: "Uno", fact: "10", recib: "8", realPV: "4", realBR: "4", real: "8" },
      { pid: "p2", codigo: "B2", desc: "Dos", fact: "5", recib: "6", realPV: "6", realBR: "", real: "6", _t: dentro(2) }
    ]
  });
  await guardar(ana, editadoAntes, { por: ANA, en: dentro(2) });

  let final = await leer(beto, id);
  assert.ok(!partida(final, "p2"), "una edición ANTERIOR al borrado NO revive la partida");

  /* Ahora Ana edita p2 DESPUÉS del borrado (T=4000) y la partida se restaura. */
  const editadoDespues = base(id, "u-ana", ANA, {
    actualizado: dentro(4),
    actualizadoEn: dentro(4),
    partidas: [
      { pid: "p1", codigo: "A1", desc: "Uno", fact: "10", recib: "8", realPV: "4", realBR: "4", real: "8" },
      { pid: "p2", codigo: "B2", desc: "Dos", fact: "5", recib: "6", realPV: "6", realBR: "", real: "6", _t: dentro(4) }
    ]
  });
  await guardar(ana, editadoDespues, { por: ANA, en: dentro(4) });

  final = await leer(beto, id);
  assert.equal(partida(final, "p2").recib, "6", "una edición POSTERIOR al borrado restaura la partida");
});

/* ============ 5) ESTADO VIEJO contra NUEVO ============ */
test("estado viejo contra nuevo: el paso no retrocede y el folio no se pisa", async () => {
  const id = "sim-viejo";
  /* El documento en Firestore ya va en el PASO 5 con el folio capturado. */
  await sembrar(base(id, "u-ana", ANA, { paso: 5, folio: "F-REAL", proveedor: "Real SA", rev: 6 }));

  /* Ana abre una pestaña con un estado ANTIGUO en memoria (paso 2, sin proveedor
     ni folio) y guarda: la fusión debe conservar lo que ya había. */
  const viejo = base(id, "u-ana", ANA, {
    paso: 2,
    folio: "",
    proveedor: "",
    actualizado: hace(5),
    actualizadoEn: hace(5),
    partidas: [{ pid: "p1", codigo: "A1", desc: "Uno", fact: "10", recib: "8", realPV: "4", realBR: "4", real: "8" }]
  });
  const db = cliente("u-ana", ANA);
  await guardar(db, viejo, { por: ANA, en: hace(5) });

  const final = await leer(db, id);
  assert.equal(final.paso, 5, "el paso se queda en el máximo (5), no retrocede al del estado viejo (2)");
  assert.equal(final.folio, "F-REAL", "un campo capturado NO se pisa con un vacío del estado viejo");
  assert.equal(final.proveedor, "Real SA", "el proveedor capturado se conserva");
  assert.equal(partida(final, "p1").recib, "8", "la partida del estado viejo sigue siendo válida");
});

/* ============ 6) NO copiar sellos ni rev del documento LEÍDO ============ */
test("el guardado NUNCA copia actualizadoEn ni rev del documento leído", async () => {
  const id = "sim-sellos";
  /* Documento con un rev ALTO y sellos claramente reconocibles. */
  await sembrar(
    base(id, "u-ana", ANA, { rev: 42, actualizado: 111, actualizadoEn: 111, actualizadoPor: "otro@ejemplo.mx" })
  );
  const db = cliente("u-beto", BETO);
  const local = base(id, "u-ana", ANA, {
    actualizado: hace(1),
    actualizadoEn: hace(1),
    actualizadoPor: "otro@ejemplo.mx",
    rev: 42
  });

  /* Se guarda por la ruta real (transacción + fusor) y se inspecciona el resultado. */
  await guardar(db, local, { por: BETO, en: dentro(9) });

  const final = await leer(db, id);
  assert.equal(final.actualizadoPor, BETO, "actualizadoPor es el correo del que guarda, no el leído");
  assert.notEqual(final.actualizadoPor, "otro@ejemplo.mx", "no se imita al autor anterior");
  assert.equal(final.rev, 43, "rev avanza sobre el máximo leído (42) → 43");
  const ms = final.actualizadoEn && final.actualizadoEn.toMillis ? final.actualizadoEn.toMillis() : null;
  assert.ok(ms && ms > 111, "actualizadoEn es un sello NUEVO del servidor, no el 111 del documento leído");
});
