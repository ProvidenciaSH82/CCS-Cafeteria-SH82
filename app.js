/* =========================================================
   POS SHALOM — lógica de la aplicación
   Todo se guarda en localStorage (memoria del navegador).
   ========================================================= */

/* ---------------------------------------------------------
   SINCRONIZACIÓN ENTRE DISPOSITIVOS (Firebase Realtime Database)
   ---------------------------------------------------------
   Arquitectura (deliberadamente simple, para no arriesgar lo que ya
   funciona):
     - Todo "state" se sigue guardando también en localStorage, como antes
       (el sistema funciona 100% aunque no haya internet o Firebase falle).
     - Datos de bajo riesgo de choque (nombre del negocio, categorías,
       cuadrícula, caja abierta/cerrada, tema, contraseñas, etc.) se
       sincronizan como un solo bloque "meta".
     - Datos de alto riesgo de choque entre varios cajeros al mismo tiempo
       (productos, ventas, ventas en espera, movimientos de caja, cierres)
       se sincronizan registro por registro, usando Firebase `update()`
       con rutas tipo "sales/<id>": cada registro vive en su propia ruta,
       así dos dispositivos que crean cosas distintas al mismo tiempo no se
       pisan entre sí. Por eso los IDs de ventas/ventas en espera/
       movimientos/cierres pasaron de números secuenciales a identificadores
       únicos (uid()): dos dispositivos nunca calculan el mismo ID nuevo.
     - Cada vez que se guarda el estado (saveState) se calcula qué registros
       cambiaron desde la última sincronización y solo esos se envían
       (diffCollectionUpdates). Un listener permanente aplica los cambios
       que lleguen de otros dispositivos y vuelve a dibujar la pantalla
       visible, sin interrumpir una venta que se esté armando en este
       mismo dispositivo (el carrito nunca se sincroniza, es local).
   --------------------------------------------------------- */
const firebaseConfig = {
  apiKey: "AIzaSyCRW_IdtuifOQCI38lIVnZDZlEvIn5W3iU",
  authDomain: "cafeteria-sh82-ccs.firebaseapp.com",
  databaseURL: "https://cafeteria-sh82-ccs-default-rtdb.firebaseio.com",
  projectId: "cafeteria-sh82-ccs",
  storageBucket: "cafeteria-sh82-ccs.firebasestorage.app",
  messagingSenderId: "828798106418",
  appId: "1:828798106418:web:e3eeccf7bf169282d2f52b"
};
let fbReady = false;
let fbRootRef = null;
try {
  if (typeof firebase !== "undefined"){
    firebase.initializeApp(firebaseConfig);
    fbRootRef = firebase.database().ref("posShalomState");
    fbReady = true;
  }
} catch (err){
  console.error("No se pudo iniciar Firebase; el sistema seguirá funcionando solo en este dispositivo:", err);
}
let appStarted = false; // evita sincronizar antes de haber comparado con Firebase al arrancar
let fbPushTimer = null;
let lastSyncSnapshot = { products: {}, sales: {}, pendingSales: {}, cashMovements: {}, cashClosures: {}, meta: null };
let fbStatus = "init"; // "init" | "ok" | "error" — se muestra en pantalla para poder diagnosticar problemas de conexión sin abrir la consola

// Actualiza el indicador visible (pantalla de Inicio y panel lateral) del
// estado de la sincronización con Firebase. Se agregó porque, sin esto, un
// problema de conexión (por ejemplo, reglas de la base de datos mal
// configuradas) fallaba en silencio: el sistema seguía funcionando con los
// datos locales de cada dispositivo, pero nadie se daba cuenta de que no se
// estaban compartiendo con los demás.
function setFbStatus(status){
  fbStatus = status;
  const label = status === "ok" ? "☁ Sincronizado"
    : status === "error" ? "⚠ Sin conexión con la nube"
    : "☁ Conectando...";
  document.querySelectorAll(".fb-status-dot").forEach(el => { el.textContent = label; });
}

// ---------- ESTADO GLOBAL ----------
let state = {
  businessName: "POS Shalom",
  categories: [],   // { id, name }  (el orden del arreglo = orden de visualización)
  products: [],     // { id, name, price, cost, categoryId, hidden, stock, stockMin, stockTracked }
  sales: [],        // { id, jornadaNumber, date, name, items:[...], subtotal, discount, total, method, cash, qr, delivery:{...}, deleted }
  cart: [],         // { productId, name, price, qty, discountType, discountValue }
  pendingSales: [], // ventas en espera: { id, items:[...], createdAt }
  gridSizes: [],    // [{ rows, cols }, ...]
  selectedGridSizeIndex: 0,
  cashRegister: null,   // { openedAt, initialAmount } — caja abierta actualmente, o null si está cerrada
  cashClosures: [],     // historial de cierres de caja
  cashMovements: [],    // entradas/salidas de dinero: { id, type:'entrada'|'salida', description, account:'efectivo'|'qr', amount, date, deleted, deletedAt }
  stockEnabled: false,  // interruptor general del sistema de stock
  theme: { bgColor: null, sidebarColor: null, accentColor: null, textColor: null, logoDataUrl: null, logoScale: 1 },
  advancedConfigPassword: "Shalom82", // protege Configuración avanzada (no distingue mayúsculas/minúsculas)
  deletePassword: "1234"              // protege eliminación de ventas, cierres y movimientos (solo números)
};

let currentArea = "landing";    // "landing" | "cajero" | "entrega" | "config-general"
let currentCategoryId = null;   // categoría abierta en Nueva venta
let selectedPayMethod = null;   // solo para resaltar visualmente el último método usado
let editingSaleId = null;       // si no es null, se está editando una venta existente
let editingSaleOriginal = null; // { method, cash, qr } de la venta que se está editando, para precargar su modal de pago
let categoryPage = 0;
let productPage = 0;
let currentDeliverySaleId = null; // pedido abierto en el detalle de entrega

// ---------- CARGA / GUARDADO ----------
function defaultGridSizes(){
  return [
    { rows:2, cols:2 }, { rows:2, cols:3 }, { rows:3, cols:2 },
    { rows:3, cols:3 }, { rows:3, cols:4 }, { rows:4, cols:3 }
  ];
}

function generateDeliveryUnits(items, delivered){
  const units = [];
  items.forEach(i => {
    for (let k = 0; k < i.qty; k++){
      units.push({
        name: i.name,
        delivered: !!delivered,
        answers: (i.unitAnswers && i.unitAnswers[k]) ? i.unitAnswers[k] : []
      });
    }
  });
  return units;
}

// Asigna un número de venta por jornada (1, 2, 3...) a las ventas guardadas
// antes de esta mejora, agrupándolas según la jornada de caja (cierre, o la
// caja actualmente abierta) a la que pertenecen por fecha. Las ventas nuevas
// ya reciben su jornadaNumber directamente al crearse.
function migrateJornadaNumbers(){
  const needsNumbering = state.sales.filter(s => s.jornadaNumber === undefined);
  if (needsNumbering.length === 0) return;

  const jornadas = (state.cashClosures || [])
    .map(c => ({ start: new Date(c.openedAt).getTime(), end: new Date(c.closedAt).getTime() }))
    .sort((a,b) => a.start - b.start);
  if (state.cashRegister){
    jornadas.push({ start: new Date(state.cashRegister.openedAt).getTime(), end: Infinity });
  }

  needsNumbering.sort((a,b) => new Date(a.date) - new Date(b.date));
  const counters = {};
  needsNumbering.forEach(s => {
    const t = new Date(s.date).getTime();
    const jornada = jornadas.find(j => t >= j.start && t <= j.end);
    const key = jornada ? jornada.start : "sinjornada";
    counters[key] = (counters[key] || 0) + 1;
    s.jornadaNumber = counters[key];
  });
}

function loadLocalOrSeed(){
  const saved = localStorage.getItem("posShalomState");
  if (saved){
    state = JSON.parse(saved);
  } else {
    seedData();
  }
  applyDefaultsAndMigrations();
  saveState();
}

// Migración: asegura que estados guardados antes de estas mejoras (o que
// llegan recién descargados de Firebase) tengan todos los campos nuevos.
function applyDefaultsAndMigrations(){
  if (!state.pendingSales) state.pendingSales = [];
  if (!state.gridSizes || state.gridSizes.length === 0) state.gridSizes = defaultGridSizes();
  if (state.selectedGridSizeIndex === undefined || state.selectedGridSizeIndex === null || !state.gridSizes[state.selectedGridSizeIndex]){
    const idx = state.gridSizes.findIndex(g => g.rows === 3 && g.cols === 3);
    state.selectedGridSizeIndex = idx >= 0 ? idx : 0;
  }
  state.products.forEach((p, idx) => {
    if (p.cost === undefined || p.cost === null) p.cost = 0;
    if (p.stock === undefined || p.stock === null) p.stock = 0;
    if (p.stockMin === undefined || p.stockMin === null) p.stockMin = 0;
    if (p.stockTracked === undefined || p.stockTracked === null) p.stockTracked = false;
    if (p.advanced === undefined || p.advanced === null) p.advanced = false;
    if (!p.questions) p.questions = [];
    if (p.kitchen === undefined || p.kitchen === null) p.kitchen = false;
    if (p.order === undefined || p.order === null) p.order = idx;
  });
  if (state.cashRegister === undefined) state.cashRegister = null;
  if (!state.cashClosures) state.cashClosures = [];
  if (!state.cashMovements) state.cashMovements = [];
  if (!state.advancedConfigPassword) state.advancedConfigPassword = "Shalom82";
  if (!state.deletePassword) state.deletePassword = "1234";
  if (state.stockEnabled === undefined) state.stockEnabled = false;
  if (!state.theme) state.theme = { bgColor: null, sidebarColor: null, accentColor: null, textColor: null, logoDataUrl: null, logoScale: 1 };
  if (!state.theme.logoScale) state.theme.logoScale = 1;
  // Ventas guardadas antes de "Entrega de pedidos": se consideran ya entregadas
  // para no generar pedidos pendientes de jornadas que ya pasaron.
  state.sales.forEach(s => {
    if (!s.delivery){
      s.delivery = { units: generateDeliveryUnits(s.items, true), finalized: true };
    }
  });
  migrateJornadaNumbers();
}

function saveState(){
  try {
    localStorage.setItem("posShalomState", JSON.stringify(state));
  } catch (err){
    console.error("No se pudo guardar el estado:", err);
    alert("No se pudo guardar la información (posiblemente el almacenamiento está lleno, por ejemplo por un logo muy grande). Intenta con una imagen más pequeña.");
  }
  scheduleFirebaseSync();
}

// Datos de ejemplo, solo la primera vez que se abre el sistema
function seedData(){
  state.categories = [
    { id: "c1", name: "Hamburguesas" },
    { id: "c2", name: "Salados" },
    { id: "c3", name: "Bebidas" }
  ];
  state.products = [
    { id: "p1", name: "Hamburguesa simple", price: 15, cost: 8, categoryId: "c1", hidden: false, stock: 0, stockMin: 0, stockTracked: false, order: 0 },
    { id: "p2", name: "Hamburguesa con papa", price: 20, cost: 11, categoryId: "c1", hidden: false, stock: 0, stockMin: 0, stockTracked: false, order: 1 },
    { id: "p3", name: "Empanada de queso", price: 5, cost: 2.5, categoryId: "c2", hidden: false, stock: 0, stockMin: 0, stockTracked: false, order: 0 },
    { id: "p4", name: "Salteña", price: 6, cost: 3, categoryId: "c2", hidden: false, stock: 0, stockMin: 0, stockTracked: false, order: 1 },
    { id: "p5", name: "Gaseosa 500ml", price: 7, cost: 4, categoryId: "c3", hidden: false, stock: 0, stockMin: 0, stockTracked: false, order: 0 },
    { id: "p6", name: "Agua", price: 4, cost: 2, categoryId: "c3", hidden: false, stock: 0, stockMin: 0, stockTracked: false, order: 1 }
  ];
  state.gridSizes = defaultGridSizes();
  state.selectedGridSizeIndex = state.gridSizes.findIndex(g => g.rows === 3 && g.cols === 3);
  state.cashRegister = null;
  state.cashClosures = [];
  state.cashMovements = [];
  state.stockEnabled = false;
  state.theme = { bgColor: null, sidebarColor: null, accentColor: null, textColor: null, logoDataUrl: null, logoScale: 1 };
  state.advancedConfigPassword = "Shalom82";
  state.deletePassword = "1234";
}

function uid(prefix){
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
}

// Devuelve los productos de una categoría ya ordenados según el campo
// `order` (antes el orden era la posición en el arreglo; ahora que cada
// producto es también un registro independiente de Firebase, el orden
// visible se guarda explícitamente en cada producto).
function productsInCategory(catId){
  return state.products.filter(p => p.categoryId === catId).sort((a,b) => (a.order||0) - (b.order||0));
}

// ---------- FIREBASE: SINCRONIZACIÓN ENTRE DISPOSITIVOS ----------
function arrayToMapById(arr){
  const map = {};
  (arr || []).forEach(item => { map[String(item.id)] = item; });
  return map;
}

function buildMetaObject(){
  return {
    businessName: state.businessName,
    categories: state.categories,
    gridSizes: state.gridSizes,
    selectedGridSizeIndex: state.selectedGridSizeIndex,
    cashRegister: state.cashRegister,
    stockEnabled: state.stockEnabled,
    theme: state.theme,
    advancedConfigPassword: state.advancedConfigPassword,
    deletePassword: state.deletePassword
  };
}

// Compara el arreglo actual de una colección contra la última foto enviada
// a Firebase y arma solo las rutas que cambiaron, para usar con `update()`
// (que fusiona por ruta, sin pisar lo que otro dispositivo haya escrito en
// una ruta distinta al mismo tiempo).
// Identificador de la jornada actual para la ruta del contador en Firebase
// (una jornada = una apertura de caja; cada apertura tiene su propio
// contador, así que el número de venta vuelve a empezar en 1 sin chocar con
// el de jornadas anteriores).
function getJornadaCounterKey(){
  if (!state.cashRegister || !state.cashRegister.openedAt) return null;
  return state.cashRegister.openedAt.replace(/[.#$\[\]\/]/g, "_");
}

// Calcula el próximo número de venta de forma segura entre varios
// dispositivos. Usa una transacción de Firebase (increment atómico en el
// servidor): si dos cajeros cobran en el mismo instante, Firebase procesa
// las dos transacciones una después de la otra y a cada una le entrega un
// número distinto — nunca el mismo. Si no hay Firebase disponible, o no
// responde en unos segundos (sin internet), se usa el cálculo local de
// siempre, para no trabar una venta.
function nextJornadaNumberSafe(){
  const localFallback = () => getCurrentJornadaSales().length + 1;
  const key = getJornadaCounterKey();
  if (!fbReady || !fbRootRef || !key) return Promise.resolve(localFallback());
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(localFallback());
    }, 3000);
    fbRootRef.child("counters/" + key).transaction((current) => (current || 0) + 1)
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result.committed && result.snapshot.val()){
          resolve(result.snapshot.val());
        } else {
          resolve(localFallback());
        }
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(localFallback());
      });
  });
}

function diffCollectionUpdates(basePath, currentArr, lastMap){
  const updates = {};
  const currentMap = arrayToMapById(currentArr);
  Object.keys(currentMap).forEach(id => {
    const cur = currentMap[id];
    const prev = lastMap[id];
    if (!prev || JSON.stringify(prev) !== JSON.stringify(cur)){
      updates[`${basePath}/${id}`] = cur;
    }
  });
  Object.keys(lastMap).forEach(id => {
    if (!currentMap[id]) updates[`${basePath}/${id}`] = null;
  });
  return { updates, currentMap };
}

function scheduleFirebaseSync(){
  if (!fbReady || !appStarted) return;
  clearTimeout(fbPushTimer);
  fbPushTimer = setTimeout(pushStateToFirebase, 500);
}

function pushStateToFirebase(){
  if (!fbReady) return;
  try {
    const p = diffCollectionUpdates("products", state.products, lastSyncSnapshot.products);
    const s = diffCollectionUpdates("sales", state.sales, lastSyncSnapshot.sales);
    const ps = diffCollectionUpdates("pendingSales", state.pendingSales, lastSyncSnapshot.pendingSales);
    const cm = diffCollectionUpdates("cashMovements", state.cashMovements, lastSyncSnapshot.cashMovements);
    const cc = diffCollectionUpdates("cashClosures", state.cashClosures, lastSyncSnapshot.cashClosures);
    const metaObj = buildMetaObject();
    const metaChanged = JSON.stringify(metaObj) !== JSON.stringify(lastSyncSnapshot.meta);
    const updates = Object.assign({}, p.updates, s.updates, ps.updates, cm.updates, cc.updates);
    if (metaChanged) updates["meta"] = metaObj;
    if (Object.keys(updates).length === 0) return;
    fbRootRef.update(updates).then(() => {
      lastSyncSnapshot = { products: p.currentMap, sales: s.currentMap, pendingSales: ps.currentMap, cashMovements: cm.currentMap, cashClosures: cc.currentMap, meta: metaObj };
      setFbStatus("ok");
    }).catch(err => {
      console.error("No se pudo sincronizar con Firebase (revisa las reglas de la base de datos en Firebase Console):", err);
      setFbStatus("error");
    });
  } catch (err){
    console.error("No se pudo sincronizar con Firebase:", err);
    setFbStatus("error");
  }
}

// Vuelve a dibujar la pantalla visible para reflejar datos que llegaron de
// otro dispositivo, sin sacar al usuario de donde está. En "Nueva venta" no
// se reemplaza toda la pantalla (interrumpiría un carrito a medio armar);
// solo se actualiza el contador de ventas en espera.
function refreshVisibleView(){
  applyTheme();
  renderSidebarNav();
  updateNewSaleLock();
  if (currentArea === "landing"){
    document.getElementById("landingBrandName").textContent = state.businessName;
    return;
  }
  if (currentArea === "config-general"){
    if (document.getElementById("view-config-general")) renderConfigGeneral();
    return;
  }
  const activeView = document.querySelector(".view.active");
  if (!activeView) return;
  const viewName = activeView.id.replace("view-", "");
  if (viewName === "newsale"){
    renderPendingBadge();
    return;
  }
  switchView(viewName);
}

// Aplica al estado local los datos que llegaron de Firebase (de este mismo
// dispositivo o de otro). El carrito (state.cart) es local y nunca se toca.
// ---------- FUSIÓN SEGURA CON LO QUE LLEGA DE OTRO DISPOSITIVO ----------
// Bug real que esto corrige: antes, cuando llegaba una actualización de
// Firebase, se reemplazaba el arreglo local completo (state.sales = lo que
// vino de remoto). Si este mismo dispositivo acababa de crear una venta
// propia que TODAVÍA no había terminado de subirse (el envío real tiene un
// pequeño retraso, "debounce", de medio segundo), esa venta propia quedaba
// pisada por la foto de Firebase que llegaba un instante antes de que la
// propia terminara de subirse — y como además esa foto se guardaba como
// "ya sincronizado", la venta nunca se volvía a intentar subir: desaparecía
// para siempre. Esto es exactamente lo que pasaba al vender casi al mismo
// tiempo desde dos dispositivos.
//
// La solución: por cada registro (venta, producto, etc.), se compara el
// valor local contra el último valor que SABEMOS que ya se subió
// (lastSyncSnapshot). Si son iguales, no hay nada propio pendiente y se
// puede confiar en lo que diga remoto. Si son distintos, hay un cambio
// propio sin subir todavía (una venta nueva, una edición, incluso un
// borrado) y se respeta tal cual está acá — el propio envío pendiente de
// este dispositivo se va a encargar de subirlo enseguida. "lastSyncSnapshot"
// solo se actualiza para los registros que sabemos confirmados por
// Firebase, nunca para los que se dejaron tal cual por tener un cambio
// local pendiente, así el próximo envío los sigue detectando y subiendo.
function mergeCollectionWithRemote(localArr, remoteObj, lastSyncedMap){
  const remoteMap = remoteObj || {};
  const localMap = arrayToMapById(localArr);
  lastSyncedMap = lastSyncedMap || {};
  const ids = new Set([
    ...Object.keys(remoteMap),
    ...Object.keys(localMap),
    ...Object.keys(lastSyncedMap)
  ]);
  const merged = {};
  const confirmedSynced = Object.assign({}, lastSyncedMap);
  ids.forEach(id => {
    const hasLocal = Object.prototype.hasOwnProperty.call(localMap, id);
    const localVal = hasLocal ? localMap[id] : undefined;
    const hasLastSynced = Object.prototype.hasOwnProperty.call(lastSyncedMap, id);
    const lastVal = hasLastSynced ? lastSyncedMap[id] : undefined;
    const remoteVal = (remoteMap[id] !== undefined && remoteMap[id] !== null) ? remoteMap[id] : undefined;
    const hasRemote = remoteVal !== undefined;

    const localPending = JSON.stringify(hasLocal ? localVal : null) !== JSON.stringify(hasLastSynced ? lastVal : null);

    if (localPending){
      if (hasLocal) merged[id] = localVal;
      // no se toca confirmedSynced[id]: el próximo push lo va a detectar y subir.
    } else if (hasRemote){
      merged[id] = remoteVal;
      confirmedSynced[id] = remoteVal;
    } else if (hasLocal){
      merged[id] = localVal;
    } else if (hasLastSynced){
      delete confirmedSynced[id]; // remoto ya no lo tiene y no hay nada pendiente local: se eliminó en otro lado
    }
  });
  return { mergedArr: Object.values(merged), confirmedMap: confirmedSynced };
}

