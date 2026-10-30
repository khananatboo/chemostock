/* ============================ ตั้งค่า URL ของ Apps Script API ============================ */
// นำ URL เว็บแอปที่ได้จากการ Deploy Apps Script (ลงท้ายด้วย /exec) มาใส่ตรงนี้
const API_URL = 'https://script.google.com/macros/s/AKfycbzr4Ij0kx0IeeUQjQ7B_Edsd5JdUAih6YEQL7en6hmqoIvBG0OdVv7_iKX6-YeSYGvb/exec';

/* ============================ STATE & HELPERS ============================ */
let TOKEN = sessionStorage.getItem('token') || null;
let ROLE = null, FULLNAME = null;
let currentReceiveDrug = null;
let currentDispenseDrug = null;
let selectedLotIndex = 0;
let html5QrCode = null;
let scannerTargetId = null;

function gsRun(fnName, ...args) {
  return fetch(API_URL, {
    method: 'POST',
    // ใช้ text/plain เพื่อให้เบราว์เซอร์ไม่ส่ง CORS preflight (OPTIONS) ซึ่ง Apps Script ไม่รองรับ
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: fnName, args: args })
  })
    .catch(() => {
      throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ (ตรวจสอบอินเทอร์เน็ต หรือค่า API_URL ใน app.js ว่าเป็นลิงก์ /exec ที่ถูกต้อง)');
    })
    .then(res => res.text().then(text => ({ status: res.status, text })))
    .then(({ status, text }) => {
      const preview = text.replace(/\s+/g, ' ').slice(0, 200);
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error('เซิร์ฟเวอร์ตอบกลับไม่ใช่ JSON (HTTP ' + status + ') เนื้อหา: ' + preview);
      }
      if (data && data.success) return data.result;
      if (data && data.error === 'SESSION_EXPIRED') {
        // session หมดอายุ หรือถูกตัด (เช่นถูกระงับบัญชี/เปลี่ยนสิทธิ์/เปลี่ยนรหัสผ่าน) → กลับไปหน้าเข้าสู่ระบบ
        TOKEN = null;
        sessionStorage.removeItem('token');
        showLoginScreen();
        document.getElementById('error-msg').textContent = 'หมดเวลาการใช้งาน กรุณาเข้าสู่ระบบใหม่';
        throw new Error('กรุณาเข้าสู่ระบบใหม่');
      }
      if (data && data.error) throw new Error(data.error);
      throw new Error('คำตอบจากเซิร์ฟเวอร์ไม่อยู่ในรูปแบบที่คาดไว้: ' + preview);
    });
}

/* ---- กันกดปุ่มซ้ำระหว่างรอเซิร์ฟเวอร์ ---- */
const busyActions = {};
// action = ชื่อฟังก์ชันใน onclick ของปุ่ม (เช่น 'submitReceive'), fn ต้องคืน Promise
function runBusy(action, label, fn) {
  if (busyActions[action]) return Promise.resolve(); // กำลังบันทึกอยู่ กดซ้ำไม่ทำงาน
  busyActions[action] = true;
  const btns = Array.from(document.querySelectorAll('button[onclick^="' + action + '("]'));
  const oldText = btns.map(b => b.textContent);
  btns.forEach(b => { b.disabled = true; b.textContent = label; });
  return Promise.resolve().then(fn).catch(() => {}).finally(() => {
    busyActions[action] = false;
    btns.forEach((b, i) => { b.disabled = false; b.textContent = oldText[i]; });
  });
}

/* ---- ข้อมูลยาที่ใช้ร่วมกันทุกหน้า (โหลดครั้งเดียว แล้วอัปเดตเบื้องหลัง) ---- */
let DRUGS = [];             // ผลจาก getDrugList (Code.gs ใหม่จะมี lots ของแต่ละยามาด้วย)
let drugsLoaded = false;
let drugsInFlight = null;
let drugsRefreshAgain = false;
let drugsMutationSeq = 0;   // เพิ่มทุกครั้งที่แก้ข้อมูลในเครื่อง กันผลโหลดเก่ามาทับ

function refreshDrugs() {
  if (drugsInFlight) return drugsInFlight; // กำลังโหลดอยู่แล้ว ใช้ผลเดียวกัน
  const startSeq = drugsMutationSeq;
  drugsInFlight = gsRun('getDrugList', TOKEN).then(list => {
    if (startSeq === drugsMutationSeq) {
      DRUGS = list; drugsLoaded = true; onDrugsUpdated();
    } else {
      drugsRefreshAgain = true; // มีการบันทึกระหว่างโหลด → โหลดใหม่อีกรอบให้ได้ข้อมูลล่าสุด
    }
    return DRUGS;
  }).finally(() => {
    drugsInFlight = null;
    if (drugsRefreshAgain) { drugsRefreshAgain = false; refreshDrugs().catch(() => {}); }
  });
  return drugsInFlight;
}

function findDrug(code) { return DRUGS.find(d => String(d.drugCode) === String(code)); }

// คำนวณยอดคงเหลือ/วันหมดอายุใกล้สุดใหม่จาก lots (ใช้หลังอัปเดตข้อมูลในเครื่อง)
function recalcDrug(d) {
  if (!Array.isArray(d.lots)) return;
  d.lots = d.lots.filter(l => Number(l.qty) > 0).sort((a, b) => new Date(a.expiryDate) - new Date(b.expiryDate));
  d.currentStock = d.lots.reduce((s, l) => s + Number(l.qty), 0);
  d.nearestExpiry = d.lots.length && d.lots[0].expiryDate ? d.lots[0].expiryDate : null;
}

// ข้อมูลยาเปลี่ยน → วาดหน้าที่เปิดอยู่ใหม่
function onDrugsUpdated() {
  const active = (document.querySelector('.page.active') || {}).id;
  if (active === 'page-dashboard') renderDashboard();
  if (active === 'page-drugs') renderDrugList();
  if (active === 'page-reports') fillReportDrugs();
  ['receive', 'dispense'].forEach(k => {
    const box = document.getElementById(k + '-suggest');
    if (box && box.innerHTML) renderDrugSuggestions(k);
  });
}

function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { el.className = 'toast'; }, 3200);
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' }) + ' ' +
    d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

/* ============================== AUTH FLOW ============================== */

window.onload = function () {
  if (TOKEN) {
    refreshDrugs().catch(() => {}); // โหลดข้อมูลยาไปพร้อมกับตรวจ session (ไม่ต้องรอทีละขั้น)
    gsRun('checkSession', TOKEN).then(res => {
      if (res.valid) { onLoginSuccess(res.username, res.fullName, res.role, TOKEN); }
      else { sessionStorage.removeItem('token'); showLoginScreen(); }
    }).catch(() => showLoginScreen());
  } else {
    showLoginScreen();
  }
};

