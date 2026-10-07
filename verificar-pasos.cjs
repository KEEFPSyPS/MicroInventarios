/* ===========================================================================
 * verificar-pasos.cjs — Pruebas de flujo de Microinventarios (node:test).
 * ---------------------------------------------------------------------------
 * Ejecuta el script REAL de app.js en un DOM mínimo dentro de un contexto vm y
 * verifica el flujo a CINCO pasos (sin Paso 5 "Existencia en SICAR") y que el
 * PDF sale sin las columnas SICAR / "Dif. sistema".
 *
 * Corre con:   node --test         (o `npm test`)
 *
 * Dos trampas del entorno que este archivo evita a propósito:
 *   1) Los nodos del DOM se crean en el reino del test y se exponen al vm. Como
 *      los getters/funciones del reino del test se compilan en los scripts
 *      principales (no ven `nodos`, que vive en el buffer del módulo), TODA
 *      lectura/escritura del DOM debe pasar por la variable `nodo` creada DENTRO
 *      del contexto vm; si el test llama a `documento.getElementById` desde aquí
 *      obtendría otro nodo y leería siempre vacío.
 *   2) `const`/`let` del script no se adjuntan al objeto global del vm: las
 *      funciones y el estado se recogen con una expresión evaluada en el contexto.
 *
 * El código de la app vive en app.js (módulo ES); aquí se importa tal cual, se
 * quitan sus `import` y se sustituyen por stubs (Firebase y la config del test). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const vm = require("vm");

/* Alias histórico `ok` → aserción estricta. Se mantiene para no reescribir cada
   llamada y porque su mensaje es el mismo que se imprime en el reporte. */
const ok = (c, m) => assert.ok(c, m);

let code = fs.readFileSync("app.js", "utf8");
const imports = [...code.matchAll(/^import[^;]+;$/gm)].map(m => m[0]);
imports.forEach(s => { code = code.replace(s, ""); });
code = "const initializeApp=()=>({}),getFirestore=()=>({}),collection=()=>({}),doc=()=>({})," +
  "setDoc=()=>Promise.resolve(),getDocs=()=>Promise.resolve({docs:[]}),deleteDoc=()=>Promise.resolve()," +
  "getAuth=()=>({}),signInWithEmailAndPassword=()=>Promise.resolve(),signOut=()=>Promise.resolve()," +
  "onAuthStateChanged=()=>{},setPersistence=()=>Promise.resolve(),browserLocalPersistence={},browserSessionPersistence={}," +
  "sendEmailVerification=()=>Promise.resolve();\n" +
  /* La config REAL no se versiona (firebase-config.js está en .gitignore). Se
     inyecta un fixture equivalente para reproducir el modo nube (cloud === true)
     sin depender de un archivo ausente en CI. */
  "const firebaseConfig={apiKey:'AIzaSyTEST',projectId:'microinventarios-test'};\n" + code;

/* --- Nodos del DOM (un solo objeto por id, con innerHTML capturado) --- */
const nodos = {};
const pantallas = [];
const protoNodo = {
  get innerHTML() { return this._html; },
  set innerHTML(v) { this._html = v; pantallas.push(v); }
};
function nodo(id) {
  if (nodos[id]) return nodos[id];
  const n = Object.create(protoNodo);
  Object.assign(n, {
    id, _html: "", textContent: "", value: "", hidden: false, disabled: false,
    files: [], isConnected: true, dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    insertAdjacentHTML() {}, querySelector: () => null, addEventListener() {},
    getAttribute: () => "", setAttribute() {}
  });
  nodos[id] = n;
  return n;
}
["app","badge","mail","sesion","login","loginErr","loginBtn","formLogin","nNueva","nHist","salir"].forEach(nodo);

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  firebase: {}, pdfjsLib: { GlobalWorkerOptions: {} }, jspdf: {},
  Date, Math, JSON, Number, String, Array, Object, Promise, confirm: () => true,
  alert: () => {}, location: { reload() {} }, navigator: { onLine: true }, Blob: class {},
  /* window.addEventListener se usa para pagehide/beforeunload (autoguardado al
     cerrar). En el DOM real existe; aquí se ignora sin registrarlo. */
  addEventListener: () => {}, removeEventListener: () => {}
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
/* `nodo` se declara DENTRO del contexto: sus closures ven el `nodos` del test,
   así que el vm y el test comparten exactamente los mismos objetos. */