// Misma idea que mergeCollectionWithRemote pero campo por campo, para el
// bloque "meta" (que no es una colección con IDs sino un solo objeto:
// nombre del negocio, categorías, caja abierta/cerrada, tema, etc.). Esto
// es lo que corrige que un cierre de caja hecho en un dispositivo pudiera
// ser "revivido" por una foto de otro dispositivo que todavía no se había
// enterado del cierre.
function mergeMetaWithRemote(remoteMeta, lastSyncedMeta){
  const current = buildMetaObject();
  lastSyncedMeta = lastSyncedMeta || {};
  const merged = {};
  const confirmedSynced = Object.assign({}, lastSyncedMeta);
  const keys = new Set([
    ...Object.keys(current),
    ...Object.keys(remoteMeta || {}),
    ...Object.keys(lastSyncedMeta)
  ]);
  keys.forEach(key => {
    const curVal = current[key];
    const lastVal = lastSyncedMeta[key];
    const remVal = remoteMeta ? remoteMeta[key] : undefined;
    const pending = JSON.stringify(curVal) !== JSON.stringify(lastVal);
    if (pending){
      merged[key] = curVal; // cambio propio (p.ej. un cierre de caja) sin subir todavía: se respeta
    } else if (remVal !== undefined){
      merged[key] = remVal;
      confirmedSynced[key] = remVal;
    } else {
      merged[key] = curVal;
    }
  });
  return { mergedMeta: merged, confirmedMeta: confirmedSynced };
}

function applyRemoteSnapshot(remote){
  if (!remote) return false;
  let changed = false;

  if (remote.meta){
    const { mergedMeta, confirmedMeta } = mergeMetaWithRemote(remote.meta, lastSyncSnapshot.meta);
    if (JSON.stringify(mergedMeta) !== JSON.stringify(buildMetaObject())){
      state.businessName = mergedMeta.businessName;
      state.categories = mergedMeta.categories || state.categories;
      state.gridSizes = (mergedMeta.gridSizes && mergedMeta.gridSizes.length) ? mergedMeta.gridSizes : state.gridSizes;
      state.selectedGridSizeIndex = (mergedMeta.selectedGridSizeIndex !== undefined && mergedMeta.selectedGridSizeIndex !== null) ? mergedMeta.selectedGridSizeIndex : state.selectedGridSizeIndex;
      state.cashRegister = mergedMeta.cashRegister !== undefined ? mergedMeta.cashRegister : state.cashRegister;
      state.stockEnabled = mergedMeta.stockEnabled !== undefined ? mergedMeta.stockEnabled : state.stockEnabled;
      state.theme = mergedMeta.theme || state.theme;
      state.advancedConfigPassword = mergedMeta.advancedConfigPassword || state.advancedConfigPassword;
      state.deletePassword = mergedMeta.deletePassword || state.deletePassword;
      changed = true;
    }
    lastSyncSnapshot.meta = confirmedMeta;
  }

  const collections = [
    ["products", "products"],
    ["sales", "sales"],
    ["pendingSales", "pendingSales"],
    ["cashMovements", "cashMovements"],
    ["cashClosures", "cashClosures"]
  ];
  collections.forEach(([remoteKey, stateKey]) => {
    if (!remote[remoteKey]) return;
    const { mergedArr, confirmedMap } = mergeCollectionWithRemote(state[stateKey], remote[remoteKey], lastSyncSnapshot[stateKey]);
    if (JSON.stringify(mergedArr) !== JSON.stringify(state[stateKey])){
      state[stateKey] = mergedArr;
      changed = true;
    }
    lastSyncSnapshot[stateKey] = confirmedMap;
  });

  if (changed){
    applyDefaultsAndMigrations();
    localStorage.setItem("posShalomState", JSON.stringify(state));
  }
  return changed;
}

function attachFirebaseListener(){
  if (!fbReady) return;
  fbRootRef.on("value", (snap) => {
    if (!appStarted) return; // el arranque ya maneja la primera lectura con startApp()
    setFbStatus("ok");
    const remote = snap.val();
    if (!remote) return;
    const changed = applyRemoteSnapshot(remote);
    if (changed) refreshVisibleView();
  }, (err) => {
    // Esto se dispara, por ejemplo, si las reglas de la base de datos no
    // permiten leer/escribir: antes pasaba inadvertido porque no había
    // una función de error registrada aquí.
    console.error("Error del listener de Firebase (revisa las reglas de la base de datos en Firebase Console):", err);
    setFbStatus("error");
  });
}
function debounce(fn, wait){
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

// ---------- TEMA VISUAL (Configuración general) ----------
function applyTheme(){
  const t = state.theme || {};
  document.documentElement.style.setProperty("--bg", t.bgColor || "#161d27");
  document.documentElement.style.setProperty("--accent", t.accentColor || "#f2a649");
  document.documentElement.style.setProperty("--text", t.textColor || "#f1efe9");
  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.style.background = t.sidebarColor || "";

  const initial = (state.businessName || "P").trim().charAt(0).toUpperCase() || "P";
  // El logo (imagen o inicial) se muestra igual en el panel lateral (Cajero/
  // Entrega) y en la pantalla de Inicio; la escala configurable, en cambio,
  // solo se aplica más abajo al de Inicio — el del panel lateral conserva
  // siempre su tamaño fijo.
  document.querySelectorAll(".brand-mark, .landing-mark").forEach(el => {
    if (t.logoDataUrl){
      // El contenedor tenía el color de acento como fondo (el mismo que un botón
      // activo); si no se anula aquí, un logo PNG con transparencia lo muestra
      // detrás. Se deja transparente para que se vea el fondo general.
      el.style.background = "transparent";
      el.style.backgroundImage = `url(${t.logoDataUrl})`;
      el.style.backgroundSize = "cover";
      el.style.backgroundPosition = "center";
      el.textContent = "";
    } else {
      el.style.background = "";
      el.style.backgroundImage = "";
      el.textContent = initial;
    }
  });

  // Escala del logo — SOLO para el de la pantalla de Inicio (Cajero/Entrega/
  // Configuración). Se aplica cambiando el ancho/alto reales (no una
  // transformación visual), para que el espacio ocupado crezca de verdad y
  // el texto de abajo se desplace automáticamente en vez de quedar tapado.
  // .landing-mark tiene además max-width/max-height en el CSS como límite de
  // seguridad, así un valor extremo no rompe la pantalla en ningún dispositivo.
  const rawScale = parseFloat(t.logoScale) || 1;
  const scale = Math.min(5, Math.max(0.1, rawScale));
  const baseLogoSize = 64; // debe coincidir con el ancho/alto base de .landing-mark en el CSS
  const landingSize = baseLogoSize * scale;
  document.querySelectorAll(".landing-mark").forEach(el => {
    el.style.width = landingSize + "px";
    el.style.height = landingSize + "px";
  });
}

// ---------- ÁREAS: PANTALLA PRINCIPAL / CAJERO / ENTREGA / CONFIGURACIÓN GENERAL ----------
const CAJERO_NAV = [
  { action: "landing", icon: "⌂", label: "Inicio" },
  { view: "newsale", icon: "＋", label: "Nueva venta" },
  { view: "resumen", icon: "📊", label: "Resumen del día" },
  { view: "products", icon: "▦", label: "Productos" },
  { view: "history", icon: "≡", label: "Historial de ventas" },
  { view: "cashregister", icon: "🗃", label: "Apertura y cierre" },
  { view: "settings", icon: "⚙", label: "Configuración" }
];
const ENTREGA_NAV = [
  { action: "landing", icon: "⌂", label: "Inicio" },
  { view: "pedidos", icon: "📋", label: "Pedidos" },
  { view: "productospendientes", icon: "⏳", label: "Productos pendientes" },
  { view: "cocina", icon: "🍳", label: "Cocina" },
  { view: "pedidosfinalizados", icon: "✅", label: "Pedidos finalizados" },
  { view: "visibility", icon: "👁", label: "Ocultar / Visualizar" }
];
const CONFIG_NAV = [
  { action: "landing", icon: "⌂", label: "Inicio" }
];

function goToLanding(){
  currentArea = "landing";
  document.getElementById("appShell").classList.add("hidden");
  document.getElementById("mobileMenuBtn").classList.add("hidden");
  document.getElementById("landingScreen").classList.remove("hidden");
  document.getElementById("sidebar").classList.remove("mobile-open");
  document.getElementById("landingBrandName").textContent = state.businessName;
  updateNewSaleLock();
  applyTheme();
}

// Si no hay caja abierta, entrar a Cajero lleva primero a "Apertura y cierre";
// si ya hay caja abierta, entra directo a "Nueva venta".
function enterCajero(){
  currentArea = "cajero";
  document.getElementById("landingScreen").classList.add("hidden");
  document.getElementById("appShell").classList.remove("hidden");
  document.getElementById("mobileMenuBtn").classList.remove("hidden");
  renderSidebarNav();
  switchView(state.cashRegister ? "newsale" : "cashregister");
}

function enterEntrega(){
  if (!state.cashRegister){
    showModal(`
      <h2>Caja cerrada</h2>
      <p class="muted">Debes realizar la apertura de caja para comenzar a gestionar los pedidos.</p>
      <div class="modal-actions"><button class="modal-confirm" id="entregaLockedOk" style="flex:1;">Aceptar</button></div>
    `);
    document.getElementById("entregaLockedOk").addEventListener("click", closeModal);
    return;
  }
  currentArea = "entrega";
  document.getElementById("landingScreen").classList.add("hidden");
  document.getElementById("appShell").classList.remove("hidden");
  document.getElementById("mobileMenuBtn").classList.remove("hidden");
  renderSidebarNav();
  switchView("pedidos");
}

// "Configuración general" en la pantalla principal: nombre, logo y colores del
// negocio. Es distinta de "Configuración" dentro de Cajero (cuadrícula y stock).
function enterConfigGeneral(){
  currentArea = "config-general";
  document.getElementById("landingScreen").classList.add("hidden");
  document.getElementById("appShell").classList.remove("hidden");
  document.getElementById("mobileMenuBtn").classList.remove("hidden");
  renderSidebarNav();
  switchView("config-general");
}

function renderSidebarNav(){
  const nav = document.getElementById("sidebarNav");
  let items;
  if (currentArea === "cajero") items = CAJERO_NAV;
  else if (currentArea === "entrega") items = ENTREGA_NAV;
  else items = CONFIG_NAV;
  nav.innerHTML = items.map(it => it.action
    ? `<button class="nav-item" data-action="${it.action}"><span class="nav-icon">${it.icon}</span><span class="nav-label">${it.label}</span></button>`
    : `<button class="nav-item" data-view="${it.view}"><span class="nav-icon">${it.icon}</span><span class="nav-label">${it.label}</span></button>`
  ).join("");
  updateNewSaleLock();
}

function updateNewSaleLock(){
  const locked = !state.cashRegister;
  document.querySelectorAll('[data-view="newsale"]').forEach(el => el.classList.toggle("locked", locked));
  const entregaBtn = document.getElementById("btnEnterEntrega");
  if (entregaBtn) entregaBtn.classList.toggle("locked", locked);
}

document.getElementById("btnEnterCajero").addEventListener("click", enterCajero);
document.getElementById("btnEnterEntrega").addEventListener("click", enterEntrega);
document.getElementById("btnEnterConfigGeneral").addEventListener("click", enterConfigGeneral);

// ---------- NAVEGACIÓN INTERNA (dentro de un área) ----------
function switchView(viewName){
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById("view-" + viewName).classList.add("active");
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  const navBtn = document.querySelector(`.nav-item[data-view="${viewName}"]`);
  if (navBtn) navBtn.classList.add("active");

  if (viewName === "resumen") renderResumenDia();
  if (viewName === "newsale") { currentCategoryId = null; renderCategories(); renderCart(); renderPendingBadge(); }
  if (viewName === "history") renderHistory();
  if (viewName === "products") renderProductAdmin();
  if (viewName === "cashregister") renderCashRegisterView();
  if (viewName === "settings") renderCajeroSettings();
  if (viewName === "config-general") renderConfigGeneral();
  if (viewName === "pedidos") renderPedidos();
  if (viewName === "productospendientes") renderProductosPendientes();
  if (viewName === "cocina") renderCocina();
  if (viewName === "pedidosfinalizados") renderPedidosFinalizados();
  if (viewName === "visibility") renderVisibilityScreen();
  if (viewName === "stock") renderStockScreen();
  if (viewName === "stocklow") renderStockLowScreen();

  // Corrige el bug donde "Nueva venta" quedaba bloqueado en el menú incluso
  // después de abrir caja, si esa apertura ocurrió sin volver a entrar a Cajero.
  updateNewSaleLock();
}

// Delegación de clics: "Inicio" (data-action="landing") siempre vuelve a la pantalla
// principal; el resto de la navegación usa [data-view] como antes.
document.addEventListener("click", (e) => {
  const actionEl = e.target.closest('[data-action="landing"]');
  if (actionEl){
    goToLanding();
    return;
  }
  const el = e.target.closest("[data-view]");
  if (!el) return;
  if (el.dataset.view === "newsale" && !state.cashRegister){
    alert("Primero debes realizar la apertura de caja para iniciar una venta.");
    return;
  }
  switchView(el.dataset.view);
  if (window.innerWidth <= 640){
    document.getElementById("sidebar").classList.remove("mobile-open");
  }
});

// Panel lateral: contraer (escritorio) o abrir/cerrar como menú deslizable (móvil)
document.getElementById("sidebarToggle").addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("collapsed");
});
document.getElementById("mobileMenuBtn").addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("mobile-open");
});

// Vuelve a acomodar la cuadrícula visible de Nueva venta si cambia el tamaño de la ventana
window.addEventListener("resize", debounce(() => {
  if (document.getElementById("view-newsale").classList.contains("active")){
    if (currentCategoryId) renderProductGrid(currentCategoryId); else renderCategoryGrid();
  }
}, 200));

// ---------- RESUMEN DEL DÍA ----------
// Ventas de la jornada de caja actualmente abierta (no del día calendario).
// Así, al cerrar caja y volver a abrir, los totales arrancan en cero
// aunque sea el mismo día, y las ventas de jornadas anteriores no se mezclan.
// Las ventas eliminadas (borrado suave, se conservan para el registro del cierre) no se incluyen.
function getCurrentJornadaSales(){
  if (!state.cashRegister) return [];
  const openedTime = new Date(state.cashRegister.openedAt).getTime();
  return state.sales.filter(s => !s.deleted && new Date(s.date).getTime() >= openedTime);
}

// Entradas/salidas de dinero de la jornada actualmente abierta (no son ventas:
// no afectan la numeración de ventas ni aparecen en Historial de ventas).
function getCurrentJornadaMovements(){
  if (!state.cashRegister) return [];
  const openedTime = new Date(state.cashRegister.openedAt).getTime();
  return (state.cashMovements || []).filter(m => !m.deleted && new Date(m.date).getTime() >= openedTime);
}

// Saldo disponible de una cuenta (efectivo/QR) considerando ventas y
// entradas/salidas ya registradas. Se recalcula siempre desde cero (nunca se
// guarda un "total acumulado"), así que editar o eliminar un movimiento
// nunca descuadra el saldo. excludeMovementId permite validar una edición
// sin contar el efecto que ese mismo movimiento tenía antes de editarse.
function computeAccountBalance(account, excludeMovementId){
  const jornadaSales = getCurrentJornadaSales();
  const salesTotal = jornadaSales.reduce((a,s) => a + (account === "efectivo" ? (s.cash || 0) : (s.qr || 0)), 0);
  const movements = getCurrentJornadaMovements().filter(m => m.account === account && m.id !== excludeMovementId);
  const entradas = movements.filter(m => m.type === "entrada").reduce((a,m) => a + m.amount, 0);
  const salidas = movements.filter(m => m.type === "salida").reduce((a,m) => a + m.amount, 0);
  const initial = (account === "efectivo" && state.cashRegister) ? state.cashRegister.initialAmount : 0;
  return initial + salesTotal + entradas - salidas;
}

// "Ventas + entradas - salidas" de una cuenta, SIN el monto inicial de caja
// (ese monto es exclusivo de Efectivo y se muestra aparte, en Apertura y cierre,
// dentro de "Efectivo + caja"). Reutiliza computeAccountBalance como única
// fuente de verdad, para que Resumen del día y Apertura/Cierre nunca puedan
// mostrar cifras distintas para el mismo dato.
function computeSalesAdjusted(account){
  const initial = (account === "efectivo" && state.cashRegister) ? state.cashRegister.initialAmount : 0;
  return computeAccountBalance(account, null) - initial;
}