function showLoginScreen() {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

function doLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  document.getElementById('error-msg').textContent = '';
  if (!username || !password) { document.getElementById('error-msg').textContent = 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน'; return; }

  return runBusy('doLogin', 'กำลังเข้าสู่ระบบ...', () => gsRun('login', username, password).then(res => {
    if (res.success) {
      onLoginSuccess(res.username, res.fullName, res.role, res.token);
    } else {
      document.getElementById('error-msg').textContent = res.message;
    }
  }).catch(err => { document.getElementById('error-msg').textContent = 'เกิดข้อผิดพลาด: ' + err.message; }));
}

function onLoginSuccess(username, fullName, role, token) {
  TOKEN = token; ROLE = role; FULLNAME = fullName;
  sessionStorage.setItem('token', token);
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('hdr-name').textContent = fullName;
  document.getElementById('hdr-role').textContent = roleLabel(role);
  document.getElementById('btn-add-drug').classList.toggle('hidden', !(role === 'ADMIN' || role === 'PHARMACIST'));
  document.getElementById('admin-only-section').classList.toggle('hidden', role !== 'ADMIN');
  showPage('dashboard');
}

function roleLabel(role) {
  return {
    ADMIN: 'ผู้ดูแลระบบ',
    PHARMACIST: 'เภสัชกร',
    PHARMACY_TECH: 'เจ้าพนักงานเภสัชกรรม',
    STAFF: 'เจ้าหน้าที่'
  }[role] || role;
}

function canManageDrugs() { return ROLE === 'ADMIN' || ROLE === 'PHARMACIST'; }

function doLogout() {
  gsRun('logout', TOKEN).finally(() => {
    sessionStorage.removeItem('token');
    location.reload();
  });
}

/* ============================== NAVIGATION ============================== */

function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelectorAll('#bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.page === name));

  if (name === 'dashboard') loadDashboard();
  if (name === 'drugs') loadDrugList();
  if (name === 'reports') { loadReportDrugs(); loadTransactions(); }
  // หน้ารับเข้า/จ่ายออก: ใช้ข้อมูลยาที่มีอยู่ได้ทันที และอัปเดตเบื้องหลัง
  if (name === 'users') {
    if (ROLE === 'ADMIN') { loadUsers(); loadAlertEmailsField(); }
  }
  if (name === 'receive') resetReceiveForm();
  if (name === 'dispense') resetDispenseForm();
}

/* ============================== DASHBOARD ============================== */

// หมวดหมู่ตามลำดับที่แสดงบนหน้าหลัก
// key = ชื่อภาษาไทยก่อนวงเล็บ (ตรงกับตัวเลือกใน dropdown หมวดหมู่ของหน้ารายการยา)
const CATEGORY_GROUPS = [
  { key: 'ยาเคมีบำบัด', label: 'ยาเคมีบำบัด' },
  { key: 'ยามุ่งเป้า', label: 'ยามุ่งเป้า' },
  { key: 'ยาภูมิคุ้มกันบำบัด', label: 'ยาภูมิคุ้มกันบำบัด' },
  { key: 'ยาอื่นๆ', label: 'ยาอื่นๆ' },
  { key: 'สารน้ำ', label: 'สารน้ำ' },
  { key: 'เวชภัณฑ์มิใช่ยา', label: 'เวชภัณฑ์มิใช่ยา' }
];
const CATEGORY_NONE_LABEL = 'ไม่ระบุหมวดหมู่';
// กล่องตัวเลขจำนวนรายการยา แสดง 4 กลุ่มแรก
const COUNT_GROUP_KEYS = ['ยาเคมีบำบัด', 'ยามุ่งเป้า', 'ยาภูมิคุ้มกันบำบัด', 'ยาอื่นๆ'];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// แปลงค่าหมวดหมู่ในชีต (เช่น "ยาเคมีบำบัด (Chemotherapy)") เป็น key ภาษาไทยสั้นๆ
// ถ้าว่างหรือไม่รู้จัก จะคืนค่า '' (= ไม่ระบุหมวดหมู่)
function categoryKey(raw) {
  const k = String(raw || '').replace(/\s*\(.*$/, '').trim();
  return CATEGORY_GROUPS.some(g => g.key === k) ? k : '';
}

// จัดกลุ่มรายการตามหมวดหมู่ ตามลำดับใน CATEGORY_GROUPS (แสดงเฉพาะกลุ่มที่มีรายการ)
function groupByCategory(items) {
  const buckets = {};
  items.forEach(d => {
    const k = categoryKey(d.category);
    (buckets[k] = buckets[k] || []).push(d);
  });
  const groups = [];
  CATEGORY_GROUPS.forEach(g => {
    if (buckets[g.key]) groups.push({ label: g.label, items: buckets[g.key] });
  });
  if (buckets['']) groups.push({ label: CATEGORY_NONE_LABEL, items: buckets[''] });
  return groups;
}

function renderGroupedList(elId, items, emptyMsg, itemHtml) {
  const el = document.getElementById(elId);
  el.className = '';
  if (items.length === 0) {
    el.innerHTML = '<p class="muted">' + emptyMsg + '</p>';
    return;
  }
  el.innerHTML = groupByCategory(items).map((g, i) =>
    '<div class="section-title"' + (i === 0 ? ' style="margin-top:4px;"' : '') + '>' +
      esc(g.label) + ' (' + g.items.length + ')</div>' +
    g.items.map(itemHtml).join('')
  ).join('');
}

function renderCategoryCounts(counts) {
  const grid = document.getElementById('stat-grid');
  const byKey = {};
  Object.keys(counts).forEach(raw => {
    const k = categoryKey(raw);
    byKey[k] = (byKey[k] || 0) + counts[raw];
  });
  const boxes = COUNT_GROUP_KEYS.map(k => ({ label: k, num: byKey[k] || 0 }));
  if (byKey['']) boxes.push({ label: CATEGORY_NONE_LABEL, num: byKey[''] });
  grid.innerHTML = boxes.map(b =>
    '<div class="stat-box" style="flex:1 1 calc(50% - 10px);min-width:130px;">' +
      '<div class="num">' + b.num + '</div><div class="label">' + esc(b.label) + '</div></div>'
  ).join('');
}

// สรุปหน้าหลักจากข้อมูลยา (คำนวณแบบเดียวกับ getDashboardSummary ใน Code.gs)
function computeDashboard(drugs) {
  const now = Date.now();
  const cutoff30 = now + 30 * 24 * 60 * 60 * 1000;
  const cutoff6mo = now + 182 * 24 * 60 * 60 * 1000;
  const exp = d => new Date(d.nearestExpiry).getTime();
  const byExp = (a, b) => exp(a) - exp(b);
  const categoryCounts = {};
  drugs.forEach(d => { const k = d.category || ''; categoryCounts[k] = (categoryCounts[k] || 0) + 1; });
  return {
    categoryCounts,
    lowStock: drugs.filter(d => d.currentStock <= d.minStock),
    nearExpiry: drugs.filter(d => d.nearestExpiry && exp(d) <= cutoff30).sort(byExp),
    nearExpiry6Months: drugs.filter(d => d.nearestExpiry && exp(d) > cutoff30 && exp(d) <= cutoff6mo).sort(byExp)
  };
}

function renderDashboard() {
  if (!drugsLoaded) return;
  const sum = computeDashboard(DRUGS);
  renderCategoryCounts(sum.categoryCounts);
  renderGroupedList('low-stock-list', sum.lowStock, 'ไม่มีรายการสต็อกต่ำ',
    d => '<div class="alert-item danger">' + esc(d.drugName) + ': คงเหลือ <b>' + esc(d.currentStock) + '</b> ' +
      esc(d.unit || '') + ' (ขั้นต่ำ ' + esc(d.minStock) + ')</div>');
  const expiryItem = d => '<div class="alert-item">' + esc(d.drugName) + ': หมดอายุ <b>' + fmtDate(d.nearestExpiry) + '</b></div>';
  renderGroupedList('near-expiry-list', sum.nearExpiry, 'ไม่มียาใกล้หมดอายุ', expiryItem);
  renderGroupedList('near-expiry-6mo-list', sum.nearExpiry6Months, 'ไม่มียาใกล้หมดอายุในช่วงนี้', expiryItem);
}

function loadDashboard() {
  renderDashboard();                                       // แสดงข้อมูลที่มีอยู่ทันที (ถ้ามี)
  refreshDrugs().catch(err => toast(err.message, true));   // แล้วอัปเดตให้เป็นล่าสุด
}

/* ============================== SCANNER (กล้อง) ============================== */

async function openScanner(targetId) {
  if (typeof Html5Qrcode === 'undefined') {
    toast('ไม่พบไฟล์ html5-qrcode.min.js ในเว็บ — สแกนด้วยกล้องไม่ได้ (ใช้การพิมพ์หรือเครื่องอ่านบาร์โค้ดแทนได้)', true);
    return;
  }
  scannerTargetId = targetId;
  document.getElementById('scanner-modal').style.display = 'block';
  html5QrCode = new Html5Qrcode('reader');
  const formats = [
    Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39,
    Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
    Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E,
    Html5QrcodeSupportedFormats.ITF, Html5QrcodeSupportedFormats.QR_CODE
  ];
  const scanConfig = { fps: 10, qrbox: { width: 260, height: 160 }, formatsToSupport: formats };

  // ลองเปิดกล้องหลัง (environment) ก่อน
  try {
    await html5QrCode.start({ facingMode: 'environment' }, scanConfig, decodedText => onScanSuccess(decodedText));
    return;
  } catch (err1) {
    console.warn('เปิดกล้อง environment ไม่สำเร็จ:', err1);
  }

  // ถ้าไม่สำเร็จ ลองดึงรายชื่อกล้องทั้งหมดแล้วเลือกกล้องตัวสุดท้าย (มักเป็นกล้องหลัง) แทน
  try {
    const cameras = await Html5Qrcode.getCameras();
    if (!cameras || cameras.length === 0) {
      toast('ไม่พบกล้องในอุปกรณ์นี้', true);
      closeScanner();
      return;
    }
    const cameraId = cameras[cameras.length - 1].id;
    await html5QrCode.start(cameraId, scanConfig, decodedText => onScanSuccess(decodedText));
  } catch (err2) {
    const reason = (err2 && (err2.name || err2.message)) ? (err2.name || err2.message) : String(err2);
    toast('เปิดกล้องไม่สำเร็จ: ' + reason, true);
    closeScanner();
  }
}

function onScanSuccess(decodedText) {
  const cleaned = parseBarcodeValue(decodedText);
  document.getElementById(scannerTargetId).value = cleaned;
  closeScanner();
  if (scannerTargetId === 'receive-barcode') handleSearchEnter('receive');
  if (scannerTargetId === 'dispense-barcode') handleSearchEnter('dispense');
}

// รองรับกรณีบาร์โค้ด GS1-128 ที่มี Application Identifier (01=GTIN) นำหน้า — ตัดให้เหลือรหัสสำหรับค้นหา
function parseBarcodeValue(raw) {
  return raw.trim();
}

function closeScanner() {
  document.getElementById('scanner-modal').style.display = 'none';
  if (html5QrCode) {
    html5QrCode.stop().then(() => html5QrCode.clear()).catch(() => {});
    html5QrCode = null;
  }
}

/* ===================== ค้นหายาจากชื่อ (หน้ารับเข้า / จ่ายออก) ===================== */

const SUGGEST_MAX = 10;
let suggestMatches = { receive: [], dispense: [] };
const lookupSeq = { receive: 0, dispense: 0 };     // กันผลค้นหาเก่ามาทับเมื่อผู้ใช้พิมพ์ค้นใหม่
let pendingAddCode = '';                           // ข้อความที่ค้นแล้วไม่พบ (ใช้ตอนกด "เพิ่มยานี้เข้าระบบ")

function loadSearchDrugs() { refreshDrugs().catch(() => {}); }

function normalizeText(s) {
  return String(s == null ? '' : s).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ค้นจากชื่อยา: พิมพ์บางคำก็เจอ, พิมพ์หลายคำคั่นด้วยเว้นวรรคได้ (ต้องมีครบทุกคำ), ไม่สนตัวพิมพ์เล็ก/ใหญ่
function searchDrugsByName(query) {
  const tokens = normalizeText(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return [];
  const startsWithFirst = d => (normalizeText(d.drugName).startsWith(tokens[0]) ? 0 : 1);
  return DRUGS
    .filter(d => { const name = normalizeText(d.drugName); return tokens.every(t => name.includes(t)); })
    .sort((a, b) => startsWithFirst(a) - startsWithFirst(b)); // ชื่อที่ขึ้นต้นด้วยคำที่พิมพ์ มาก่อน
}

function onDrugSearchInput(kind) {
  // พิมพ์ค้นใหม่ → ล้างยาที่เลือกไว้เดิม ป้องกันบันทึกรับ/จ่ายผิดตัว
  if (kind === 'receive') clearReceiveSelection(); else clearDispenseSelection();
  renderDrugSuggestions(kind);
}

function renderDrugSuggestions(kind) {
  const box = document.getElementById(kind + '-suggest');
  const q = document.getElementById(kind + '-barcode').value;
  if (!normalizeText(q)) { suggestMatches[kind] = []; box.innerHTML = ''; return; }
  const hits = searchDrugsByName(q);
  suggestMatches[kind] = hits.slice(0, SUGGEST_MAX);
  if (hits.length === 0) {
    box.innerHTML = '<p class="muted">ไม่พบชื่อยาที่ตรงกัน — หากเป็นบาร์โค้ดหรือรหัสยา ให้กด Enter เพื่อค้นหา</p>';
    return;
  }
  box.innerHTML = suggestMatches[kind].map((d, i) => {
    const cat = categoryKey(d.category);
    return `<div class="lot-pick" onclick="pickDrugSuggestion('${kind}', ${i})">
      <span><b>${esc(d.drugName)}</b><br><span class="muted">รหัส ${esc(d.drugCode)}${cat ? ' · ' + esc(cat) : ''}</span></span>
      <span class="stock-pill ${d.currentStock <= d.minStock ? 'low' : 'ok'}">${esc(d.currentStock)} ${esc(d.unit || '')}</span>
    </div>`;
  }).join('') + (hits.length > SUGGEST_MAX
    ? `<p class="muted">แสดง ${SUGGEST_MAX} จาก ${hits.length} รายการ — พิมพ์เพิ่มเพื่อกรองให้แคบลง</p>` : '');
}

function pickDrugSuggestion(kind, i) {
  const d = suggestMatches[kind][i];
  if (d) selectDrug(kind, d);
}

function selectDrug(kind, d) {
  document.getElementById(kind + '-barcode').value = d.drugName;
  document.getElementById(kind + '-suggest').innerHTML = '';
  suggestMatches[kind] = [];
  // มีข้อมูลยาในเครื่องแล้ว → แสดงฟอร์มทันที ไม่ต้องรอเซิร์ฟเวอร์
  if (kind === 'receive') showReceiveDrug(d);
  else if (Array.isArray(d.lots)) showDispenseDrug(d);
  else lookupDispenseDrug(d.drugCode); // Code.gs เวอร์ชันเก่า (ไม่มีข้อมูล Lot) → ถามเซิร์ฟเวอร์
}

// กด Enter ในช่องค้นหา (รวมถึงเครื่องอ่านบาร์โค้ดที่ส่ง Enter ต่อท้าย)
function handleSearchEnter(kind) {
  const raw = document.getElementById(kind + '-barcode').value.trim();
  if (!raw) return;
  const q = normalizeText(raw);
  // 1) ตรงกับรหัสยา/บาร์โค้ดเป๊ะ (สแกน หรือพิมพ์รหัสครบ)
  const exact = DRUGS.find(d => normalizeText(d.drugCode) === q || (d.barcode && normalizeText(d.barcode) === q));
  if (exact) { selectDrug(kind, exact); return; }
  // 2) ค้นจากชื่อ: เหลือรายการเดียว หรือชื่อตรงเป๊ะรายการเดียว → เลือกให้เลย
  const hits = searchDrugsByName(raw);
  if (hits.length === 1) { selectDrug(kind, hits[0]); return; }
  const sameName = hits.filter(d => normalizeText(d.drugName) === q);
  if (sameName.length === 1) { selectDrug(kind, sameName[0]); return; }
  if (hits.length > 1) { toast('พบหลายรายการ กรุณาแตะเลือกยาจากรายการ', false); return; }
  // 3) ไม่พบในรายการที่โหลดไว้ → ให้เซิร์ฟเวอร์ค้นด้วยบาร์โค้ด/รหัสยา (เผื่อรายการยาเพิ่งถูกเพิ่ม)
  document.getElementById(kind + '-suggest').innerHTML = '';
  if (kind === 'receive') lookupReceiveDrug(); else lookupDispenseDrug();
}

/* ============================== รับเข้า ============================== */

function clearReceiveSelection() {
  lookupSeq.receive++;
  document.getElementById('receive-drug-info').innerHTML = '';
  document.getElementById('receive-form').classList.add('hidden');
  ['receive-lot', 'receive-expiry', 'receive-qty', 'receive-note'].forEach(id => { document.getElementById(id).value = ''; });
  currentReceiveDrug = null;
}

function resetReceiveForm() {
  document.getElementById('receive-barcode').value = '';
  document.getElementById('receive-suggest').innerHTML = '';
  suggestMatches.receive = [];
  clearReceiveSelection();
  loadSearchDrugs();
  setTimeout(() => document.getElementById('receive-barcode').focus(), 100);
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('receive-barcode').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); handleSearchEnter('receive'); }
  });
  document.getElementById('dispense-barcode').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); handleSearchEnter('dispense'); }
  });
  // จำว่าฟอร์มเพิ่ม/แก้ไขยามีข้อมูลที่ยังไม่ได้บันทึกหรือไม่ (ไว้เตือนก่อนปิด)
  const drugForm = document.getElementById('drug-form-card');
  ['input', 'change'].forEach(ev => drugForm.addEventListener(ev, () => { drugFormDirty = true; }));
});