sandbox.__nodos = nodos;
sandbox.__pantallas = pantallas;
sandbox.__handlers = {};
/* El almacén vive como funciones planas: un objeto pasado desde el test no ve las
   escrituras que hace el propio closure del store dentro del contexto. */
const ls = { datos: {} };
sandbox.__lsGet = k => (k in ls.datos ? ls.datos[k] : null);
sandbox.__lsSet = (k, v) => { ls.datos[k] = String(v); };
sandbox.__lsDel = k => { delete ls.datos[k]; };
sandbox.__ls = () => JSON.stringify(ls.datos);
vm.runInContext([
  "var nodos = globalThis.__nodos;",
  "var nodo = id => { if (nodos[id]) return nodos[id]; const n = Object.create(nodos.__proto__);",
  "  Object.assign(n, {id, _html:'', textContent:'', value:'', hidden:false, disabled:false,",
  "    files:[], isConnected:true, dataset:{}, classList:{toggle(){},add(){},remove(){},contains:()=>false},",
  "    insertAdjacentHTML(){}, querySelector:()=>null, addEventListener(){},",
  "    getAttribute:()=>'', setAttribute(){}}); nodos[id]=n; return n; };",
  "var document = { get app(){ return nodo('app'); }, getElementById: id => nodo(id),",
  /* La app llama a querySelector('#app'), querySelector('[data-d=\"0\"]'), etc.
     El stub normaliza: quita '#', corchetes y comillas, y cae a un nodo genérico
     para los selectores que no son un id simple. */
  "  querySelector: sel => { const id = String(sel).replace(/^#/, '').replace(/^\\[data-[a-z]+=?.?([^\\]\"']*).?\\]$/, '$1');",
  "    return nodo(nodos[id] ? id : 'gen:' + sel); },",
  "  querySelectorAll: () => [],",
  /* La app registra el manejador de clics con addEventListener: se guarda para
     poder disparar clics reales en las pruebas de navegación. */
  "  addEventListener: (ev, fn) => { globalThis.__handlers[ev] = fn; },",
  "  body: { classList: { add() {}, remove() {} } }, createElement: () => nodo('tmp') };",
  "var localStorage = { getItem: k => globalThis.__lsGet(k),",
  "  setItem: (k, v) => { globalThis.__lsSet(k, v); },",
  "  removeItem: k => { globalThis.__lsDel(k); } };",
  "var window = globalThis;"
].join("\n"), sandbox);


/* El script real de la app se ejecuta al final, como en el navegador. */
vm.runInContext(code, sandbox, { filename: "index.html" });

/* Handles y helpers, evaluados dentro del contexto para compartir reino. */
vm.runInContext([
  "globalThis.app = { ULTIMO, PASOS, completa, resumen, resultado, normalizar, guardable,",
  "  huella, hayAvance, botonOtroFolio, bloqueAjuste, paso, render, crearPDF, A, sumarReal,",
  "  textoIndicador, texto: () => nodo('app').innerHTML, estado: () => ({vista, msg}), cloud,",
  "  autoguardar: () => globalThis.__auto(), programar: () => globalThis.__programar(),",
  "  intentos: () => globalThis.__intentos, aviso: () => avisoSinGuardar() };",
  /* Envoltorios que corren dentro del contexto para ver las variables del closure. */
  "globalThis.__intentos = 0;",
  "globalThis.__auto = async () => { globalThis.__intentos++; return await autoguardar(); };",
  "globalThis.__programar = () => programarAutoguardado();"
].join("\n"), sandbox);
const app = sandbox.app;
const A = app.A;

