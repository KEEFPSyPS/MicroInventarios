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
  /* Stub del súper buscador (busqueda.js): app.js importa `buscarRegistros`.
     Los tests de flujo no abren el Historial, pero se define para que el vm
     nunca falle por una referencia ausente. Devuelve todos los registros. */
  "const buscarRegistros=(registros)=>((registros||[]).map(registro=>({registro,partidas:[]})));\n" +
  "const normalizarTexto=(s)=>{ if(s==null) return \"\"; return String(s).normalize(\"NFD\").replace(/\\p{Diacritic}/gu,\"\").toLowerCase().replace(/\\s+/g,\" \").trim(); };\n" +
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
    insertAdjacentHTML() {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
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
/* --- DOMParser mínimo para los fixtures CFDI ---
   Node no trae DOMParser. La app lo usa en extraerXML()/leerCabeceraCFDI() para
   leer el comprobante. En vez de un motor XML completo, se implementa un parser
   ligero que reconoce etiquetas (con o sin cierre), atributos y self-closing, que
   es lo que necesitan los fixtures. Expone getElementsByTagName(), getAttribute(),
   querySelector() y querySelectorAll() con la semántica que usa la app. */
function parseXML(texto){
  const raiz = { tag: "#doc", attrs: {}, hijos: [] };
  const pila = [raiz];
  const re = /<([!?/]?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let m;
  while((m = re.exec(texto))){
    const [, cierre, tag, attrsTxt, auto] = m;
    if(cierre === "!" || cierre === "?") continue;           /* <!DOCTYPE/<?xml */
    if(cierre === "/"){                                        /* cierre de etiqueta */
      if(pila.length > 1) pila.pop();
      continue;
    }
    const attrs = {};
    const ra = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let a;
    while((a = ra.exec(attrsTxt))) attrs[a[1]] = a[2];
    const nodo = { tag, attrs, hijos: [] };
    pila[pila.length - 1].hijos.push(nodo);
    if(!auto) pila.push(nodo);                                 /* abierta: anida */
  }
  const recorrer = (n, fn) => { fn(n); n.hijos.forEach(h => recorrer(h, fn)); };
  const doc = {
    querySelector: sel => (sel === "parsererror" ? null : null),
    getElementsByTagName(t){ const out = []; recorrer(raiz, n => { if(n.tag === t) out.push(el(n)); }); return out; },
    querySelectorAll(sel){
      const tags = sel.split(",").map(s => s.replace(/[[\].]/g, "").trim()).filter(Boolean);
      const out = [];
      recorrer(raiz, n => { if(tags.some(t => n.attrs && t in n.attrs)) out.push(el(n)); });
      return out;
    }
  };
  const el = n => ({ getAttribute: k => (k in n.attrs ? n.attrs[k] : null) });
  return doc;
}
sandbox.DOMParser = function(){ this.parseFromString = t => parseXML(String(t)); };

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
  "    insertAdjacentHTML(){}, querySelector:()=>null, querySelectorAll:()=>[], addEventListener(){},",
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
  "globalThis.app = { ULTIMO, PASOS, completa, resumen, resultado, normalizar, guardable, blank,",
  "  huella, hayAvance, botonOtroFolio, bloqueAjuste, paso, render, crearPDF, A, sumarReal,",
  "  sincronizarVerificador,",
  "  renderHist: () => renderHist(),",
  "  procesarLoteXML, auditoriaDesdeCFDI, claveFacturaDe, partidasDeCFDI, extraerXML,",
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

test("arranque y modelo de pasos (PV/BR, sin SICAR)", async () => {
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

/* --- Responsable automático: linea y encargado YA NO se capturan ---
   Objetivo: las auditorías NUEVAS no escriben `linea` ni `encargado` (el
   responsable sale de la sesión → campo `email`), pero las VIEJAS que sí los
   traen se siguen leyendo sin romper nada. */
const nuevo = app.blank();
ok(!("linea" in nuevo) && !("encargado" in nuevo),
   "blank() NO crea linea ni encargado");
ok(nuevo.email === "", "blank() reserva el campo email para el responsable de la sesión");

/* El Paso 1 ya no exige linea ni encargado: con fecha, proveedor y folio basta. */
const p1 = app.blank();
p1.fecha = "2026-05-05"; p1.proveedor = "ACME"; p1.folio = "F-1";
ok(app.PASOS[0].ok(p1) === true, "el Paso 1 se completa sin linea ni encargado");
delete p1.proveedor;
ok(app.PASOS[0].ok(p1) === false, "el Paso 1 sigue exigiendo proveedor");

/* normalizar(): ausente → se elimina (doc nuevo); válido → se conserva (doc viejo). */
const sinCampos = app.normalizar({ id: "n1", fecha: "2026-05-05", proveedor: "P", folio: "F-2",
  partidas: [{ codigo: "C", desc: "D", fact: "1" }], paso: 1 });
ok(!("linea" in sinCampos) && !("encargado" in sinCampos),
   "normalizar() no escribe linea/encargado cuando no vienen (doc nuevo)");
ok(app.guardable(sinCampos) === true, "guardable() acepta un documento sin linea/encargado");

const viejoOk = app.normalizar({ id: "v2", fecha: "2026-05-05", proveedor: "P", folio: "F-3",
  linea: "Volkswagen", encargado: "Luis", partidas: [{ codigo: "C", desc: "D", fact: "1" }], paso: 1 });
ok(viejoOk.linea === "Volkswagen" && viejoOk.encargado === "Luis",
   "normalizar() CONSERVA linea/encargado válidos de un documento viejo");

const viejoMalo = app.normalizar({ id: "v3", fecha: "2026-05-05", proveedor: "P", folio: "F-4",
  linea: "Nissan", encargado: 5, partidas: [{ codigo: "C", desc: "D", fact: "1" }], paso: 1 });
ok(!("linea" in viejoMalo) && !("encargado" in viejoMalo),
   "normalizar() descarta linea/encargado inválidos (las reglas los denegarían)");

/* hayAvance(): sin linea/encargado, un folio vacío sigue sin contar como avance. */
const vacio = app.blank();
ok(app.hayAvance(vacio) === false, "hayAvance() es false en un folio recién abierto (sin linea/encargado)");
ok(app.hayAvance(p1) === true, "hayAvance() detecta folio/proveedor aunque no haya linea/encargado");

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

/* --- Paso 1: sin campos Línea/Encargado; responsable de solo lectura --- */
const p1ui = app.paso(1);
ok(!/data-f="linea"/.test(p1ui) && !/<select/.test(p1ui),
   "el Paso 1 ya no ofrece el selector de Línea");
ok(!/data-f="encargado"/.test(p1ui),
   "el Paso 1 ya no ofrece el campo Encargado");
ok(/data-f="fecha"/.test(p1ui) && /data-f="proveedor"/.test(p1ui) && /data-f="folio"/.test(p1ui),
   "el Paso 1 conserva fecha, proveedor y folio");
ok(/Responsable/.test(p1ui) && /readonly/.test(p1ui) && /prueba@ejemplo\.mx/.test(p1ui),
   "el Paso 1 muestra el responsable de la sesión como solo lectura");

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

/* --- Verificador automático (Paso 4): sale de la sesión, ya no se captura ---
   El verificador se autocompleta con el correo de quien tiene la sesión abierta,
   solo si está vacío, y se fija antes de guardar/avanzar para que quede en el PDF.
   Una auditoría VIEJA con su verificador escrito a mano lo conserva. */

/* UI: el campo es de solo lectura y muestra el correo de la sesión. */
ok(/Verificador/.test(p4) && /readonly/.test(p4) && /prueba@ejemplo\.mx/.test(p4),
   "el Paso 4 muestra el Verificador de la sesión como solo lectura");
ok(!/data-f="verificador"/.test(p4),
   "el Paso 4 ya no expone el Verificador como campo editable (data-f)");

/* El Paso 4 avanza con solo PV/BR: sin verificador sigue ok. */
ok(app.PASOS[3].ok({ partidas: [{ realPV: "4", realBR: "3" }] }) === true,
   "el Paso 4 se da por ok con PV y BR aunque no haya verificador");
ok(app.PASOS[3].ok({ verificador: "", partidas: [{ realPV: "4", realBR: "3" }] }) === true,
   "el Paso 4 se da por ok con el verificador vacío");

/* huella() detecta el cambio del verificador → el autoguardado se dispara.
   Se comprueban dos documentos idénticos salvo por el verificador. */
const baseHuella = { folio: "F-1", fecha: "2026-05-05", proveedor: "P", email: "e", paso: 4,
  partidas: [{ codigo: "C", desc: "D", fact: "1", recib: "1", realPV: "1", realBR: "0", real: "1" }] };
const conVerif = Object.assign({}, baseHuella, { verificador: "prueba@ejemplo.mx" });
const sinVerif = Object.assign({}, baseHuella, { verificador: "" });
ok(app.huella(conVerif) !== app.huella(sinVerif),
   "huella() cambia cuando se fija el verificador (dispara el autoguardado)");

/* Autocompletado y respeto del valor guardado. Se prueba sobre una copia LOCAL del
   documento para no alterar la auditoría A que usan las pruebas siguientes. */
const rVerif = await vm.runInContext(
  "(function(){" +
  "  const respaldo = A;" +
  "  const out = {};" +
  /* 1) Con sesión y verificador vacío → toma el correo de la sesión. */
  "  A = blank(); A.verificador = ''; sincronizarVerificador(); out.conSesion = A.verificador;" +
  /* 2) No pisa un verificador ya escrito (auditoría vieja / ya verificada). */
  "  A.verificador = 'Ana'; sincronizarVerificador(); out.respetado = A.verificador;" +
  /* 3) Sin sesión no hay correo que asignar: queda vacío y no falla. */
  "  const u = usuario; usuario = null;" +
  "  A = blank(); A.verificador = ''; sincronizarVerificador(); out.sinSesion = A.verificador;" +
  /* 4) Sin sesión el Paso 4 sigue avanzando con solo PV/BR. */
  "  out.pasoOkSinSesion = PASOS[3].ok({ partidas: [{ realPV: '4', realBR: '3' }] });" +
  "  usuario = u;" +
  "  A = respaldo;" +
  "  return JSON.stringify(out);" +
  "})()", sandbox);
const vv = JSON.parse(rVerif);
ok(vv.conSesion === "prueba@ejemplo.mx",
   "sincronizarVerificador() completa el verificador con el correo de la sesión");
ok(vv.respetado === "Ana",
   "sincronizarVerificador() NO pisa un verificador ya guardado");
ok(vv.sinSesion === "",
   "sin sesión sincronizarVerificador() deja el verificador vacío sin fallar");
ok(vv.pasoOkSinSesion === true,
   "sin sesión el Paso 4 sigue avanzando con solo PV/BR");


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
/* El PDF quedó con UNA sola tabla: la de artículos auditados. Se quitaron las
   tablas "Resumen general" y "Conteo total para ajuste de inventario". */
ok(pdf.tablas.length === 1, "el PDF trae solo la tabla de artículos: " + pdf.tablas.length);
const cabeceras = pdf.tablas.map(t => t.head.join(" | ")).join(" ;; ");
ok(!/SICAR/.test(cabeceras) && !/Dif\. sistema/.test(cabeceras),
   "ninguna tabla del PDF tiene SICAR ni 'Dif. sistema'");
ok(!/Auditorías/.test(cabeceras) && !/Recibido \+ Real/.test(cabeceras),
   "el PDF ya no trae las tablas Resumen general ni Conteo para ajuste: " + cabeceras);
ok(!/SICAR/i.test(pdf.textos.join(" ")), "ningun texto del PDF cita SICAR");
/* Ya no aparecen los títulos de las tablas retiradas ni las notas de ajuste. */
const textosPlano = pdf.textos.join(" ");
ok(!/Resumen general/.test(textosPlano), "el PDF ya no imprime el título 'Resumen general'");
ok(!/Conteo total para ajuste de inventario/.test(textosPlano),
   "el PDF ya no imprime el título 'Conteo total para ajuste de inventario'");
ok(!/Ajuste sugerido/.test(textosPlano) && !/No usar para ajuste/.test(textosPlano),
   "el PDF ya no imprime las notas de ajuste");
/* El PDF ya no dice "Línea X": ahora nombra al Responsable (email de sesión o,
   si el documento es viejo, su `encargado`). */
const textosPDF = pdf.textos.join(" \u0001 ");
ok(!/\bL\u00ednea\b/.test(textosPDF), "el PDF ya no imprime 'Línea'");
ok(/Responsable/.test(textosPDF), "el PDF etiqueta al responsable: " + resultadosPDF(textosPDF));
ok(/Verificó/.test(textosPDF), "el PDF conserva la línea con Verificó");
ok(/Página 1 de/.test(textosPDF), "el PDF conserva el pie de página");
function resultadosPDF(t){ return String(t).split("\u0001").filter(s => /Responsable/.test(s)).join(" | ").slice(0, 160); }
const detalle = pdf.tablas.filter(t => /C\u00f3digo/.test(t.head.join("")))[0];
ok(!!detalle && detalle.head.join("|") === "C\u00f3digo|Descripci\u00f3n|Fact.|Recib.|Dif. recep.|Real PV|Real BR|Real total|Resultado",
   "la tabla por partida tiene 9 columnas con Real PV, Real BR y Real total en orden: " + (detalle ? detalle.head.join(" | ") : "sin tabla"));
const celda = i => ({ section: "body", column: { index: i }, row: { raw: [] }, cell: { styles: {} } });
let c = celda(8); c.row.raw[8] = "Faltante en recepci\u00f3n"; detalle.resalta(c);
ok(Array.isArray(c.cell.styles.fillColor), "un hallazgo pinta la fila usando el indice 8 (Resultado)");
c = celda(8); c.row.raw[8] = "Conforme"; detalle.resalta(c);
ok(!c.cell.styles.fillColor, "una partida conforme no se pinta");
/* --- PDF: 1 partida, muchas partidas (varias páginas) y auditoría VIEJA ---
   Se rearma el espía para contar páginas y tablas de cada corrida. */
const correrPDF = (docs, titulo) => {
  const spy = { tablas: [], textos: [], guardado: "", paginas: 1, addPage: 0 };
  sandbox.jspdf = { jsPDF: function () {
    const api = {
      internal: { pageSize: { getWidth: () => 612, getHeight: () => 792 } },
      lastAutoTable: { finalY: 300 },
      setFillColor() {}, rect() {}, setTextColor() {}, setFont() {}, setFontSize() {},
      setDrawColor() {}, line() {},
      addPage() { spy.addPage++; spy.paginas++; api.lastAutoTable = { finalY: 100 }; },
      setPage() {}, getNumberOfPages: () => spy.paginas,
      text: t => { spy.textos.push(String(t)); },
      /* Cada fila avanza el cursor ~20pt: así un folio con muchas partidas empuja
         el `y` más allá del alto de página y se ejercita el salto de página. */
      autoTable: o => { spy.tablas.push({ head: o.head[0], filas: o.body.length });
        api.lastAutoTable = { finalY: (o.startY || 100) + o.body.length * 20 }; },
      save: n => { spy.guardado = n; }
    };
    return api;
  } };
  sandbox.jsPDF = sandbox.jspdf.jsPDF;
  app.crearPDF(docs, titulo);
  return spy;
};

/* (a) Una sola partida: sin errores, una tabla y el encabezado/sello del folio. */
const spyUna = correrPDF([Object.assign({}, A)], "Prueba 1 partida");
ok(spyUna.tablas.length === 1 && spyUna.tablas[0].filas === 1,
   "PDF con 1 partida: una tabla de 1 fila");
ok(/Folio A-9912/.test(spyUna.textos.join(" ")), "PDF con 1 partida: incluye el encabezado del folio");

/* (b) Muchas partidas: obliga a saltar de página y no debe lanzar excepción. */
const muchas = app.normalizar({
  id: "muchas", fecha: "2026-09-01", folio: "M-1", proveedor: "P", email: "e@e.mx", verificador: "V", paso: 5,
  partidas: Array.from({ length: 60 }, (_, i) => ({ codigo: "C-" + i, desc: "Art " + i, fact: "10", recib: "10", realPV: "5", realBR: "5", real: "10" }))
});
const spyMuchas = correrPDF([muchas], "Prueba muchas partidas");
ok(spyMuchas.tablas.length === 1 && spyMuchas.tablas[0].filas === 60,
   "PDF con muchas partidas: una tabla de 60 filas");
ok(spyMuchas.addPage >= 1, "PDF con muchas partidas: salta de página (" + spyMuchas.addPage + ")");
ok(/Página 1 de/.test(spyMuchas.textos.join(" ")), "PDF con muchas partidas: numera las páginas");

/* (c) Auditoría VIEJA (con linea/encargado y sin verificador): no debe romper y
   debe usar `encargado` como responsable. */
const viejoPDF = app.normalizar({ id: "vp", fecha: "2026-09-01", linea: "Chevrolet", encargado: "Luis",
  folio: "V-9", proveedor: "P", paso: 5, partidas: [{ codigo: "C", desc: "D", fact: "5", recib: "5", real: "5" }] });
const spyViejo = correrPDF([viejoPDF], "Prueba auditoría vieja");
ok(spyViejo.tablas.length === 1, "PDF de auditoría vieja: una sola tabla");
ok(/Luis/.test(spyViejo.textos.join(" ")), "PDF de auditoría vieja: usa `encargado` como responsable");
ok(!/Resumen general/.test(spyViejo.textos.join(" ")) && !/Conteo total para ajuste de inventario/.test(spyViejo.textos.join(" ")),
   "PDF de auditoría vieja: tampoco imprime las tablas retiradas");

/* (d) Reporte del DÍA (varios folios): conserva el encabezado y una tabla por folio. */
const dia1 = app.normalizar({ id: "d1", fecha: "2026-09-01", folio: "D1", proveedor: "P1", email: "e@e.mx", verificador: "V", paso: 5, partidas: [{ codigo: "C1", desc: "A", fact: "1", recib: "1", real: "1" }] });
const dia2 = app.normalizar({ id: "d2", fecha: "2026-09-01", folio: "D2", proveedor: "P2", email: "e@e.mx", verificador: "V", paso: 5, partidas: [{ codigo: "C2", desc: "B", fact: "2", recib: "2", real: "2" }] });
const spyDia = correrPDF([dia1, dia2], "Reporte del día 2026-09-01");
ok(spyDia.tablas.length === 2, "PDF del día: una tabla por folio (" + spyDia.tablas.length + ")");
ok(spyDia.guardado.indexOf("hallazgos_dia_2026-09-01") === 0, "PDF del día: nombre de archivo correcto: " + spyDia.guardado);



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
  /* --- Historial: encabezado con Responsable (ya no Línea) ---
     renderHist() lee store.all() (en el test, getDocs devuelve vacío → tabla sin
     filas, pero con el encabezado). Se comprueba que la columna de Línea se
     reemplazó por Responsable, el dato que ahora existe en los documentos. */
  await app.renderHist();
  const histHTML = app.texto();
  ok(/Historial y reportes/.test(histHTML), "el Historial se pinta");
  ok(/<th scope="col">Responsable<\/th>/.test(histHTML) && !/<th scope="col">L\u00ednea<\/th>/.test(histHTML),
     "el Historial cambia la columna Línea por Responsable");

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

/* ===== Carga múltiple de XML: un CFDI = una auditoría =====
   Cubre: parser CFDI, clave de duplicados (UUID o proveedor·folio), cálculo del
   paso inicial, el lote completo (válidos + sin partidas + ilegible + duplicado
   + mismo folio con otro proveedor), el cotejo contra lo YA GUARDADO (una sola
   lectura de store.all() al inicio; mayúsculas/acentos ignorados) y que un solo
   archivo NO se trata como lote.
   Se leen fixtures reales de tests/fixtures. */
const rutaFixture = n => require("path").join(__dirname, "tests", "fixtures", n);
const leerXML = n => fs.readFileSync(rutaFixture(n), "utf8");
const archivoFalso = (nombre, texto) => ({ name: nombre, size: texto.length, text: () => Promise.resolve(texto) });

test("carga múltiple de XML: helpers de dedupe y paso inicial", () => {
  const { claveFacturaDe, partidasDeCFDI, auditoriaDesdeCFDI, extraerXML } = app;

  /* Clave de duplicado: UUID cuando existe; si no, proveedor·folio. */
  ok(claveFacturaDe({ uuid: "ABC", proveedor: "P", folio: "F" }) === "uuid:abc",
     "con UUID la clave usa el UUID");
  ok(claveFacturaDe({ proveedor: "Refaccionaria", folio: "A-1" }) === "pf:refaccionaria\u00b7a-1",
     "sin UUID la clave usa proveedor·folio en minúsculas");

  /* partidasDeCFDI: descarta sin código o sin cantidad y completa los seis campos. */
  const ps = partidasDeCFDI([
    { codigo: "C1", desc: "D", fact: "5" },
    { codigo: "", desc: "sin codigo", fact: "2" },
    { codigo: "C2", desc: "sin cantidad", fact: "" }
  ]);
  ok(ps.length === 1 && ps[0].codigo === "C1" && ps[0].fact === "5",
     "solo queda la partida con codigo y cantidad: " + ps.length);
  ok(Object.keys(ps[0]).join(",") === "codigo,desc,fact,recib,real,realPV,realBR",
     "la partida del lote trae los siete campos: " + Object.keys(ps[0]).join(","));

  /* extraerXML sobre un fixture real. */
  const res = extraerXML(leerXML("cfdi-valido-a.xml"));
  ok(res.partidas.length === 2, "el fixture válido trae 2 partidas");
  ok(res.cabecera.folio === "A-1001", "el folio del fixture viene del atributo Folio: " + res.cabecera.folio);
  ok(res.cabecera.uuid === "11111111-1111-1111-1111-111111111111", "el UUID del timbre se expone aparte");

  /* Paso inicial: con cabecera completa y partidas → 2; sin partidas → 1. */
  const conTodo = auditoriaDesdeCFDI(res);
  ok(conTodo.paso === 2, "con cabecera completa y partidas el paso inicial es 2, no " + conTodo.paso);
  ok(typeof conTodo.email === "string", "el responsable sale de la sesión (email)");
  ok(!("linea" in conTodo) && !("encargado" in conTodo), "la auditoría del lote no escribe linea ni encargado");
  const sinPartes = auditoriaDesdeCFDI({ partidas: [], cabecera: res.cabecera });
  ok(sinPartes.paso === 1, "sin partidas el paso inicial es 1, no " + sinPartes.paso);
});

test("carga múltiple de XML: lote omite y sigue", async () => {
  /* Lote de 8: 4 válidos (a y b con UUID; mismo-folio con OTRO proveedor; pf-1 sin
     UUID), 2 duplicados (dup con el UUID de a; pf-2 con el mismo proveedor·folio de
     pf-1) y 2 omitidos (sin partidas e ilegible). */
  const lote = [
    archivoFalso("a.xml", leerXML("cfdi-valido-a.xml")),
    archivoFalso("b.xml", leerXML("cfdi-valido-b.xml")),
    archivoFalso("dup.xml", leerXML("cfdi-duplicado.xml")),
    archivoFalso("mismo-folio.xml", leerXML("cfdi-mismo-folio.xml")),
    archivoFalso("pf-1.xml", leerXML("cfdi-pf-1.xml")),
    archivoFalso("pf-2.xml", leerXML("cfdi-pf-2.xml")),
    archivoFalso("sin-partidas.xml", leerXML("cfdi-sin-partidas.xml")),
    archivoFalso("roto.xml", leerXML("cfdi-roto.xml"))
  ];
  const r = await vm.runInContext(
    "(async function(){ usuario = {uid:'prueba-uid', email:'auditor@ejemplo.mx'};" +
    "  return JSON.stringify(await procesarLoteXML(globalThis.__lote)); })()",
    Object.assign(sandbox, { __lote: lote }));
  const res = JSON.parse(r);
  ok(res.guardados.length === 4, "se guardan 4 auditorías del lote, no " + res.guardados.length);
  ok(res.omitidos.length === 4, "se omiten 4 archivos, no " + res.omitidos.length);
  const motivos = res.omitidos.map(o => o.motivo).join(" | ");
  ok((motivos.match(/repetida/g) || []).length === 2,
     "los 2 duplicados (UUID y proveedor·folio) se omiten por repetidos: " + motivos);
  ok(/sin partidas|conceptos/i.test(motivos), "el archivo sin partidas se omite con su motivo: " + motivos);
  ok(res.guardados.every(g => g.paso === 2), "las 4 auditorías válidas quedan en el paso 2");
  ok(res.guardados.every(g => g.folio && g.proveedor), "cada auditoría guardada trae folio y proveedor");
  ok(/4 de 8/.test(res.resumenTexto), "el resumen informa 4 de 8: " + res.resumenTexto);

  /* El resumen visible queda en la región aria-live #facturaMsg. */
  const msg = sandbox.__nodos["facturaMsg"] ? sandbox.__nodos["facturaMsg"].innerHTML : "";
  ok(/guardados/.test(msg) && /lista-lote/.test(msg),
     "el resumen del lote se pinta en #facturaMsg (aria-live)");
});

test("carga múltiple de XML: tope de 20 archivos y 5 MB por archivo", async () => {
  const valido = leerXML("cfdi-valido-b.xml");
  /* 19 válidos con UUID distinto (ninguno duplicado) + 1 de más de 5 MB (dentro de
     los 20) + 3 válidos de sobra (fuera del tope). Esperado: 1 omitido por tamaño,
     19 guardados y 3 ignorados por cantidad. */
  const lote = [];
  for(let i = 0; i < 19; i++){
    lote.push(archivoFalso("f" + i + ".xml",
      valido.replace("22222222-2222-2222-2222-222222222222",
                     "22222222-2222-2222-2222-2222222222" + String(i).padStart(2, "0"))));
  }
  const grande = archivoFalso("grande.xml", valido);
  grande.size = (5 * 1024 * 1024) + 1;
  lote.push(grande);
  for(let i = 19; i < 22; i++){
    lote.push(archivoFalso("g" + i + ".xml",
      valido.replace("22222222-2222-2222-2222-222222222222",
                     "22222222-2222-2222-2222-2222222222" + String(i).padStart(2, "0"))));
  }
  const r = await vm.runInContext(
    "(async function(){ usuario = {uid:'prueba-uid', email:'auditor@ejemplo.mx'};" +
    "  return JSON.stringify(await procesarLoteXML(globalThis.__lote2)); })()",
    Object.assign(sandbox, { __lote2: lote }));
  const res = JSON.parse(r);
  ok(res.porCantidad === 23 - 20, "se avisa que 3 archivos pasaron del tope de 20: " + res.porCantidad);
  ok(res.omitidos.some(o => /5 MB/.test(o.motivo)),
     "el archivo de más de 5 MB se omite: " + res.omitidos.map(o => o.motivo).join(" | "));
  ok(res.guardados.length === 19, "se guardan 19 auditorías (20 menos el grande), no " + res.guardados.length);
});

test("carga múltiple de XML: un solo archivo conserva el flujo de siempre (no es lote)", async () => {
  /* El disparador real es el `change` del input #factura. Con UN solo archivo NO
     debe entrar a la rama de lote (que guarda y manda al Historial): debe rellenar
     la auditoría en pantalla, como siempre. Se invoca el manejador guardado por el
     arnés (document.addEventListener) con un input de un único XML. */
  const r = await vm.runInContext(
    "(async function(){" +
    "  usuario = {uid:'prueba-uid', email:'auditor@ejemplo.mx', emailVerified:true};" +
    "  vista = 'nueva'; A = blank(); msg = '';" +
    "  const t = { id:'factura', isConnected:true, dataset:{}, value:'x'," +
    "    files:[{ name:'una.xml', size:1, text:()=>Promise.resolve(globalThis.__unoA) }] };" +
    "  globalThis.__guardadosAntes = (window._list||[]).length;" +
    "  await globalThis.__handlers.change({ target: t });" +
    "  return JSON.stringify({ vista, folio: A.folio, proveedor: A.proveedor," +
    "    msgHtml: (nodo('facturaMsg') && nodo('facturaMsg').innerHTML) || '' });" +
    "})()",
    Object.assign(sandbox, { __unoA: leerXML("cfdi-valido-a.xml") }));
  const res = JSON.parse(r);
  ok(res.vista === "nueva", "con un solo XML se permanece en la captura, no salta al Historial: " + res.vista);
  ok(res.folio === "A-1001", "el único XML rellena el folio en pantalla: " + res.folio);
  ok(res.proveedor === "Refaccionaria del Norte", "también el proveedor: " + res.proveedor);
  ok(!/lista-lote/.test(res.msgHtml), "no aparece el resumen de lote con un solo archivo");
});

/* Corre procesarLoteXML con un historial YA GUARDADO simulado: se sustituye
   store.all() por los registros indicados (una sola lectura, como en producción)
   y se restaura al terminar. Devuelve el resumen real. */
const correrLoteConGuardados = (lote, guardados) => vm.runInContext(
  "(async function(){" +
  "  usuario = {uid:'prueba-uid', email:'auditor@ejemplo.mx'};" +
  "  const original = store.all;" +
  "  store.all = async () => globalThis.__guardados;" +
  "  try{ return JSON.stringify(await procesarLoteXML(globalThis.__loteG)); }" +
  "  finally{ store.all = original; }" +
  "})()",
  Object.assign(sandbox, { __loteG: lote, __guardados: guardados }));

test("carga múltiple de XML: una factura ya guardada antes se omite del lote", async () => {
  /* El historial ya tiene "Refaccionaria del Norte" · A-1001 (cfdi-valido-a). Un
     lote con esa misma factura (mismo UUID) y otra nueva: la guardada se omite con
     motivo legible y la nueva sí se guarda. */
  const lote = [
    archivoFalso("a.xml", leerXML("cfdi-valido-a.xml")),
    archivoFalso("b.xml", leerXML("cfdi-valido-b.xml"))
  ];
  const res = JSON.parse(await correrLoteConGuardados(lote,
    [{ proveedor: "Refaccionaria del Norte", folio: "A-1001" }]));
  ok(res.guardados.length === 1, "solo se guarda la factura nueva, no " + res.guardados.length);
  ok(res.guardados[0].folio === "C-2002", "la que se guarda es la nueva (C-2002): " + res.guardados[0].folio);
  ok(res.omitidos.length === 1, "se omite 1 archivo ya capturado, no " + res.omitidos.length);
  ok(/ya capturada antes \(folio A-1001\)/.test(res.omitidos[0].motivo),
     "el motivo nombra el folio ya capturado: " + res.omitidos[0].motivo);
});

test("carga múltiple de XML: el mismo folio con OTRO proveedor sí se guarda", async () => {
  /* cfdi-mismo-folio.xml trae folio A-1001 pero de "Otro Proveedor SA": no es la
     misma factura que la ya guardada de "Refaccionaria del Norte", así que se
     guarda. La comparación contra lo guardado es por proveedor + folio. */
  const lote = [archivoFalso("mismo-folio.xml", leerXML("cfdi-mismo-folio.xml"))];
  const res = JSON.parse(await correrLoteConGuardados(lote,
    [{ proveedor: "Refaccionaria del Norte", folio: "A-1001" }]));
  ok(res.guardados.length === 1, "la factura con el mismo folio pero otro proveedor se guarda");
  ok(res.omitidos.length === 0, "no se omite nada: " + res.omitidos.map(o => o.motivo).join(" | "));
  ok(res.guardados[0].proveedor === "Otro Proveedor SA", "se guardó la del otro proveedor: " + res.guardados[0].proveedor);
});

test("carga múltiple de XML: el cotejo contra lo guardado ignora mayúsculas y acentos", async () => {
  /* Lo guardado viene "sucio" (mayúsculas y espacios sobrantes) y una variante con
     acento: el cotejo debe reconocer igual la factura gracias a normalizarTexto().
     (a) proveedor en MAYÚSCULAS + folio con espacios; (b) acento en "Póniente". */
  const loteA = [archivoFalso("a.xml", leerXML("cfdi-valido-a.xml"))];
  const resA = JSON.parse(await correrLoteConGuardados(loteA,
    [{ proveedor: "  REFACCIONARIA DEL NORTE ", folio: "  a-1001 " }]));
  ok(resA.omitidos.length === 1 && resA.guardados.length === 0,
     "con lo guardado en mayúsculas/espacios la factura se reconoce como ya capturada");

  const loteB = [archivoFalso("b.xml", leerXML("cfdi-valido-b.xml"))];
  const resB = JSON.parse(await correrLoteConGuardados(loteB,
    [{ proveedor: "Autopartes Póniente", folio: "C-2002" }]));
  ok(resB.omitidos.length === 1 && resB.guardados.length === 0,
     "un acento en el proveedor guardado no impide reconocer la factura repetida");
});
test("carga múltiple de XML: si falla la lectura del historial, el lote continúa y se avisa", async () => {
  /* store.all() rechaza (sin red / sin permiso). El cotejo contra lo guardado no se
     puede hacer, pero el lote debe seguir guardando los válidos y, además del
     console.warn, el aviso fijo debe aparecer en el resumen (aria-live #facturaMsg)
     y en el texto plano. Se comprueba también que el resto del lote (un duplicado
     interno) sigue funcionando. */
  const lote = [
    archivoFalso("a.xml", leerXML("cfdi-valido-a.xml")),
    archivoFalso("dup.xml", leerXML("cfdi-duplicado.xml")),   /* repetida dentro del lote (UUID de a) */
    archivoFalso("b.xml", leerXML("cfdi-valido-b.xml")),
    archivoFalso("pf-1.xml", leerXML("cfdi-pf-1.xml"))
  ];
  const r = await vm.runInContext(
    "(async function(){" +
    "  usuario = {uid:'prueba-uid', email:'auditor@ejemplo.mx'};" +
    "  const original = store.all;" +
    "  store.all = async () => { throw new Error('sin red'); };" +
    "  try{ return JSON.stringify(await procesarLoteXML(globalThis.__loteF)); }" +
    "  finally{ store.all = original; }" +
    "})()",
    Object.assign(sandbox, { __loteF: lote }));
  const res = JSON.parse(r);
  ok(res.cotejoFalló === true, "el resumen marca que el cotejo contra lo guardado falló");
  ok(res.guardados.length === 3, "el lote CONTINÚA y guarda los 3 válidos, no " + res.guardados.length);
  ok(res.omitidos.length === 1 && /repetida/.test(res.omitidos[0].motivo),
     "el dedupe interno sigue funcionando aunque falle el cotejo externo");
  const aviso = "No se pudo comprobar contra lo ya guardado; revisa posibles duplicados en el Historial.";
  ok(res.resumenTexto.includes(aviso), "el texto plano incluye el aviso de cotejo fallido: " + res.resumenTexto);

  const msg = sandbox.__nodos["facturaMsg"] ? sandbox.__nodos["facturaMsg"].innerHTML : "";
  ok(/No se pudo comprobar contra lo ya guardado/.test(msg),
     "el aviso aparece en la región aria-live #facturaMsg");
});