function lookupReceiveDrug(codeOverride) {
  const code = (codeOverride != null ? String(codeOverride) : document.getElementById('receive-barcode').value).trim();
  if (!code) return;
  const seq = ++lookupSeq.receive;
  gsRun('getDrugByBarcode', TOKEN, code).then(res => {
    if (seq !== lookupSeq.receive) return; // ผู้ใช้พิมพ์ค้นใหม่แล้ว ทิ้งผลเก่า
    const infoEl = document.getElementById('receive-drug-info');
    if (res.found) {
      showReceiveDrug(res);
    } else {
      currentReceiveDrug = null;
      pendingAddCode = res.scannedCode;
      document.getElementById('receive-form').classList.add('hidden');
      infoEl.innerHTML = `<div class="alert-item danger">ไม่พบยา "${esc(res.scannedCode)}" ในระบบ
        ${canManageDrugs() ? `<br><button class="btn-small btn-primary" style="margin-top:6px;" onclick="goAddDrugFromCode()">+ เพิ่มยานี้เข้าระบบ</button>` : ''}</div>`;
    }
  }).catch(err => toast(err.message, true));
}

function showReceiveDrug(d) {
  currentReceiveDrug = d;
  document.getElementById('receive-drug-info').innerHTML =
    `<div class="drug-info-box"><span class="name">${esc(d.drugName)}</span><br>รหัส: ${esc(d.drugCode)} · หน่วย: ${esc(d.unit || '-')}</div>`;
  document.getElementById('receive-form').classList.remove('hidden');
  document.getElementById('receive-lot').focus();
}