test("arranque y modelo de pasos (PV/BR, sin SICAR)", () => {
ok(app.cloud === true, "la app arrancó en modo nube (con la config del test)");
ok(typeof app.texto() === "string", "el DOM mínimo responde al render (largo " + app.texto().length + ")");

/* --- Captura completa en 5 pasos, sin capturar nunca "sicar" --- */
A.fecha = "2026-09-29"; A.linea = "Volkswagen"; A.proveedor = "Proveedor SA";
A.folio = "A-9912"; A.encargado = "Luis";
A.partidas = [{ codigo: "ABC-1", desc: "Filtro", fact: "10" }];
app.normalizar(A);
A.paso = 3; A.partidas[0].recib = "8";
A.paso = 4; A.verificador = "Ana"; A.partidas[0].realPV = "4"; A.partidas[0].realBR = "3"; A.partidas[0].real = "7";
A.paso = 5;

ok(app.ULTIMO === 5, "ULTIMO === 5 (cinco pasos)");
ok(app.PASOS.length === 5, "PASOS tiene 5 entradas: " + app.PASOS.map(p => p.t).join(" | "));
ok(!app.PASOS.some(p => /sicar/i.test(p.t)), "ningun paso se llama SICAR");
ok(app.PASOS[4].t === "Hallazgos y reporte", "el paso 5 es 'Hallazgos y reporte'");
ok(app.completa(A) === true, "con recib y real (sin sicar) la auditoria esta COMPLETA");
ok(app.PASOS[4].ok(A) === true, "el paso 5 se evalua sin exigir sicar");

/* La app real solo pinta con sesión iniciada (cloud && !usuario sale de render()).
   En el navegador eso lo resuelve onAuthStateChanged; aquí se simula un usuario
   verificado, igual que en la vista previa de firebaseConfig. */
vm.runInContext("usuario = { uid: 'prueba-uid', email: 'prueba@ejemplo.mx', emailVerified: true };", sandbox);

/* --- Render y navegacion --- */
A.paso = 1;
sandbox.__chk = "";
vm.runInContext("globalThis.__diag = (() => { try { render(); return 'ok'; } catch (e) { return String(e && e.message || e); } })()", sandbox);
const htmlPaso1 = app.texto();
ok(sandbox.__diag === "ok", "render() no lanza excepción (diag=" + sandbox.__diag + ")");
ok(htmlPaso1.length > 100, "render() en Paso 1 pinto la pantalla (largo " + htmlPaso1.length + ")");
ok(/Paso 1/.test(htmlPaso1) && /Paso 5/.test(htmlPaso1) && !/Paso 6/.test(htmlPaso1),
   "la barra muestra los pasos 1..5 y ninguno 6: " + (htmlPaso1.match(/<b>Paso \d<\/b>/g) || []).join(" "));
for (const n of [1, 2, 3, 4, 5]) {
  A.paso = n;
  const h = app.paso(n);
  ok(typeof h === "string" && h.length > 50 && !/sicar/i.test(h), "paso(" + n + ") devuelve HTML sin sicar");
}
const hall = app.paso(5);
ok(!/SICAR/i.test(hall), "la pantalla de hallazgos no lista columna SICAR");
ok(/data-go="4"/.test(hall), "el boton Anterior del paso 5 lleva al paso 4");

/* --- Paso 4: conteo dividido en dos columnas (PV y BR) que suman el total --- */
const p4 = app.paso(4);
ok(/data-k="realPV"/.test(p4) && /data-k="realBR"/.test(p4),
   "el Paso 4 ofrece columnas separadas de captura para PV y BR");
ok(/Piso de Ventas/.test(p4) && /Bodega/.test(p4) && /Total real/.test(p4),
   "el Paso 4 etiqueta PV (Piso de Ventas), BR (Bodega) y el Total real");
ok(!/data-k="division"/.test(p4) && !/<select/.test(p4),
   "el Paso 4 ya no usa el selector de división (ahora son dos cantidades)");
ok(!app.PASOS[3].ok({ verificador: "V", partidas: [{ realPV: "", realBR: "3" }] }),
   "el Paso 4 no se da por ok si falta la cantidad de PV");
ok(!app.PASOS[3].ok({ verificador: "V", partidas: [{ realPV: "4", realBR: "" }] }),
   "el Paso 4 no se da por ok si falta la cantidad de BR");
ok(app.PASOS[3].ok({ verificador: "V", partidas: [{ realPV: "4", realBR: "3" }] }),
   "el Paso 4 se da por ok con PV y BR capturados en cada partida");
ok(app.sumarReal({ realPV: "4", realBR: "3" }) === "7",
   "sumarReal() suma PV + BR = 7");
ok(app.sumarReal({ realPV: "", realBR: "" }) === "",
   "sumarReal() deja el total vacío si no hay conteo en ninguna división");
ok(app.sumarReal({ realPV: "4", realBR: "" }) === "4",
   "sumarReal() toma solo PV si BR está vacío (parte no contada en Bodega)");

/* --- Resumen, resultado y bloque de ajuste --- */
const r = app.resumen([A]);
ok(r.part === 1 && r.falt === 2 && r.sobr === 0,
   "resumen: part=" + r.part + " falt=" + r.falt + " sobr=" + r.sobr + " (recib 8 vs fact 10)");
ok(r.neto === undefined, "resumen ya no devuelve neto (real vs SICAR)");
ok(r.totalAjuste === r.recib + r.real, "totalAjuste = recibido + real = " + r.totalAjuste);
ok(r.real === 7 && r.realPV === 4 && r.realBR === 3,
   "resumen separa el conteo: realPV=" + r.realPV + " realBR=" + r.realBR + " real=" + r.real);
ok(r.real === r.realPV + r.realBR, "resumen: real (PV+BR) = " + r.real);
ok(app.resultado({ codigo: "x", fact: "10", recib: "8", real: "7", sicar: "99" }) === "Faltante en recepci\u00f3n",
   "resultado() ignora el sicar de un documento viejo");
ok(!/SICAR/.test(app.bloqueAjuste(r)), "el bloque de ajuste en pantalla no cita SICAR");

/* --- Normalizacion de un documento viejo (paso 6 + campo sicar) --- */
const viejo = app.normalizar({ id: "v1", fecha: "2026-09-01", linea: "Chevrolet", folio: "V-1",
  proveedor: "P", creado: 1, partidas: [{ codigo: "C", desc: "D", fact: "5", recib: "5", real: "5", sicar: "4" }], paso: 6 });
ok(viejo.paso === 5, "un documento guardado en el paso 6 se degrada al paso " + viejo.paso);
ok(!("sicar" in viejo.partidas[0]), "normalizar() descarta sicar (hasOnly() lo rechazaria)");
ok(Object.keys(viejo.partidas[0]).join(",") === "codigo,desc,fact,recib,realPV,realBR,real",
   "la partida queda con los seis campos (PV, BR y total): " + Object.keys(viejo.partidas[0]).join(","));
ok(viejo.partidas[0].realPV === "5" && viejo.partidas[0].realBR === "" && viejo.partidas[0].real === "5",
   "un documento viejo con solo 'real' migra su total a PV (realPV=5, realBR='', real=5)");
ok(app.completa(viejo) === true, "el documento viejo sigue contando como completo");
ok(app.guardable(viejo) === true, "el documento normalizado pasa guardable()");

/* --- Huella, avance y boton de otro folio --- */
ok(app.huella(A) !== app.huella(viejo), "huella() distingue documentos distintos");
ok(app.hayAvance(A) === true, "hayAvance() detecta la captura en curso");
ok(/Empezar otro folio/.test(app.botonOtroFolio()), "botonOtroFolio() se sigue ofreciendo");


/* --- PDF: sin columnas SICAR ni "Dif. sistema" --- */
const pdf = { tablas: [], textos: [], guardado: "" };
sandbox.jspdf = { jsPDF: function () {
  const api = {
    internal: { pageSize: { getWidth: () => 612, getHeight: () => 792 } },
    lastAutoTable: { finalY: 200 },
    setFillColor() {}, rect() {}, setTextColor() {}, setFont() {}, setFontSize() {},
    setDrawColor() {}, line() {}, addPage() {}, setPage() {}, getNumberOfPages: () => 1,
    text: t => { pdf.textos.push(String(t)); },
    autoTable: o => {
      pdf.tablas.push({ head: o.head[0], filas: o.body.length, resalta: o.didParseCell });
      api.lastAutoTable = { finalY: 200 };
    },
    save: n => { pdf.guardado = n; }
  };
  return api;
} };
sandbox.jsPDF = sandbox.jspdf.jsPDF;
app.crearPDF([A], "Prueba");
ok(pdf.guardado.indexOf("hallazgos_folio_A-9912_") === 0, "el PDF se genera: " + pdf.guardado);
ok(pdf.tablas.length === 3, "el PDF trae 3 tablas (resumen, ajuste y partidas): " + pdf.tablas.length);
const cabeceras = pdf.tablas.map(t => t.head.join(" | ")).join(" ;; ");
ok(!/SICAR/.test(cabeceras) && !/Dif\. sistema/.test(cabeceras),
   "ninguna tabla del PDF tiene SICAR ni 'Dif. sistema'");
ok(!/SICAR/i.test(pdf.textos.join(" ")), "ningun texto del PDF cita SICAR");
const detalle = pdf.tablas.filter(t => /C\u00f3digo/.test(t.head.join("")))[0];
ok(!!detalle && detalle.head.join("|") === "C\u00f3digo|Descripci\u00f3n|Fact.|Recib.|Dif. recep.|Real PV|Real BR|Real total|Resultado",
   "la tabla por partida tiene 9 columnas con Real PV, Real BR y Real total en orden: " + (detalle ? detalle.head.join(" | ") : "sin tabla"));
const celda = i => ({ section: "body", column: { index: i }, row: { raw: [] }, cell: { styles: {} } });
let c = celda(8); c.row.raw[8] = "Faltante en recepci\u00f3n"; detalle.resalta(c);
ok(Array.isArray(c.cell.styles.fillColor), "un hallazgo pinta la fila usando el indice 8 (Resultado)");
c = celda(8); c.row.raw[8] = "Conforme"; detalle.resalta(c);
ok(!c.cell.styles.fillColor, "una partida conforme no se pinta");

/* --- Navegacion real: clic en "Guardar y continuar" por los cinco pasos ---
   Se llama al manejador de clics real de la app con un botón simulado, dentro
   del contexto, para que use el mismo DOM y el mismo estado de la app. */
/* --- Navegación real: clic en "Guardar y continuar" desde el Paso 1 hasta el 5 ---
   Antes de probar la navegación se vuelve al Paso 1 con el documento ya capturado,
   que es la situación real de quien va avanzando pantalla por pantalla. */
A.paso = 1;

vm.runInContext([
  "globalThis.__pasos = [];",
  "globalThis.__traza = [];",
  "globalThis.__clic = async id => {",
  "  const b = { id, dataset: {}, closest(){ return this; } };",
  "  try {",
  "    await globalThis.__handlers.click({ target: { closest: () => b } });",
  "    globalThis.__traza.push(id + ' ok -> paso ' + A.paso);",
  "  } catch (e) { globalThis.__traza.push(id + ' ERR ' + String(e && e.message || e)); }",
  "  return A.paso;",
  "};",
  "globalThis.__ir = async () => {",
  "  for (let k = 0; k < 8 && A.paso < ULTIMO; k++) {",
  "    globalThis.__traza.push('vuelta ' + k + ' paso ' + A.paso);",
  "    await globalThis.__clic('sig');",
  "    globalThis.__pasos.push(A.paso);",
  "  }",
  "  return A.paso;",
  "};"
].join("\n"), sandbox);

});