function renderResumenDia(){
  document.getElementById("todayDate").textContent = new Date().toLocaleDateString("es-BO", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
  const jornadaSales = getCurrentJornadaSales();

  const total = jornadaSales.reduce((a,s) => a + s.total, 0);
  const cash = jornadaSales.reduce((a,s) => a + (s.cash || 0), 0);
  const qr = jornadaSales.reduce((a,s) => a + (s.qr || 0), 0);
  const productsCount = jornadaSales.reduce((a,s) => a + s.items.reduce((b,i) => b + i.qty, 0), 0);

  document.getElementById("statTotal").textContent = "Bs " + total.toFixed(2);
  document.getElementById("statCash").textContent = "Bs " + cash.toFixed(2);
  document.getElementById("statQr").textContent = "Bs " + qr.toFixed(2);
  document.getElementById("statCount").textContent = jornadaSales.length;
  document.getElementById("statProductsSold").textContent = productsCount;
  document.getElementById("statCashAdjusted").textContent = "Bs " + computeSalesAdjusted("efectivo").toFixed(2);
  document.getElementById("statQrAdjusted").textContent = "Bs " + computeSalesAdjusted("qr").toFixed(2);
  renderMovementsList();
}

// ---------- ENTRADA / SALIDA DE DINERO ----------
function renderMovementsList(){
  const list = document.getElementById("movementsList");
  list.innerHTML = "";
  const movements = getCurrentJornadaMovements();
  if (movements.length === 0){
    list.innerHTML = `<p class="empty-msg">Todavía no hay movimientos registrados en esta jornada.</p>`;
    return;
  }
  [...movements].sort((a,b) => new Date(b.date) - new Date(a.date)).forEach(m => {
    const d = new Date(m.date);
    const row = document.createElement("div");
    row.className = "history-row";
    row.innerHTML = `
      <span class="tag ${m.type==='salida'?'danger':''}" style="${m.type==='salida'?'background:var(--danger); color:#fff;':''}">${m.type === "entrada" ? "Entrada" : "Salida"}</span>
      <span class="hmeta">${m.description} · <strong>${m.account === "efectivo" ? "Efectivo" : "QR"}</strong> · Bs ${m.amount.toFixed(2)} · ${d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>
      <div class="hactions">
        <button class="mini-btn" data-edit-mov="${m.id}">Editar</button>
        <button class="mini-btn danger" data-delete-mov="${m.id}">Eliminar</button>
      </div>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll("[data-edit-mov]").forEach(b => b.addEventListener("click", () => openMovementModal(b.dataset.editMov)));
  list.querySelectorAll("[data-delete-mov]").forEach(b => b.addEventListener("click", () => deleteMovement(b.dataset.deleteMov)));
}

document.getElementById("btnMovement").addEventListener("click", () => openMovementModal(null));

function openMovementModal(existingId){
  if (!state.cashRegister){
    alert("Debes tener una caja abierta para registrar movimientos.");
    return;
  }
  const editing = existingId !== null ? state.cashMovements.find(m => m.id === existingId) : null;
  let type = editing ? editing.type : "entrada";
  let account = editing ? editing.account : "efectivo";

  showModal(`
    <h2>${editing ? "Editar movimiento" : "Entrada / Salida"}</h2>
    <label>Tipo</label>
    <div class="toggle-pair">
      <button type="button" id="movEntrada" class="${type==='entrada'?'selected':''}">Entrada</button>
      <button type="button" id="movSalida" class="${type==='salida'?'selected':''}">Salida</button>
    </div>
    <label>Descripción</label>
    <input type="text" id="movDesc" value="${editing ? editing.description : ""}" placeholder="Ej: Compra de 1/4 kg de queso">
    <label>Cuenta</label>
    <div class="toggle-pair">
      <button type="button" id="movEfectivo" class="${account==='efectivo'?'selected':''}">Efectivo</button>
      <button type="button" id="movQr" class="${account==='qr'?'selected':''}">QR</button>
    </div>
    <label>Monto (Bs)</label>
    <input type="number" id="movAmount" min="0" value="${editing ? editing.amount : ""}" placeholder="0.00">
    <p class="import-feedback" id="movError"></p>
    <div class="modal-actions">
      <button class="modal-cancel" id="movCancel">Cancelar</button>
      <button class="modal-confirm" id="movSave">Guardar</button>
    </div>
  `);

  function refreshToggles(){
    document.getElementById("movEntrada").classList.toggle("selected", type === "entrada");
    document.getElementById("movSalida").classList.toggle("selected", type === "salida");
    document.getElementById("movEfectivo").classList.toggle("selected", account === "efectivo");
    document.getElementById("movQr").classList.toggle("selected", account === "qr");
  }
  document.getElementById("movEntrada").addEventListener("click", () => { type = "entrada"; refreshToggles(); });
  document.getElementById("movSalida").addEventListener("click", () => { type = "salida"; refreshToggles(); });
  document.getElementById("movEfectivo").addEventListener("click", () => { account = "efectivo"; refreshToggles(); });
  document.getElementById("movQr").addEventListener("click", () => { account = "qr"; refreshToggles(); });

  document.getElementById("movCancel").addEventListener("click", closeModal);
  document.getElementById("movSave").addEventListener("click", () => {
    const description = document.getElementById("movDesc").value.trim();
    const amount = parseFloat(document.getElementById("movAmount").value);
    const errorEl = document.getElementById("movError");
    if (!description){
      errorEl.textContent = "Escribe una descripción.";
      errorEl.className = "import-feedback error";
      return;
    }
    if (isNaN(amount) || amount <= 0){
      errorEl.textContent = "Ingresa un monto válido mayor a 0.";
      errorEl.className = "import-feedback error";
      return;
    }
    if (type === "salida"){
      // El saldo se recalcula excluyendo este mismo movimiento (si se está
      // editando), así la validación siempre refleja el estado real.
      const available = computeAccountBalance(account, editing ? editing.id : null);
      if (amount > available){
        errorEl.textContent = `No hay suficiente dinero disponible en ${account === "efectivo" ? "Efectivo" : "QR"} (disponible: Bs ${available.toFixed(2)}).`;
        errorEl.className = "import-feedback error";
        return;
      }
    }
    if (editing){
      editing.type = type; editing.description = description; editing.account = account; editing.amount = amount;
    } else {
      const nextId = uid("mov");
      state.cashMovements.push({ id: nextId, type, description, account, amount, date: new Date().toISOString() });
    }
    saveState();
    closeModal();
    renderResumenDia();
  });
  setTimeout(() => { document.getElementById("movDesc").focus(); }, 50);
}

function deleteMovement(id){
  const m = state.cashMovements.find(mv => mv.id === id);
  if (!m) return;
  requireDeletePassword(() => {
    m.deleted = true;
    m.deletedAt = new Date().toISOString();
    saveState();
    renderMovementsList();
  });
}

// ---------- APERTURA Y CIERRE DE CAJA ----------
function renderCashRegisterView(){
  const panel = document.getElementById("cajaPanel");
  const jornadaSales = getCurrentJornadaSales();
  const cash = jornadaSales.reduce((a,s) => a + (s.cash || 0), 0);

  if (state.cashRegister){
    const efectivoCaja = computeAccountBalance("efectivo", null);
    const qrBalance = computeAccountBalance("qr", null);
    const dOpen = new Date(state.cashRegister.openedAt);
    panel.innerHTML = `
      <div class="stat-grid">
        <div class="stat-card"><span class="stat-label">Caja abierta desde</span><span class="stat-value" style="font-size:1.1rem;">${dOpen.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span></div>
        <div class="stat-card"><span class="stat-label">Monto inicial</span><span class="stat-value">Bs ${state.cashRegister.initialAmount.toFixed(2)}</span></div>
        <div class="stat-card accent"><span class="stat-label">Efectivo + caja</span><span class="stat-value">Bs ${efectivoCaja.toFixed(2)}</span></div>
        <div class="stat-card"><span class="stat-label">QR</span><span class="stat-value">Bs ${qrBalance.toFixed(2)}</span></div>
      </div>
      <button class="btn-ghost danger" id="btnCloseRegister" style="margin-top:14px;">Realizar cierre de caja</button>
    `;
    document.getElementById("btnCloseRegister").addEventListener("click", () => {
      openConfirmModal("Cierre de caja", "¿Está seguro de realizar el cierre de caja del día?", performCloseRegister, false, { cancel:"No", confirm:"Sí" }, true);
    });
  } else {
    panel.innerHTML = `
      <div class="caja-alert">
        <p>Todavía no se realizó la apertura de caja. Debes abrir caja para poder iniciar ventas y gestionar pedidos.</p>
        <button class="btn-primary" id="btnOpenRegister" style="width:fit-content;">Realizar apertura de caja</button>
      </div>
    `;
    document.getElementById("btnOpenRegister").addEventListener("click", openRegisterModal);
  }
  renderClosuresList();
  updateNewSaleLock();
}

function openRegisterModal(){
  showModal(`
    <h2>Apertura de caja</h2>
    <label>Monto inicial de caja (Bs)</label>
    <input type="number" id="openAmountInput" min="0" placeholder="0.00">
    <div class="modal-actions">
      <button class="modal-cancel" id="openCancel">Cancelar</button>
      <button class="modal-confirm" id="openConfirm">Abrir caja</button>
    </div>
  `);
  document.getElementById("openCancel").addEventListener("click", closeModal);
  document.getElementById("openConfirm").addEventListener("click", () => {
    const amount = parseFloat(document.getElementById("openAmountInput").value) || 0;
    state.cashRegister = { openedAt: new Date().toISOString(), initialAmount: amount };
    saveState();
    closeModal();
    updateNewSaleLock();
    if (currentArea === "cajero") switchView("newsale"); else renderCashRegisterView();
  });
  setEnterConfirm("openConfirm");
  // El cursor queda listo para escribir el monto de inmediato (computadora y teléfono)
  const input = document.getElementById("openAmountInput");
  setTimeout(() => { input.focus(); }, 50);
}

function computeTotals(sales){
  const total = sales.reduce((a,s) => a + s.total, 0);
  const cash = sales.reduce((a,s) => a + (s.cash || 0), 0);
  const qr = sales.reduce((a,s) => a + (s.qr || 0), 0);
  const mixto = sales.filter(s => s.method === "mixto").reduce((a,s) => a + s.total, 0);
  const salesCount = sales.length;
  const productsCount = sales.reduce((a,s) => a + s.items.reduce((b,i) => b + i.qty, 0), 0);
  return { total, cash, qr, mixto, salesCount, productsCount };
}

function computeProductDetail(sales){
  const map = {};
  sales.forEach(s => s.items.forEach(i => { map[i.name] = (map[i.name] || 0) + i.qty; }));
  return Object.entries(map).map(([name, qty]) => ({ name, qty })).sort((a,b) => b.qty - a.qty);
}

function performCloseRegister(){
  const reg = state.cashRegister;
  if (!reg) return;
  const closedAt = new Date().toISOString();
  const periodSales = state.sales.filter(s => {
    const t = new Date(s.date).getTime();
    return t >= new Date(reg.openedAt).getTime() && t <= new Date(closedAt).getTime();
  });
  const activeSales = periodSales.filter(s => !s.deleted);
  const deletedSalesInPeriod = periodSales.filter(s => s.deleted);

  const periodMovements = (state.cashMovements || []).filter(m => {
    const t = new Date(m.date).getTime();
    return !m.deleted && t >= new Date(reg.openedAt).getTime() && t <= new Date(closedAt).getTime();
  });
  const entradasEfectivo = periodMovements.filter(m => m.type==="entrada" && m.account==="efectivo").reduce((a,m)=>a+m.amount,0);
  const salidasEfectivo = periodMovements.filter(m => m.type==="salida" && m.account==="efectivo").reduce((a,m)=>a+m.amount,0);
  const entradasQr = periodMovements.filter(m => m.type==="entrada" && m.account==="qr").reduce((a,m)=>a+m.amount,0);
  const salidasQr = periodMovements.filter(m => m.type==="salida" && m.account==="qr").reduce((a,m)=>a+m.amount,0);

  const totals = computeTotals(activeSales);
  const productDetail = computeProductDetail(activeSales);
  const closure = {
    id: uid("cls"),
    openedAt: reg.openedAt,
    closedAt,
    initialAmount: reg.initialAmount,
    totals,
    productDetail,
    salesDetail: activeSales.map(s => ({ id: s.id, jornadaNumber: s.jornadaNumber, date: s.date, name: s.name || null, cash: s.cash, qr: s.qr, method: s.method, total: s.total })),
    deletedSales: deletedSalesInPeriod.map(s => ({ id: s.id, jornadaNumber: s.jornadaNumber, date: s.date, name: s.name || null, total: s.total, deletedAt: s.deletedAt })),
    movements: periodMovements.map(m => ({ type: m.type, description: m.description, account: m.account, amount: m.amount, date: m.date })),
    movementsSummary: { entradasEfectivo, salidasEfectivo, entradasQr, salidasQr }
  };
  state.cashClosures.push(closure);
  state.cashRegister = null;
  saveState();
  showClosureSummary(closure, false);
  exportClosurePdf(closure);
}

function showClosureSummary(closure, isHistoryView){
  const dOpen = new Date(closure.openedAt);
  const dClose = new Date(closure.closedAt);
  const ms = closure.movementsSummary || { entradasEfectivo:0, salidasEfectivo:0, entradasQr:0, salidasQr:0 };
  const efectivoCaja = closure.initialAmount + closure.totals.cash + ms.entradasEfectivo - ms.salidasEfectivo;
  const qrAjustado = closure.totals.qr + ms.entradasQr - ms.salidasQr;
  const productsHtml = closure.productDetail.map(p => `
    <div class="pay-line"><span>${p.name}</span><span>${p.qty} unid.</span></div>
  `).join("") || `<p class="muted" style="font-size:.85rem;">No se vendieron productos.</p>`;
  const movementsHtml = (closure.movements || []).length
    ? closure.movements.map(m => `<div class="pay-line"><span>${m.type==="entrada"?"Entrada":"Salida"} — ${m.description} (${m.account==="efectivo"?"Efectivo":"QR"})</span><span>Bs ${m.amount.toFixed(2)}</span></div>`).join("")
    : `<p class="muted" style="font-size:.85rem;">No hubo entradas ni salidas registradas.</p>`;

  showModal(`
    <h2>${isHistoryView ? "Detalle del cierre" : "Cierre de caja realizado con éxito"}</h2>
    <p class="muted" style="margin-bottom:10px;">${dClose.toLocaleDateString()} — ${dClose.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</p>
    <div class="pay-line"><span>Hora de apertura</span><span>${dOpen.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span></div>
    <div class="pay-line"><span>Monto inicial de caja</span><span>Bs ${closure.initialAmount.toFixed(2)}</span></div>
    <div class="pay-line"><span>Ventas del día</span><span>${closure.totals.salesCount}</span></div>
    <div class="pay-line"><span>Total efectivo</span><span>Bs ${closure.totals.cash.toFixed(2)}</span></div>
    <div class="pay-line"><span>Total QR</span><span>Bs ${closure.totals.qr.toFixed(2)}</span></div>
    <div class="pay-line"><span>Total mixto</span><span>Bs ${closure.totals.mixto.toFixed(2)}</span></div>
    <div class="pay-line highlight"><span>Total de ventas</span><span>Bs ${closure.totals.total.toFixed(2)}</span></div>
    <div class="pay-line highlight"><span>Total efectivo + caja</span><span>Bs ${efectivoCaja.toFixed(2)}</span></div>
    <div class="pay-line highlight"><span>QR (con entradas/salidas)</span><span>Bs ${qrAjustado.toFixed(2)}</span></div>
    <div class="pay-line"><span>Cantidad de productos vendidos</span><span>${closure.totals.productsCount}</span></div>
    <h2 style="font-size:1rem; margin-top:16px;">Entradas y salidas</h2>
    ${movementsHtml}
    <h2 style="font-size:1rem; margin-top:16px;">Detalle de productos</h2>
    ${productsHtml}
    <div class="modal-actions"><button class="modal-confirm" id="closeClosureView" style="flex:1;">${isHistoryView ? "Cerrar" : "Aceptar"}</button></div>
  `);
  document.getElementById("closeClosureView").addEventListener("click", () => {
    closeModal();
    if (!isHistoryView) renderCashRegisterView();
  });
  if (!isHistoryView) setEnterConfirm("closeClosureView");
}

// ---------- PDF DEL CIERRE ----------
// Se dibuja manualmente con las funciones básicas de jsPDF (texto y rectángulos),
// sin depender de un plugin externo de tablas. Esto reduce drásticamente los
// puntos de falla: solo depende de una librería (jsPDF), no de dos que deben
// coincidir en versión y orden de carga.
function drawPdfTable(doc, { startY, headers, rows, colWidths, marginLeft = 14, headFill = [242,166,73], headText = [30,30,30] }){
  const rowHeight = 7;
  let y = startY;
  const tableWidth = colWidths.reduce((a,b) => a+b, 0);
  const pageBottom = 280;

  function drawHeader(){
    doc.setFillColor(headFill[0], headFill[1], headFill[2]);
    doc.rect(marginLeft, y, tableWidth, rowHeight, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.setTextColor(headText[0], headText[1], headText[2]);
    let x = marginLeft;
    headers.forEach((h, i) => {
      doc.text(String(h), x + 2, y + 4.8);
      x += colWidths[i];
    });
    y += rowHeight;
  }

  drawHeader();
  doc.setFont("helvetica", "normal");
  doc.setTextColor(20, 20, 20);
  rows.forEach((row, rIdx) => {
    if (y + rowHeight > pageBottom){
      doc.addPage();
      y = 20;
      drawHeader();
    }
    if (rIdx % 2 === 1){
      doc.setFillColor(244, 244, 244);
      doc.rect(marginLeft, y, tableWidth, rowHeight, "F");
    }
    let x = marginLeft;
    row.forEach((cell, i) => {
      const text = String(cell === null || cell === undefined ? "—" : cell);
      doc.text(text, x + 2, y + 4.8, { maxWidth: colWidths[i] - 3 });
      x += colWidths[i];
    });
    y += rowHeight;
  });
  return y;
}

function exportClosurePdf(closure){
  try {
    if (!window.jspdf || !window.jspdf.jsPDF){
      alert("No se pudo generar el PDF: la librería no cargó correctamente. Verifica tu conexión a internet y vuelve a intentarlo.");
      return;
    }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const dOpen = new Date(closure.openedAt);
    const dClose = new Date(closure.closedAt);
    const accentRGB = [242, 166, 73];
    const darkRGB = [22, 29, 39];
    const pageWidth = doc.internal.pageSize.getWidth();
    let y = 20;

    // Encabezado
    doc.setFillColor(darkRGB[0], darkRGB[1], darkRGB[2]);
    doc.rect(0, 0, pageWidth, 32, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text(String(state.businessName || "POS Shalom"), 14, 14);
    doc.setFontSize(11);
    doc.setTextColor(accentRGB[0], accentRGB[1], accentRGB[2]);
    doc.text("Informe de cierre de caja — Jornada N.º " + closure.id, 14, 22);
    doc.setFontSize(9);
    doc.setTextColor(220, 220, 220);
    doc.text("Fecha: " + dClose.toLocaleDateString(), 14, 28);
    doc.text("Apertura: " + dOpen.toLocaleTimeString() + "   ·   Cierre: " + dClose.toLocaleTimeString(), pageWidth - 14, 28, { align: "right" });

    y = 42;
    doc.setTextColor(0, 0, 0);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Resumen financiero", 14, y);
    y += 4;

    const initialAmount = closure.initialAmount || 0;
    const totals = closure.totals || { total:0, cash:0, qr:0, mixto:0, salesCount:0, productsCount:0 };
    const ms2 = closure.movementsSummary || { entradasEfectivo:0, salidasEfectivo:0, entradasQr:0, salidasQr:0 };
    const efectivoCaja = initialAmount + (totals.cash || 0) + ms2.entradasEfectivo - ms2.salidasEfectivo;

    y = drawPdfTable(doc, {
      startY: y,
      headers: ["Concepto", "Valor"],
      colWidths: [110, 76],
      rows: [
        ["Número de jornada/caja", String(closure.id)],
        ["Monto inicial de caja", "Bs " + initialAmount.toFixed(2)],
        ["Total de ventas", "Bs " + (totals.total || 0).toFixed(2)],
        ["Total efectivo", "Bs " + (totals.cash || 0).toFixed(2)],
        ["Total QR", "Bs " + (totals.qr || 0).toFixed(2)],
        ["Total mixto", "Bs " + (totals.mixto || 0).toFixed(2)],
        ["Entradas efectivo", "Bs " + ms2.entradasEfectivo.toFixed(2)],
        ["Salidas efectivo", "Bs " + ms2.salidasEfectivo.toFixed(2)],
        ["Entradas QR", "Bs " + ms2.entradasQr.toFixed(2)],
        ["Salidas QR", "Bs " + ms2.salidasQr.toFixed(2)],
        ["Total efectivo + caja", "Bs " + efectivoCaja.toFixed(2)],
        ["QR (con entradas/salidas)", "Bs " + (( totals.qr || 0) + ms2.entradasQr - ms2.salidasQr).toFixed(2)],
        ["Cantidad de ventas", String(totals.salesCount || 0)],
        ["Cantidad de productos vendidos", String(totals.productsCount || 0)]
      ]
    });

    y += 10;
    if (y > 260){ doc.addPage(); y = 20; }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Detalle de ventas", 14, y);
    y += 4;

    const salesDetail = closure.salesDetail || [];
    const ventasRows = salesDetail.length
      ? salesDetail.map(s => [
          "Venta " + (s.jornadaNumber !== undefined ? s.jornadaNumber : s.id),
          new Date(s.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          s.name || "—",
          "Bs " + (s.cash || 0).toFixed(2),
          "Bs " + (s.qr || 0).toFixed(2),
          s.method === "mixto" ? "Sí" : "—",
          "Bs " + (s.total || 0).toFixed(2)
        ])
      : [["—", "—", "—", "—", "—", "—", "—"]];

    y = drawPdfTable(doc, {
      startY: y,
      headers: ["Venta", "Hora", "Nombre", "Efectivo", "QR", "Mixto", "Total"],
      colWidths: [24, 18, 30, 26, 26, 18, 24],
      rows: ventasRows
    });

    // Ventas eliminadas durante la jornada, si las hubo (registro completo de auditoría)
    const deletedSales = closure.deletedSales || [];
    if (deletedSales.length > 0){
      y += 10;
      if (y > 250){ doc.addPage(); y = 20; }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.setTextColor(200, 60, 60);
      doc.text("Ventas eliminadas", 14, y);
      doc.setTextColor(0, 0, 0);
      y += 4;
      const deletedRows = deletedSales.map(s => [
        "Venta " + (s.jornadaNumber !== undefined ? s.jornadaNumber : s.id),
        new Date(s.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        s.name || "—",
        "Bs " + (s.total || 0).toFixed(2),
        new Date(s.deletedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      ]);
      y = drawPdfTable(doc, {
        startY: y,
        headers: ["Venta", "Hora", "Nombre", "Total", "Eliminada a las"],
        colWidths: [24, 20, 40, 28, 34],
        headFill: [225, 85, 84],
        headText: [255, 255, 255],
        rows: deletedRows
      });
    }

    // Entradas y salidas de dinero registradas durante la jornada
    const movements = closure.movements || [];
    if (movements.length > 0){
      y += 10;
      if (y > 250){ doc.addPage(); y = 20; }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.text("Entradas y salidas", 14, y);
      y += 4;
      const movementRows = movements.map(m => [
        m.type === "entrada" ? "Entrada" : "Salida",
        m.description,
        m.account === "efectivo" ? "Efectivo" : "QR",
        "Bs " + m.amount.toFixed(2),
        new Date(m.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      ]);
      y = drawPdfTable(doc, {
        startY: y,
        headers: ["Detalle", "Descripción", "Cuenta", "Monto", "Hora"],
        colWidths: [22, 62, 22, 26, 22],
        rows: movementRows
      });
    }

    y += 10;
    if (y > 260){ doc.addPage(); y = 20; }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Detalle de productos", 14, y);
    y += 4;

    const productDetail = closure.productDetail || [];
    const productosRows = productDetail.length
      ? productDetail.map(p => [p.name, String(p.qty) + " unid."])
      : [["—", "—"]];

    drawPdfTable(doc, {
      startY: y,
      headers: ["Producto", "Cantidad vendida"],
      colWidths: [130, 56],
      rows: productosRows
    });

    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++){
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text(String(state.businessName || "POS Shalom") + " — Cierre de caja", 14, doc.internal.pageSize.getHeight() - 8);
    }

    const fileName = "cierre_caja_" + dClose.toISOString().slice(0,10) + "_" + closure.id + ".pdf";
    doc.save(fileName);
  } catch (err){
    console.error("Error generando el PDF del cierre:", err);
    alert("Ocurrió un error al generar el PDF del cierre: " + (err && err.message ? err.message : err) + ". Vuelve a intentarlo; si el problema continúa, avísame con este mensaje.");
  }
}

// ---------- HISTORIAL DE CIERRES (dentro de "Apertura y cierre") ----------
function renderClosuresList(){
  const list = document.getElementById("closuresList");
  list.innerHTML = "";
  if (state.cashClosures.length === 0){
    list.innerHTML = `<p class="empty-msg">Todavía no hay cierres de caja registrados.</p>`;
    return;
  }
  [...state.cashClosures].sort((a,b) => new Date(b.closedAt) - new Date(a.closedAt)).forEach(closure => {
    const d = new Date(closure.closedAt);
    const ms = closure.movementsSummary || { entradasEfectivo:0, salidasEfectivo:0 };
    const efectivoCaja = closure.initialAmount + closure.totals.cash + ms.entradasEfectivo - ms.salidasEfectivo;
    const row = document.createElement("div");
    row.className = "history-row";
    row.innerHTML = `
      <span class="hnum">${d.toLocaleDateString()}</span>
      <span class="hmeta">Hora: ${d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} · Efectivo: Bs ${closure.totals.cash.toFixed(2)} · QR: Bs ${closure.totals.qr.toFixed(2)} · Efectivo+caja: Bs ${efectivoCaja.toFixed(2)}</span>
      <div class="hactions">
        <button class="mini-btn" data-view-closure="${closure.id}">Ver</button>
        <button class="mini-btn" data-download-closure="${closure.id}">Descargar</button>
        <button class="mini-btn danger" data-delete-closure="${closure.id}">Eliminar</button>
      </div>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll("[data-view-closure]").forEach(b => b.addEventListener("click", () => {
    const closure = state.cashClosures.find(c => c.id === b.dataset.viewClosure);
    if (closure) showClosureSummary(closure, true);
  }));
  list.querySelectorAll("[data-download-closure]").forEach(b => b.addEventListener("click", () => {
    const closure = state.cashClosures.find(c => c.id === b.dataset.downloadClosure);
    if (closure) exportClosurePdf(closure);
  }));
  list.querySelectorAll("[data-delete-closure]").forEach(b => b.addEventListener("click", () => {
    const closureId = b.dataset.deleteClosure;
    openConfirmModal("Eliminar cierre", "¿Seguro que quieres eliminar este cierre de caja? Esta acción no se puede deshacer.", () => {
      requireDeletePassword(() => {
        state.cashClosures = state.cashClosures.filter(c => c.id !== closureId);
        saveState();
        renderClosuresList();
      });
    }, true);
  }));
}

// ---------- CUADRÍCULA CONFIGURABLE ----------
function getSelectedGridSize(){
  return state.gridSizes[state.selectedGridSizeIndex] || { rows:3, cols:3 };
}
// La cantidad de columnas configurada (ej. 3x3 = 3 columnas) se respeta siempre,
// en cualquier dispositivo. Lo que se adapta al espacio disponible es el tamaño
// de cada tarjeta (ver .pick-card en el CSS), no la cantidad de columnas.

function renderPagination(containerId, currentPage, totalPages, onChange){
  const el = document.getElementById(containerId);
  if (totalPages <= 1){
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  el.innerHTML = `
    <button class="page-btn" id="pgPrev" ${currentPage === 0 ? "disabled" : ""}>‹ Anterior</button>
    <span class="page-info">Página ${currentPage + 1} de ${totalPages}</span>
    <button class="page-btn" id="pgNext" ${currentPage === totalPages - 1 ? "disabled" : ""}>Siguiente ›</button>
  `;
  document.getElementById("pgPrev").addEventListener("click", () => onChange(currentPage - 1));
  document.getElementById("pgNext").addEventListener("click", () => onChange(currentPage + 1));
}

// ---------- STOCK: reglas compartidas ----------
// El stock solo se aplica cuando el interruptor general está activado Y el
// producto tiene su propio control de stock activado. "Oculto" y "sin stock"
// son conceptos independientes: cada uno se evalúa por separado.
function stockAppliesTo(prod){
  return !!(state.stockEnabled && prod && prod.stockTracked);
}
function isProductAvailableForSale(p){
  if (p.hidden) return false;
  if (stockAppliesTo(p) && (p.stock || 0) <= 0) return false;
  return true;
}

// ---------- NUEVA VENTA: CATEGORÍAS / PRODUCTOS ----------
function categoriesWithVisibleProducts(){
  // Una categoría solo aparece en Nueva venta si tiene al menos un producto disponible
  return state.categories.filter(cat => state.products.some(p => p.categoryId === cat.id && isProductAvailableForSale(p)));
}

function renderCategories(){
  currentCategoryId = null;
  categoryPage = 0;
  document.getElementById("pickerTitle").textContent = "Categorías";
  document.getElementById("btnBackToCats").classList.add("hidden");
  document.getElementById("productGrid").classList.add("hidden");
  document.getElementById("categoryGrid").classList.remove("hidden");
  renderCategoryGrid();
}

function renderCategoryGrid(){
  const grid = document.getElementById("categoryGrid");
  grid.innerHTML = "";

  const visibleCats = categoriesWithVisibleProducts();
  if (visibleCats.length === 0){
    document.getElementById("pickerPagination").classList.add("hidden");
    grid.innerHTML = `<p class="empty-msg">Todavía no hay categorías con productos disponibles.</p>`;
    return;
  }

  const { rows, cols } = getSelectedGridSize();
  const perPage = rows * cols;
  const totalPages = Math.max(1, Math.ceil(visibleCats.length / perPage));
  if (categoryPage >= totalPages) categoryPage = totalPages - 1;
  const pageItems = visibleCats.slice(categoryPage * perPage, categoryPage * perPage + perPage);

  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  pageItems.forEach(cat => {
    const btn = document.createElement("button");
    btn.className = "pick-card";
    btn.innerHTML = `<span class="name">${cat.name}</span>`;
    btn.addEventListener("click", () => openCategory(cat.id));
    grid.appendChild(btn);
  });

  renderPagination("pickerPagination", categoryPage, totalPages, (p) => { categoryPage = p; renderCategoryGrid(); });
}

function openCategory(catId){
  currentCategoryId = catId;
  productPage = 0;
  const cat = state.categories.find(c => c.id === catId);
  document.getElementById("pickerTitle").textContent = cat.name;
  document.getElementById("btnBackToCats").classList.remove("hidden");
  document.getElementById("categoryGrid").classList.add("hidden");
  document.getElementById("productGrid").classList.remove("hidden");
  renderProductGrid(catId);
}

function renderProductGrid(catId){
  const grid = document.getElementById("productGrid");
  grid.innerHTML = "";

  const prods = productsInCategory(catId).filter(p => isProductAvailableForSale(p));
  if (prods.length === 0){
    document.getElementById("pickerPagination").classList.add("hidden");
    grid.innerHTML = `<p class="empty-msg">No hay productos disponibles en esta categoría.</p>`;
    return;
  }

  const { rows, cols } = getSelectedGridSize();
  const perPage = rows * cols;
  const totalPages = Math.max(1, Math.ceil(prods.length / perPage));
  if (productPage >= totalPages) productPage = totalPages - 1;
  const pageItems = prods.slice(productPage * perPage, productPage * perPage + perPage);

  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  pageItems.forEach(p => {
    const lowStock = stockAppliesTo(p) && p.stock <= p.stockMin;
    const btn = document.createElement("button");
    btn.className = "pick-card";
    btn.innerHTML = `
      <span class="name">${p.name}</span>
      <span class="price">Bs ${p.price.toFixed(2)}</span>
      ${lowStock ? `<span class="stock-warning">⚠ Stock: ${p.stock}</span>` : ""}
    `;
    btn.addEventListener("click", () => addToCart(p.id));
    grid.appendChild(btn);
  });

  renderPagination("pickerPagination", productPage, totalPages, (p) => { productPage = p; renderProductGrid(catId); });
}

document.getElementById("btnBackToCats").addEventListener("click", renderCategories);

// ---------- CARRITO ----------
function addToCart(productId){
  const prod = state.products.find(p => p.id === productId);
  const existing = state.cart.find(i => i.productId === productId);
  const currentQty = existing ? existing.qty : 0;
  if (stockAppliesTo(prod) && currentQty + 1 > (prod.stock || 0)){
    alert(`No hay suficiente stock de "${prod.name}". Disponible: ${prod.stock || 0}.`);
    return;
  }
  if (existing){
    existing.qty += 1;
    if (prod && prod.advanced){
      if (!existing.unitSelections) existing.unitSelections = [];
      existing.unitSelections.push(null);
    }
  } else {
    state.cart.push({
      productId, name: prod.name, price: prod.price, qty: 1, discountType: null, discountValue: 0,
      unitSelections: prod.advanced ? [null] : []
    });
  }
  renderCart();
}

function itemFinalPrice(item){
  if (item.discountType === "percent"){
    return item.price * (1 - item.discountValue/100);
  }
  if (item.discountType === "final"){
    return item.discountValue;
  }
  return item.price;
}
function itemDiscountAmount(item){
  return (item.price - itemFinalPrice(item)) * item.qty;
}

function renderCart(){
  const wrap = document.getElementById("cartItems");
  wrap.innerHTML = "";
  if (state.cart.length === 0){
    wrap.innerHTML = `<p class="empty-msg">Aún no hay productos en la venta.</p>`;
  }
  state.cart.forEach(item => {
    const finalPrice = itemFinalPrice(item);
    const hasDiscount = item.discountType !== null;
    const row = document.createElement("div");
    row.className = "cart-item";
    row.innerHTML = `
      <div class="cart-item-top">
        <span class="cart-item-name">${item.name}</span>
        <button class="cart-item-remove" data-remove="${item.productId}">✕</button>
      </div>
      <div class="cart-item-row">
        <div class="qty-control">
          <button class="qty-btn" data-minus="${item.productId}">−</button>
          <input type="number" class="qty-input" data-qtyinput="${item.productId}" value="${item.qty}" min="1" step="1">
          <button class="qty-btn" data-plus="${item.productId}">+</button>
        </div>
        <div class="cart-item-prices">
          ${hasDiscount ? `<span class="orig">Bs ${item.price.toFixed(2)}</span>` : ""}
          <span>Bs ${finalPrice.toFixed(2)}</span>
        </div>
      </div>
      <button class="discount-btn" data-discount="${item.productId}">% Descuento</button>
    `;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll("[data-plus]").forEach(b => b.addEventListener("click", () => changeQty(b.dataset.plus, 1)));
  wrap.querySelectorAll("[data-minus]").forEach(b => b.addEventListener("click", () => changeQty(b.dataset.minus, -1)));
  wrap.querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", () => removeFromCart(b.dataset.remove)));
  wrap.querySelectorAll("[data-discount]").forEach(b => b.addEventListener("click", () => openDiscountModal(b.dataset.discount)));
  wrap.querySelectorAll("[data-qtyinput]").forEach(inp => {
    inp.addEventListener("change", () => {
      const pid = inp.dataset.qtyinput;
      const raw = inp.value.trim();
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0){
        alert("La cantidad debe ser un número entero mayor a 0.");
        renderCart();
        return;
      }
      if (!setItemQty(pid, n)) renderCart();
    });
  });

  const subtotal = state.cart.reduce((a,i) => a + i.price*i.qty, 0);
  const discount = state.cart.reduce((a,i) => a + itemDiscountAmount(i), 0);
  const total = subtotal - discount;

  document.getElementById("cartSubtotal").textContent = "Bs " + subtotal.toFixed(2);
  document.getElementById("cartDiscount").textContent = "Bs " + discount.toFixed(2);
  document.getElementById("cartTotal").textContent = "Bs " + total.toFixed(2);
}

// Cambia la cantidad de una línea del carrito a un valor exacto, validando
// stock y ajustando la cantidad de unidades de "opciones avanzadas" en
// consecuencia (agrega unidades pendientes de configurar, o quita las
// últimas si se reduce la cantidad). La usan tanto los botones [-]/[+]
// como el campo de cantidad editable.
function setItemQty(productId, newQty){
  const item = state.cart.find(i => i.productId === productId);
  if (!item) return false;
  if (!Number.isInteger(newQty) || newQty <= 0) return false;
  const prod = state.products.find(p => p.id === productId);
  if (stockAppliesTo(prod) && newQty > (prod.stock || 0)){
    alert(`No hay suficiente stock de "${prod.name}". Disponible: ${prod.stock || 0}.`);
    return false;
  }
  item.qty = newQty;
  if (prod && prod.advanced){
    if (!item.unitSelections) item.unitSelections = [];
    while (item.unitSelections.length < newQty) item.unitSelections.push(null);
    while (item.unitSelections.length > newQty) item.unitSelections.pop();
  }
  renderCart();
  return true;
}

function changeQty(productId, delta){
  const item = state.cart.find(i => i.productId === productId);
  if (!item) return;
  const newQty = item.qty + delta;
  if (newQty <= 0){
    state.cart = state.cart.filter(i => i.productId !== productId);
    renderCart();
    return;
  }
  setItemQty(productId, newQty);
}
function removeFromCart(productId){
  state.cart = state.cart.filter(i => i.productId !== productId);
  renderCart();
}

document.getElementById("btnClearCart").addEventListener("click", () => {
  if (state.cart.length === 0) return;
  openConfirmModal("Vaciar carrito", "¿Seguro que quieres quitar todos los productos de la venta actual?", () => {
    state.cart = [];
    selectedPayMethod = null;
    document.querySelectorAll(".pay-btn").forEach(b => b.classList.remove("selected"));
    renderCart();
  });
});

// ---------- VENTAS EN ESPERA (COLA) ----------
function renderPendingBadge(){
  const btn = document.getElementById("btnPendingSales");
  if (!btn) return;
  const count = state.pendingSales.length;
  btn.textContent = count > 0 ? `Ventas en espera (${count})` : "Ventas en espera";
}

document.getElementById("btnHoldSale").addEventListener("click", () => {
  if (state.cart.length === 0){
    alert("No hay productos en el carrito para mandar a la cola.");
    return;
  }
  const pendingId = uid("pend");
  state.pendingSales.push({
    id: pendingId,
    items: JSON.parse(JSON.stringify(state.cart)),
    createdAt: new Date().toISOString()
  });
  state.cart = [];
  selectedPayMethod = null;
  editingSaleId = null;
  editingSaleOriginal = null;
  document.querySelectorAll(".pay-btn").forEach(b => b.classList.remove("selected"));
  saveState();
  renderCart();
  renderPendingBadge();
});

document.getElementById("btnPendingSales").addEventListener("click", () => {
  if (state.pendingSales.length === 0){
    showModal(`
      <h2>Ventas en espera</h2>
      <p class="empty-msg">No hay ventas en espera.</p>
      <div class="modal-actions"><button class="modal-confirm" id="closePending">Cerrar</button></div>
    `);
    document.getElementById("closePending").addEventListener("click", closeModal);
    return;
  }
  const rows = state.pendingSales.map(p => {
    const total = p.items.reduce((a,i) => a + itemFinalPrice(i) * i.qty, 0);
    const summary = p.items.map(i => `${i.qty} ${i.name}`).join(", ");
    return `
      <div class="held-sale-card">
        <div class="held-sale-summary">${summary}</div>
        <div class="held-sale-total">Total: Bs ${total.toFixed(2)}</div>
        <button class="btn-primary" data-continue="${p.id}">Continuar pedido</button>
      </div>
    `;
  }).join("");
  showModal(`
    <h2>Ventas en espera</h2>
    <div class="held-sale-list">${rows}</div>
    <div class="modal-actions"><button class="modal-cancel" id="closePending2">Cerrar</button></div>
  `);
  document.getElementById("closePending2").addEventListener("click", closeModal);
  document.querySelectorAll("[data-continue]").forEach(b => {
    b.addEventListener("click", () => continuePendingSale(b.dataset.continue));
  });
});

function continuePendingSale(id){
  const pending = state.pendingSales.find(p => p.id === id);
  if (!pending) return;
  state.cart = JSON.parse(JSON.stringify(pending.items));
  state.pendingSales = state.pendingSales.filter(p => p.id !== id);
  editingSaleId = null;
  editingSaleOriginal = null;
  selectedPayMethod = null;
  document.querySelectorAll(".pay-btn").forEach(b => b.classList.remove("selected"));
  closeModal();
  saveState();
  switchView("newsale");
  renderPendingBadge();
}

// ---------- DESCUENTO POR PRODUCTO ----------
function openDiscountModal(productId){
  const item = state.cart.find(i => i.productId === productId);
  const prod = state.products.find(p => p.id === productId);
  const cost = prod ? (prod.cost || 0) : 0;
  let type = item.discountType || "percent";
  let value = item.discountValue || 0;

  showModal(`
    <h2>Aplicar descuento — ${item.name}</h2>
    <div class="toggle-pair">
      <button id="dtPercent" class="${type==='percent'?'selected':''}">Porcentaje</button>
      <button id="dtFinal" class="${type==='final'?'selected':''}">Precio final</button>
    </div>
    <label id="dtLabel">${type==='percent' ? 'Porcentaje de descuento (%)' : 'Nuevo precio final (Bs)'}</label>
    <input type="number" id="dtValue" min="0" value="${type==='percent' ? (item.discountType==='percent'?value:0) : (item.discountType==='final'?value:item.price)}">
    <p class="muted" style="margin-top:10px; font-size:.85rem;">Precio original: Bs ${item.price.toFixed(2)}</p>
    <p class="muted" style="font-size:.85rem;">Precio de costo: Bs ${cost.toFixed(2)}</p>
    <div class="modal-actions">
      <button class="modal-cancel" id="dtCancel">Cancelar</button>
      <button class="modal-confirm" id="dtConfirm">Aplicar</button>
    </div>
  `);

  document.getElementById("dtPercent").addEventListener("click", () => { type="percent"; toggleDtButtons(); });
  document.getElementById("dtFinal").addEventListener("click", () => { type="final"; toggleDtButtons(); });
  function toggleDtButtons(){
    document.getElementById("dtPercent").classList.toggle("selected", type==="percent");
    document.getElementById("dtFinal").classList.toggle("selected", type==="final");
    document.getElementById("dtLabel").textContent = type==="percent" ? "Porcentaje de descuento (%)" : "Nuevo precio final (Bs)";
  }
  document.getElementById("dtCancel").addEventListener("click", closeModal);
  document.getElementById("dtConfirm").addEventListener("click", () => {
    const val = parseFloat(document.getElementById("dtValue").value) || 0;
    if (val <= 0){
      item.discountType = null;
      item.discountValue = 0;
    } else {
      item.discountType = type;
      item.discountValue = val;
    }
    closeModal();
    renderCart();
  });
}

// ---------- FORMA DE PAGO (ventanas/modales) ----------
function getCartTotal(){
  const subtotal = state.cart.reduce((a,i) => a + i.price*i.qty, 0);
  const discount = state.cart.reduce((a,i) => a + itemDiscountAmount(i), 0);
  return subtotal - discount;
}

document.querySelectorAll(".pay-btn").forEach(btn => {
  btn.addEventListener("click", () => openPayModal(btn.dataset.method));
});

// Variable temporal: qué método de pago retomar después de completar
// "Selecciones extra" (si el carrito tiene productos con opciones avanzadas).
let pendingPayMethodAfterSelections = null;

function cartNeedsAdvancedSelections(){
  return state.cart.some(item => {
    const prod = state.products.find(p => p.id === item.productId);
    return prod && prod.advanced && prod.questions && prod.questions.length > 0;
  });
}

function openPayModal(method){
  if (state.cart.length === 0){
    alert("No hay productos en el carrito.");
    return;
  }
  selectedPayMethod = method;
  document.querySelectorAll(".pay-btn").forEach(b => b.classList.toggle("selected", b.dataset.method === method));

  if (cartNeedsAdvancedSelections()){
    pendingPayMethodAfterSelections = method;
    openAdvancedSelectionsModal();
    return;
  }
  openSpecificPayModal(method);
}

function openSpecificPayModal(method){
  const total = getCartTotal();
  let prefillCash = null;
  if (editingSaleId && editingSaleOriginal && editingSaleOriginal.method === method){
    prefillCash = editingSaleOriginal.cash;
  }

  if (method === "efectivo") openCashModal(total, prefillCash);
  if (method === "qr") openQrModal(total);
  if (method === "mixto") openMixModal(total, prefillCash);
}

// ---------- SELECCIONES EXTRA (opciones avanzadas, por unidad) ----------
function openAdvancedSelectionsModal(){
  const rows = [];
  state.cart.forEach(item => {
    const prod = state.products.find(p => p.id === item.productId);
    if (!prod || !prod.advanced || !prod.questions || prod.questions.length === 0) return;
    if (!item.unitSelections) item.unitSelections = [];
    while (item.unitSelections.length < item.qty) item.unitSelections.push(null);
    for (let u = 0; u < item.qty; u++){
      const sel = item.unitSelections[u];
      const complete = !!sel && prod.questions.every(q => sel[q.id]);
      rows.push({
        productId: item.productId,
        unitIndex: u,
        label: item.qty > 1 ? `${item.name} ${u+1}` : item.name,
        complete
      });
    }
  });

  const rowsHtml = rows.map(r => `
    <button type="button" class="unit-btn" data-config-unit="${r.productId}::${r.unitIndex}">
      <span class="unit-name">${r.label} ${r.complete ? "✓" : "⚠ Falta configurar"}</span>
    </button>
  `).join("");

  showModal(`
    <h2>Selecciones extra</h2>
    <p class="muted" style="margin-bottom:10px; font-size:.85rem;">Toca cada unidad para elegir sus opciones.</p>
    <div class="unit-grid">${rowsHtml}</div>
    <div class="modal-actions">
      <button class="modal-cancel" id="advSelCancel">Cancelar</button>
      <button class="modal-confirm" id="advSelContinue">Continuar</button>
    </div>
  `);
  document.getElementById("advSelCancel").addEventListener("click", closeModal);
  document.querySelectorAll("[data-config-unit]").forEach(b => {
    b.addEventListener("click", () => {
      const [pid, uidx] = b.dataset.configUnit.split("::");
      openUnitConfigModal(pid, parseInt(uidx));
    });
  });
  document.getElementById("advSelContinue").addEventListener("click", () => {
    for (const r of rows){
      if (!r.complete){
        alert(`Debes completar las opciones de ${r.label}.`);
        return;
      }
    }
    closeModal();
    openSpecificPayModal(pendingPayMethodAfterSelections);
  });
}

function openUnitConfigModal(productId, unitIndex){
  const item = state.cart.find(i => i.productId === productId);
  const prod = state.products.find(p => p.id === productId);
  if (!item || !prod) return;
  if (!item.unitSelections[unitIndex]) item.unitSelections[unitIndex] = {};
  const sel = item.unitSelections[unitIndex];
  const label = item.qty > 1 ? `${item.name} ${unitIndex+1}` : item.name;

  const questionsHtml = prod.questions.map(q => `
    <p style="font-weight:600; margin:14px 0 8px;">${q.text}</p>
    <div class="option-group" data-question="${q.id}">
      ${q.options.map(opt => `<button type="button" class="option-btn ${sel[q.id]===opt?'selected':''}" data-option="${opt}">${opt}</button>`).join("")}
    </div>
  `).join("");

  showModal(`
    <h2>${label}</h2>
    ${questionsHtml}
    <div class="modal-actions">
      <button class="modal-confirm" id="unitConfigOk" style="flex:1;">OK</button>
    </div>
  `);

  document.querySelectorAll(".option-group").forEach(group => {
    const qid = group.dataset.question;
    group.querySelectorAll(".option-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        sel[qid] = btn.dataset.option;
        group.querySelectorAll(".option-btn").forEach(b => b.classList.toggle("selected", b.dataset.option === sel[qid]));
      });
    });
  });

  document.getElementById("unitConfigOk").addEventListener("click", () => {
    closeModal();
    openAdvancedSelectionsModal();
  });
}

function openCashModal(total, prefillCash){
  const confirmLabel = editingSaleId ? "Guardar cambios" : "Cobrar";
  showModal(`
    <h2>Pago en efectivo</h2>
    <label>Total a pagar</label>
    <p class="modal-total">Bs ${total.toFixed(2)}</p>
    <label>Monto recibido</label>
    <input type="number" id="pmCashReceived" min="0" placeholder="0.00" value="${prefillCash!==null ? prefillCash : ""}">
    <div class="pay-line" id="pmChangeLine"></div>
    <div class="modal-actions">
      <button class="modal-cancel" id="pmCancel">Cancelar</button>
      <button class="modal-confirm" id="pmConfirm" disabled>${confirmLabel}</button>
    </div>
  `);
  const input = document.getElementById("pmCashReceived");
  const confirmBtn = document.getElementById("pmConfirm");
  const changeLine = document.getElementById("pmChangeLine");

  function update(){
    if (input.value === ""){
      changeLine.innerHTML = "";
      confirmBtn.disabled = true;
      return;
    }
    const received = parseFloat(input.value);
    if (isNaN(received)){
      changeLine.innerHTML = "";
      confirmBtn.disabled = true;
      return;
    }
    const change = received - total;
    if (change < 0){
      changeLine.innerHTML = `<span class="pm-error">Monto insuficiente — falta Bs ${Math.abs(change).toFixed(2)}</span>`;
      confirmBtn.disabled = true;
    } else {
      changeLine.innerHTML = `<span>Cambio</span><span>Bs ${change.toFixed(2)}</span>`;
      confirmBtn.disabled = false;
    }
  }
  input.addEventListener("input", update);
  if (prefillCash !== null) update();
  setTimeout(() => { input.focus(); }, 50);

  document.getElementById("pmCancel").addEventListener("click", closeModal);
  confirmBtn.addEventListener("click", () => {
    // Se registra el total de la venta como efectivo (no el monto recibido),
    // porque el vuelto entregado no es dinero que quede en caja.
    closeModal();
    proceedToFinalize("efectivo", total, 0);
  });
  setEnterConfirm("pmConfirm");
}

function openQrModal(total){
  const confirmLabel = editingSaleId ? "Guardar cambios" : "Cobrar";
  showModal(`
    <h2>Pago por QR</h2>
    <label>Total a pagar</label>
    <p class="modal-total">Bs ${total.toFixed(2)}</p>
    <p class="muted" style="font-size:.85rem; margin-bottom:6px;">Se cobrará el total completo mediante QR.</p>
    <div class="modal-actions">
      <button class="modal-cancel" id="pmCancel">Cancelar</button>
      <button class="modal-confirm" id="pmConfirm">${confirmLabel}</button>
    </div>
  `);
  document.getElementById("pmCancel").addEventListener("click", closeModal);
  document.getElementById("pmConfirm").addEventListener("click", () => {
    closeModal();
    proceedToFinalize("qr", 0, total);
  });
  setEnterConfirm("pmConfirm");
}

function openMixModal(total, prefillCash){
  const confirmLabel = editingSaleId ? "Guardar cambios" : "Cobrar";
  showModal(`
    <h2>Pago mixto</h2>
    <label>Total a pagar</label>
    <p class="modal-total">Bs ${total.toFixed(2)}</p>
    <label>Pago en efectivo</label>
    <input type="number" id="pmMixCash" min="0" placeholder="0.00" value="${prefillCash!==null ? prefillCash : ""}">
    <div class="pay-line highlight" id="pmMixQrLine">Pago por QR: Bs ${total.toFixed(2)}</div>
    <div class="modal-actions">
      <button class="modal-cancel" id="pmCancel">Cancelar</button>
      <button class="modal-confirm" id="pmConfirm" disabled>${confirmLabel}</button>
    </div>
  `);
  const input = document.getElementById("pmMixCash");
  const confirmBtn = document.getElementById("pmConfirm");
  const qrLine = document.getElementById("pmMixQrLine");

  function update(){
    if (input.value === ""){
      qrLine.textContent = `Pago por QR: Bs ${total.toFixed(2)}`;
      confirmBtn.disabled = true;
      return;
    }
    let cash = parseFloat(input.value);
    if (isNaN(cash)) cash = 0;
    if (cash > total){ cash = total; input.value = cash; }
    if (cash < 0){ cash = 0; input.value = 0; }
    const qr = total - cash;
    qrLine.textContent = `Pago por QR: Bs ${qr.toFixed(2)}`;
    confirmBtn.disabled = false;
  }
  input.addEventListener("input", update);
  if (prefillCash !== null) update();

  document.getElementById("pmCancel").addEventListener("click", closeModal);
  confirmBtn.addEventListener("click", () => {
    let cash = parseFloat(input.value) || 0;
    if (cash > total) cash = total;
    const qr = total - cash;
    closeModal();
    proceedToFinalize("mixto", cash, qr);
  });
  setEnterConfirm("pmConfirm");
}

// ---------- VALIDACIÓN DE STOCK AL COBRAR ----------
function validateStockForCart(){
  for (const item of state.cart){
    const prod = state.products.find(p => p.id === item.productId);
    if (stockAppliesTo(prod) && item.qty > (prod.stock || 0)){
      return { ok: false, name: prod.name, available: prod.stock || 0 };
    }
  }
  return { ok: true };
}

// ---------- COBRAR / MODIFICAR PEDIDO ----------
function proceedToFinalize(method, cash, qr){
  if (editingSaleId){
    finalizeSale(null, method, cash, qr);
  } else {
    openNameModal(method, cash, qr);
  }
}

function openNameModal(method, cash, qr){
  showModal(`
    <h2>Agregar nombre al pedido</h2>
    <label>Nombre del pedido (opcional)</label>
    <input type="text" id="orderNameInput" placeholder="Ej: Juan Pérez">
    <div class="modal-actions">
      <button class="modal-cancel" id="nameCancel">Cancelar</button>
      <button class="modal-confirm" id="nameConfirm">Continuar</button>
    </div>
  `);
  document.getElementById("nameCancel").addEventListener("click", closeModal);
  document.getElementById("nameConfirm").addEventListener("click", () => {
    const name = document.getElementById("orderNameInput").value.trim();
    closeModal();
    finalizeSale(name, method, cash, qr);
  });
  setEnterConfirm("nameConfirm");
  setTimeout(() => { document.getElementById("orderNameInput").focus(); }, 50);
}

let finalizingSale = false; // evita que un doble clic durante la breve espera de red cree dos ventas
async function finalizeSale(name, method, cash, qr){
  if (finalizingSale) return;
  finalizingSale = true;
  try {
    await finalizeSaleInner(name, method, cash, qr);
  } finally {
    finalizingSale = false;
  }
}
async function finalizeSaleInner(name, method, cash, qr){
  const total = getCartTotal();
  const subtotal = state.cart.reduce((a,i) => a + i.price*i.qty, 0);
  const discount = subtotal - total;

  const itemsSnapshot = state.cart.map(i => {
    const prod = state.products.find(p => p.id === i.productId);
    const snap = { ...i, finalPrice: itemFinalPrice(i), cost: prod ? (prod.cost || 0) : 0 };
    // Congela las preguntas/respuestas de "producto avanzado" tal como estaban
    // al momento de la venta (para Historial y Entrega de pedidos), por unidad.
    if (prod && prod.advanced && prod.questions && prod.questions.length){
      snap.unitAnswers = (i.unitSelections || []).map(sel => {
        if (!sel) return [];
        return prod.questions
          .filter(q => sel[q.id])
          .map(q => ({ questionId: q.id, question: q.text, answer: sel[q.id] }));
      });
    }
    return snap;
  });

  if (editingSaleId){
    const sale = state.sales.find(s => s.id === editingSaleId);

    if (state.stockEnabled){
      // 1) Se devuelve el stock que había reservado la venta original
      sale.items.forEach(oi => {
        const prod = state.products.find(p => p.id === oi.productId);
        if (stockAppliesTo(prod)) prod.stock = (prod.stock || 0) + oi.qty;
      });
      // 2) Se valida el carrito editado contra el stock ya restituido
      const check = validateStockForCart();
      if (!check.ok){
        // Se revierte la devolución para no dejar el stock inconsistente
        sale.items.forEach(oi => {
          const prod = state.products.find(p => p.id === oi.productId);
          if (stockAppliesTo(prod)) prod.stock = (prod.stock || 0) - oi.qty;
        });
        alert(`No hay suficiente stock de "${check.name}". Disponible: ${check.available}.`);
        return;
      }
      // 3) Se descuenta el stock según el carrito ya editado
      state.cart.forEach(ci => {
        const prod = state.products.find(p => p.id === ci.productId);
        if (stockAppliesTo(prod)) prod.stock -= ci.qty;
      });
    }

    sale.items = itemsSnapshot;
    sale.subtotal = subtotal; sale.discount = discount; sale.total = total;
    sale.method = method; sale.cash = cash; sale.qr = qr;
    // El pedido de entrega se genera de nuevo a partir de los productos actualizados
    sale.delivery = { units: generateDeliveryUnits(itemsSnapshot, false), finalized: false };
    editingSaleId = null;
    editingSaleOriginal = null;
    saveState();
    resetCartAfterSale();
    showToast("Venta N.º " + sale.jornadaNumber + " actualizada correctamente.");
  } else {
    if (state.stockEnabled){
      const check = validateStockForCart();
      if (!check.ok){
        alert(`No hay suficiente stock de "${check.name}". Disponible: ${check.available}.`);
        return;
      }
      state.cart.forEach(ci => {
        const prod = state.products.find(p => p.id === ci.productId);
        if (stockAppliesTo(prod)) prod.stock -= ci.qty;
      });
    }

    // El id interno nunca se reinicia (identifica la venta de forma única para
    // siempre). El número de jornada sí se reinicia con cada apertura de caja,
    // y es el número que se le muestra al usuario ("Venta 1", "Venta 2"...).
    // Se calcula de forma segura entre dispositivos (ver nextJornadaNumberSafe)
    // para que dos cajeros cobrando al mismo tiempo nunca obtengan el mismo número.
    const nextId = uid("sale");
    const jornadaNumber = await nextJornadaNumberSafe();
    const sale = {
      id: nextId,
      jornadaNumber,
      date: new Date().toISOString(),
      name: name ? name : null,
      items: itemsSnapshot,
      subtotal, discount, total,
      method, cash, qr,
      delivery: { units: generateDeliveryUnits(itemsSnapshot, false), finalized: false }
    };
    state.sales.push(sale);
    saveState();
    resetCartAfterSale();
    showToast("Venta N.º " + sale.jornadaNumber + " registrada correctamente.");
  }
}

function resetCartAfterSale(){
  state.cart = [];
  selectedPayMethod = null;
  document.querySelectorAll(".pay-btn").forEach(b => b.classList.remove("selected"));
  renderCart();
  renderCategories();
}

// ---------- HISTORIAL DE VENTAS ----------
// Muestra solo las ventas de la jornada de caja actualmente abierta: al cerrar
// caja, esa jornada queda guardada dentro del cierre correspondiente, y una
// nueva apertura comienza un historial nuevo (numeración desde Venta 1).
function renderHistory(){
  const list = document.getElementById("historyList");
  list.innerHTML = "";
  const sales = getCurrentJornadaSales();
  if (sales.length === 0){
    list.innerHTML = `<p class="empty-msg">${state.cashRegister ? "Todavía no hay ventas registradas en esta jornada." : "No hay una caja abierta. Abre caja para comenzar a vender."}</p>`;
    return;
  }
  [...sales].sort((a,b) => new Date(b.date) - new Date(a.date)).forEach(sale => {
    const d = new Date(sale.date);
    const row = document.createElement("div");
    row.className = "history-row";
    row.innerHTML = `
      <span class="hnum">#${String(sale.jornadaNumber).padStart(3,'0')}</span>
      <span class="hmeta">
        ${sale.name ? `<strong>${sale.name}</strong> · ` : ""}${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} · <span class="tag">${sale.method}</span>
      </span>
      <span class="htotal">Bs ${sale.total.toFixed(2)}</span>
      <div class="hactions">
        <button class="mini-btn" data-view-sale="${sale.id}">Ver</button>
        <button class="mini-btn" data-edit-sale="${sale.id}">Editar pedido</button>
        <button class="mini-btn danger" data-delete-sale="${sale.id}">Eliminar</button>
      </div>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll("[data-view-sale]").forEach(b => b.addEventListener("click", () => viewSale(b.dataset.viewSale)));
  list.querySelectorAll("[data-edit-sale]").forEach(b => b.addEventListener("click", () => editSale(b.dataset.editSale)));
  list.querySelectorAll("[data-delete-sale]").forEach(b => b.addEventListener("click", () => deleteSale(b.dataset.deleteSale)));
}

function viewSale(saleId){
  const sale = state.sales.find(s => s.id === saleId);
  const d = new Date(sale.date);
  const itemsHtml = sale.items.map(i => {
    const answersHtml = (i.unitAnswers || []).map((ans, idx) => {
      if (!ans || ans.length === 0) return "";
      const label = i.qty > 1 ? `${i.name} ${idx+1}` : i.name;
      const lines = ans.map(a => `<div class="muted" style="font-size:.8rem;">${a.question} - ${a.answer}</div>`).join("");
      return `<div style="margin:4px 0 6px 10px;"><strong style="font-size:.85rem;">${label}</strong>${lines}</div>`;
    }).join("");
    return `
      <div class="pay-line"><span>${i.name} x${i.qty}</span><span>Bs ${(i.finalPrice*i.qty).toFixed(2)}</span></div>
      ${answersHtml}
    `;
  }).join("");
  showModal(`
    <h2>Venta #${String(sale.jornadaNumber).padStart(3,'0')}</h2>
    ${sale.name ? `<p style="font-weight:700; margin-bottom:4px;">${sale.name}</p>` : ""}
    <p class="muted" style="margin-bottom:10px;">${d.toLocaleDateString()} — ${d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</p>
    ${itemsHtml}
    <div class="cart-summary" style="margin-top:10px;">
      <div class="sum-row"><span>Subtotal</span><span>Bs ${sale.subtotal.toFixed(2)}</span></div>
      <div class="sum-row"><span>Descuento</span><span>Bs ${sale.discount.toFixed(2)}</span></div>
      <div class="sum-row total"><span>Total</span><span>Bs ${sale.total.toFixed(2)}</span></div>
    </div>
    <div class="pay-line"><span>Efectivo</span><span>Bs ${sale.cash.toFixed(2)}</span></div>
    <div class="pay-line"><span>QR</span><span>Bs ${sale.qr.toFixed(2)}</span></div>
    <div class="modal-actions"><button class="modal-confirm" id="closeSaleView">Cerrar</button></div>
  `);
  document.getElementById("closeSaleView").addEventListener("click", closeModal);
}

// Borrado "suave": la venta se marca como eliminada pero se conserva en los
// datos (deja de contarse y de mostrarse) para poder incluirla en el registro
// de "ventas eliminadas" del cierre de caja. El stock reservado se devuelve.
function deleteSale(saleId){
  const sale = state.sales.find(s => s.id === saleId);
  if (!sale) return;
  openConfirmModal("Eliminar venta", `¿Seguro que quieres eliminar la venta #${String(sale.jornadaNumber).padStart(3,'0')}? Esta acción no se puede deshacer.`, () => {
    requireDeletePassword(() => {
      if (state.stockEnabled){
        sale.items.forEach(i => {
          const prod = state.products.find(p => p.id === i.productId);
          if (stockAppliesTo(prod)) prod.stock = (prod.stock || 0) + i.qty;
        });
      }
      sale.deleted = true;
      sale.deletedAt = new Date().toISOString();
      saveState();
      renderHistory();
    });
  }, true);
}

function editSale(saleId){
  const sale = state.sales.find(s => s.id === saleId);
  if (!sale) return;

  state.cart = sale.items.map(i => ({
    productId: i.productId, name: i.name, price: i.price, qty: i.qty,
    discountType: i.discountType, discountValue: i.discountValue,
    // Reconstruye las selecciones de "producto avanzado" (por unidad) a partir
    // de las respuestas ya guardadas, para no volver a pedirlas desde cero.
    unitSelections: (i.unitAnswers || []).map(ans => {
      if (!ans || !ans.length) return null;
      const obj = {};
      ans.forEach(a => { obj[a.questionId] = a.answer; });
      return obj;
    })
  }));
  editingSaleId = saleId;
  editingSaleOriginal = { method: sale.method, cash: sale.cash, qr: sale.qr };
  selectedPayMethod = sale.method;

  switchView("newsale");
  document.querySelectorAll(".pay-btn").forEach(b => b.classList.toggle("selected", b.dataset.method === sale.method));
}

// ---------- PRODUCTOS (administración: listado + orden + ocultar/editar/eliminar) ----------
let currentProdCategoryId = null;

function renderProductAdmin(){
  currentProdCategoryId = null;
  document.getElementById("prodTitle").textContent = "Productos y categorías";
  document.getElementById("btnBackToProdCats").classList.add("hidden");
  document.getElementById("productAdminList").classList.add("hidden");
  document.getElementById("prodCategoryGrid").classList.remove("hidden");
  document.getElementById("btnGoStock").classList.toggle("hidden", !state.stockEnabled);
  renderProdCategoryGrid();
}

function renderProdCategoryGrid(){
  const wrap = document.getElementById("prodCategoryGrid");
  wrap.innerHTML = "";
  if (state.categories.length === 0){
    wrap.innerHTML = `<p class="empty-msg">Todavía no hay categorías. Usa el botón "Categoría" para crear la primera.</p>`;
    return;
  }
  state.categories.forEach(cat => {
    const count = state.products.filter(p => p.categoryId === cat.id).length;
    const btn = document.createElement("button");
    btn.className = "pick-card";
    btn.innerHTML = `<span class="name">${cat.name}</span><span class="price">${count} producto${count===1?"":"s"}</span>`;
    btn.addEventListener("click", () => openProdCategory(cat.id));
    wrap.appendChild(btn);
  });
}

function openProdCategory(catId){
  currentProdCategoryId = catId;
  const cat = state.categories.find(c => c.id === catId);
  document.getElementById("prodTitle").textContent = cat.name;
  document.getElementById("btnBackToProdCats").classList.remove("hidden");
  document.getElementById("prodCategoryGrid").classList.add("hidden");
  document.getElementById("productAdminList").classList.remove("hidden");
  renderProductAdminList(catId);
}
document.getElementById("btnBackToProdCats").addEventListener("click", renderProductAdmin);

function renderProductAdminList(catId){
  const wrap = document.getElementById("productAdminList");
  wrap.innerHTML = "";
  const prods = productsInCategory(catId);
  if (prods.length === 0){
    wrap.innerHTML = `<p class="empty-msg">Sin productos todavía en esta categoría.</p>`;
    return;
  }
  prods.forEach((p, idx) => {
    const row = document.createElement("div");
    row.className = "admin-prod-row" + (p.hidden ? " hidden-product" : "");
    row.innerHTML = `
      <div class="admin-prod-info">
        <span class="admin-prod-name">${p.name}${p.hidden ? " (oculto)" : ""}</span>
        <span class="admin-prod-meta">Precio: Bs ${p.price.toFixed(2)} · Costo: Bs ${(p.cost||0).toFixed(2)}</span>
        ${state.stockEnabled ? `<span class="admin-prod-meta">${p.stockTracked ? "Stock: " + p.stock + " · Stock mínimo: " + p.stockMin : "Sin control de stock"}</span>` : ""}
      </div>
      <div class="admin-prod-actions">
        <button class="mini-btn" data-move-prod-up="${p.id}" ${idx===0?"disabled":""}>↑</button>
        <button class="mini-btn" data-move-prod-down="${p.id}" ${idx===prods.length-1?"disabled":""}>↓</button>
        <button class="mini-btn" data-edit-prod="${p.id}">Editar</button>
        <button class="mini-btn" data-toggle-hide="${p.id}">${p.hidden ? "Mostrar" : "Ocultar"}</button>
        <button class="mini-btn danger" data-delete-prod="${p.id}">Eliminar</button>
      </div>
    `;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll("[data-move-prod-up]").forEach(b => b.addEventListener("click", () => moveProduct(b.dataset.moveProdUp, -1)));
  wrap.querySelectorAll("[data-move-prod-down]").forEach(b => b.addEventListener("click", () => moveProduct(b.dataset.moveProdDown, 1)));
  wrap.querySelectorAll("[data-edit-prod]").forEach(b => b.addEventListener("click", () => openEditProductModal(b.dataset.editProd)));
  wrap.querySelectorAll("[data-toggle-hide]").forEach(b => b.addEventListener("click", () => {
    const p = state.products.find(p => p.id === b.dataset.toggleHide);
    p.hidden = !p.hidden;
    saveState(); renderProductAdminList(catId);
  }));
  wrap.querySelectorAll("[data-delete-prod]").forEach(b => b.addEventListener("click", () => {
    openConfirmModal("Eliminar producto", "¿Seguro que quieres eliminar este producto?", () => {
      state.products = state.products.filter(p => p.id !== b.dataset.deleteProd);
      saveState(); renderProductAdminList(catId);
    }, true);
  }));
}

// Vuelve a dibujar la vista de productos actual (lista de una categoría, o el
// listado de categorías si no hay ninguna abierta) tras un cambio de datos.
function refreshProductAdminView(){
  if (currentProdCategoryId){
    renderProductAdminList(currentProdCategoryId);
  } else {
    renderProdCategoryGrid();
  }
}

function moveProduct(productId, dir){
  const prod = state.products.find(p => p.id === productId);
  if (!prod) return;
  const sameCat = productsInCategory(prod.categoryId);
  const idx = sameCat.indexOf(prod);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= sameCat.length) return;
  const other = sameCat[newIdx];
  const tmpOrder = prod.order;
  prod.order = other.order;
  other.order = tmpOrder;
  saveState();
  renderProductAdminList(prod.categoryId);
}

// Campos de stock que se agregan al formulario de producto solo si el
// sistema de stock está activado en Configuración.
// Estado temporal del formulario de producto mientras el modal está abierto
// (permite ir y volver desde el editor de preguntas sin perder lo ya escrito).
let productFormDraft = null;

function syncProductFormDraftFromDom(){
  const d = productFormDraft;
  if (!d) return;
  const nameEl = document.getElementById("pfName");
  if (!nameEl) return;
  d.name = nameEl.value;
  d.categoryId = document.getElementById("pfCat").value;
  d.price = document.getElementById("pfPrice").value;
  d.cost = document.getElementById("pfCost").value;
  if (state.stockEnabled){
    if (d.mode === "add"){
      const stockEl = document.getElementById("pfStock");
      if (stockEl) d.stock = stockEl.value;
    }
    const stockMinEl = document.getElementById("pfStockMin");
    if (stockMinEl) d.stockMin = stockMinEl.value;
  }
}

function readIntOrZero(raw){
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

document.getElementById("btnAddProduct").addEventListener("click", () => {
  if (state.categories.length === 0){
    alert("Primero crea una categoría.");
    return;
  }
  productFormDraft = {
    mode: "add", categoryId: currentProdCategoryId || state.categories[0].id, name: "", price: "", cost: "",
    stock: 0, stockMin: 0, stockTracked: state.stockEnabled, advanced: false, questions: [], kitchen: false
  };
  renderProductFormModal();
});

function openEditProductModal(productId){
  const p = state.products.find(x => x.id === productId);
  if (!p) return;
  productFormDraft = {
    mode: "edit", productId: p.id, categoryId: p.categoryId, name: p.name, price: p.price, cost: p.cost || 0,
    stockMin: p.stockMin || 0, stockTracked: !!p.stockTracked, hidden: p.hidden,
    advanced: !!p.advanced, questions: p.questions ? JSON.parse(JSON.stringify(p.questions)) : [],
    kitchen: !!p.kitchen
  };
  renderProductFormModal();
}

// Dibuja el formulario completo de producto (agregar o editar) a partir de
// productFormDraft. Se vuelve a llamar cada vez que cambia algo (ej. al
// activar/desactivar producto avanzado, o al volver del editor de preguntas)
// para reflejar el estado actual sin perder lo demás.
function renderProductFormModal(){
  const d = productFormDraft;
  const catOptions = state.categories.map(c => `<option value="${c.id}" ${c.id===d.categoryId?"selected":""}>${c.name}</option>`).join("");
  const questionsHtml = d.questions.length
    ? d.questions.map((q, idx) => `<div class="question-row" data-question-idx="${idx}">${idx+1}. ${q.text}</div>`).join("")
    : `<p class="muted" style="font-size:.85rem;">Todavía no hay preguntas configuradas.</p>`;

  showModal(`
    <h2>${d.mode === "add" ? "Nuevo producto" : "Editar producto"}</h2>
    <label>Nombre</label>
    <input type="text" id="pfName" value="${d.name}" placeholder="Ej: Hamburguesa doble">
    <label>Categoría</label>
    <select id="pfCat">${catOptions}</select>
    <label>Precio (Bs)</label>
    <input type="number" id="pfPrice" min="0" value="${d.price}" placeholder="0.00">
    <label>Costo (Bs)</label>
    <input type="number" id="pfCost" min="0" value="${d.cost}" placeholder="0.00">
    ${state.stockEnabled ? `
      ${d.mode==="add" ? `<label>Stock actual</label><input type="number" id="pfStock" min="0" step="1" value="${d.stock}">` : ""}
      <label>Stock mínimo</label>
      <input type="number" id="pfStockMin" min="0" step="1" value="${d.stockMin}">
      <label>Control de stock</label>
      <div class="toggle-pair">
        <button type="button" id="pfStockOn" class="${d.stockTracked?'selected':''}">Activado</button>
        <button type="button" id="pfStockOff" class="${!d.stockTracked?'selected':''}">Desactivado</button>
      </div>
    ` : ""}
    <label>Mandar a cocina</label>
    <div class="toggle-pair">
      <button type="button" id="pfKitchenOn" class="${d.kitchen?'selected':''}">Activado</button>
      <button type="button" id="pfKitchenOff" class="${!d.kitchen?'selected':''}">Desactivado</button>
    </div>
    <label>Producto avanzado</label>
    <div class="toggle-pair">
      <button type="button" id="pfAdvOn" class="${d.advanced?'selected':''}">Activar</button>
      <button type="button" id="pfAdvOff" class="${!d.advanced?'selected':''}">Desactivar</button>
    </div>
    <div id="pfAdvSection" class="${d.advanced?'':'hidden'}" style="margin-top:8px;">
      <p class="muted" style="font-size:.85rem; margin-bottom:6px;">Preguntas configuradas (máximo 5, toca una para editarla)</p>
      <div id="pfQuestionsList">${questionsHtml}</div>
      <button type="button" class="btn-ghost" id="pfAddQuestion" style="margin-top:8px;">+ Añadir pregunta</button>
    </div>
    ${d.mode==="edit" ? `
    <label style="margin-top:14px;">Estado</label>
    <div class="toggle-pair">
      <button id="pfVisible" class="${!d.hidden?'selected':''}">Visible</button>
      <button id="pfHidden" class="${d.hidden?'selected':''}">Oculto</button>
    </div>` : ""}
    <div class="modal-actions">
      <button class="modal-cancel" id="pfCancel">Cancelar</button>
      <button class="modal-confirm" id="pfSave">Guardar</button>
    </div>
  `);

  document.getElementById("pfCancel").addEventListener("click", () => { productFormDraft = null; closeModal(); });

  document.getElementById("pfKitchenOn").addEventListener("click", () => { syncProductFormDraftFromDom(); d.kitchen = true; renderProductFormModal(); });
  document.getElementById("pfKitchenOff").addEventListener("click", () => { syncProductFormDraftFromDom(); d.kitchen = false; renderProductFormModal(); });

  document.getElementById("pfAdvOn").addEventListener("click", () => { syncProductFormDraftFromDom(); d.advanced = true; renderProductFormModal(); });
  document.getElementById("pfAdvOff").addEventListener("click", () => { syncProductFormDraftFromDom(); d.advanced = false; renderProductFormModal(); });

  if (state.stockEnabled){
    document.getElementById("pfStockOn").addEventListener("click", () => { syncProductFormDraftFromDom(); d.stockTracked = true; renderProductFormModal(); });
    document.getElementById("pfStockOff").addEventListener("click", () => { syncProductFormDraftFromDom(); d.stockTracked = false; renderProductFormModal(); });
  }
  if (d.mode === "edit"){
    document.getElementById("pfVisible").addEventListener("click", () => { syncProductFormDraftFromDom(); d.hidden = false; renderProductFormModal(); });
    document.getElementById("pfHidden").addEventListener("click", () => { syncProductFormDraftFromDom(); d.hidden = true; renderProductFormModal(); });
  }

  document.querySelectorAll("#pfQuestionsList [data-question-idx]").forEach(el => {
    el.addEventListener("click", () => {
      syncProductFormDraftFromDom();
      openQuestionEditor(parseInt(el.dataset.questionIdx));
    });
  });
  document.getElementById("pfAddQuestion").addEventListener("click", () => {
    if (d.questions.length >= 5){
      alert("Ya alcanzaste el máximo de 5 preguntas por producto.");
      return;
    }
    syncProductFormDraftFromDom();
    openQuestionEditor(null);
  });

  document.getElementById("pfSave").addEventListener("click", () => {
    syncProductFormDraftFromDom();
    const name = d.name.trim();
    const price = parseFloat(d.price) || 0;
    const cost = parseFloat(d.cost) || 0;
    if (!name || price <= 0){
      alert("Completa el nombre y un precio válido.");
      return;
    }
    if (d.mode === "add"){
      const stock = state.stockEnabled ? readIntOrZero(d.stock) : 0;
      const stockMin = state.stockEnabled ? readIntOrZero(d.stockMin) : 0;
      const maxOrder = productsInCategory(d.categoryId).reduce((m,p) => Math.max(m, p.order||0), -1);
      state.products.push({
        id: uid("p"), name, price, cost, categoryId: d.categoryId, hidden: false,
        order: maxOrder + 1,
        stock, stockMin, stockTracked: state.stockEnabled ? !!d.stockTracked : false,
        advanced: d.advanced, questions: d.questions, kitchen: !!d.kitchen
      });
    } else {
      const p = state.products.find(x => x.id === d.productId);
      p.name = name; p.categoryId = d.categoryId; p.price = price; p.cost = cost; p.hidden = d.hidden;
      if (state.stockEnabled){
        p.stockMin = readIntOrZero(d.stockMin);
        p.stockTracked = !!d.stockTracked;
      }
      p.advanced = d.advanced;
      p.questions = d.questions;
      p.kitchen = !!d.kitchen;
    }
    saveState();
    const savedCategoryId = d.categoryId;
    productFormDraft = null;
    closeModal();
    openProdCategory(savedCategoryId);
  });
}

// Editor de una pregunta (hasta 5 opciones). Al guardar/cancelar, vuelve al
// formulario de producto con productFormDraft actualizado (sin perder nada).
function openQuestionEditor(idx){
  const d = productFormDraft;
  const q = idx !== null ? d.questions[idx] : { text: "", options: [] };
  const opts = (q.options || []).concat(["", "", "", "", ""]).slice(0, 5);

  showModal(`
    <h2>${idx !== null ? "Editar pregunta" : "Añadir pregunta"}</h2>
    <label>Pregunta</label>
    <input type="text" id="qeText" value="${q.text}" placeholder="Ej: Elige tu esencia">
    <label>Opción 1</label><input type="text" id="qeOpt0" value="${opts[0]||''}">
    <label>Opción 2</label><input type="text" id="qeOpt1" value="${opts[1]||''}">
    <label>Opción 3</label><input type="text" id="qeOpt2" value="${opts[2]||''}">
    <label>Opción 4</label><input type="text" id="qeOpt3" value="${opts[3]||''}">
    <label>Opción 5</label><input type="text" id="qeOpt4" value="${opts[4]||''}">
    <div class="modal-actions">
      <button class="modal-cancel" id="qeCancel">Cancelar</button>
      ${idx !== null ? `<button class="modal-cancel danger" id="qeDelete">Eliminar</button>` : ""}
      <button class="modal-confirm" id="qeSave">Guardar</button>
    </div>
  `);

  document.getElementById("qeCancel").addEventListener("click", () => renderProductFormModal());
  if (idx !== null){
    document.getElementById("qeDelete").addEventListener("click", () => {
      d.questions.splice(idx, 1);
      renderProductFormModal();
    });
  }
  document.getElementById("qeSave").addEventListener("click", () => {
    const text = document.getElementById("qeText").value.trim();
    if (!text){
      alert("Escribe el texto de la pregunta.");
      return;
    }
    const options = [0,1,2,3,4].map(i => document.getElementById("qeOpt"+i).value.trim()).filter(v => v !== "");
    if (options.length === 0){
      alert("Agrega al menos una opción.");
      return;
    }
    const newQ = { id: (idx !== null && q.id) ? q.id : uid("q"), text, options };
    if (idx !== null){ d.questions[idx] = newQ; } else { d.questions.push(newQ); }
    renderProductFormModal();
  });
}

// ---------- CATEGORÍAS (pantalla propia: agregar, editar, eliminar, ordenar) ----------
document.getElementById("btnAddCategory").addEventListener("click", openCategoriesScreen);
document.getElementById("btnBackToProducts").addEventListener("click", () => switchView("products"));
document.getElementById("btnBackToProductsFromStock").addEventListener("click", () => switchView("products"));
document.getElementById("btnBackToStockFromLow").addEventListener("click", () => switchView("stock"));
document.getElementById("btnGoStock").addEventListener("click", () => switchView("stock"));
document.getElementById("btnGoStockLow").addEventListener("click", () => switchView("stocklow"));

function openCategoriesScreen(){
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById("view-categories").classList.add("active");
  renderCategoryAdminList();
}

function renderCategoryAdminList(){
  const wrap = document.getElementById("categoryAdminList");
  wrap.innerHTML = "";
  if (state.categories.length === 0){
    wrap.innerHTML = `<p class="empty-msg">Todavía no hay categorías.</p>`;
    return;
  }
  state.categories.forEach((cat, idx) => {
    const prodCount = state.products.filter(p => p.categoryId === cat.id).length;
    const row = document.createElement("div");
    row.className = "admin-prod-row";
    row.innerHTML = `
      <div class="admin-prod-info">
        <span class="admin-prod-name">${cat.name}</span>
        <span class="admin-prod-meta">Cantidad de productos: ${prodCount}</span>
      </div>
      <div class="admin-prod-actions">
        <button class="mini-btn" data-move-cat-up="${cat.id}" ${idx===0?"disabled":""}>↑</button>
        <button class="mini-btn" data-move-cat-down="${cat.id}" ${idx===state.categories.length-1?"disabled":""}>↓</button>
        <button class="mini-btn" data-edit-cat="${cat.id}">Editar</button>
        <button class="mini-btn danger" data-delete-cat="${cat.id}">Eliminar</button>
      </div>
    `;
    wrap.appendChild(row);
  });
  wrap.querySelectorAll("[data-move-cat-up]").forEach(b => b.addEventListener("click", () => moveCategory(b.dataset.moveCatUp, -1)));
  wrap.querySelectorAll("[data-move-cat-down]").forEach(b => b.addEventListener("click", () => moveCategory(b.dataset.moveCatDown, 1)));
  wrap.querySelectorAll("[data-edit-cat]").forEach(b => b.addEventListener("click", () => openEditCategoryModal(b.dataset.editCat)));
  wrap.querySelectorAll("[data-delete-cat]").forEach(b => b.addEventListener("click", () => deleteCategory(b.dataset.deleteCat)));
}

function moveCategory(catId, dir){
  const idx = state.categories.findIndex(c => c.id === catId);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= state.categories.length) return;
  const tmp = state.categories[idx];
  state.categories[idx] = state.categories[newIdx];
  state.categories[newIdx] = tmp;
  saveState();
  renderCategoryAdminList();
}

document.getElementById("btnAddCategoryScreen").addEventListener("click", () => {
  showModal(`
    <h2>Agregar categoría</h2>
    <label>Nombre</label>
    <input type="text" id="newCatNameScreen" placeholder="Ej: Postres">
    <div class="modal-actions">
      <button class="modal-cancel" id="catCancelScreen">Cancelar</button>
      <button class="modal-confirm" id="catConfirmScreen">Guardar</button>
    </div>
  `);
  document.getElementById("catCancelScreen").addEventListener("click", closeModal);
  document.getElementById("catConfirmScreen").addEventListener("click", () => {
    const name = document.getElementById("newCatNameScreen").value.trim();
    if (!name) return;
    state.categories.push({ id: uid("c"), name });
    saveState(); closeModal(); renderCategoryAdminList();
  });
});

function openEditCategoryModal(catId){
  const cat = state.categories.find(c => c.id === catId);
  if (!cat) return;
  showModal(`
    <h2>Editar categoría</h2>
    <label>Nombre</label>
    <input type="text" id="editCatName" value="${cat.name}">
    <div class="modal-actions">
      <button class="modal-cancel" id="editCatCancel">Cancelar</button>
      <button class="modal-confirm" id="editCatConfirm">Guardar</button>
    </div>
  `);
  document.getElementById("editCatCancel").addEventListener("click", closeModal);
  document.getElementById("editCatConfirm").addEventListener("click", () => {
    const name = document.getElementById("editCatName").value.trim();
    if (!name) return;
    cat.name = name;
    saveState(); closeModal(); renderCategoryAdminList();
  });
}

function deleteCategory(catId){
  const cat = state.categories.find(c => c.id === catId);
  if (!cat) return;
  const prodCount = state.products.filter(p => p.categoryId === catId).length;
  const msg = prodCount > 0
    ? `Esta categoría tiene ${prodCount} producto(s) asociado(s). Si la eliminas, esos productos también se eliminarán. ¿Seguro que quieres continuar?`
    : `¿Seguro que quieres eliminar la categoría "${cat.name}"?`;
  openConfirmModal("Eliminar categoría", msg, () => {
    state.products = state.products.filter(p => p.categoryId !== catId);
    state.categories = state.categories.filter(c => c.id !== catId);
    saveState();
    renderCategoryAdminList();
  }, true);
}

// ---------- STOCK ----------
function renderStockScreen(){
  const wrap = document.getElementById("stockList");
  wrap.innerHTML = "";
  if (state.categories.length === 0){
    wrap.innerHTML = `<p class="empty-msg">Todavía no hay categorías ni productos cargados.</p>`;
    return;
  }
  state.categories.forEach(cat => {
    const prods = productsInCategory(cat.id);
    const block = document.createElement("div");
    block.className = "admin-cat";
    block.innerHTML = `<h3>${cat.name}</h3>`;
    prods.forEach(p => {
      const low = p.stockTracked && p.stock <= p.stockMin;
      const row = document.createElement("div");
      row.className = "admin-prod-row";
      row.innerHTML = `
        <div class="admin-prod-info">
          <span class="admin-prod-name">${p.name} ${!p.stockTracked ? '<span class="tag">Sin control</span>' : ''} ${low ? '<span class="tag danger">STOCK BAJO</span>' : ''}</span>
          <span class="admin-prod-meta">Stock actual: ${p.stock} · Stock mínimo: ${p.stockMin}</span>
        </div>
        <div class="admin-prod-actions">
          <button class="mini-btn" data-stock-add="${p.id}">Añadir</button>
          <button class="mini-btn" data-stock-remove="${p.id}">Quitar</button>
          <button class="mini-btn" data-stock-toggle="${p.id}">${p.stockTracked ? "Desactivar" : "Activar"} stock</button>
          <button class="mini-btn danger" data-stock-clear="${p.id}">Vaciar stock</button>
        </div>
      `;
      block.appendChild(row);
    });
    if (prods.length === 0){
      block.innerHTML += `<p class="muted" style="font-size:.85rem;">Sin productos en esta categoría.</p>`;
    }
    wrap.appendChild(block);
  });

  wrap.querySelectorAll("[data-stock-add]").forEach(b => b.addEventListener("click", () => openStockMoveModal(b.dataset.stockAdd, "add")));
  wrap.querySelectorAll("[data-stock-remove]").forEach(b => b.addEventListener("click", () => openStockMoveModal(b.dataset.stockRemove, "remove")));
  wrap.querySelectorAll("[data-stock-toggle]").forEach(b => b.addEventListener("click", () => {
    const p = state.products.find(p => p.id === b.dataset.stockToggle);
    if (!p) return;
    p.stockTracked = !p.stockTracked;
    saveState();
    renderStockScreen();
  }));
  wrap.querySelectorAll("[data-stock-clear]").forEach(b => b.addEventListener("click", () => {
    const p = state.products.find(p => p.id === b.dataset.stockClear);
    if (!p) return;
    openConfirmModal("Vaciar stock", `¿Estás seguro de vaciar el stock de "${p.name}"? Su stock actual quedará en 0.`, () => {
      p.stock = 0;
      saveState();
      renderStockScreen();
    }, true, { cancel: "Cancelar", confirm: "Vaciar stock" });
  }));
}

document.getElementById("btnClearAllStock").addEventListener("click", () => {
  openConfirmModal(
    "Vaciar todo el stock",
    "¿Estás seguro de vaciar el stock de todos los productos? Esta acción dejará el stock actual de todos los productos en 0 (no afecta precio, costo, categoría, stock mínimo, oculto ni el estado de control de stock).",
    () => {
      state.products.forEach(p => { p.stock = 0; });
      saveState();
      renderStockScreen();
    },
    true,
    { cancel: "Cancelar", confirm: "Vaciar todo el stock" }
  );
});

function openStockMoveModal(productId, mode){
  const p = state.products.find(x => x.id === productId);
  if (!p) return;
  const title = mode === "add" ? "Añadir stock" : "Quitar stock";
  showModal(`
    <h2>${title} — ${p.name}</h2>
    <p class="muted" style="margin-bottom:10px;">Stock actual: ${p.stock}</p>
    <label>Cantidad a ${mode === "add" ? "añadir" : "quitar"}</label>
    <input type="number" id="stockMoveQty" min="1" step="1" placeholder="0">
    <p class="import-feedback" id="stockMoveError"></p>
    <div class="modal-actions">
      <button class="modal-cancel" id="stockMoveCancel">Cancelar</button>
      <button class="modal-confirm" id="stockMoveConfirm">${title}</button>
    </div>
  `);
  document.getElementById("stockMoveCancel").addEventListener("click", closeModal);
  document.getElementById("stockMoveConfirm").addEventListener("click", () => {
    const raw = document.getElementById("stockMoveQty").value.trim();
    const qty = Number(raw);
    const errorEl = document.getElementById("stockMoveError");
    if (!Number.isInteger(qty) || qty <= 0){
      errorEl.textContent = "Debes ingresar un número entero mayor a 0.";
      errorEl.className = "import-feedback error";
      return;
    }
    if (mode === "add"){
      p.stock = (p.stock || 0) + qty;
    } else {
      if (qty > (p.stock || 0)){
        errorEl.textContent = `No hay suficiente stock disponible (actual: ${p.stock}).`;
        errorEl.className = "import-feedback error";
        return;
      }
    p.stock -= qty;
    }
    saveState();
    closeModal();
    renderStockScreen();
  });
  setTimeout(() => { document.getElementById("stockMoveQty").focus(); }, 50);
}

function renderStockLowScreen(){
  const wrap = document.getElementById("stockLowList");
  wrap.innerHTML = "";
  const lowProducts = state.products.filter(p => p.stockTracked && p.stock <= p.stockMin);
  if (lowProducts.length === 0){
    wrap.innerHTML = `<p class="empty-msg">No hay productos con stock bajo.</p>`;
    return;
  }
  lowProducts.forEach(p => {
    const cat = state.categories.find(c => c.id === p.categoryId);
    const row = document.createElement("div");
    row.className = "admin-prod-row";
    row.innerHTML = `
      <div class="admin-prod-info">
        <span class="admin-prod-name">${p.name} <span class="tag danger">STOCK BAJO</span></span>
        <span class="admin-prod-meta">${cat ? cat.name + " · " : ""}Stock actual: ${p.stock} · Stock mínimo: ${p.stockMin}</span>
      </div>
      <div class="admin-prod-actions">
        <button class="mini-btn" data-stock-add="${p.id}">Añadir</button>
      </div>
    `;
    wrap.appendChild(row);
  });
  wrap.querySelectorAll("[data-stock-add]").forEach(b => b.addEventListener("click", () => openStockMoveModalFromLow(b.dataset.stockAdd)));
}
function openStockMoveModalFromLow(productId){
  const p = state.products.find(x => x.id === productId);
  if (!p) return;
  showModal(`
    <h2>Añadir stock — ${p.name}</h2>
    <p class="muted" style="margin-bottom:10px;">Stock actual: ${p.stock}</p>
    <label>Cantidad a añadir</label>
    <input type="number" id="stockMoveQty" min="1" step="1" placeholder="0">
    <p class="import-feedback" id="stockMoveError"></p>
    <div class="modal-actions">
      <button class="modal-cancel" id="stockMoveCancel">Cancelar</button>
      <button class="modal-confirm" id="stockMoveConfirm">Añadir stock</button>
    </div>
  `);
  document.getElementById("stockMoveCancel").addEventListener("click", closeModal);
  document.getElementById("stockMoveConfirm").addEventListener("click", () => {
    const raw = document.getElementById("stockMoveQty").value.trim();
    const qty = Number(raw);
    const errorEl = document.getElementById("stockMoveError");
    if (!Number.isInteger(qty) || qty <= 0){
      errorEl.textContent = "Debes ingresar un número entero mayor a 0.";
      errorEl.className = "import-feedback error";
      return;
    }
    p.stock = (p.stock || 0) + qty;
    saveState();
    closeModal();
    renderStockLowScreen();
  });
  setTimeout(() => { document.getElementById("stockMoveQty").focus(); }, 50);
}

// ---------- IMPORTAR / EXPORTAR XLSX ----------
document.getElementById("btnImportExport").addEventListener("click", () => {
  showModal(`
    <h2>Importar / Exportar</h2>
    <div class="modal-choice-row">
      <button id="btnExportXlsx">Exportar XLSX</button>
      <button id="btnImportXlsx">Importar XLSX</button>
    </div>
    <div class="modal-actions">
      <button class="modal-cancel" id="ieCancel" style="flex:1;">Cerrar</button>
    </div>
  `);
  document.getElementById("ieCancel").addEventListener("click", closeModal);
  document.getElementById("btnExportXlsx").addEventListener("click", exportProductsXlsx);
  document.getElementById("btnImportXlsx").addEventListener("click", openImportFileStep);
});

function exportProductsXlsx(){
  const rows = state.products.map(p => {
    const cat = state.categories.find(c => c.id === p.categoryId);
    const row = {
      "Categoría": cat ? cat.name : "",
      "Producto": p.name,
      "Precio": p.price,
      "Costo": p.cost || 0,
      "Oculto": p.hidden ? "Sí" : "No",
      "Cocina": p.kitchen ? "Sí" : "No",
      "Stock": p.stock || 0,
      "Stock mínimo": p.stockMin || 0,
      "Stock activado": p.stockTracked ? "Sí" : "No",
      "Opción avanzada": p.advanced ? "Sí" : "No"
    };
    // Hasta 5 preguntas, cada una con hasta 5 opciones, en columnas fijas.
    const questions = p.questions || [];
    for (let qn = 1; qn <= 5; qn++){
      const q = questions[qn - 1];
      row["Pregunta " + qn] = q ? q.text : "";
      for (let on = 1; on <= 5; on++){
        row["Pregunta " + qn + " - Opción " + on] = (q && q.options[on - 1]) ? q.options[on - 1] : "";
      }
    }
    return row;
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Productos");
  const fileName = "productos_" + state.businessName.replace(/\s+/g, "_").toLowerCase() + ".xlsx";
  XLSX.writeFile(wb, fileName);
  closeModal();
}

function openImportFileStep(){
  showModal(`
    <h2>Importar productos</h2>
    <label>Selecciona un archivo Excel (.xlsx)</label>
    <input type="file" id="importFileInput" accept=".xlsx,.xls">
    <div class="import-feedback" id="importFeedback"></div>
    <div class="modal-actions">
      <button class="modal-cancel" id="importCancel" style="flex:1;">Cancelar</button>
    </div>
  `);
  document.getElementById("importCancel").addEventListener("click", closeModal);
  document.getElementById("importFileInput").addEventListener("change", handleImportFile);
}

// Quita también espacios: así "Stock mínimo" y "Stock activado" (con espacio)
// coinciden con las claves de búsqueda "stockminimo"/"stockactivado" — esta
// era la causa real de que esas dos columnas no se detectaran al importar.
function normalizeKey(k){
  return k.toString().trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "");
}
// Interpreta valores tipo Sí/No de forma robusta (con o sin tilde, mayúsculas, espacios)
function isAffirmative(raw){
  return ["si", "true", "1", "activado"].includes(normalizeKey(raw));
}
function showImportFeedback(msg){
  const feedback = document.getElementById("importFeedback");
  if (feedback){
    feedback.textContent = msg;
    feedback.className = "import-feedback error";
  }
}

function handleImportFile(e){
  const file = e.target.files[0];
  if (!file) return;
  const feedback = document.getElementById("importFeedback");
  feedback.className = "import-feedback";
  feedback.textContent = "Leyendo archivo...";

  const reader = new FileReader();
  reader.onload = (evt) => {
    try {
      const data = new Uint8Array(evt.target.result);
      const workbook = XLSX.read(data, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

      if (!raw || raw.length < 2){
        showImportFeedback("El archivo no contiene datos.");
        return;
      }

      const headers = raw[0].map(h => normalizeKey(h));
      const required = [
        { key: "categoria", label: "Categoría" },
        { key: "producto", label: "Producto" },
        { key: "precio", label: "Precio" }
      ];
      const missing = required.filter(r => !headers.includes(r.key));
      if (missing.length > 0){
        showImportFeedback(`El archivo no contiene la columna ${missing.map(m => m.label).join(", ")}.`);
        return;
      }

      const idxCat = headers.indexOf("categoria");
      const idxProd = headers.indexOf("producto");
      const idxPrecio = headers.indexOf("precio");
      const idxCosto = headers.indexOf("costo");
      const idxOculto = headers.indexOf("oculto");
      const idxStock = headers.indexOf("stock");
      const idxStockMin = headers.indexOf("stockminimo");
      const idxStockTracked = headers.indexOf("stockactivado");
      const idxAdvanced = headers.indexOf("opcionavanzada");
      const idxKitchen = headers.indexOf("cocina");
      // Hasta 5 preguntas ("Pregunta 1"...) con hasta 5 opciones cada una
      // ("Pregunta 1 - Opción 1"...), normalizadas sin espacios/tildes.
      const questionCols = [];
      for (let qn = 1; qn <= 5; qn++){
        questionCols.push({
          idxText: headers.indexOf("pregunta" + qn),
          idxOptions: [1,2,3,4,5].map(on => headers.indexOf("pregunta" + qn + "-opcion" + on))
        });
      }

      const dataRows = raw.slice(1).filter(r => r.some(cell => cell !== ""));
      if (dataRows.length === 0){
        showImportFeedback("El archivo no contiene productos.");
        return;
      }

      const parsedRows = [];
      for (const r of dataRows){
        const prodName = String(r[idxProd] || "").trim();
        const priceRaw = r[idxPrecio];
        const price = parseFloat(priceRaw);
        if (!prodName || priceRaw === "" || isNaN(price)){
          showImportFeedback("El archivo contiene datos inválidos.");
          return;
        }
        const catName = String(r[idxCat] || "Sin categoría").trim() || "Sin categoría";
        const cost = idxCosto >= 0 ? (parseFloat(r[idxCosto]) || 0) : 0;
        const hidden = idxOculto >= 0 ? isAffirmative(r[idxOculto]) : false;
        const stock = idxStock >= 0 ? Math.max(0, parseInt(r[idxStock], 10) || 0) : 0;
        const stockMin = idxStockMin >= 0 ? Math.max(0, parseInt(r[idxStockMin], 10) || 0) : 0;
        const stockTracked = idxStockTracked >= 0 ? isAffirmative(r[idxStockTracked]) : false;
        const advanced = idxAdvanced >= 0 ? isAffirmative(r[idxAdvanced]) : false;
        const kitchen = idxKitchen >= 0 ? isAffirmative(r[idxKitchen]) : false;

        let questions = [];
        if (advanced){
          questionCols.forEach(qc => {
            if (qc.idxText < 0) return;
            const text = String(r[qc.idxText] || "").trim();
            if (!text) return;
            const options = qc.idxOptions
              .map(idx => idx >= 0 ? String(r[idx] || "").trim() : "")
              .filter(v => v !== "");
            if (options.length === 0) return;
            questions.push({ id: uid("q"), text, options });
          });
        }
        parsedRows.push({ catName, prodName, price, cost, hidden, stock, stockMin, stockTracked, advanced, questions, kitchen });
      }

      const catCount = new Set(parsedRows.map(r => r.catName.toLowerCase())).size;
      showImportPreview(parsedRows, catCount);

    } catch (err){
      showImportFeedback("No se pudo leer el archivo. Verifica que sea un Excel válido.");
    }
  };
  reader.readAsArrayBuffer(file);
}

function showImportPreview(parsedRows, catCount){
  showModal(`
    <h2>Confirmar importación</h2>
    <p>Se encontraron:</p>
    <p class="modal-total" style="font-size:1.1rem;">${catCount} categorías · ${parsedRows.length} productos</p>
    <p class="muted" style="font-size:.85rem;">Los productos existentes con el mismo nombre y categoría se actualizarán (el stock importado se suma al actual). Los nuevos se crearán automáticamente.</p>
    <div class="modal-actions">
      <button class="modal-cancel" id="importPreviewCancel">Cancelar</button>
      <button class="modal-confirm" id="importPreviewConfirm">Importar</button>
    </div>
  `);
  document.getElementById("importPreviewCancel").addEventListener("click", closeModal);
  document.getElementById("importPreviewConfirm").addEventListener("click", () => {
    applyImport(parsedRows);
    closeModal();
    renderProductAdmin();
    alert("Importación completada.");
  });
}

function applyImport(parsedRows){
  parsedRows.forEach(r => {
    const cat = findOrCreateCategory(r.catName);
    findOrCreateProduct(r.prodName, cat.id, r.price, r.cost, r.hidden, r.stock, r.stockMin, r.stockTracked, r.advanced, r.questions, r.kitchen);
  });
  saveState();
}

function findOrCreateCategory(name){
  let cat = state.categories.find(c => c.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (!cat){
    cat = { id: uid("c"), name: name.trim() };
    state.categories.push(cat);
  }
  return cat;
}

// El stock importado se SUMA al stock actual de un producto ya existente
// (no lo reemplaza); el resto de los datos (precio, costo, oculto, stock
// mínimo, control de stock, opciones avanzadas) se actualiza con lo que trae el Excel.
function findOrCreateProduct(name, categoryId, price, cost, hidden, stock, stockMin, stockTracked, advanced, questions, kitchen){
  let prod = state.products.find(p => p.categoryId === categoryId && p.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (prod){
    prod.price = price;
    prod.cost = cost;
    prod.hidden = hidden;
    prod.stock = (prod.stock || 0) + (stock || 0);
    prod.stockMin = stockMin || 0;
    prod.stockTracked = !!stockTracked;
    prod.advanced = !!advanced;
    prod.questions = questions || [];
    prod.kitchen = !!kitchen;
  } else {
    const maxOrder = productsInCategory(categoryId).reduce((m,p) => Math.max(m, p.order||0), -1);
    prod = {
      id: uid("p"), name: name.trim(), price, cost, categoryId, hidden,
      order: maxOrder + 1,
      stock: stock || 0, stockMin: stockMin || 0, stockTracked: !!stockTracked,
      advanced: !!advanced, questions: questions || [], kitchen: !!kitchen
    };
    state.products.push(prod);
  }
  return prod;
}

// ---------- CONFIGURACIÓN (Cajero: cuadrícula + stock) ----------
function renderCajeroSettings(){
  document.getElementById("stockOn").classList.toggle("selected", state.stockEnabled);
  document.getElementById("stockOff").classList.toggle("selected", !state.stockEnabled);
  renderGridSizeSettings();
}
document.getElementById("stockOn").addEventListener("click", () => {
  state.stockEnabled = true;
  // Al activar el stock global, todos los productos existentes quedan con su
  // control de stock activado (el usuario puede luego desactivarlo producto por producto).
  state.products.forEach(p => { p.stockTracked = true; });
  saveState();
  renderCajeroSettings();
});
document.getElementById("stockOff").addEventListener("click", () => {
  state.stockEnabled = false;
  saveState();
  renderCajeroSettings();
});

// ---------- CONTRASEÑAS (Configuración avanzada / eliminaciones) ----------
// Prompt genérico de contraseña: compara sin distinguir mayúsculas/minúsculas.
function promptPassword(title, message, getExpectedPassword, onSuccess){
  showModal(`
    <h2>${title}</h2>
    <p class="muted" style="margin-bottom:10px;">${message}</p>
    <label>Contraseña</label>
    <input type="password" id="pwInput" placeholder="••••">
    <p class="import-feedback" id="pwError"></p>
    <div class="modal-actions">
      <button class="modal-cancel" id="pwCancel">Cancelar</button>
      <button class="modal-confirm" id="pwOk">Confirmar</button>
    </div>
  `);
  document.getElementById("pwCancel").addEventListener("click", closeModal);
  document.getElementById("pwOk").addEventListener("click", () => {
    const entered = document.getElementById("pwInput").value;
    const expected = getExpectedPassword();
    if (entered.toLowerCase() === String(expected).toLowerCase()){
      closeModal();
      onSuccess();
    } else {
      const err = document.getElementById("pwError");
      err.textContent = "Contraseña incorrecta.";
      err.className = "import-feedback error";
    }
  });
  setTimeout(() => { const el = document.getElementById("pwInput"); if (el) el.focus(); }, 50);
}

// Usada antes de eliminar una venta, un cierre de caja o un movimiento de dinero.
function requireDeletePassword(onSuccess){
  promptPassword("Contraseña requerida", "Ingresa la contraseña de eliminaciones para continuar.", () => state.deletePassword, onSuccess);
}

document.getElementById("btnAdvancedConfig").addEventListener("click", () => {
  promptPassword("Configuración avanzada", "Ingresa la contraseña para continuar.", () => state.advancedConfigPassword, openAdvancedConfigScreen);
});

function openAdvancedConfigScreen(){
  showModal(`
    <h2>Configuración avanzada</h2>
    <div class="settings-block" style="max-width:100%;">
      <label>Contraseña de eliminaciones</label>
      <p class="muted" style="font-size:.85rem; margin-bottom:8px;">Protege la eliminación de ventas, cierres de caja y movimientos de dinero.</p>
      <button class="btn-primary" id="btnConfigDeletePassword" style="width:fit-content;">Configurar</button>
    </div>
    <div class="modal-actions" style="margin-top:20px;">
      <button class="modal-confirm" id="advConfigClose" style="flex:1;">Cerrar</button>
    </div>
  `);
  document.getElementById("advConfigClose").addEventListener("click", closeModal);
  document.getElementById("btnConfigDeletePassword").addEventListener("click", openChangeDeletePasswordModal);
}

function openChangeDeletePasswordModal(){
  showModal(`
    <h2>Contraseña de eliminaciones</h2>
    <label>Contraseña anterior</label>
    <input type="password" id="oldPw" inputmode="numeric" placeholder="••••">
    <label>Nueva contraseña (solo números)</label>
    <input type="password" id="newPw" inputmode="numeric" placeholder="••••">
    <p class="import-feedback" id="pwChangeError"></p>
    <div class="modal-actions">
      <button class="modal-cancel" id="pwChangeCancel">Cancelar</button>
      <button class="modal-confirm" id="pwChangeSave">Guardar</button>
    </div>
  `);
  document.getElementById("pwChangeCancel").addEventListener("click", () => openAdvancedConfigScreen());
  document.getElementById("pwChangeSave").addEventListener("click", () => {
    const oldPw = document.getElementById("oldPw").value;
    const newPw = document.getElementById("newPw").value;
    const errorEl = document.getElementById("pwChangeError");
    if (oldPw !== state.deletePassword){
      errorEl.textContent = "La contraseña anterior no es correcta.";
      errorEl.className = "import-feedback error";
      return;
    }
    if (newPw.length === 0 || !/^[0-9]+$/.test(newPw)){
      errorEl.textContent = "La nueva contraseña solo puede contener números.";
      errorEl.className = "import-feedback error";
      return;
    }
    state.deletePassword = newPw;
    saveState();
    closeModal();
    alert("Contraseña de eliminaciones actualizada.");
  });
}

function renderGridSizeSettings(){
  const wrap = document.getElementById("gridSizeList");
  wrap.innerHTML = "";
  state.gridSizes.forEach((g, idx) => {
    const btn = document.createElement("button");
    btn.className = "size-btn" + (idx === state.selectedGridSizeIndex ? " selected" : "");
    btn.textContent = `${g.cols} x ${g.rows}`;
    btn.addEventListener("click", () => {
      state.selectedGridSizeIndex = idx;
      saveState();
      renderGridSizeSettings();
    });
    wrap.appendChild(btn);
  });
}

document.getElementById("btnAddGridSize").addEventListener("click", () => {
  showModal(`
    <h2>Agregar tamaño de cuadrícula</h2>
    <label>Columnas</label>
    <input type="number" id="newGridCols" min="1" placeholder="Ej: 3">
    <label>Filas</label>
    <input type="number" id="newGridRows" min="1" placeholder="Ej: 2">
    <div class="modal-actions">
      <button class="modal-cancel" id="gridCancel">Cancelar</button>
      <button class="modal-confirm" id="gridConfirm">Guardar</button>
    </div>
  `);
  document.getElementById("gridCancel").addEventListener("click", closeModal);
  document.getElementById("gridConfirm").addEventListener("click", () => {
    const rows = parseInt(document.getElementById("newGridRows").value) || 0;
    const cols = parseInt(document.getElementById("newGridCols").value) || 0;
    if (rows <= 0 || cols <= 0) return;
    state.gridSizes.push({ rows, cols });
    saveState();
    closeModal();
    renderGridSizeSettings();
  });
});

// ---------- CONFIGURACIÓN GENERAL (nombre, logo, colores del negocio) ----------
function renderConfigGeneral(){
  document.getElementById("cfgBusinessName").value = state.businessName;
  const t = state.theme || {};
  document.getElementById("cfgBgColor").value = t.bgColor || "#161d27";
  document.getElementById("cfgSidebarColor").value = t.sidebarColor || "#1f2836";
  document.getElementById("cfgAccentColor").value = t.accentColor || "#f2a649";
  document.getElementById("cfgTextColor").value = t.textColor || "#f1efe9";
  document.getElementById("cfgLogoScale").value = t.logoScale || 1;
}

document.getElementById("btnSaveLogoScale").addEventListener("click", () => {
  const raw = document.getElementById("cfgLogoScale").value.trim();
  // Acepta enteros o decimales con un solo decimal (0.5, 1, 1.2, 2, 3.4...)
  if (!/^[0-9]+(\.[0-9])?$/.test(raw) || parseFloat(raw) <= 0){
    alert("Ingresa un tamaño válido: un número entero o con un solo decimal, mayor a 0 (ej: 1, 1.2, 2, 3.4).");
    return;
  }
  state.theme.logoScale = parseFloat(raw);
  saveState();
  applyTheme();
  alert("Tamaño del logo aplicado.");
});

document.getElementById("btnSaveBusinessName").addEventListener("click", () => {
  const name = document.getElementById("cfgBusinessName").value.trim();
  if (name){
    state.businessName = name;
    saveState();
    document.getElementById("brandName").textContent = name;
    applyTheme();
    alert("Nombre guardado.");
  }
});

document.getElementById("logoInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 1.5 * 1024 * 1024){
    alert("La imagen es demasiado grande. Elige una imagen de menos de 1.5 MB.");
    e.target.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = (evt) => {
    state.theme.logoDataUrl = evt.target.result;
    saveState();
    applyTheme();
  };
  reader.readAsDataURL(file);
});

document.getElementById("btnSaveTheme").addEventListener("click", () => {
  state.theme.bgColor = document.getElementById("cfgBgColor").value;
  state.theme.sidebarColor = document.getElementById("cfgSidebarColor").value;
  state.theme.accentColor = document.getElementById("cfgAccentColor").value;
  state.theme.textColor = document.getElementById("cfgTextColor").value;
  saveState();
  applyTheme();
  alert("Colores guardados.");
});

document.getElementById("btnResetTheme").addEventListener("click", () => {
  state.theme.bgColor = null;
  state.theme.sidebarColor = null;
  state.theme.accentColor = null;
  state.theme.textColor = null;
  saveState();
  applyTheme();
  renderConfigGeneral();
});

// =========================================================
// ÁREA ENTREGA DE PEDIDOS
// =========================================================

function pedidoSummaryHtml(sale){
  return sale.items.map(i => `${i.qty} ${i.name}`).join(", ");
}

function pendingUnitsCount(sale){
  return sale.delivery.units.filter(u => !u.delivered).length;
}

// ---------- PEDIDOS (no finalizados) ----------
function renderPedidos(){
  const list = document.getElementById("pedidosList");
  list.innerHTML = "";
  const orders = getCurrentJornadaSales().filter(s => s.delivery && !s.delivery.finalized);
  if (orders.length === 0){
    list.innerHTML = `<p class="empty-msg">No hay pedidos pendientes.</p>`;
    return;
  }
  orders.forEach(sale => {
    const row = document.createElement("div");
    row.className = "history-row";
    row.innerHTML = `
      <span class="hnum">#${sale.jornadaNumber}</span>
      <span class="hmeta">
        ${sale.name ? `<strong>${sale.name}</strong> · ` : ""}${pedidoSummaryHtml(sale)}
        · <span class="tag">${pendingUnitsCount(sale)} pendiente(s)</span>
      </span>
      <div class="hactions">
        <button class="mini-btn" data-deliver="${sale.id}">Realizar entrega</button>
        <button class="mini-btn" data-finalize="${sale.id}">Finalizar pedido</button>
      </div>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll("[data-deliver]").forEach(b => b.addEventListener("click", () => openDeliveryDetail(b.dataset.deliver)));
  list.querySelectorAll("[data-finalize]").forEach(b => b.addEventListener("click", () => {
    finalizeOrder(b.dataset.finalize);
    renderPedidos();
  }));
}

// ---------- PEDIDOS FINALIZADOS ----------
function renderPedidosFinalizados(){
  const list = document.getElementById("pedidosFinalizadosList");
  list.innerHTML = "";
  const orders = getCurrentJornadaSales().filter(s => s.delivery && s.delivery.finalized);
  if (orders.length === 0){
    list.innerHTML = `<p class="empty-msg">Todavía no hay pedidos finalizados.</p>`;
    return;
  }
  orders.forEach(sale => {
    const row = document.createElement("div");
    row.className = "history-row";
    row.innerHTML = `
      <span class="hnum">#${sale.jornadaNumber}</span>
      <span class="hmeta">${sale.name ? `<strong>${sale.name}</strong> · ` : ""}${pedidoSummaryHtml(sale)}</span>
      <div class="hactions">
        <button class="mini-btn" data-review="${sale.id}">Revisar</button>
      </div>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll("[data-review]").forEach(b => b.addEventListener("click", () => openDeliveryDetail(b.dataset.review)));
}

// ---------- PRODUCTOS PENDIENTES (consolidado) ----------
function renderProductosPendientes(){
  const wrap = document.getElementById("productosPendientesList");
  wrap.innerHTML = "";
  const orders = getCurrentJornadaSales();
  const map = {};
  orders.forEach(sale => {
    if (!sale.delivery) return;
    sale.delivery.units.forEach(u => { if (!u.delivered) map[u.name] = (map[u.name] || 0) + 1; });
  });
  const rows = Object.entries(map).sort((a,b) => b[1] - a[1]);
  if (rows.length === 0){
    wrap.innerHTML = `<p class="empty-msg">No hay productos pendientes de entrega.</p>`;
    return;
  }
  rows.forEach(([name, qty]) => {
    const row = document.createElement("div");
    row.className = "admin-prod-row";
    row.innerHTML = `
      <div class="admin-prod-info">
        <span class="admin-prod-name">${name}</span>
      </div>
      <div class="admin-prod-actions"><span class="tag">${qty} pendiente${qty===1?"":"s"}</span></div>
    `;
    wrap.appendChild(row);
  });
}

// ---------- COCINA ----------
// Igual que "Productos pendientes", pero solo para los productos marcados
// como "Mandar a cocina". Se actualiza automáticamente con el mismo estado
// de los pedidos (entregar/desmarcar, eliminar o modificar una venta).
function renderCocina(){
  const wrap = document.getElementById("cocinaList");
  wrap.innerHTML = "";
  const kitchenNames = new Set(state.products.filter(p => p.kitchen).map(p => p.name));
  const orders = getCurrentJornadaSales();
  const map = {};
  orders.forEach(sale => {
    if (!sale.delivery) return;
    sale.delivery.units.forEach(u => {
      if (!u.delivered && kitchenNames.has(u.name)) map[u.name] = (map[u.name] || 0) + 1;
    });
  });
  const rows = Object.entries(map).sort((a,b) => b[1] - a[1]);
  if (rows.length === 0){
    wrap.innerHTML = `<p class="empty-msg">No hay productos pendientes de preparación en cocina.</p>`;
    return;
  }
  rows.forEach(([name, qty]) => {
    const row = document.createElement("div");
    row.className = "admin-prod-row";
    row.innerHTML = `
      <div class="admin-prod-info">
        <span class="admin-prod-name">${name}</span>
      </div>
      <div class="admin-prod-actions"><span class="tag">${qty} pendiente${qty===1?"":"s"}</span></div>
    `;
    wrap.appendChild(row);
  });
}

// ---------- OCULTAR / VISUALIZAR ----------
// Usa exactamente el mismo campo p.hidden que ya utiliza Cajero → Productos,
// así que el estado queda automáticamente sincronizado entre ambos sectores
// (es el mismo dato guardado, no dos sistemas separados). Navega primero por
// categorías y luego muestra los productos de la seleccionada.
let currentVisCategoryId = null;

function renderVisibilityScreen(){
  currentVisCategoryId = null;
  document.getElementById("visTitle").textContent = "Ocultar / Visualizar";
  document.getElementById("btnBackToVisCats").classList.add("hidden");
  document.getElementById("visProductList").classList.add("hidden");
  document.getElementById("visCategoryGrid").classList.remove("hidden");
  renderVisCategoryGrid();
}

function renderVisCategoryGrid(){
  const wrap = document.getElementById("visCategoryGrid");
  wrap.innerHTML = "";
  if (state.categories.length === 0){
    wrap.innerHTML = `<p class="empty-msg">Todavía no hay categorías ni productos cargados.</p>`;
    return;
  }
  state.categories.forEach(cat => {
    const count = state.products.filter(p => p.categoryId === cat.id).length;
    const btn = document.createElement("button");
    btn.className = "pick-card";
    btn.innerHTML = `<span class="name">${cat.name}</span><span class="price">${count} producto${count===1?"":"s"}</span>`;
    btn.addEventListener("click", () => openVisCategory(cat.id));
    wrap.appendChild(btn);
  });
}

function openVisCategory(catId){
  currentVisCategoryId = catId;
  const cat = state.categories.find(c => c.id === catId);
  document.getElementById("visTitle").textContent = cat.name;
  document.getElementById("btnBackToVisCats").classList.remove("hidden");
  document.getElementById("visCategoryGrid").classList.add("hidden");
  document.getElementById("visProductList").classList.remove("hidden");
  renderVisProductList(catId);
}

function renderVisProductList(catId){
  const wrap = document.getElementById("visProductList");
  wrap.innerHTML = "";
  const prods = productsInCategory(catId);
  if (prods.length === 0){
    wrap.innerHTML = `<p class="empty-msg">Sin productos en esta categoría.</p>`;
    return;
  }
  prods.forEach(p => {
    const btn = document.createElement("button");
    btn.className = "visibility-row" + (p.hidden ? " is-hidden" : "");
    // El stock solo se muestra si ese producto tiene su control de stock activado.
    btn.innerHTML = `
      <span class="visibility-name">${p.name} — Bs ${p.price.toFixed(2)}${p.stockTracked ? " · Stock: " + p.stock : ""}</span>
      ${p.hidden ? '<span class="tag danger">OCULTADO</span>' : '<span class="mini-btn">Ocultar</span>'}
    `;
    btn.addEventListener("click", () => {
      p.hidden = !p.hidden;
      saveState();
      renderVisProductList(catId);
    });
    wrap.appendChild(btn);
  });
}

document.getElementById("btnBackToVisCats").addEventListener("click", renderVisibilityScreen);

// ---------- DETALLE DE ENTREGA ----------
function openDeliveryDetail(saleId){
  currentDeliverySaleId = saleId;
  switchViewRaw("deliverydetail");
  renderDeliveryDetail();
}

// Cambia de vista sin pasar por switchView (evita recargar listas de otras secciones)
function switchViewRaw(viewName){
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById("view-" + viewName).classList.add("active");
}

function renderDeliveryDetail(){
  const sale = state.sales.find(s => s.id === currentDeliverySaleId);
  if (!sale){ switchView("pedidos"); return; }

  document.getElementById("deliveryDetailTitle").textContent = "Pedido #" + sale.jornadaNumber;
  document.getElementById("deliveryDetailMeta").textContent = sale.name ? sale.name : "Sin nombre";

  const pendingGrid = document.getElementById("deliveryPendingGrid");
  const doneGrid = document.getElementById("deliveryDoneGrid");
  pendingGrid.innerHTML = "";
  doneGrid.innerHTML = "";

  sale.delivery.units.forEach((unit, idx) => {
    const answersHtml = (unit.answers && unit.answers.length)
      ? unit.answers.map(a => `<div class="unit-answer">${a.question} - ${a.answer}</div>`).join("")
      : "";
    const btn = document.createElement("button");
    btn.className = "unit-btn" + (unit.delivered ? " delivered" : "");
    btn.innerHTML = `<div class="unit-name">${unit.name}</div>${answersHtml}`;
    btn.addEventListener("click", () => toggleDeliveryUnit(sale.id, idx));
    (unit.delivered ? doneGrid : pendingGrid).appendChild(btn);
  });

  if (pendingGrid.children.length === 0){
    pendingGrid.innerHTML = `<p class="empty-msg">No quedan productos pendientes.</p>`;
  }
  if (doneGrid.children.length === 0){
    doneGrid.innerHTML = `<p class="empty-msg">Todavía no se entregó nada.</p>`;
  }
}

function toggleDeliveryUnit(saleId, unitIdx){
  const sale = state.sales.find(s => s.id === saleId);
  if (!sale) return;
  const unit = sale.delivery.units[unitIdx];
  unit.delivered = !unit.delivered;

  const allDelivered = sale.delivery.units.every(u => u.delivered);
  const wasFinalized = sale.delivery.finalized;

  if (allDelivered && !wasFinalized){
    sale.delivery.finalized = true;
    showToast("Pedido #" + sale.jornadaNumber + " finalizado.");
  } else if (!allDelivered && wasFinalized){
    sale.delivery.finalized = false;
    showToast("Pedido #" + sale.jornadaNumber + " volvió a Pedidos.");
  }

  saveState();
  renderDeliveryDetail();
}

function finalizeOrder(saleId){
  const sale = state.sales.find(s => s.id === saleId);
  if (!sale) return;
  sale.delivery.units.forEach(u => { u.delivered = true; });
  sale.delivery.finalized = true;
  saveState();
  showToast("Pedido #" + sale.jornadaNumber + " finalizado.");
}

document.getElementById("btnFinalizeDeliveryDetail").addEventListener("click", () => {
  if (currentDeliverySaleId === null) return;
  finalizeOrder(currentDeliverySaleId);
  renderDeliveryDetail();
});

document.getElementById("btnBackFromDeliveryDetail").addEventListener("click", () => {
  const sale = state.sales.find(s => s.id === currentDeliverySaleId);
  if (sale && sale.delivery && sale.delivery.finalized){
    switchView("pedidosfinalizados");
  } else {
    switchView("pedidos");
  }
});

// ---------- NOTIFICACIÓN FLOTANTE (toast) ----------
function showToast(message){
  const toast = document.getElementById("posToast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => { toast.classList.remove("show"); }, 2000);
}

// ---------- MODAL genérico ----------
// Permite que ciertos modales respondan a ENTER ejecutando un botón específico
// (solo donde se solicita explícitamente: apertura de caja, nombre del pedido,
// confirmación de cierre, aviso de cierre exitoso y "Cobrar" en los pagos).
// El resto de los modales no se ven afectados.
let activeEnterHandler = null;
function setEnterConfirm(buttonId){
  clearEnterConfirm();
  activeEnterHandler = function(e){
    if (e.key === "Enter"){
      const btn = document.getElementById(buttonId);
      if (btn && !btn.disabled){
        e.preventDefault();
        btn.click();
      }
    }
  };
  document.addEventListener("keydown", activeEnterHandler);
}
function clearEnterConfirm(){
  if (activeEnterHandler){
    document.removeEventListener("keydown", activeEnterHandler);
    activeEnterHandler = null;
  }
}

function showModal(html){
  document.getElementById("modalBox").innerHTML = html;
  document.getElementById("modalOverlay").classList.remove("hidden");
}
function closeModal(){
  clearEnterConfirm();
  document.getElementById("modalOverlay").classList.add("hidden");
}
document.getElementById("modalOverlay").addEventListener("click", (e) => {
  if (e.target.id === "modalOverlay") closeModal();
});
function openConfirmModal(title, message, onConfirm, danger=false, labels={}, enterConfirms=false){
  const cancelLabel = labels.cancel || "Cancelar";
  const confirmLabel = labels.confirm || "Confirmar";
  showModal(`
    <h2>${title}</h2>
    <p class="muted">${message}</p>
    <div class="modal-actions">
      <button class="modal-cancel" id="confCancel">${cancelLabel}</button>
      <button class="modal-confirm ${danger?'danger':''}" id="confOk">${confirmLabel}</button>
    </div>
  `);
  document.getElementById("confCancel").addEventListener("click", closeModal);
  document.getElementById("confOk").addEventListener("click", () => { closeModal(); onConfirm(); });
  if (enterConfirms) setEnterConfirm("confOk");
}

// ---------- INICIO DE LA APP ----------
// Primero se carga lo que haya en este dispositivo (instantáneo, funciona
// sin internet). Si Firebase está disponible, se compara con lo que haya
// en la nube: si hay datos remotos se usan esos (por ejemplo, si este es
// un dispositivo nuevo o la nube tiene ventas más recientes que este
// dispositivo no vio todavía). Si la nube está vacía (primera vez que se
// usa Firebase), se sube lo que había localmente. A partir de ahí, un
// listener permanente mantiene todo sincronizado en segundo plano.
async function startApp(){
  loadLocalOrSeed();
  applyTheme();
  goToLanding();
  updateNewSaleLock();

  if (fbReady){
    try {
      // Límite de tiempo para la primera lectura: si se demora (por ejemplo,
      // en datos móviles), no se deja trabada la pantalla de arranque — se
      // sigue con lo que haya localmente y el listener en tiempo real (más
      // abajo) se encarga de traer lo que falte apenas pueda conectar.
      const snap = await Promise.race([
        fbRootRef.once("value"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Tiempo de espera agotado conectando con Firebase")), 8000))
      ]);
      const remote = snap.val();
      if (remote){
        // Antes de fusionar, la "última foto confirmada" se inicializa con lo
        // que trae Firebase (no con un objeto vacío): así, cualquier registro
        // local que coincida con uno remoto se trata como ya sincronizado, y
        // solo lo que sea distinto o exista nada más que localmente (por
        // ejemplo, algo creado sin conexión que nunca llegó a subirse) se
        // trata como pendiente de subir. Si se dejara vacío, cada registro
        // local parecería "pendiente" y ganaría siempre sobre lo remoto, aun
        // cuando lo remoto fuera más nuevo.
        lastSyncSnapshot = {
          products: remote.products || {},
          sales: remote.sales || {},
          pendingSales: remote.pendingSales || {},
          cashMovements: remote.cashMovements || {},
          cashClosures: remote.cashClosures || {},
          meta: remote.meta || null
        };
        applyRemoteSnapshot(remote);
        applyTheme();
        goToLanding();
        updateNewSaleLock();
      }
      setFbStatus("ok");
      if (!remote){
        // Primera vez que se conecta esta base de Firebase: sube los datos locales.
        pushStateToFirebase();
      }
    } catch (err){
      console.error("No se pudo completar la primera lectura de Firebase a tiempo; se sigue intentando en segundo plano (revisa las reglas de la base de datos en Firebase Console si esto persiste):", err);
      setFbStatus("error");
    }
    // IMPORTANTE: el listener en tiempo real se engancha siempre que haya
    // Firebase disponible, haya fallado o no la primera lectura de arriba.
    // Antes solo se enganchaba si esa primera lectura tenía éxito, y un
    // dispositivo que arrancaba con una conexión lenta o inestable se
    // quedaba sin recibir los cambios de los demás por el resto de la
    // sesión (por ejemplo, no se enteraba de un cierre/apertura de caja
    // hecho desde otro dispositivo) hasta recargar la página entera.
    appStarted = true;
    attachFirebaseListener();
  } else {
    appStarted = true;
    setFbStatus("error");
  }
}
startApp();