// ข้อความที่ค้นแล้วไม่พบ: ถ้าหน้าตาเป็นบาร์โค้ด (มีตัวเลข ไม่มีเว้นวรรค) ใส่ช่องบาร์โค้ด ไม่งั้นใส่ช่องชื่อยา
function looksLikeBarcode(text) { return /^(?=.*\d)[A-Za-z0-9\-_.\/]{4,}$/.test(text); }

function goAddDrugFromCode() {
  const text = pendingAddCode;
  showPage('drugs');
  openDrugForm();
  document.getElementById(looksLikeBarcode(text) ? 'drug-barcode' : 'drug-name').value = text;
}

function submitReceive() {
  if (!currentReceiveDrug) { toast('กรุณาสแกน/ค้นหายาก่อน', true); return; }
  const payload = {
    drugCode: currentReceiveDrug.drugCode,
    lotNumber: document.getElementById('receive-lot').value.trim(),
    expiryDate: document.getElementById('receive-expiry').value,
    qty: document.getElementById('receive-qty').value,
    note: document.getElementById('receive-note').value.trim()
  };
  return runBusy('submitReceive', 'กำลังบันทึก...', () => gsRun('receiveStock', TOKEN, payload).then(res => {
    toast(res.message, false);
    applyReceiveLocally(payload);
    resetReceiveForm();
  }).catch(err => toast(err.message, true)));
}

// อัปเดตยอดในเครื่องทันทีหลังรับเข้าสำเร็จ (แล้วค่อยโหลดข้อมูลจริงเบื้องหลัง)
function applyReceiveLocally(p) {
  drugsMutationSeq++;
  const d = findDrug(p.drugCode);
  if (d && Array.isArray(d.lots)) {
    const lot = d.lots.find(l => String(l.lotNumber).trim() === p.lotNumber);
    if (lot) lot.qty = Number(lot.qty) + Number(p.qty);
    else d.lots.push({ lotNumber: p.lotNumber, expiryDate: new Date(p.expiryDate).toISOString(), qty: Number(p.qty) });
    recalcDrug(d);
  }
}

/* ============================== จ่ายออก ============================== */

function clearDispenseSelection() {
  lookupSeq.dispense++;
  document.getElementById('dispense-drug-info').innerHTML = '';
  document.getElementById('dispense-form').classList.add('hidden');
  document.getElementById('dispense-lot-list').innerHTML = '';
  ['dispense-qty', 'dispense-patient', 'dispense-note'].forEach(id => { document.getElementById(id).value = ''; });
  currentDispenseDrug = null;
  selectedLotIndex = 0;
}

function resetDispenseForm() {
  document.getElementById('dispense-barcode').value = '';
  document.getElementById('dispense-suggest').innerHTML = '';
  suggestMatches.dispense = [];
  clearDispenseSelection();
  loadSearchDrugs();
  setTimeout(() => document.getElementById('dispense-barcode').focus(), 100);
}

function lookupDispenseDrug(codeOverride) {
  const code = (codeOverride != null ? String(codeOverride) : document.getElementById('dispense-barcode').value).trim();
  if (!code) return;
  const seq = ++lookupSeq.dispense;
  gsRun('getDrugByBarcode', TOKEN, code).then(res => {
    if (seq !== lookupSeq.dispense) return; // ผู้ใช้พิมพ์ค้นใหม่แล้ว ทิ้งผลเก่า
    const infoEl = document.getElementById('dispense-drug-info');
    if (!res.found) {
      currentDispenseDrug = null;
      document.getElementById('dispense-form').classList.add('hidden');
      infoEl.innerHTML = `<div class="alert-item danger">ไม่พบยา "${esc(res.scannedCode)}" ในระบบ</div>`;
      return;
    }
    showDispenseDrug(res);
  }).catch(err => toast(err.message, true));
}