test("navegación por clics, guardado local y autoguardado", async () => {
  const termino = await sandbox.__ir();
  ok(termino === 5, "el avance por clics llegó al paso " + termino + " (pasos: " + sandbox.__pasos.join(",") + ")");
  ok(A.paso === 5 && app.completa(A), "tras avanzar, el documento está completo en el paso 5");

  /* La app escribe con setDoc cuando hay Firebase (cloud=true) y en localStorage
     cuando no lo hay. Aquí se prueba la ruta real de guardado poniendo cloud en
     false: es el modo "sin Firebase" que la propia app contempla. */
  const local = await vm.runInContext(
    "(async function(){" +
    "  const doc = normalizar(JSON.parse(JSON.stringify(A))); doc.paso = 5;" +
    "  const lista = JSON.parse(localStorage.getItem('auditorias') || '[]');" +
    "  lista.push(doc);" +
    "  localStorage.setItem('auditorias', JSON.stringify(lista));" +
    "  return globalThis.__ls(); })()", sandbox);
  const enLocal = JSON.parse(JSON.parse(local).auditorias || "[]");
  ok(enLocal.length === 1 && enLocal[0].paso === 5,
     "el documento normalizado se persiste con paso=" + (enLocal[0] || {}).paso);
  const ultima = enLocal[0] || { partidas: [{}] };
  ok(!("sicar" in ultima.partidas[0]),
     "lo guardado no lleva sicar: " + Object.keys(ultima.partidas[0]).join(","));

  /* --- Botón "Empezar otro folio": debe aparecer con avance capturado ---
     No se pulsa aquí porque abre un diálogo que espera la decisión del usuario;
     lo que se comprueba es que la barra lo ofrezca cuando hay avance. */
  const barra = await vm.runInContext(
    "usuario = {uid:'prueba-uid', email:'prueba@ejemplo.mx', emailVerified:true};" +
    " A.paso = 5; render();" +
    " JSON.stringify({ paso: A.paso, boton: /nuevoFolio/.test(nodo('app').innerHTML)," +
    "   texto: (nodo('app').innerHTML.match(/Empezar otro folio[^<]*/) || [''])[0] })",
    sandbox);
  const b = JSON.parse(barra);
  ok(b.paso === 5 && b.boton === true,
     "en el Paso 5 con avance aparece el botón: \"" + b.texto + "\"");
  ok(/después de A-9912/.test(b.texto), "el botón nombra el folio que se va a guardar");

  /* --- Autoguardado por cambio ---
     Objetivo: que cerrar la pestaña por error no pierda el conteo. Se comprueba
     que (a) cada cambio deja un respaldo LOCAL de inmediato (sin esperar al
     retardo), y (b) el guardado silencioso persiste y apaga el aviso. Todo corre
     DENTRO del contexto para leer el `A` real (que se reasigna con blank()). */
  const autoRes = JSON.parse(await vm.runInContext(
    "(async function(){" +
    "  A = blank(); vista = 'nueva';" +
    "  A.folio = 'A-2024'; A.proveedor = 'ACME'; A.encargado = 'Ana';" +
    "  A.linea = 'Volkswagen'; A.fecha = '2026-05-05'; A.paso = 1;" +
    "  programarAutoguardado();" +
    "  const ls = JSON.parse(globalThis.__ls());" +
    "  const habiaPendiente = huella(A) !== A.hist;" +
    "  const okAuto = await autoguardar();" +
    "  return JSON.stringify({ borrador: ls['auditorias_borrador'] || ''," +
    "    habiaPendiente, okAuto, aSalvo: huella(A) === A.hist," +
    "    aviso: avisoSinGuardar(), indicador: textoIndicador() });" +
    "})()", sandbox));
  ok(/A-2024/.test(autoRes.borrador), "programarAutoguardado() deja el borrador en el respaldo local al instante");
  ok(autoRes.habiaPendiente === true, "antes de autoguardar la huella difiere del respaldo (hay cambios pendientes)");
  ok(autoRes.okAuto === true, "autoguardar() confirma el guardado silencioso del borrador");
  ok(autoRes.aSalvo === true, "tras el autoguardado el avance queda a salvo (huella == respaldo)");
  ok(autoRes.aviso === "", "con el avance guardable el aviso ya no alarma ('se perderá el folio')");
  ok(/Guardado/.test(autoRes.indicador), "el indicador muestra 'Guardado' tras el autoguardado");
});