function showDispenseDrug(d) {
  const infoEl = document.getElementById('dispense-drug-info');
  const lots = (d.lots || []).filter(l => Number(l.qty) > 0);
  if (lots.length === 0) {
    currentDispenseDrug = null;
    document.getElementById('dispense-form').classList.add('hidden');
    infoEl.innerHTML = `<div class="drug-info-box"><span class="name">${esc(d.drugName)}</span></div><div class="alert-item danger">ไม่มีสต็อกคงเหลือของยานี้</div>`;
    return;
  }
  currentDispenseDrug = Object.assign({}, d, { lots: lots });
  selectedLotIndex = 0;
  infoEl.innerHTML = `<div class="drug-info-box"><span class="name">${esc(d.drugName)}</span><br>รหัส: ${esc(d.drugCode)} · หน่วย: ${esc(d.unit || '-')}</div>`;
  renderLotPicker();
  document.getElementById('dispense-form').classList.remove('hidden');
  document.getElementById('dispense-qty').focus();
}

function renderLotPicker() {
  const el = document.getElementById('dispense-lot-list');
  el.innerHTML = currentDispenseDrug.lots.map((l, i) => `
    <div class="lot-pick ${i === selectedLotIndex ? 'selected' : ''}" onclick="selectLot(${i})">
      <span>Lot ${esc(l.lotNumber)}</span>
      <span>คงเหลือ ${esc(l.qty)} · หมดอายุ ${fmtDate(l.expiryDate)}</span>
    </div>`).join('');
}

function selectLot(i) { selectedLotIndex = i; renderLotPicker(); }

function submitDispense() {
  if (!currentDispenseDrug) { toast('กรุณาสแกน/ค้นหายาก่อน', true); return; }
  const lot = currentDispenseDrug.lots[selectedLotIndex];
  const payload = {
    drugCode: currentDispenseDrug.drugCode,
    lotNumber: lot.lotNumber,
    qty: document.getElementById('dispense-qty').value,
    patientRef: document.getElementById('dispense-patient').value.trim(),
    note: document.getElementById('dispense-note').value.trim()
  };
  return runBusy('submitDispense', 'กำลังบันทึก...', () => gsRun('dispenseStock', TOKEN, payload).then(res => {
    toast(res.message, false);
    applyDispenseLocally(payload.drugCode, res.usedLots || []);
    resetDispenseForm();
  }).catch(err => {
    toast(err.message, true);
    refreshDrugs().catch(() => {}); // เช่น สต็อกไม่พอเพราะเครื่องอื่นเพิ่งจ่ายไป → ดึงยอดล่าสุด
  }));
}

function applyDispenseLocally(drugCode, usedLots) {
  drugsMutationSeq++;
  const d = findDrug(drugCode);
  if (d && Array.isArray(d.lots)) {
    usedLots.forEach(u => {
      const lot = d.lots.find(l => String(l.lotNumber).trim() === String(u.lotNumber).trim());
      if (lot) lot.qty = Number(lot.qty) - Number(u.qty);
    });
    recalcDrug(d);
  }
}

/* ============================== รายการยา ============================== */

function loadDrugList() {
  if (drugsLoaded) renderDrugList();                       // แสดงทันที
  refreshDrugs().catch(err => toast(err.message, true));   // แล้วอัปเดตเบื้องหลัง
}

function renderDrugList() {
  const filter = document.getElementById('drug-category-filter').value;
  const drugs = filter ? DRUGS.filter(d => d.category === filter) : DRUGS;
  const el = document.getElementById('drug-list');
  const emptyMsg = filter ? 'ไม่มีรายการยาในหมวดนี้' : 'ยังไม่มีรายการยา';
  el.innerHTML = drugs.length === 0 ? `<p class="muted">${emptyMsg}</p>` : drugs.map(d => {
    const i = DRUGS.indexOf(d);
    return `
      <div class="drug-list-item" ${canManageDrugs() ? `onclick="openDrugForm(${i})" style="cursor:pointer;"` : ''}>
        <div>
          <div><b>${esc(d.drugName)}</b></div>
          <div class="meta">รหัส ${esc(d.drugCode)} ${d.barcode ? '· บาร์โค้ด ' + esc(d.barcode) : ''}${d.category ? '<br>' + esc(d.category) : ''}</div>
        </div>
        <div class="stock-pill ${d.currentStock <= d.minStock ? 'low' : 'ok'}">${esc(d.currentStock)} ${esc(d.unit || '')}</div>
      </div>`;
  }).join('');
}

let drugFormDirty = false; // มีข้อมูลในฟอร์มที่ยังไม่ได้บันทึก

// ถ้ามีข้อมูลที่ยังไม่ได้บันทึกค้างอยู่ ให้ถามก่อนทิ้ง (คืน true = ทำต่อได้)
function confirmDiscardDrugForm() {
  const isOpen = !document.getElementById('drug-form-card').classList.contains('hidden');
  if (isOpen && drugFormDirty) {
    return confirm('ยังมีข้อมูลที่ยังไม่ได้บันทึก ต้องการทิ้งข้อมูลนี้หรือไม่?');
  }
  return true;
}

function openDrugForm(index) {
  if (!confirmDiscardDrugForm()) return;
  document.getElementById('drug-form-card').classList.remove('hidden');
  const codeInput = document.getElementById('drug-code');
  if (typeof index === 'number') {
    const d = DRUGS[index];
    document.getElementById('drug-form-title').textContent = 'แก้ไขข้อมูลยา';
    codeInput.value = d.drugCode; codeInput.disabled = true;
    document.getElementById('drug-barcode').value = d.barcode || '';
    document.getElementById('drug-name').value = d.drugName;
    document.getElementById('drug-unit').value = d.unit || '';
    document.getElementById('drug-min').value = d.minStock;
    document.getElementById('drug-category').value = d.category || '';
  } else {
    document.getElementById('drug-form-title').textContent = 'เพิ่มยาใหม่';
    ['drug-code', 'drug-barcode', 'drug-name', 'drug-unit', 'drug-min', 'drug-category'].forEach(id => document.getElementById(id).value = '');
    codeInput.disabled = false;
  }
  drugFormDirty = false;
  window.scrollTo({ top: 0, behavior: 'smooth' }); // ฟอร์มอยู่ด้านบนสุดของหน้า
}

// ปุ่ม "เสร็จสิ้น": ปิดฟอร์ม (ถ้ายังมีข้อมูลที่ไม่ได้บันทึกจะถามก่อน)
function closeDrugForm() {
  if (!confirmDiscardDrugForm()) return;
  drugFormDirty = false;
  document.getElementById('drug-form-card').classList.add('hidden');
}

function submitDrug() {
  const isEdit = document.getElementById('drug-code').disabled; // โหมดแก้ไข: ช่องรหัสยาถูกล็อก
  const payload = {
    drugCode: document.getElementById('drug-code').value.trim(),
    barcode: document.getElementById('drug-barcode').value.trim(),
    drugName: document.getElementById('drug-name').value.trim(),
    unit: document.getElementById('drug-unit').value.trim(),
    minStock: document.getElementById('drug-min').value,
    category: document.getElementById('drug-category').value.trim()
  };
  return runBusy('submitDrug', 'กำลังบันทึก...', () => gsRun('saveDrug', TOKEN, payload).then(res => {
    toast(res.message + ' — ' + payload.drugName, false);
    applyDrugLocally(payload);
    renderDrugList();
    refreshDrugs().catch(() => {});
    drugFormDirty = false;
    if (!isEdit) {
      // ฟอร์มยังเปิดอยู่ ล้างช่องเพื่อเพิ่มยาตัวถัดไป (กด "เสร็จสิ้น" เมื่อเพิ่มครบแล้ว)
      openDrugForm();
      document.getElementById('drug-code').focus();
    }
  }).catch(err => toast(err.message, true)));
}

function applyDrugLocally(p) {
  drugsMutationSeq++;
  const d = findDrug(p.drugCode);
  const fields = { barcode: p.barcode, drugName: p.drugName, unit: p.unit, minStock: Number(p.minStock) || 0, category: p.category };
  if (d) Object.assign(d, fields);
  else {
    DRUGS.push(Object.assign({ drugCode: p.drugCode, currentStock: 0, nearestExpiry: null, lots: [] }, fields));
    DRUGS.sort((a, b) => String(a.drugName).localeCompare(String(b.drugName), 'th'));
  }
}

/* ============================== รายงาน ============================== */

const REPORT_LIMIT = 500; // ต้องตรงกับจำนวนสูงสุดที่ getTransactions ใน Code.gs ส่งกลับ
let reportDrugMap = {};   // drugCode -> ข้อมูลยา (ใช้แสดงหน่วยในสรุป)
let reportReqSeq = 0;     // กันผลลัพธ์เก่าทับผลลัพธ์ใหม่เมื่อเปลี่ยนตัวกรองเร็วๆ

// เติมรายชื่อยาใน dropdown (จัดกลุ่มตามหมวดหมู่) โดยคงค่าที่เลือกไว้เดิม
function loadReportDrugs() {
  if (drugsLoaded) fillReportDrugs();
  refreshDrugs().catch(err => toast(err.message, true));
}

let reportDrugOptionsKey = '';
function fillReportDrugs() {
  reportDrugMap = {};
  DRUGS.forEach(d => { reportDrugMap[d.drugCode] = d; });
  const key = DRUGS.map(d => d.drugCode + ':' + d.drugName + ':' + d.category).join('|');
  if (key === reportDrugOptionsKey) return; // รายชื่อยาไม่เปลี่ยน ไม่ต้องสร้าง dropdown ใหม่
  reportDrugOptionsKey = key;
  const sel = document.getElementById('report-drug');
  const current = sel.value;
  sel.innerHTML = '<option value="">ยาทั้งหมด</option>' +
    groupByCategory(DRUGS).map(g =>
      '<optgroup label="' + esc(g.label) + '">' +
      g.items.map(d => '<option value="' + esc(d.drugCode) + '">' + esc(d.drugName) + ' (' + esc(d.drugCode) + ')</option>').join('') +
      '</optgroup>'
    ).join('');
  sel.value = reportDrugMap[current] ? current : '';
}

// คำนวณช่วงเวลาที่เลือก (ตามเวลาท้องถิ่นของผู้ใช้) — null = ไม่จำกัด
function getReportRange() {
  const period = document.getElementById('report-period').value;
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  let from = null, to = null;
  if (period === 'today') from = new Date(y, m, d);
  else if (period === '7d') from = new Date(y, m, d - 6);
  else if (period === '30d') from = new Date(y, m, d - 29);
  else if (period === 'month') from = new Date(y, m, 1);
  else if (period === 'day') {
    const v = document.getElementById('report-day').value;
    if (v) { from = new Date(v + 'T00:00:00'); to = new Date(v + 'T23:59:59.999'); }
  }
  else if (period === 'custom') {
    const f = document.getElementById('report-from').value;
    const t = document.getElementById('report-to').value;
    if (f) from = new Date(f + 'T00:00:00');
    if (t) to = new Date(t + 'T23:59:59.999');
  }
  return { from, to };
}

function onReportPeriodChange() {
  const period = document.getElementById('report-period').value;
  const isCustom = period === 'custom';
  document.getElementById('report-custom-range').classList.toggle('hidden', !isCustom);
  document.getElementById('report-day-wrap').classList.toggle('hidden', period !== 'day');
  if (period === 'day' && !document.getElementById('report-day').value) {
    document.getElementById('report-day').value = toDateInputValue(new Date()); // ค่าเริ่มต้น = วันนี้
  }
  const hasDates = document.getElementById('report-from').value || document.getElementById('report-to').value;
  // เลือก "กำหนดเอง" ครั้งแรกให้รอผู้ใช้เลือกวันที่ก่อนค่อยโหลด
  if (!isCustom || hasDates) loadTransactions();
}

function resetReportFilters() {
  document.getElementById('report-drug').value = '';
  document.getElementById('report-filter').value = '';
  document.getElementById('report-period').value = 'all';
  document.getElementById('report-from').value = '';
  document.getElementById('report-to').value = '';
  document.getElementById('report-custom-range').classList.add('hidden');
  document.getElementById('report-day').value = '';
  document.getElementById('report-day-wrap').classList.add('hidden');
  loadTransactions();
}

function renderReportSummary(rows, drugCode) {
  const el = document.getElementById('report-summary');
  if (rows.length >= REPORT_LIMIT) {
    el.textContent = 'แสดง ' + REPORT_LIMIT + ' รายการล่าสุด (อาจมีรายการเก่ากว่านี้อีก) — กรุณาจำกัดช่วงเวลาหรือเลือกยาเพื่อดูให้ครบ';
    return;
  }
  let text = 'พบ ' + rows.length + ' รายการ';
  if (drugCode && rows.length > 0) {
    // รวมจำนวนเฉพาะเมื่อเลือกยาชนิดเดียว (หน่วยเดียวกัน) และข้อมูลไม่ถูกตัด
    const sum = { RECEIVE: 0, DISPENSE: 0 };
    rows.forEach(r => { sum[r.type] = (sum[r.type] || 0) + Number(r.qty || 0); });
    const unit = (reportDrugMap[drugCode] && reportDrugMap[drugCode].unit) || '';
    text += ' · รับเข้ารวม ' + sum.RECEIVE + ' ' + unit + ' · จ่ายออกรวม ' + sum.DISPENSE + ' ' + unit;
  }
  el.textContent = text;
}

function loadTransactions() {
  const drugCode = document.getElementById('report-drug').value;
  const type = document.getElementById('report-filter').value;
  const { from, to } = getReportRange();
  if (from && to && from > to) { toast('วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด', true); return; }

  const filters = { type, drugCode };
  if (from) filters.dateFrom = from.toISOString();
  if (to) filters.dateTo = to.toISOString();

  const seq = ++reportReqSeq;
  const el = document.getElementById('tx-list');
  document.getElementById('report-summary').textContent = '';
  el.className = 'loading';
  el.innerHTML = 'กำลังโหลด...';

  gsRun('getTransactions', TOKEN, filters).then(rows => {
    if (seq !== reportReqSeq) return; // มีการเปลี่ยนตัวกรองใหม่แล้ว ทิ้งผลเก่า
    el.className = '';
    renderReportSummary(rows, drugCode);
    if (rows.length === 0) { el.innerHTML = '<p class="muted">ไม่พบรายการตามเงื่อนไขที่เลือก</p>'; return; }
    el.innerHTML = `<table><thead><tr><th>วันที่</th><th>ประเภท</th><th>ยา</th><th>Lot</th><th>จำนวน</th><th>โดย</th></tr></thead><tbody>` +
      rows.map(r => `<tr>
        <td>${fmtDateTime(r.timestamp)}</td>
        <td><span class="tag ${r.type === 'RECEIVE' ? 'receive' : 'dispense'}">${r.type === 'RECEIVE' ? 'รับเข้า' : 'จ่ายออก'}</span></td>
        <td>${esc(r.drugName)}</td>
        <td>${esc(r.lotNumber)}</td>
        <td>${esc(r.qty)}</td>
        <td>${esc(r.user)}</td>
      </tr>`).join('') + `</tbody></table>`;
  }).catch(err => {
    if (seq !== reportReqSeq) return;
    el.className = '';
    el.innerHTML = '';
    toast(err.message, true);
  });
}

/* ============================== พิมพ์รายงาน A4 ============================== */

const pad2 = n => (n < 10 ? '0' : '') + n;
function toDateInputValue(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
// วันที่แบบ DD/MM/YYYY (พ.ศ.)
function fmtThaiDate(v) { const d = new Date(v); return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + (d.getFullYear() + 543); }
function fmtTime(v) { const d = new Date(v); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

// ใส่เนื้อหาลงพื้นที่พิมพ์แล้วเปิดหน้าต่างพิมพ์ (ตั้งชื่อเอกสาร = ชื่อไฟล์เมื่อบันทึกเป็น PDF)
function printHtml(html, docTitle) {
  document.getElementById('print-area').innerHTML = html;
  const oldTitle = document.title;
  document.title = docTitle;
  window.addEventListener('afterprint', () => { document.title = oldTitle; }, { once: true });
  setTimeout(() => window.print(), 50);
}

function printedByLine() {
  const now = new Date();
  return 'พิมพ์โดย: ' + esc(FULLNAME || '-') + ' · ' + fmtThaiDate(now) + ' ' + fmtTime(now) + ' น.';
}

const SIGN_BLOCK = '<div class="pr-sign"><div>ลงชื่อ ................................................ ผู้จัดทำ<br><br>(................................................)</div>' +
  '<div>ลงชื่อ ................................................ ผู้ตรวจสอบ<br><br>(................................................)</div></div>';

/* ---------- 1) สรุปรายการยา (หน้ารายการยา) ---------- */

const PRINT_DRUG_GROUPS = {
  all: { label: 'ทุกหมวดหมู่', keys: null },
  drugs: { label: 'หมวดยา (ยาเคมีบำบัด, ยามุ่งเป้า, ยาภูมิคุ้มกันบำบัด, ยาอื่นๆ)', keys: ['ยาเคมีบำบัด', 'ยามุ่งเป้า', 'ยาภูมิคุ้มกันบำบัด', 'ยาอื่นๆ'] },
  fluids: { label: 'สารน้ำ', keys: ['สารน้ำ'] },
  supplies: { label: 'เวชภัณฑ์มิใช่ยา', keys: ['เวชภัณฑ์มิใช่ยา'] }
};

// หมายเหตุอัตโนมัติ: หมด / หมดอายุแล้ว / ใกล้หมดอายุ / สต็อกต่ำ (ช่องนี้ยังเขียนเพิ่มด้วยมือได้)
function stockNote(drug, lot, isFirstRow) {
  const notes = [];
  if (!lot) notes.push('ไม่มีคงเหลือ');
  else if (lot.expiryDate) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.floor((new Date(lot.expiryDate) - today) / 86400000);
    if (days < 0) notes.push('หมดอายุแล้ว');
    else if (days <= 30) notes.push('ใกล้หมดอายุ (≤ 30 วัน)');
  }
  const total = drug.lots.reduce((s, l) => s + Number(l.qty || 0), 0);
  if (isFirstRow && lot && total <= drug.minStock) notes.push('ต่ำกว่าขั้นต่ำ (' + drug.minStock + ')');
  return notes.join(', ');
}

function buildDrugSummaryHtml(drugs, groupKey, printedAt) {
  const g = PRINT_DRUG_GROUPS[groupKey] || PRINT_DRUG_GROUPS.all;
  const list = g.keys ? drugs.filter(d => g.keys.indexOf(categoryKey(d.category)) >= 0) : drugs;
  let no = 0;
  const body = groupByCategory(list).map(gr =>
    `<tr class="pr-group"><td colspan="6">${esc(gr.label)} (${gr.items.length} รายการ)</td></tr>` +
    gr.items.map(d => {
      no++;
      const lots = d.lots.length ? d.lots : [null];
      return lots.map((l, i) => '<tr>' +
        (i === 0 ? `<td class="c" rowspan="${lots.length}">${no}</td><td rowspan="${lots.length}">${esc(d.drugName)}</td>` : '') +
        `<td>${l ? esc(l.lotNumber) : '-'}</td>` +
        `<td class="c">${l && l.expiryDate ? fmtThaiDate(l.expiryDate) : '-'}</td>` +
        `<td class="r">${l ? esc(l.qty) : 0} ${esc(d.unit || '')}</td>` +
        `<td>${esc(stockNote(d, l, i === 0))}</td></tr>`).join('');
    }).join('')
  ).join('');
  return {
    count: list.length,
    html: `<div class="print-doc">
      <h1>สรุปรายการยาวันที่ ${fmtThaiDate(printedAt)}</h1>
      <div class="pr-meta"><span>หมวดหมู่: ${esc(g.label)} · ${list.length} รายการ</span><span>${printedByLine()}</span></div>
      <table><thead><tr>
        <th style="width:7%">ลำดับ</th><th>รายการ</th><th style="width:15%">Lot</th>
        <th style="width:13%">วันหมดอายุ</th><th style="width:14%">จำนวนคงเหลือ</th><th style="width:20%">หมายเหตุ</th>
      </tr></thead><tbody>${body}</tbody></table>
      ${SIGN_BLOCK}
    </div>`
  };
}

function printDrugSummary() {
  const groupKey = document.getElementById('print-drug-group').value;
  toast('กำลังเตรียมรายงาน...', false);
  return runBusy('printDrugSummary', 'กำลังเตรียม...', () => gsRun('getStockReport', TOKEN).then(drugs => {
    const now = new Date();
    const doc = buildDrugSummaryHtml(drugs, groupKey, now);
    if (doc.count === 0) { toast('ไม่มีรายการยาในหมวดที่เลือก', true); return; }
    printHtml(doc.html, 'สรุปรายการยา_' + fmtThaiDate(now).replace(/\//g, '-'));
  }).catch(err => toast(err.message, true)));
}

/* ---------- 2) รายงานรับเข้า/จ่ายออก (หน้ารายงาน) ---------- */

const PRINT_TX_LIMIT = 5000;

function periodLabel(from, to) {
  if (!from && !to) return 'ทั้งหมด';
  const f = from ? fmtThaiDate(from) : null;
  const t = fmtThaiDate(to || new Date());
  if (f && f === t) return 'วันที่ ' + f;
  return f ? 'ตั้งแต่วันที่ ' + f + ' ถึง ' + t : 'จนถึงวันที่ ' + t;
}

function buildTransactionsHtml(rowsNewestFirst, opts) {
  const rows = rowsNewestFirst.slice().reverse(); // เรียงจากเก่าไปใหม่
  const unitOf = code => (reportDrugMap[code] && reportDrugMap[code].unit) || '';
  const title = { '': 'รายงานการรับเข้า–จ่ายออกยา', RECEIVE: 'รายงานการรับยาเข้าสต็อก', DISPENSE: 'รายงานการจ่ายยาออก' }[opts.type || ''];

  const detail = rows.map((r, i) => {
    const note = [r.patientRef ? 'HN ' + r.patientRef : '', r.note || ''].filter(Boolean).join(' · ');
    return `<tr><td class="c">${i + 1}</td><td class="c">${fmtThaiDate(r.timestamp)}<br>${fmtTime(r.timestamp)}</td>
      <td class="c">${r.type === 'RECEIVE' ? 'รับเข้า' : 'จ่ายออก'}</td><td>${esc(r.drugName)}</td><td>${esc(r.lotNumber)}</td>
      <td class="c">${r.expiryDate ? fmtThaiDate(r.expiryDate) : '-'}</td><td class="r">${esc(r.qty)} ${esc(unitOf(r.drugCode))}</td>
      <td>${esc(r.user)}</td><td>${esc(note)}</td></tr>`;
  }).join('');

  // สรุปรวมตามรายการยา
  const byDrug = {};
  rows.forEach(r => {
    const k = String(r.drugCode);
    const b = byDrug[k] = byDrug[k] || { name: r.drugName, unit: unitOf(r.drugCode), RECEIVE: 0, DISPENSE: 0 };
    b[r.type] = (b[r.type] || 0) + Number(r.qty || 0);
  });
  const sumRows = Object.keys(byDrug).map(k => byDrug[k])
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'th'))
    .map((b, i) => `<tr><td class="c">${i + 1}</td><td>${esc(b.name)}</td>
      ${opts.type !== 'DISPENSE' ? `<td class="r">${b.RECEIVE} ${esc(b.unit)}</td>` : ''}
      ${opts.type !== 'RECEIVE' ? `<td class="r">${b.DISPENSE} ${esc(b.unit)}</td>` : ''}</tr>`).join('');

  return `<div class="print-doc">
    <h1>${title}</h1>
    <div class="pr-sub">${esc(periodLabel(opts.from, opts.to))}</div>
    <div class="pr-meta"><span>ยา: ${esc(opts.drugLabel)} · ${rows.length} รายการ</span><span>${printedByLine()}</span></div>
    ${opts.truncated ? `<div class="pr-note">* แสดง ${PRINT_TX_LIMIT} รายการล่าสุดเท่านั้น กรุณาเลือกช่วงวันที่ให้แคบลงเพื่อให้ได้รายงานครบ</div>` : ''}
    <table><thead><tr>
      <th style="width:6%">ลำดับ</th><th style="width:11%">วันที่/เวลา</th><th style="width:8%">ประเภท</th><th>รายการ</th>
      <th style="width:11%">Lot</th><th style="width:11%">วันหมดอายุ</th><th style="width:10%">จำนวน</th>
      <th style="width:12%">ผู้บันทึก</th><th style="width:13%">หมายเหตุ</th>
    </tr></thead><tbody>${detail}</tbody></table>
    <h2>สรุปรวมตามรายการยา</h2>
    <table><thead><tr><th style="width:8%">ลำดับ</th><th>รายการ</th>
      ${opts.type !== 'DISPENSE' ? '<th style="width:20%">รับเข้ารวม</th>' : ''}
      ${opts.type !== 'RECEIVE' ? '<th style="width:20%">จ่ายออกรวม</th>' : ''}
    </tr></thead><tbody>${sumRows}</tbody></table>
    ${SIGN_BLOCK}
  </div>`;
}

function printTransactions() {
  const drugCode = document.getElementById('report-drug').value;
  const type = document.getElementById('report-filter').value;
  const { from, to } = getReportRange();
  if (from && to && from > to) { toast('วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด', true); return; }
  const filters = { type, drugCode, limit: PRINT_TX_LIMIT };
  if (from) filters.dateFrom = from.toISOString();
  if (to) filters.dateTo = to.toISOString();
  toast('กำลังเตรียมรายงาน...', false);
  return runBusy('printTransactions', 'กำลังเตรียมรายงาน...', () => gsRun('getTransactions', TOKEN, filters).then(rows => {
    if (rows.length === 0) { toast('ไม่พบรายการตามเงื่อนไขที่เลือก', true); return; }
    const drugLabel = drugCode ? ((reportDrugMap[drugCode] && reportDrugMap[drugCode].drugName) || drugCode) : 'ยาทั้งหมด';
    const html = buildTransactionsHtml(rows, { type, from, to, drugLabel, truncated: rows.length >= PRINT_TX_LIMIT });
    printHtml(html, 'รายงานรับเข้า-จ่ายออก_' + periodLabel(from, to).replace(/\//g, '-').replace(/\s+/g, '_'));
  }).catch(err => toast(err.message, true)));
}

/* ============================== ผู้ใช้งาน (admin) ============================== */

let userCache = [];

function loadUsers() {
  gsRun('getUsers', TOKEN).then(users => {
    userCache = users;
    const el = document.getElementById('user-list');
    el.innerHTML = users.map((u, i) => `
      <div class="drug-list-item" onclick="openUserForm(${i})" style="cursor:pointer;">
        <div><b>${esc(u.fullName)}</b><div class="meta">${esc(u.username)} · ${esc(roleLabel(u.role))}</div></div>
        <div class="stock-pill ${u.active && !u.locked ? 'ok' : 'low'}">${!u.active ? 'ระงับ' : (u.locked ? 'ล็อกชั่วคราว' : 'ใช้งาน')}</div>
      </div>`).join('');
  }).catch(err => toast(err.message, true));
}

function openUserForm(index) {
  document.getElementById('user-form-card').classList.remove('hidden');
  const unameInput = document.getElementById('user-username');
  if (typeof index === 'number') {
    const u = userCache[index];
    document.getElementById('user-form-title').textContent = 'แก้ไขผู้ใช้';
    unameInput.value = u.username; unameInput.disabled = true;
    document.getElementById('user-fullname').value = u.fullName;
    document.getElementById('user-role').value = u.role;
    document.getElementById('user-password').value = '';
    document.getElementById('user-active').checked = u.active;
    document.getElementById('btn-unlock-user').classList.toggle('hidden', !u.locked);
  } else {
    document.getElementById('btn-unlock-user').classList.add('hidden');
    document.getElementById('user-form-title').textContent = 'เพิ่มผู้ใช้ใหม่';
    unameInput.value = ''; unameInput.disabled = false;
    document.getElementById('user-fullname').value = '';
    document.getElementById('user-role').value = 'PHARMACIST';
    document.getElementById('user-password').value = '';
    document.getElementById('user-active').checked = true;
  }
}

function closeUserForm() { document.getElementById('user-form-card').classList.add('hidden'); }

function unlockSelectedUser() {
  const username = document.getElementById('user-username').value;
  return runBusy('unlockSelectedUser', 'กำลังปลดล็อก...', () => gsRun('unlockUser', TOKEN, username).then(res => {
    toast(res.message, false);
    document.getElementById('btn-unlock-user').classList.add('hidden');
    loadUsers();
  }).catch(err => toast(err.message, true)));
}

function submitUser() {
  const payload = {
    username: document.getElementById('user-username').value.trim(),
    fullName: document.getElementById('user-fullname').value.trim(),
    role: document.getElementById('user-role').value,
    password: document.getElementById('user-password').value,
    active: document.getElementById('user-active').checked
  };
  if (payload.password && payload.password.length < 8) { toast('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร', true); return; }
  return runBusy('submitUser', 'กำลังบันทึก...', () => gsRun('saveUser', TOKEN, payload).then(res => {
    toast(res.message, false);
    closeUserForm();
    loadUsers();
  }).catch(err => toast(err.message, true)));
}

/* ============================== แจ้งเตือน / รหัสผ่าน ============================== */

function loadAlertEmailsField() {
  gsRun('getAlertEmails', TOKEN).then(v => { document.getElementById('alert-emails').value = v; }).catch(() => {});
}

function saveAlertEmails() {
  return runBusy('saveAlertEmails', 'กำลังบันทึก...', () => gsRun('setAlertEmails', TOKEN, document.getElementById('alert-emails').value.trim())
    .then(res => toast(res.message, false)).catch(err => toast(err.message, true)));
}

function testAlert() {
  return runBusy('testAlert', 'กำลังส่ง...', () => gsRun('testAlertNow', TOKEN).then(res => toast(res.message, false)).catch(err => toast(err.message, true)));
}

function submitChangeOwnPassword() {
  const oldPw = document.getElementById('own-old-pw').value;
  const newPw = document.getElementById('own-new-pw').value;
  if (!oldPw || !newPw) { toast('กรุณากรอกรหัสผ่านให้ครบ', true); return; }
  if (newPw.length < 8) { toast('รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร', true); return; }
  return runBusy('submitChangeOwnPassword', 'กำลังเปลี่ยน...', () => gsRun('changeOwnPassword', TOKEN, oldPw, newPw).then(res => {
    toast(res.message, false);
    document.getElementById('own-old-pw').value = '';
    document.getElementById('own-new-pw').value = '';
  }).catch(err => toast(err.message, true)));
}
