/* =====================================================================
   FUTAI — ระบบบันทึกงาน + ประเมินคะแนนพนักงาน (V2 — Frontend)
   ไฟล์นี้คือ UI ทั้งหมด รันอยู่บน GitHub Pages (Static site)
   เรียกข้อมูล/บันทึกข้อมูลทั้งหมดผ่าน fetch() ไปที่ Apps Script Web App (config.js > CONFIG.API_URL)
   ไม่มี google.script.run อีกต่อไป เพราะไม่ได้รันอยู่ใน Apps Script HtmlService แล้ว

   โครงสร้าง/ตรรกะ UI ทั้งหมดเหมือน V1 เป๊ะ (ไม่มีการเปลี่ยน Business Rule ใดๆ ในไฟล์นี้)
   สิ่งที่ต่างจาก V1 มีแค่ "วิธีคุยกับ Backend":
   1) โหมด Employee/Admin อ่านจาก URL query string (?mode=admin) ฝั่ง Client เอง แทนการอ่านจาก Apps Script Template
   2) ทุกการอ่านข้อมูลใช้ apiGet() (fetch แบบ GET) แทน gsRun()
   3) ทุกการบันทึกข้อมูลใช้ apiPost() (fetch แบบ POST, Content-Type: text/plain กัน CORS preflight)
      พร้อมแนบ requestId สุ่มใหม่ทุกครั้งที่กดปุ่ม เพื่อกัน Backend สร้างข้อมูลซ้ำถ้ากดซ้ำ/เน็ตหลุดแล้ว retry
   4) ปุ่มบันทึกทุกปุ่มจะถูกปิด (disabled) ระหว่างรอผลจาก Backend กันคนกดซ้ำเร็วๆ (double-tap)
   5) มี Timeout (45 วินาที) และข้อความแจ้งเตือนภาษาไทยสำหรับ: ออฟไลน์/เน็ตหลุด/หมดเวลา/เซิร์ฟเวอร์ error
   ===================================================================== */

/* ===================== ชั้นเชื่อมต่อ API (fetch layer) ===================== */

// เดิม 20 วินาที — action "companyMonthlyScores" คำนวณคะแนน+เงินของพนักงาน "ทุกคน" ในบริษัทพร้อมกันทุกครั้ง
// (ทั้งหน้า Dashboard ที่ดูทีละคน และหน้า "สรุปคะแนน/เงิน") ยิ่งพนักงาน/ข้อมูลสะสมเยอะขึ้นเรื่อยๆ ยิ่งใช้เวลานานขึ้น
// ปรับเป็น 45 วินาทีกันหลุด Timeout ง่ายเกินไป (แก้ที่ต้นตอความช้าฝั่ง Backend แล้วด้วย ดู Code.gs)
var API_TIMEOUT_MS = 45000;

function genRequestId() {
  return 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

function fetchWithTimeout(url, options, timeoutMs) {
  var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var timer = null;
  var opts = options || {};
  if (controller) {
    opts = Object.assign({}, options, { signal: controller.signal });
    timer = setTimeout(function () { controller.abort(); }, timeoutMs || API_TIMEOUT_MS);
  }
  return fetch(url, opts).then(function (res) {
    if (timer) clearTimeout(timer);
    return res;
  }).catch(function (err) {
    if (timer) clearTimeout(timer);
    if (err && err.name === 'AbortError') throw new Error('หมดเวลาเชื่อมต่อเซิร์ฟเวอร์ (Timeout) กรุณาลองใหม่อีกครั้ง');
    throw err;
  });
}

// แปล error ให้เป็นข้อความภาษาไทยที่พนักงาน/แอดมินอ่านเข้าใจ ไม่ใช่ raw error ของเบราว์เซอร์
function friendlyErrorMessage(e) {
  var msg = (e && e.message) ? e.message : String(e);
  if (/Failed to fetch|NetworkError|Load failed|ERR_INTERNET_DISCONNECTED/i.test(msg)) {
    return 'ไม่สามารถเชื่อมต่ออินเทอร์เน็ตได้ กรุณาตรวจสอบสัญญาณแล้วลองใหม่อีกครั้ง (ข้อมูลที่กรอกไว้ยังอยู่ ลองกดบันทึกซ้ำได้)';
  }
  return msg;
}

function apiGet(action, params) {
  // ใช้ typeof เช็คแทน !CONFIG ตรงๆ เพราะถ้าไฟล์ config.js โหลดไม่สำเร็จ (404/พาธผิด)
  // การอ้างถึงตัวแปร CONFIG ที่ไม่เคยถูกประกาศเลยจะทำให้เกิด ReferenceError ทันที (ไม่ใช่แค่ค่า false/undefined)
  // ซึ่งจะทำให้ทั้งหน้าค้างที่ "กำลังโหลด..." ตลอดไปโดยไม่มีข้อความ error ให้เห็นเลย
  if (typeof CONFIG === 'undefined' || !CONFIG.API_URL || CONFIG.API_URL.indexOf('YOUR_DEPLOYMENT_ID_HERE') !== -1) {
    return Promise.reject(new Error('ยังไม่ได้ตั้งค่า API_URL ใน config.js หรือไฟล์ config.js โหลดไม่สำเร็จ (ตรวจว่าไฟล์ config.js อยู่ในโฟลเดอร์เดียวกับ index.html และ push ขึ้น GitHub แล้วจริง)'));
  }
  var url = CONFIG.API_URL + '?action=' + encodeURIComponent(action);
  if (params) {
    Object.keys(params).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
        url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
      }
    });
  }
  return fetchWithTimeout(url, { method: 'GET' }).then(function (res) {
    if (!res.ok) throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ (HTTP ' + res.status + ')');
    return res.json();
  }).then(function (json) {
    if (!json || json.success !== true) throw new Error((json && json.error) || 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์');
    return json.data;
  }).catch(function (e) { throw new Error(friendlyErrorMessage(e)); });
}

// payload ต้องเป็น plain object เสมอ (ไม่ใช่ FormData) — ส่งเป็น text/plain กัน CORS preflight ที่ Apps Script ตอบไม่ได้
function apiPost(action, payload) {
  if (typeof CONFIG === 'undefined' || !CONFIG.API_URL || CONFIG.API_URL.indexOf('YOUR_DEPLOYMENT_ID_HERE') !== -1) {
    return Promise.reject(new Error('ยังไม่ได้ตั้งค่า API_URL ใน config.js หรือไฟล์ config.js โหลดไม่สำเร็จ (ตรวจว่าไฟล์ config.js อยู่ในโฟลเดอร์เดียวกับ index.html และ push ขึ้น GitHub แล้วจริง)'));
  }
  var requestId = genRequestId();
  var body = JSON.stringify({ action: action, requestId: requestId, payload: payload || {} });
  return fetchWithTimeout(CONFIG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: body
  }).then(function (res) {
    if (!res.ok) throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ (HTTP ' + res.status + ')');
    return res.json();
  }).then(function (json) {
    if (!json || json.success !== true) throw new Error((json && json.error) || 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์');
    return json.data;
  }).catch(function (e) { throw new Error(friendlyErrorMessage(e)); });
}

// ห่อปุ่มบันทึกไว้กันกดซ้ำระหว่างรอผล (ชั้นป้องกันที่ 1 — ชั้นที่ 2 คือ requestId ฝั่ง Backend)
function withButtonGuard(btn, action) {
  if (!btn || btn.disabled) return; // กำลังส่งอยู่แล้ว หรือหาปุ่มไม่เจอ — ไม่ทำซ้ำ
  var original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'กำลังบันทึก...';
  function restore() { btn.disabled = false; btn.textContent = original; }
  return action().then(function (r) { restore(); return r; }).catch(function (e) { restore(); throw e; });
}

/* ===================== state ทั่วไป ===================== */

function getInitialMode() {
  try {
    var params = new URLSearchParams(window.location.search);
    return params.get('mode') === 'admin' ? 'admin' : 'employee';
  } catch (e) {
    return (window.location.search || '').indexOf('mode=admin') !== -1 ? 'admin' : 'employee';
  }
}

var APP = { mode: getInitialMode(), employees: [], departments: [], errorTypes: [], severityLevels: [], impactOptions: [], workTypesByDept: {}, attendanceStatuses: [], leaveTypes: [], reportRewardDefaults: { self: null, external: null }, goodDeedPoints: null, month: null, year: null, tab: null, adminUnlocked: false };

// จำว่า Admin ผ่านรหัสผ่านแล้วในแท็บนี้ (sessionStorage = อยู่แค่แท็บนี้ ปิดแท็บแล้วต้องใส่ใหม่ ไม่ใช่ Login ถาวร)
function isAdminUnlockedThisTab() {
  try { return sessionStorage.getItem('futai_admin_unlocked') === '1'; } catch (e) { return false; }
}
function markAdminUnlockedThisTab() {
  try { sessionStorage.setItem('futai_admin_unlocked', '1'); } catch (e) { /* ถ้า sessionStorage ใช้ไม่ได้ก็แค่ต้องใส่รหัสใหม่ทุกครั้ง ไม่ใช่ปัญหาคอขวด */ }
}

function toast(msg, isError) {
  var t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(function () { t.className = 'toast'; }, 2600);
}
// กันชนเวลาสลับแท็บระหว่างที่ apiGet ยังโหลดไม่เสร็จ — พอ fetch เก่ากลับมาถึง แต่พี่สลับไปหน้าอื่นแล้ว
// element เดิม (เช่น wsA) จะหายไปจาก DOM ทำให้ .value=/.textContent= พังด้วย "Cannot set properties of null"
// (เจอจริงตอนสลับจากหน้า "ประเมิน Work Score" ไปหน้า "Sales Field" เร็วๆ ระหว่างที่ยังโหลดอยู่) ฟังก์ชันนี้เช็คก่อนว่า
// element ยังอยู่จริงไหม ถ้าไม่อยู่ (สลับหน้าไปแล้ว) ก็แค่ไม่ทำอะไร ไม่ error ไม่กระทบข้อมูลที่บันทึกไปแล้ว
function setValIfExists(id, v) { var el = document.getElementById(id); if (el) el.value = v; }
function setTextIfExists(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function fmtDate(v) { if (!v) return ''; var d = new Date(v); if (isNaN(d)) return String(v); return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + d.getFullYear(); }
// เลขทุกจุดในเว็บแอพ (คะแนน/จำนวน/ยอดเงิน) ใช้ตัวนี้ตัวเดียวกันหมด — เติมจุลภาคคั่นหลักพันให้อัตโนมัติเมื่อค่า >= 1000
// (คะแนน/จำนวนนับทั่วไปมักไม่ถึงหลักพันอยู่แล้วจึงไม่เห็นผลต่างอะไร ส่วนยอดเงิน เช่น เงินพิเศษ/เบี้ยขยัน/ค่าเสียหาย/ยอดขาย จะมีจุลภาคให้อ่านง่ายขึ้นเลย)
function fmtNum(v) {
  if (typeof v !== 'number') return v === undefined || v === null || v === '' ? '-' : String(v);
  var rounded = Math.round(v * 100) / 100;
  var parts = Math.abs(rounded).toString().split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (rounded < 0 ? '-' : '') + parts.join('.');
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
// เดือน/ปีบวกลบ delta เดือน แล้วข้ามปีให้ถูกต้องอัตโนมัติ (delta ติดลบได้ = ถอยหลัง) — ใช้ร่วมกันทั้งหน้า
// "สรุปคะแนน/เงิน" (คำนวณเดือนที่เงินออกจริง) และหน้า "ปฏิทินบริษัท" (ปุ่มก่อนหน้า/ถัดไป)
function addMonths(month, year, delta) {
  var total = (Number(year) * 12 + (Number(month) - 1)) + delta;
  return { month: (total % 12) + 1, year: Math.floor(total / 12) };
}
function sumField(rows, key) {
  return rows.reduce(function (sum, r) { var n = Number(r[key]); return sum + (isNaN(n) ? 0 : n); }, 0);
}

function monthPickerHtml(id, month, year) {
  var months = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  var mOpts = '', yOpts = '';
  for (var m = 1; m <= 12; m++) mOpts += '<option value="' + m + '"' + (m === month ? ' selected' : '') + '>' + months[m] + '</option>';
  for (var y = year - 1; y <= year + 1; y++) yOpts += '<option value="' + y + '"' + (y === year ? ' selected' : '') + '>' + y + '</option>';
  return '<div class="month-picker"><select id="' + id + '_m">' + mOpts + '</select><select id="' + id + '_y">' + yOpts + '</select><button class="btn small secondary" id="' + id + '_go">ดู</button></div>';
}

function employeeOptions(list) { return list.map(function (e) { return '<option value="' + e.id + '">' + esc(e.name) + '</option>'; }).join(''); }
// ใช้เฉพาะจุดที่ผู้รับผิดชอบ/ผู้แจ้งอาจมาจากคนละแผนกกัน (เช่นหน้า Error) — โชว์แผนกต่อท้ายชื่อในตัวเลือกเลย ไม่ต้องเดา/สลับไปเช็คที่อื่น
function employeeOptionsWithDept(list) { return list.map(function (e) { return '<option value="' + e.id + '">' + esc(e.name) + (e.department ? ' — ' + esc(e.department) : '') + '</option>'; }).join(''); }

/* ===================== UI-ONLY HELPER: Card-Select ═════════════════════
   ครอบ <select> เดิมด้วยการ์ดให้คลิกเลือกได้ (Radio Card) โดย <select> ตัวเดิม
   (id เดิมทุกอย่าง) ยังอยู่ใน DOM เป็นตัวเก็บค่าจริงเหมือนเดิมทุกประการ แค่ซ่อนด้วย CSS
   — โค้ด Business Logic ที่อ่าน .value หรือ addEventListener('change', ...) ของ select
   ตัวนั้นทำงานเหมือนเดิม 100% ไม่ต้องแก้อะไรเลย ฟังก์ชันนี้เป็น UI Layer ล้วนๆ
   เวลามีโค้ดอื่นตั้งค่า select.value ตรงๆ (ไม่ผ่านการคลิกการ์ด) ให้เรียก
   select._cardSync() ต่อท้ายเพื่อให้การ์ดที่ไฮไลต์อยู่อัปเดตตาม (ดูตัวอย่างใน syncSeverityToImpact)
   ========================================================================= */
function cardSelectHtml(groupId, options) {
  return '<div class="cardSelectGroup" id="' + groupId + '">' + options.map(function (o) {
    return '<div class="cardSelectOption' + (o.highLevel ? ' levelHigh' : '') + '" data-value="' + esc(o.value) + '">' +
      '<div class="optLeft"><span class="optDot">✓</span><div class="optText"><div class="optTitle">' + esc(o.title) + '</div>' +
      (o.desc ? '<div class="optDesc">' + esc(o.desc) + '</div>' : '') + '</div></div>' +
      (o.pointsLabel ? '<span class="optPoints">' + esc(o.pointsLabel) + '</span>' : '') +
      '</div>';
  }).join('') + '</div>';
}
function wireCardSelect(selectId) {
  var select = document.getElementById(selectId);
  var group = document.getElementById(selectId + 'Cards');
  if (!select || !group) return;
  var cards = group.querySelectorAll('.cardSelectOption');
  function sync() {
    Array.prototype.forEach.call(cards, function (card) { card.classList.toggle('selected', card.getAttribute('data-value') === select.value); });
  }
  Array.prototype.forEach.call(cards, function (card) {
    card.addEventListener('click', function () {
      select.value = card.getAttribute('data-value');
      sync();
      var evt; try { evt = new Event('change', { bubbles: true }); } catch (e2) { evt = document.createEvent('Event'); evt.initEvent('change', true, true); }
      select.dispatchEvent(evt);
    });
  });
  select.addEventListener('change', sync);
  select._cardSync = sync;
  sync();
}

/* ===================== boot ===================== */
function boot() {
  // ห่อด้วย try/catch กันไว้อีกชั้น: ถ้ามีอะไร throw แบบ synchronous ก่อนถึง .catch() (เช่น config.js โหลดไม่สำเร็จ)
  // อย่างน้อยหน้าเว็บต้องเปลี่ยนจาก "กำลังโหลด..." เป็นข้อความ error ให้เห็น ไม่ใช่ค้างเฉยๆ ตลอดไป
  try {
    apiGet('bootstrap', {}).then(function (data) {
      APP.employees = data.employees; APP.departments = data.departments;
      APP.errorTypes = data.errorTypes; APP.severityLevels = data.severityLevels; APP.impactOptions = data.impactOptions || [];
      APP.workTypesByDept = data.workTypesByDept || {}; APP.attendanceStatuses = data.attendanceStatuses || ['ปกติ', 'ขาด', 'ลา', 'มาสาย'];
      APP.leaveTypes = data.leaveTypes || ['ลาพักร้อน', 'ลาป่วยมีใบรับรองแพทย์', 'ลากิจ', 'ลาป่วยไม่มีใบรับรองแพทย์'];
      APP.reportRewardDefaults = data.reportRewardDefaults || { self: null, external: null };
      APP.goodDeedPoints = data.goodDeedPoints;
      APP.month = data.month; APP.year = data.year;
      renderShell();
    }).catch(function (e) { showBootError(e); });
  } catch (e) {
    showBootError(e);
  }
}

function showBootError(e) {
  var el = document.getElementById('content');
  if (el) el.innerHTML = '<div class="card"><h3>โหลดไม่สำเร็จ</h3><p class="muted">' + esc((e && e.message) || e) + '</p><button class="btn secondary" onclick="boot()">ลองใหม่อีกครั้ง</button></div>';
}

// ข้อความทักทายเปลี่ยนตามช่วงเวลา — ตกแต่ง UI เท่านั้น ไม่มีผลต่อข้อมูล/Logic ใดๆ
function greetingText() {
  var h = new Date().getHours();
  var g = h < 12 ? 'สวัสดีตอนเช้า' : (h < 17 ? 'สวัสดีตอนบ่าย' : 'สวัสดีตอนเย็น');
  return g + ' 👋 วันนี้ทำงานเป็นอย่างไรบ้าง?';
}

function renderShell() {
  var titleEl = document.getElementById('headerTitle');
  var subtitleEl = document.getElementById('headerSubtitle');
  var toggleEl = document.getElementById('modeToggle');
  if (APP.mode === 'admin') {
    titleEl.textContent = 'FUTAI Performance';
    subtitleEl.textContent = 'โหมดผู้ดูแลระบบ';
    toggleEl.textContent = 'โหมดพนักงาน';
    toggleEl.onclick = function () { APP.mode = 'employee'; renderShell(); };
    if (APP.adminUnlocked || isAdminUnlockedThisTab()) {
      APP.adminUnlocked = true;
      setupAdminTabs();
    } else {
      document.getElementById('tabbar').style.display = 'none';
      document.getElementById('tabbar').innerHTML = '';
      renderAdminPasswordGate();
    }
  } else {
    titleEl.textContent = 'FUTAI';
    subtitleEl.textContent = greetingText();
    toggleEl.textContent = 'สำหรับผู้ดูแลระบบ';
    toggleEl.onclick = function () { APP.mode = 'admin'; renderShell(); };
    document.getElementById('tabbar').style.display = 'none';
    document.getElementById('tabbar').innerHTML = '';
    renderEmployeeHome();
  }
}

/* ===================== EMPLOYEE MODE (ไม่มี Login) ===================== */
function renderEmployeeHome() {
  var html = '<div class="card"><h3>👋 บันทึกงาน</h3><div class="cardSubtitle">เลือกชื่อของคุณเพื่อเริ่มบันทึกงานวันนี้</div>' +
    '<label>เลือกชื่อพนักงาน</label><select id="empSelect"><option value="">— เลือกชื่อ —</option>' + employeeOptions(APP.employees) + '</select>' +
    '<div id="deptLine" class="muted" style="margin-top:6px;"></div>' +
    '</div>' +
    '<div id="empFormArea"></div>' +
    '<div id="empHistoryArea"></div>';
  document.getElementById('content').innerHTML = html;
  document.getElementById('empSelect').addEventListener('change', function () {
    var emp = APP.employees.filter(function (e) { return e.id === this.value; }, this)[0];
    if (!emp) { document.getElementById('deptLine').textContent = ''; document.getElementById('empFormArea').innerHTML = ''; document.getElementById('empHistoryArea').innerHTML = ''; return; }
    document.getElementById('deptLine').innerHTML = 'แผนก: <span class="pill">' + esc(emp.department) + '</span>';
    renderEmployeeForm(emp);
  });
}

function renderEmployeeForm(emp) {
  var area = document.getElementById('empFormArea');
  var hist = document.getElementById('empHistoryArea');

  if (emp.formType === 'daily') {
    area.innerHTML = dailyFormHtml('e', emp.department);
    wireDailyForm('e', emp.id);
    hist.innerHTML = '<div class="card"><h3>ประวัติงานของฉัน</h3><div id="e_hist" class="muted">กำลังโหลด...</div></div>';
    loadDailyHistory('e', emp.id);
  } else if (emp.formType === 'weekly') {
    area.innerHTML = weeklyFormHtml('e');
    wireWeeklyForm('e', emp.id, function () { loadWeeklyHistory('e', emp.id); });
    hist.innerHTML = '<div class="card"><h3>ประวัติงานของฉัน (รายสัปดาห์)</h3><div id="e_whist" class="muted">กำลังโหลด...</div></div>';
    loadWeeklyHistory('e', emp.id);
  } else {
    area.innerHTML = '<div class="card muted">งานของแผนกนี้ Admin เป็นผู้บันทึกให้ ไม่ต้องกรอกเองครับ</div>';
    hist.innerHTML = '';
  }
}

/* ---- Daily form (ใช้ทั้งฝั่งพนักงานและฝั่ง Admin บันทึกแทน) ---- */
// ประเภทงานเป็น Dropdown ตามแผนก (มาจาก Work_Type_Config ผ่าน Bootstrap) แก้ไข/เพิ่มรายการได้ที่ Sheet โดยตรง
// เลือก "อื่นๆ" ได้เสมอ — กรณีนั้นให้ระบุรายละเอียดในช่องหมายเหตุ
function workTypeOptionsForDept(dept) {
  var list = (APP.workTypesByDept && APP.workTypesByDept[dept]) || [];
  var opts = list.map(function (t) { return '<option value="' + esc(t.label) + '">' + esc(t.label) + '</option>'; }).join('');
  if (list.every(function (t) { return t.label !== 'งานอื่น' && t.label !== 'อื่นๆ'; })) opts += '<option value="อื่นๆ">อื่นๆ</option>';
  return opts;
}

function dailyFormHtml(prefix, dept) {
  return '<div class="card"><h3>📝 บันทึกงานวันนี้</h3>' +
    '<label>วันที่</label><input type="date" id="' + prefix + '_date" value="' + todayStr() + '">' +
    '<label>ประเภทงาน</label><select id="' + prefix + '_task">' + workTypeOptionsForDept(dept) + '</select>' +
    '<div class="row"><div><label>จำนวน</label><input type="number" id="' + prefix + '_qty"></div><div><label>หน่วย</label><input type="text" id="' + prefix + '_unit" placeholder="รายการ / เจ้า / ชิ้น"></div></div>' +
    '<label>หมายเหตุ <span class="muted">(ถ้าเลือก "อื่นๆ" กรุณาระบุรายละเอียดตรงนี้)</span></label><input type="text" id="' + prefix + '_note">' +
    '<button class="btn secondary" id="' + prefix + '_add">+ เพิ่มในรายการวันนี้</button>' +
    '<div id="' + prefix + '_pending" style="margin-top:10px;"></div>' +
    '<button class="btn" id="' + prefix + '_saveAll" style="display:none;">บันทึกทั้งหมด</button>' +
    '</div>';
}

function wireDailyForm(prefix, employeeId) {
  var pending = [];
  function renderPending() {
    var el = document.getElementById(prefix + '_pending');
    el.innerHTML = pending.map(function (l, i) {
      return '<div class="lineItem"><span>' + esc(l.task) + (l.qty ? ' (' + esc(l.qty) + ' ' + esc(l.unit) + ')' : '') + '</span><button data-i="' + i + '">ลบ</button></div>';
    }).join('');
    Array.prototype.forEach.call(el.querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () { pending.splice(Number(b.getAttribute('data-i')), 1); renderPending(); });
    });
    document.getElementById(prefix + '_saveAll').style.display = pending.length ? 'inline-block' : 'none';
  }
  document.getElementById(prefix + '_add').addEventListener('click', function () {
    var taskSel = document.getElementById(prefix + '_task');
    var task = taskSel.value;
    var note = document.getElementById(prefix + '_note').value;
    if (!task) { toast('เลือกประเภทงานก่อน', true); return; }
    if ((task === 'อื่นๆ') && !note.trim()) { toast('เลือก "อื่นๆ" แล้วกรุณาระบุรายละเอียดในหมายเหตุด้วย', true); return; }
    pending.push({ task: task, qty: document.getElementById(prefix + '_qty').value, unit: document.getElementById(prefix + '_unit').value, note: note });
    taskSel.selectedIndex = 0; document.getElementById(prefix + '_qty').value = ''; document.getElementById(prefix + '_unit').value = ''; document.getElementById(prefix + '_note').value = '';
    renderPending();
  });
  document.getElementById(prefix + '_saveAll').addEventListener('click', function (evt) {
    var date = document.getElementById(prefix + '_date').value;
    var linesToSave = pending;
    withButtonGuard(evt.target, function () { return apiPost('addWorkLogBatch', { employeeId: employeeId, date: date, lines: linesToSave }); })
      .then(function () {
        toast('บันทึกแล้ว ' + linesToSave.length + ' รายการ'); pending = []; renderPending();
        if (document.getElementById(prefix + '_hist')) loadDailyHistory(prefix, employeeId);
      }).catch(function (e) { toast(e.message || String(e), true); });
  });
}

function loadDailyHistory(prefix, employeeId) {
  apiGet('workHistory', { employeeId: employeeId, limit: 20 }).then(function (rows) {
    var el = document.getElementById(prefix + '_hist');
    if (!el) return;
    if (!rows.length) { el.innerHTML = '<div class="muted">ยังไม่มีข้อมูล</div>'; return; }
    el.innerHTML = rows.map(function (r) {
      return '<div class="list-item"><b>' + esc(r['งานที่ทำ']) + '</b> ' + (r['จำนวน'] ? '(' + esc(r['จำนวน']) + ' ' + esc(r['หน่วย']) + ')' : '') + '<div class="meta">' + fmtDate(r['วันที่']) + (r['หมายเหตุ'] ? ' · ' + esc(r['หมายเหตุ']) : '') + '</div></div>';
    }).join('');
  }).catch(function (e) {
    var el = document.getElementById(prefix + '_hist');
    if (el) el.innerHTML = '<div class="muted">โหลดประวัติไม่สำเร็จ: ' + esc(e.message || e) + '</div>';
  });
}

/* ---- Weekly form (Accounting) ---- */
function weeklyFormHtml(prefix) {
  return '<div class="card"><h3>📅 บันทึกงานประจำสัปดาห์ (บัญชี)</h3>' +
    '<div class="row"><div><label>วันที่เริ่มสัปดาห์</label><input type="date" id="' + prefix + '_wstart"></div><div><label>วันที่สิ้นสุดสัปดาห์</label><input type="date" id="' + prefix + '_wend"></div></div>' +
    '<div class="row"><div><label>วางบิล (จำนวน)</label><input type="number" id="' + prefix + '_invoice"></div><div><label>รับชำระ (จำนวน)</label><input type="number" id="' + prefix + '_payment"></div></div>' +
    '<div class="row"><div><label>ตรวจเอกสาร (จำนวน)</label><input type="number" id="' + prefix + '_doccheck"></div><div><label>เปิดบิล (จำนวน)</label><input type="number" id="' + prefix + '_billopen"></div></div>' +
    '<label>งานอื่นๆ</label><textarea id="' + prefix + '_other"></textarea>' +
    '<button class="btn" id="' + prefix + '_wsave">บันทึก</button></div>';
}

function wireWeeklyForm(prefix, employeeId, onSaved) {
  document.getElementById(prefix + '_wsave').addEventListener('click', function (evt) {
    var start = document.getElementById(prefix + '_wstart').value, end = document.getElementById(prefix + '_wend').value;
    if (!start || !end) { toast('เลือกช่วงวันที่ก่อน', true); return; }
    var payload = {
      employeeId: employeeId, startDate: start, endDate: end,
      invoiceCount: document.getElementById(prefix + '_invoice').value, paymentCount: document.getElementById(prefix + '_payment').value,
      docCheckCount: document.getElementById(prefix + '_doccheck').value, billOpenCount: document.getElementById(prefix + '_billopen').value,
      otherWork: document.getElementById(prefix + '_other').value
    };
    withButtonGuard(evt.target, function () { return apiPost('addWeeklyLog', payload); })
      .then(function () { toast('บันทึกแล้ว'); if (onSaved) onSaved(); }).catch(function (e) { toast(e.message || String(e), true); });
  });
}

function loadWeeklyHistory(prefix, employeeId) {
  apiGet('weeklyHistory', { employeeId: employeeId, limit: 15 }).then(function (rows) {
    var el = document.getElementById(prefix + '_whist');
    if (!el) return;
    if (!rows.length) { el.innerHTML = '<div class="muted">ยังไม่มีข้อมูล</div>'; return; }
    el.innerHTML = rows.map(function (r) {
      return '<div class="list-item"><b>' + fmtDate(r['วันที่เริ่มสัปดาห์']) + ' - ' + fmtDate(r['วันที่สิ้นสุดสัปดาห์']) + '</b>' +
        '<div class="meta">วางบิล ' + fmtNum(r['วางบิล']) + ' · รับชำระ ' + fmtNum(r['รับชำระ']) + ' · ตรวจเอกสาร ' + fmtNum(r['ตรวจเอกสาร']) + ' · เปิดบิล ' + fmtNum(r['เปิดบิล']) + (r['งานอื่นๆ'] ? ' · ' + esc(r['งานอื่นๆ']) : '') + '</div></div>';
    }).join('');
  }).catch(function (e) {
    var el = document.getElementById(prefix + '_whist');
    if (el) el.innerHTML = '<div class="muted">โหลดประวัติไม่สำเร็จ: ' + esc(e.message || e) + '</div>';
  });
}

/* ===================== ADMIN: กล่องกรอกรหัสผ่าน (ถ้ายังไม่ตั้งรหัสใน Config จะข้ามหน้านี้ไปอัตโนมัติ) ===================== */
function renderAdminPasswordGate() {
  var html = '<div class="card"><h3>เข้าสู่โหมด Admin</h3>' +
    '<label>รหัสผ่าน</label><input type="text" id="adminPw" autocomplete="off">' +
    '<button class="btn" id="adminPwGo">เข้าสู่ระบบ</button>' +
    '<p class="muted" style="margin-top:10px;">ถ้ายังไม่เคยตั้งรหัสผ่าน (Cfg_AdminPassword ในชีต Config ยังเป็น PENDING) ใส่อะไรก็ได้แล้วกดเข้าสู่ระบบได้เลย</p>' +
    '</div>';
  document.getElementById('content').innerHTML = html;
  var goBtn = document.getElementById('adminPwGo');
  function submitPw() {
    var pw = document.getElementById('adminPw').value;
    withButtonGuard(goBtn, function () { return apiPost('adminAuth', { password: pw }); })
      .then(function () { APP.adminUnlocked = true; markAdminUnlockedThisTab(); renderShell(); })
      .catch(function (e) { toast(e.message || String(e), true); });
  }
  goBtn.addEventListener('click', submitPw);
  document.getElementById('adminPw').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') submitPw(); });
}

/* ===================== ADMIN MODE ===================== */
// PHASE 2: ใส่แท็บ "ประเมิน Work Score" กลับเข้าเมนูแล้ว (ตอน PHASE 1 ถอดออกไปก่อนเพราะ Work Score ยังไม่คำนวณ)
// UI/UX Redesign: เพิ่มแท็บ "Dashboard" ใหม่ (renderAdminDashboard — ใช้ข้อมูลจาก action companyMonthlyScores เดิม
// ไม่มี Backend/Action ใหม่) + ใส่ icon ให้ทุกแท็บ เพื่อให้ Sidebar/Bottom-nav ดูเป็น Application จริง
// ย้ายแท็บ "ประเมิน Work Score" มาอยู่เหนือแท็บ "Error" ตามที่พี่ขอ (เดิมอยู่ล่างสุดก่อน "สรุปคะแนน/เงิน")
// เป็นการจัดลำดับเมนูอย่างเดียว ไม่กระทบ Logic/การคำนวณใดๆ
var ADMIN_TABS = [
  { key: 'dashboard', label: 'Dashboard', icon: '📊', render: renderAdminDashboard },
  { key: 'work', label: 'บันทึกงาน', icon: '📝', render: renderAdminWork },
  { key: 'salesfield', label: 'Sales Field', icon: '🚗', render: function () { renderAdminSalesMonthly('field'); } },
  { key: 'salesonline', label: 'Sales Online', icon: '🛒', render: function () { renderAdminSalesMonthly('online'); } },
  { key: 'workscore', label: 'ประเมิน Work Score', icon: '🎯', render: renderAdminWorkScore },
  { key: 'error', label: 'Error', icon: '⚠️', render: renderAdminError },
  { key: 'gooddeed', label: 'Good Deed', icon: '🌟', render: renderAdminGoodDeed },
  { key: 'attendance', label: 'Attendance', icon: '🗓️', render: renderAdminAttendance },
  { key: 'calendar', label: 'ปฏิทินบริษัท', icon: '📅', render: renderAdminCalendar },
  { key: 'summary', label: 'สรุปคะแนน/เงิน', icon: '💰', render: renderAdminSummary },
  { key: 'employees', label: 'จัดการพนักงาน', icon: '👤', render: renderAdminEmployees }
];

function setupAdminTabs() {
  var bar = document.getElementById('tabbar');
  bar.style.display = 'flex';
  bar.innerHTML = ADMIN_TABS.map(function (t) {
    return '<button data-key="' + t.key + '"><span class="navIcon">' + (t.icon || '•') + '</span><span class="navLabel">' + esc(t.label) + '</span></button>';
  }).join('');
  Array.prototype.forEach.call(bar.querySelectorAll('button'), function (b) { b.addEventListener('click', function () { openAdminTab(b.getAttribute('data-key')); }); });
  openAdminTab(APP.tab && ADMIN_TABS.some(function (t) { return t.key === APP.tab; }) ? APP.tab : ADMIN_TABS[0].key);
}

function openAdminTab(key) {
  APP.tab = key;
  var bar = document.getElementById('tabbar');
  Array.prototype.forEach.call(bar.querySelectorAll('button'), function (b) { b.classList.toggle('active', b.getAttribute('data-key') === key); });
  document.getElementById('content').innerHTML = '<div class="card center muted">กำลังโหลด...</div>';
  ADMIN_TABS.filter(function (t) { return t.key === key; })[0].render();
}

/* ---- 0. Dashboard (ภาพรวมคะแนนรายคน) ---- */
// UI/UX Redesign เท่านั้น — ไม่มี Action/Backend ใหม่ ใช้ข้อมูลจาก action "companyMonthlyScores" เดิม
// (ตัวเดียวกับที่แท็บ "สรุปคะแนน/เงิน" ใช้อยู่แล้ว) แค่กรองมาแสดงเป็น Stat Card ของพนักงาน 1 คนที่เลือก
function renderAdminDashboard() {
  var html = monthPickerHtml('db', APP.month, APP.year) +
    '<div class="card"><label>เลือกพนักงาน</label><select id="dbEmp"><option value="">— เลือกชื่อ —</option>' + employeeOptions(APP.employees) + '</select></div>' +
    '<div id="dbStats"></div>';
  document.getElementById('content').innerHTML = html;

  document.getElementById('db_go').addEventListener('click', load);
  document.getElementById('dbEmp').addEventListener('change', load);
  load();

  function statCardHtml(accentClass, icon, label, value, max, sub) {
    var isNum = typeof value === 'number';
    var pct = (isNum && typeof max === 'number' && max > 0) ? Math.max(0, Math.min(100, value / max * 100)) : null;
    return '<div class="statCard ' + accentClass + '"><span class="statIcon">' + icon + '</span>' +
      '<div class="statLabel">' + esc(label) + '</div>' +
      '<div class="statValue">' + fmtNum(value) + (isNum && max != null ? ' <span class="statMax">/ ' + max + '</span>' : '') + '</div>' +
      (pct !== null ? '<div class="progressTrack"><div class="progressFill" style="width:' + pct + '%"></div></div>' : '') +
      (sub ? '<div class="muted" style="margin-top:8px;">' + esc(sub) + '</div>' : '') +
      '</div>';
  }

  function load() {
    var employeeId = document.getElementById('dbEmp').value;
    var month = Number(document.getElementById('db_m').value), year = Number(document.getElementById('db_y').value);
    var area = document.getElementById('dbStats');
    if (!employeeId) { area.innerHTML = '<div class="card muted">เลือกพนักงานด้านบนเพื่อดูภาพรวมคะแนนเดือนนี้</div>'; return; }
    area.innerHTML = '<div class="card muted">กำลังโหลด...</div>';
    apiGet('companyMonthlyScores', { month: month, year: year }).then(function (rows) {
      var r = rows.filter(function (x) { return x['รหัสพนักงาน'] === employeeId; })[0];
      if (!r) { area.innerHTML = '<div class="card muted">ไม่พบข้อมูลพนักงานคนนี้ในเดือนที่เลือก</div>'; return; }
      // ตัวหารของแต่ละหมวดดึงมาจาก Backend สดๆ ทุกครั้ง (_workWeight/_errorWeight/_attendanceWeight) เผื่อเดือนนี้เข้าเงื่อนไข
      // "สัดส่วนคะแนนพิเศษเฉพาะเดือน" (ดู getEffectiveScoreWeights ฝั่ง Backend) — ไม่ Hardcode 20/60/20/100 อีกต่อไป
      var workW = (typeof r['_workWeight'] === 'number') ? r['_workWeight'] : 20;
      var errW = (typeof r['_errorWeight'] === 'number') ? r['_errorWeight'] : 60;
      var attW = (typeof r['_attendanceWeight'] === 'number') ? r['_attendanceWeight'] : 20;
      var totalW = workW + errW + attW;
      area.innerHTML =
        (r['_weightOverridden'] ? '<div class="calloutBox">📌 เดือนนี้ใช้สัดส่วนคะแนนพิเศษ: Work ' + workW + ' + Error ' + errW + ' + Attendance ' + attW + ' (ปกติ Work 20 + Error 60 + Attendance 20) — ตั้งได้ที่ชีต Config</div>' : '') +
        '<div class="statGrid">' +
        statCardHtml('accentCoral', '🏆', 'คะแนนรวม (Performance)', r['คะแนนรวม'], totalW) +
        statCardHtml('accentBlue', '🎯', 'Work Score', r['คะแนนงาน'], workW) +
        statCardHtml('accentAmber', '⚠️', 'Error Score', r['คะแนนความผิด'], errW) +
        statCardHtml('accentGreen', '🗓️', 'Attendance', r['คะแนนขาดลามาสาย'], attW) +
        statCardHtml('', '🌟', 'Reward Points สะสม', r['Reward Points สะสม'], null, 'แยกจาก Performance Score ' + totalW + ' คะแนนโดยสิ้นเชิง ใช้สะสมแลกรางวัลตามเกณฑ์บริษัท ไม่รวมกับคะแนนด้านบน') +
        '</div>' +
        '<div class="card"><h3>💰 เงินพิเศษเดือนนี้</h3><div class="statValue" style="font-size:22px;">' + fmtNum(r['เงินพิเศษ']) + '</div>' +
        '<div class="muted" style="margin-top:6px;">' + esc(r['ชื่อพนักงาน']) + ' · ' + esc(r['แผนก']) + (r['กลุ่มเงินพิเศษ'] ? ' · กลุ่มเงินพิเศษ: ' + esc(r['กลุ่มเงินพิเศษ']) : '') + '</div></div>' +
        '<div class="card"><h3>🎖️ เบี้ยขยันเดือนนี้</h3><div class="statValue" style="font-size:22px;">' + fmtNum(r['เบี้ยขยัน']) + '</div>' +
        '<div class="muted" style="margin-top:6px;">คนละก้อนกับเงินพิเศษด้านบน — ทุกคน Active ได้เท่ากันหมด หักตามนาทีมาสาย/ประเภทการลาในเดือนนี้เท่านั้น</div></div>';
    }).catch(function (e) {
      area.innerHTML = '<div class="card muted">โหลดไม่สำเร็จ: ' + esc(e.message || e) + ' <button class="btn secondary" id="dbRetry" style="margin-left:8px;">ลองใหม่</button></div>';
      var retryBtn = document.getElementById('dbRetry');
      if (retryBtn) retryBtn.addEventListener('click', load);
    });
  }
}

/* ---- 1. บันทึกงาน (Admin บันทึกแทน/ดูประวัติของใครก็ได้) ---- */
function renderAdminWork() {
  var html = '<div class="card"><h3>📝 บันทึกงาน</h3><div class="cardSubtitle">บันทึกงานแทนพนักงาน หรือดูประวัติของใครก็ได้</div><label>เลือกพนักงาน</label><select id="awEmp"><option value="">— เลือกชื่อ —</option>' + employeeOptions(APP.employees) + '</select></div>' +
    '<div id="awArea"></div><div id="awHist"></div>';
  document.getElementById('content').innerHTML = html;
  document.getElementById('awEmp').addEventListener('change', function () {
    var emp = APP.employees.filter(function (e) { return e.id === this.value; }, this)[0];
    if (!emp) { document.getElementById('awArea').innerHTML = ''; document.getElementById('awHist').innerHTML = ''; return; }
    if (emp.formType === 'daily') {
      document.getElementById('awArea').innerHTML = dailyFormHtml('aw', emp.department);
      wireDailyForm('aw', emp.id);
      document.getElementById('awHist').innerHTML = '<div class="card"><h3>ประวัติล่าสุด</h3><div id="aw_hist" class="muted">กำลังโหลด...</div></div>';
      loadDailyHistory('aw', emp.id);
    } else if (emp.formType === 'weekly') {
      document.getElementById('awArea').innerHTML = weeklyFormHtml('aw');
      wireWeeklyForm('aw', emp.id, function () { loadWeeklyHistory('aw', emp.id); });
      document.getElementById('awHist').innerHTML = '<div class="card"><h3>ประวัติล่าสุด</h3><div id="aw_whist" class="muted">กำลังโหลด...</div></div>';
      loadWeeklyHistory('aw', emp.id);
    } else {
      document.getElementById('awArea').innerHTML = '<div class="card muted">แผนกนี้ใช้แบบฟอร์มรายเดือน — ไปที่เมนู Sales Field / Sales Online แทน</div>';
      document.getElementById('awHist').innerHTML = '';
    }
  });
}

/* ---- 2/3. Sales Field / Sales Online (Admin กรอกให้) ---- */
// ฟิลด์ของ Sales Field กับ Sales Online ไม่เหมือนกัน แยกฟอร์ม/คอลัมน์สรุปตาม kind ให้ตรง Schema จริง
function renderAdminSalesMonthly(kind) {
  var dept = kind === 'field' ? 'Sales' : 'Online';
  var list = APP.employees.filter(function (e) { return e.department === dept; });
  var formHtml, cols;
  if (kind === 'field') {
    // Work Score V2: เพิ่ม "เป้ายอดขายส่วนตัว" กรอกคู่กับยอดขายจริงทุกเดือน — ใช้คำนวณข้อ A ในหน้า "ประเมิน Work Score" ให้อัตโนมัติ
    formHtml = '<div class="row"><div><label>ยอดขายส่วนตัว</label><input type="number" id="smPersonalSales"></div><div><label>เป้ายอดขายส่วนตัว (เดือนนี้)</label><input type="number" id="smTarget"></div></div>' +
      '<div class="row"><div><label>จำนวนลูกค้าใหม่</label><input type="number" id="smNewCustomers"></div><div><label>จำนวนลูกค้าที่ดึงกลับ</label><input type="number" id="smWonBack"></div></div>' +
      '<label>ยอดขายสินค้าผลักดัน</label><input type="number" id="smPush">' +
      '<label>ยอดค้างชำระ</label><input type="number" id="smOutstanding">' +
      '<label>หมายเหตุ</label><input type="text" id="smNote">';
    cols = [
      { key: 'ยอดขายส่วนตัว', label: 'ยอดขายส่วนตัว' }, { key: 'เป้ายอดขายส่วนตัว', label: 'เป้ายอดขาย' }, { key: 'จำนวนลูกค้าใหม่', label: 'ลูกค้าใหม่' },
      { key: 'จำนวนลูกค้าที่ดึงกลับ', label: 'ลูกค้าที่ดึงกลับ' }, { key: 'ยอดขายสินค้าผลักดัน', label: 'สินค้าผลักดัน' },
      { key: 'ยอดค้างชำระ', label: 'ค้างชำระ' }, { key: 'หมายเหตุ', label: 'หมายเหตุ' }
    ];
  } else {
    formHtml = '<label>ยอดขาย</label><input type="number" id="smSales">' +
      '<div class="row"><div><label>ลูกค้าใหม่</label><input type="number" id="smNewCustomers"></div><div><label>ลูกค้าที่ดูแล</label><input type="number" id="smManaged"></div></div>' +
      '<label>Order</label><input type="number" id="smOrderCount">' +
      '<label>ปัญหา/Order ผิด</label><input type="number" id="smOrderIssue">' +
      '<label>หมายเหตุ</label><input type="text" id="smNote">';
    cols = [
      { key: 'ยอดขาย', label: 'ยอดขาย' }, { key: 'ลูกค้าใหม่', label: 'ลูกค้าใหม่' },
      { key: 'ลูกค้าที่ดูแล', label: 'ลูกค้าที่ดูแล' }, { key: 'Order', label: 'Order' },
      { key: 'ปัญหา/Order ผิด', label: 'ปัญหา/Order ผิด' }, { key: 'หมายเหตุ', label: 'หมายเหตุ' }
    ];
  }
  var html =
    '<div class="card"><h3>' + (kind === 'field' ? '🚗 Sales Field' : '🛒 Sales Online') + '</h3><div class="cardSubtitle">กรอกยอดประจำเดือน</div>' + monthPickerHtml('sm', APP.month, APP.year) +
    '<label>พนักงาน</label><select id="smEmp">' + employeeOptions(list) + '</select>' +
    formHtml +
    '<button class="btn" id="smSave">✓ บันทึก</button></div>' +
    '<div class="card"><h3>🗂️ สรุปเดือนนี้</h3><div id="smList" class="muted">กำลังโหลด...</div></div>';
  document.getElementById('content').innerHTML = html;

  document.getElementById('sm_go').addEventListener('click', load);
  load();
  document.getElementById('smSave').addEventListener('click', function (evt) {
    var payload = kind === 'field' ? {
      employeeId: document.getElementById('smEmp').value,
      month: Number(document.getElementById('sm_m').value), year: Number(document.getElementById('sm_y').value),
      personalSales: document.getElementById('smPersonalSales').value, personalTarget: document.getElementById('smTarget').value,
      newCustomers: document.getElementById('smNewCustomers').value,
      wonBackCustomers: document.getElementById('smWonBack').value, pushProductSales: document.getElementById('smPush').value,
      outstandingAmount: document.getElementById('smOutstanding').value, note: document.getElementById('smNote').value
    } : {
      employeeId: document.getElementById('smEmp').value,
      month: Number(document.getElementById('sm_m').value), year: Number(document.getElementById('sm_y').value),
      sales: document.getElementById('smSales').value, newCustomers: document.getElementById('smNewCustomers').value,
      managedCustomers: document.getElementById('smManaged').value, orderCount: document.getElementById('smOrderCount').value,
      orderIssue: document.getElementById('smOrderIssue').value, note: document.getElementById('smNote').value
    };
    withButtonGuard(evt.target, function () { return apiPost('upsertSalesMonthly', { kind: kind, payload: payload }); })
      .then(function () { toast('บันทึกแล้ว'); load(); }).catch(function (e) { toast(e.message || String(e), true); });
  });

  function load() {
    var m = Number(document.getElementById('sm_m').value), y = Number(document.getElementById('sm_y').value);
    apiGet('salesMonthlyAll', { kind: kind, month: m, year: y }).then(function (rows) {
      var el = document.getElementById('smList');
      if (!el) return; // สลับแท็บไปแล้วระหว่างรอโหลด — ไม่มีอะไรให้อัปเดต ไม่ต้อง toast error (เคยเจอ error "Cannot set properties of null" ตรงนี้)
      if (!rows.length) { el.innerHTML = '<div class="muted">ยังไม่มีข้อมูลเดือนนี้</div>'; return; }
      el.innerHTML = '<div style="overflow-x:auto"><table class="simple"><tr><th>ชื่อ</th>' + cols.map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('') + '</tr>' +
        rows.map(function (r) { return '<tr><td>' + esc(r['ชื่อพนักงาน']) + '</td>' + cols.map(function (c) { return '<td>' + (c.key === 'หมายเหตุ' ? esc(r[c.key]) : fmtNum(r[c.key])) + '</td>'; }).join('') + '</tr>'; }).join('') + '</table></div>';
    }).catch(function (e) { if (document.getElementById('smList')) toast(e.message || String(e), true); });
  }
}

/* ---- 4. Error ---- */
// ผู้รับผิดชอบใช้แบบ "+ เพิ่มผู้รับผิดชอบ" ทีละแถว (เพิ่ม/ลบได้ไม่จำกัด) แทน Checklist รายชื่อทั้งหมด
// เริ่มต้นด้วย 1 แถวว่างให้เลยเพื่อไม่ต้องกดเพิ่มเองตั้งแต่แถวแรก
function renderAdminError() {
  // PHASE 1 (รอบแก้ Error 5 ระดับ): "ประเภทความผิด" ไม่ผูกระดับความรุนแรงแล้ว (ตัด data-severity ออก) — ระดับเริ่มต้นมาจาก
  // Dropdown "ผลกระทบ" แยกต่างหากด้านล่างแทน เพราะ Error ประเภทเดียวกันเกิดผลกระทบต่างกันได้ในแต่ละครั้ง
  var typeOptions = APP.errorTypes.map(function (t) { return '<option value="' + t['รหัสประเภท'] + '">' + esc(t['ชื่อประเภทความผิด']) + '</option>'; }).join('');
  var impactOptions = APP.impactOptions.map(function (i) { return '<option value="' + esc(i.key) + '" data-level="' + i.defaultLevel + '">' + esc(i.label) + '</option>'; }).join('');
  var severityOptions = APP.severityLevels.map(function (s) { return '<option value="' + s.level + '">' + esc(s.label) + '</option>'; }).join('');
  // UI/UX Redesign: การ์ดผลกระทบโชว์ "→ X" เฉยๆ (ไม่มีคำว่า "ระดับ" และไม่โชว์คะแนน) เพราะผลกระทบเองไม่ได้หักคะแนนตรงๆ แค่กำหนดระดับเริ่มต้นให้
  // คะแนนที่หักจริงมาจาก "ระดับความรุนแรง" เพียงจุดเดียวเท่านั้น (ดู submitErrorEvent ฝั่ง Backend: points = severityPoints(finalSeverity))
  // การแยกโชว์แบบนี้ตัดความสับสนเรื่อง "หักซ้ำสองต่อ" ที่พี่ถาม — ไม่มีจุดไหนบวกคะแนนจาก 2 ช่องนี้พร้อมกันเลย
  // ตัดคำว่า "ระดับ" ออกจากการ์ดผลกระทบตามที่พี่แจ้ง (สับสนกับ "ระดับความรุนแรง" ด้านล่างที่เป็นคนละเรื่องกัน) เหลือแค่ลูกศรชี้ไปเลขข้อที่จะตั้งให้อัตโนมัติ
  var impactCardsHtml = cardSelectHtml('eImpactCards', APP.impactOptions.map(function (i) {
    return { value: i.key, title: i.label, desc: i.desc, pointsLabel: '→ ' + i.defaultLevel };
  }));
  var severityCardsHtml = cardSelectHtml('eSeverityCards', APP.severityLevels.map(function (s) {
    return { value: String(s.level), title: s.label, desc: s.desc, pointsLabel: fmtNum(s.points), highLevel: s.level === 5 };
  }));

  var html =
    '<div class="card"><h3>⚠️ บันทึกความผิด</h3><div class="cardSubtitle">บันทึกและติดตามเหตุการณ์ความผิดพลาดในการทำงาน</div>' +
    '<div id="eMonthStats" class="statGrid mt0"></div></div>' +

    '<div class="card"><h3>👥 ผู้รับผิดชอบ &amp; ผู้แจ้ง</h3><div class="cardSubtitle">ทุกคนได้คะแนนเต็มตามระดับ ไม่หารเฉลี่ย — เลือกได้แม้ผู้รับผิดชอบมาจากคนละแผนกกัน (ระบบแยกแผนกให้อัตโนมัติ ดูด้านล่าง)</div>' +
    '<label>ผู้รับผิดชอบ</label>' +
    '<div id="eRespRows"></div>' +
    '<button class="btn secondary small" id="eAddResp">+ เพิ่มผู้รับผิดชอบ</button>' +
    '<label style="margin-top:18px;">ผู้แจ้งปัญหา (ถ้ามี — เว้นว่างได้ถ้าไม่มีคนแจ้งเป็นพิเศษ เช่นหัวหน้าเจอเอง)</label>' +
    '<select id="eReporter"><option value="">— ไม่มี / ไม่ระบุ —</option>' + employeeOptionsWithDept(APP.employees) + '</select>' +
    '<div class="muted" id="eReporterHint" style="display:none;"></div></div>' +

    '<div class="card"><h3>📋 ข้อมูลเหตุการณ์</h3>' +
    '<div class="row"><div><label>วันที่เกิดเหตุ</label><input type="date" id="eDate" value="' + todayStr() + '"></div>' +
    '<div><label>แผนก (อัตโนมัติจากผู้รับผิดชอบที่เลือกด้านบน)</label><input type="text" id="eDept" readonly placeholder="— เลือกผู้รับผิดชอบก่อน —"></div></div>' +
    '<label>ประเภทความผิด</label><select id="eType">' + typeOptions + '</select>' +
    '<label>รายละเอียดเหตุการณ์</label><textarea id="eDesc"></textarea>' +
    '<label>ค่าเสียหายจริง (บาท ถ้ามี — ไม่มีผลต่อคะแนน)</label><input type="number" id="eDamage"></div>' +

    '<div class="card"><h3>🎯 ผลกระทบ</h3><div class="cardSubtitle">กำหนดระดับความรุนแรงเริ่มต้นให้อัตโนมัติ</div>' +
    '<select id="eImpact" class="hiddenSelect">' + impactOptions + '</select>' + impactCardsHtml +
    '<div class="muted" id="eImpactDesc" style="margin-top:10px;"></div>' +
    '<hr class="sectionDivider">' +
    '<h3 style="margin-bottom:2px;">⚠️ ระดับความรุนแรง</h3><div class="cardSubtitle">ปรับเองได้ทุกข้อตามดุลยพินิจ — เลือกระดับ 5 เฉพาะเสียหายเป็นเงินจริง + ตั้งใจปกปิด</div>' +
    '<select id="eSeverity" class="hiddenSelect">' + severityOptions + '</select>' + severityCardsHtml +
    '<div class="muted" id="eSeverityDesc" style="margin-top:10px;"></div>' +
    '<div class="calloutBox" style="margin-top:12px;">คะแนนที่หักจริงมาจาก "ระดับความรุนแรง" ด้านบนเพียงจุดเดียวเท่านั้น — "ผลกระทบ" ใช้แค่ตั้งระดับเริ่มต้นให้ ไม่ได้หักคะแนนซ้ำอีกต่อ</div>' +
    '<label>เหตุผล (กรอกเฉพาะถ้าปรับระดับต่างจากค่าเริ่มต้นตามผลกระทบที่เลือก)</label><input type="text" id="eReason">' +
    '<button class="btn" id="eSave" style="margin-top:16px;">✓ บันทึกเหตุการณ์</button></div>' +

    '<div class="card"><h3>🗂️ เหตุการณ์เดือนนี้</h3>' + monthPickerHtml('el', APP.month, APP.year) + '<div id="elList" class="muted timeline">กำลังโหลด...</div></div>';
  document.getElementById('content').innerHTML = html;
  wireCardSelect('eImpact');
  wireCardSelect('eSeverity');

  // PHASE 1: คะแนนรางวัลผู้แจ้งเป็นค่าคงที่จาก Config เสมอ (คำนวณฝั่ง Backend ล้วนๆ) — ตรงนี้แค่โชว์ตัวเลขที่จะได้ให้ดูก่อนบันทึก ไม่ให้แก้เอง
  function syncReporterHint() {
    var reporterId = document.getElementById('eReporter').value;
    var hint = document.getElementById('eReporterHint');
    if (!reporterId) { hint.style.display = 'none'; return; }
    hint.style.display = '';
    var responsibleIds = Array.prototype.slice.call(document.querySelectorAll('.eRespSel')).map(function (s) { return s.value; }).filter(Boolean);
    var isSelf = responsibleIds.indexOf(reporterId) !== -1;
    var d = APP.reportRewardDefaults || {};
    var pts = isSelf ? d.self : d.external;
    hint.textContent = (isSelf ? 'ผู้แจ้งคือผู้รับผิดชอบเอง (สารภาพเอง)' : 'ผู้แจ้งไม่ใช่ผู้รับผิดชอบ (แจ้งจากคนอื่น)') +
      ' — จะได้ Reward Points +' + (pts != null ? fmtNum(pts) : '?') + ' คะแนน (สถานะ Approved ทันที ปรับได้ทีหลังจากรายการเดือนนี้)';
  }
  document.getElementById('eReporter').addEventListener('change', syncReporterHint);

  // "แผนก" ไม่ให้เลือกเองแยกต่างหากแล้ว — ดึงมาจากแผนกของผู้รับผิดชอบที่เลือกไว้ด้านบนโดยตรง (กันต้องมานั่งกดเลือกซ้ำ
  // และกันแผนกไม่ตรงกับตัวคนที่เลือกจริง) ถ้าผู้รับผิดชอบมาจากคนละแผนกกัน จะรวมชื่อแผนกทั้งหมดมาแสดง (คั่นด้วย , )
  // ฟิลด์นี้เป็นแค่ข้อมูลอ้างอิง/รายงาน ไม่มีผลต่อคะแนนหรือเงินใดๆ เลย (คะแนนหักจากระดับความรุนแรงต่อคนเท่านั้น)
  function syncDeptFromResponsible() {
    var responsibleIds = Array.prototype.slice.call(document.querySelectorAll('.eRespSel')).map(function (s) { return s.value; }).filter(Boolean);
    var depts = [];
    responsibleIds.forEach(function (id) {
      var emp = APP.employees.filter(function (e) { return e.id === id; })[0];
      if (emp && emp.department && depts.indexOf(emp.department) === -1) depts.push(emp.department);
    });
    document.getElementById('eDept').value = depts.join(', ');
  }

  var respCount = 0;
  function addRespRow() {
    respCount++;
    var row = document.createElement('div');
    row.className = 'chipRow';
    row.innerHTML = '<select class="eRespSel">' + employeeOptionsWithDept(APP.employees) + '</select>' +
      '<button class="chipRemove eRespRemove" type="button" title="ลบ">✕</button>';
    document.getElementById('eRespRows').appendChild(row);
    row.querySelector('.eRespSel').addEventListener('change', function () { syncReporterHint(); syncDeptFromResponsible(); });
    row.querySelector('.eRespRemove').addEventListener('click', function () {
      row.remove();
      if (!document.querySelectorAll('.eRespSel').length) addRespRow(); // เหลืออย่างน้อย 1 แถวเสมอ
      syncReporterHint(); syncDeptFromResponsible();
    });
  }
  document.getElementById('eAddResp').addEventListener('click', function () { addRespRow(); syncReporterHint(); syncDeptFromResponsible(); });
  addRespRow(); // เริ่มด้วย 1 แถวว่างให้เลย
  syncDeptFromResponsible();

  // PHASE 1 (รอบแก้ Error 5 ระดับ): "ผลกระทบ" เป็นตัวกำหนดระดับความรุนแรงเริ่มต้น (ไม่ใช่ "ประเภทความผิด" อีกต่อไป)
  function syncSeverityToImpact() {
    var impactSel = document.getElementById('eImpact');
    var severitySel = document.getElementById('eSeverity');
    var opt = impactSel.options[impactSel.selectedIndex];
    if (opt) {
      severitySel.value = opt.getAttribute('data-level');
      if (severitySel._cardSync) severitySel._cardSync(); // UI-only: อัปเดตการ์ดที่ไฮไลต์ให้ตรงกับค่าที่เพิ่งตั้งตรงๆ (ไม่ผ่านการคลิกการ์ด)
    }
    var impactInfo = APP.impactOptions.filter(function (i) { return i.key === impactSel.value; })[0];
    document.getElementById('eImpactDesc').textContent = impactInfo ? impactInfo.desc : '';
    var lvl = Number(severitySel.value);
    var info = APP.severityLevels.filter(function (s) { return s.level === lvl; })[0];
    document.getElementById('eSeverityDesc').textContent = info ? info.desc : '';
  }
  document.getElementById('eSeverity').addEventListener('change', function () {
    var lvl = Number(this.value);
    var info = APP.severityLevels.filter(function (s) { return s.level === lvl; })[0];
    document.getElementById('eSeverityDesc').textContent = info ? info.desc : '';
  });
  document.getElementById('eImpact').addEventListener('change', syncSeverityToImpact);
  syncSeverityToImpact();

  document.getElementById('eSave').addEventListener('click', function (evt) {
    var typeSel = document.getElementById('eType');
    var impactSel = document.getElementById('eImpact');
    var defaultSeverity = Number(impactSel.options[impactSel.selectedIndex].getAttribute('data-level'));
    var chosenSeverity = Number(document.getElementById('eSeverity').value);
    var responsibleIds = Array.prototype.slice.call(document.querySelectorAll('.eRespSel')).map(function (s) { return s.value; }).filter(Boolean);
    responsibleIds = responsibleIds.filter(function (id, idx) { return responsibleIds.indexOf(id) === idx; }); // กันเลือกคนเดียวกันซ้ำหลายแถว
    if (!responsibleIds.length) { toast('เลือกผู้รับผิดชอบอย่างน้อย 1 คน', true); return; }
    var reporterId = document.getElementById('eReporter').value;
    var payload = {
      date: document.getElementById('eDate').value, department: document.getElementById('eDept').value, errorTypeId: typeSel.value,
      impact: impactSel.value,
      severityOverride: chosenSeverity !== defaultSeverity ? chosenSeverity : '', overrideReason: document.getElementById('eReason').value,
      description: document.getElementById('eDesc').value, damageAmount: document.getElementById('eDamage').value, responsibleIds: responsibleIds,
      reporterId: reporterId // คะแนน/สถานะรางวัลผู้แจ้งคำนวณฝั่ง Backend ล้วนๆ จาก Config เสมอ (PHASE 1) ไม่ส่งจาก Client แล้ว
    };
    withButtonGuard(evt.target, function () { return apiPost('submitErrorEvent', payload); })
      .then(function (r) {
        var msg = 'บันทึกแล้ว ' + r.eventId + ' (' + r.pointsPerPerson + ' คะแนน/คน)';
        if (r.reward) msg += ' + ให้รางวัลผู้แจ้ง ' + fmtNum(r.reward.points) + ' คะแนน (' + (r.reward.isSelfReport ? 'สารภาพเอง' : 'แจ้งจากคนอื่น') + ')';
        toast(msg); renderAdminError();
      })
      .catch(function (e) { toast(e.message || String(e), true); });
  });

  function statusBadge(s) { var cls = s === 'Approved' ? 'approved' : (s === 'Rejected' ? 'rejected' : 'pending'); return '<span class="badge ' + cls + '">' + s + '</span>'; }

  document.getElementById('el_go').addEventListener('click', loadEvents);
  loadEvents();
  function renderMonthStats(rows) {
    var stats = document.getElementById('eMonthStats');
    var totalDeduct = rows.reduce(function (s, r) { return s + (Number(r['คะแนนต่อคน']) || 0); }, 0);
    var respSet = {};
    rows.forEach(function (r) { String(r['ผู้รับผิดชอบ'] || '').split(',').forEach(function (n) { n = n.trim(); if (n) respSet[n] = true; }); });
    stats.innerHTML =
      '<div class="statCard accentAmber"><span class="statIcon">🗂️</span><div class="statLabel">Error เดือนนี้</div><div class="statValue">' + rows.length + '</div></div>' +
      '<div class="statCard accentAmber"><span class="statIcon">📉</span><div class="statLabel">คะแนนที่ถูกหักรวม</div><div class="statValue">' + fmtNum(totalDeduct) + '</div></div>' +
      '<div class="statCard accentAmber"><span class="statIcon">👥</span><div class="statLabel">จำนวนผู้รับผิดชอบ</div><div class="statValue">' + Object.keys(respSet).length + '</div></div>';
  }
  function loadEvents() {
    apiGet('errorEventsForMonth', { month: Number(document.getElementById('el_m').value), year: Number(document.getElementById('el_y').value) }).then(function (rows) {
      renderMonthStats(rows);
      var el = document.getElementById('elList');
      if (!rows.length) { el.innerHTML = '<div class="muted">ไม่มีข้อมูลเดือนนี้</div>'; return; }
      el.innerHTML = rows.map(function (r) {
        var reporterHtml = r['รหัสรางวัล']
          ? '<div class="meta">ผู้แจ้ง: ' + esc(r['ชื่อผู้แจ้ง']) + ' (' + esc(r['ประเภทการแจ้ง']) + ', +' + fmtNum(r['คะแนนรางวัลผู้แจ้ง']) + ' คะแนน) ' + statusBadge(r['สถานะรางวัล']) +
            ' <select class="rwStChg" data-id="' + r['รหัสรางวัล'] + '"><option ' + (r['สถานะรางวัล'] === 'Pending' ? 'selected' : '') + '>Pending</option><option ' + (r['สถานะรางวัล'] === 'Approved' ? 'selected' : '') + '>Approved</option><option ' + (r['สถานะรางวัล'] === 'Rejected' ? 'selected' : '') + '>Rejected</option></select></div>'
          : '';
        return '<div class="list-item"><b>' + esc(r['รหัสเหตุการณ์']) + '</b> — ' + esc(r['ชื่อประเภทความผิด']) + ' — ' + esc(r['ผลกระทบ']) + ' (ระดับ ' + r['ระดับ'] + ', ' + r['คะแนนต่อคน'] + ')<div class="meta">' + fmtDate(r['วันที่']) + ' · ' + esc(r['แผนก']) + ' · ผู้รับผิดชอบ: ' + esc(r['ผู้รับผิดชอบ']) + '</div>' + reporterHtml + '</div>';
      }).join('');
      Array.prototype.forEach.call(el.querySelectorAll('.rwStChg'), function (sel) {
        sel.addEventListener('change', function () {
          sel.disabled = true;
          apiPost('updateReportRewardStatus', { id: sel.getAttribute('data-id'), status: sel.value })
            .then(function () { sel.disabled = false; toast('อัปเดตแล้ว'); })
            .catch(function (e) { sel.disabled = false; toast(e.message || String(e), true); });
        });
      });
    }).catch(function (e) { toast(e.message || String(e), true); });
  }
}

/* ---- 5. Good Deed ---- */
function renderAdminGoodDeed() {
  var categories = ['ปิดไฟ/ปิดอุปกรณ์', 'ทำความสะอาดพื้นที่ส่วนรวม', 'ช่วยงานส่วนรวม', 'ช่วยแก้ปัญหาให้บริษัท', 'แจ้งปัญหาที่ช่วยป้องกันความเสียหาย', 'อื่นๆ'];
  // PHASE 1: คะแนนเป็นค่าคงที่จาก Config (Cfg_GoodDeedPoints) แล้ว ไม่ให้พิมพ์เองต่อรายการอีกต่อไป — ตัดช่องกรอกคะแนนออก
  var pts = (APP.goodDeedPoints != null) ? APP.goodDeedPoints : 1;
  var html =
    '<div class="card"><h3>🌟 ทำความดี / Reward Points</h3><div class="cardSubtitle">บันทึกความดีเพื่อสะสม Reward Points — แลกรางวัลตามเกณฑ์บริษัท</div>' +
    '<div class="calloutBox mt0 amber">Reward Points สะสม <b>แยกจาก Performance Score 100 คะแนนโดยสิ้นเชิง</b> ไม่นำไปรวม/หัก/บวกกับคะแนนรวม 100 คะแนนไม่ว่ากรณีใด</div></div>' +

    '<div class="card"><h3>📝 บันทึกรายการใหม่</h3>' +
    '<div class="row"><div><label>วันที่</label><input type="date" id="gdDate" value="' + todayStr() + '"></div>' +
    '<div><label>พนักงาน</label><select id="gdEmp">' + employeeOptions(APP.employees) + '</select></div></div>' +
    '<label>ประเภท</label><select id="gdCat">' + categories.map(function (c) { return '<option>' + c + '</option>'; }).join('') + '</select>' +
    '<label>รายละเอียด</label><textarea id="gdDesc"></textarea>' +
    '<div class="muted">ได้ Reward Points +' + fmtNum(pts) + ' คะแนน (ค่าคงที่ต่อรายการ ปรับได้ที่ Config &gt; Cfg_GoodDeedPoints) เมื่อสถานะเป็น Approved</div>' +
    '<button class="btn" id="gdSave">✓ บันทึก</button></div>' +

    '<div class="card"><h3>🗂️ รายการเดือนนี้</h3>' + monthPickerHtml('gdm', APP.month, APP.year) + '<div id="gdList" class="muted timeline">กำลังโหลด...</div></div>';
  document.getElementById('content').innerHTML = html;

  document.getElementById('gdSave').addEventListener('click', function (evt) {
    var payload = {
      date: document.getElementById('gdDate').value, employeeId: document.getElementById('gdEmp').value,
      category: document.getElementById('gdCat').value, description: document.getElementById('gdDesc').value
    };
    withButtonGuard(evt.target, function () { return apiPost('addGoodDeed', payload); })
      .then(function () { toast('บันทึกแล้ว'); loadList(); }).catch(function (e) { toast(e.message || String(e), true); });
  });

  function statusBadge(s) { var cls = s === 'Approved' ? 'approved' : (s === 'Rejected' ? 'rejected' : 'pending'); return '<span class="badge ' + cls + '">' + s + '</span>'; }

  document.getElementById('gdm_go').addEventListener('click', loadList);
  loadList();
  function loadList() {
    apiGet('goodDeedForMonth', { month: Number(document.getElementById('gdm_m').value), year: Number(document.getElementById('gdm_y').value) }).then(function (rows) {
      var el = document.getElementById('gdList');
      if (!rows.length) { el.innerHTML = '<div class="muted">ยังไม่มีข้อมูล</div>'; return; }
      el.innerHTML = rows.map(function (r) {
        return '<div class="list-item">' + statusBadge(r['สถานะ']) + ' <b>' + esc(r['ชื่อพนักงาน']) + '</b> — ' + esc(r['ประเภท']) + ' (+' + fmtNum(r['คะแนน']) + ')<div class="meta">' + fmtDate(r['วันที่']) + ' · ' + esc(r['รายละเอียด']) + '</div>' +
          '<select class="gdStChg" data-id="' + r['รหัสรายการ'] + '"><option ' + (r['สถานะ'] === 'Pending' ? 'selected' : '') + '>Pending</option><option ' + (r['สถานะ'] === 'Approved' ? 'selected' : '') + '>Approved</option><option ' + (r['สถานะ'] === 'Rejected' ? 'selected' : '') + '>Rejected</option></select></div>';
      }).join('');
      Array.prototype.forEach.call(el.querySelectorAll('.gdStChg'), function (sel) {
        sel.addEventListener('change', function () {
          sel.disabled = true;
          apiPost('updateGoodDeedStatus', { id: sel.getAttribute('data-id'), status: sel.value })
            .then(function () { sel.disabled = false; toast('อัปเดตแล้ว'); })
            .catch(function (e) { sel.disabled = false; toast(e.message || String(e), true); });
        });
      });
    }).catch(function (e) { toast(e.message || String(e), true); });
  }
}

/* ---- 6. Report Reward ---- */
// ผนวกเข้ากับฟอร์ม "บันทึกเหตุการณ์ความผิด" แล้ว (ดู renderAdminError ด้านบน — ช่อง "ผู้แจ้งปัญหา")
// ไม่มีแท็บ/ฟอร์มแยกอีกต่อไป เพราะทุกการแจ้งเป็นเรื่องเดียวกับเหตุการณ์ความผิดเสมอ

/* ---- 7. Attendance ---- */
// บันทึกเฉพาะวันที่ผิดปกติ (ขาด/ลา/มาสาย) เท่านั้น — ไม่มีแถวของวันนั้นถือว่ามาปกติ ไม่ต้องกรอกทุกวัน
// UI/UX Redesign: ป้ายผลคะแนนต่อสถานะด้านล่างเป็น "ค่าคงที่แสดงผลอย่างเดียว" อิงตามค่าเริ่มต้นใน Config
// (Cfg_AbsentDeduct=-5, Cfg_LeaveApprovedDeduct=0, Cfg_LeaveUnapprovedDeduct=-3, Cfg_LateDeduct=-1, Cfg_AttendancePerfectBonus=+5)
// ไม่ได้ดึงจาก Config สดๆ — ถ้าพี่ปรับตัวเลขพวกนี้ใน Config ทีหลัง ป้ายตรงนี้ควรแก้ตามด้วย ไม่มีผลต่อการคำนวณคะแนนจริงเลย (คำนวณฝั่ง Backend ล้วนๆ เหมือนเดิม)
var ATTENDANCE_EFFECT_LABELS = { 'ขาด': '-5', 'ลาอนุมัติ': '0', 'ลาไม่อนุมัติ': '-3', 'มาสาย': '-1' };
function renderAdminAttendance() {
  var statusOptions = APP.attendanceStatuses.map(function (s) {
    var lbl = ATTENDANCE_EFFECT_LABELS[s];
    return '<option value="' + s + '">' + esc(s) + (lbl ? ' (' + lbl + ')' : '') + '</option>';
  }).join('');
  var leaveTypeOptions = '<option value="">ไม่ระบุ (ไม่หักเบี้ยขยัน)</option>' + APP.leaveTypes.map(function (t) {
    return '<option value="' + esc(t) + '">' + esc(t) + '</option>';
  }).join('');
  var html =
    '<div class="card"><h3>🗓️ Attendance</h3><div class="cardSubtitle">บันทึกเฉพาะวันที่ผิดปกติ (ขาด/ลา/มาสาย) — วันไหนไม่มีแถวถือว่ามาปกติ ไม่ต้องกรอกทุกวัน</div>' +
    '<div id="atMonthStats" class="statGrid mt0">กำลังโหลด...</div></div>' +

    '<div class="card"><h3>📋 บันทึกรายการใหม่</h3>' +
    '<div class="row"><div><label>พนักงาน</label><select id="atEmp">' + employeeOptions(APP.employees) + '</select></div>' +
    '<div><label>วันที่</label><input type="date" id="atDate" value="' + todayStr() + '"></div></div>' +
    '<label>สถานะ</label><select id="atStatus">' + statusOptions + '</select>' +
    '<div id="atLateMinutesWrap" style="display:none;"><label>นาทีที่มาสาย</label><input type="number" id="atLateMinutes" min="0" max="600" step="1" placeholder="ไม่บังคับ — ใช้คำนวณเบี้ยขยันเท่านั้น"></div>' +
    '<div id="atLeaveTypeWrap" style="display:none;"><label>ประเภทการลา (ใช้คำนวณเบี้ยขยัน)</label><select id="atLeaveType">' + leaveTypeOptions + '</select></div>' +
    '<label>หมายเหตุ</label><input type="text" id="atNote" placeholder="ไม่บังคับ">' +
    '<button class="btn" id="atSave">✓ บันทึก</button></div>' +

    '<div class="card"><h3>🗂️ ประวัติเดือนนี้</h3>' + monthPickerHtml('at', APP.month, APP.year) + '<div id="atList" class="muted timeline">กำลังโหลด...</div></div>';
  document.getElementById('content').innerHTML = html;

  function syncConditionalFields() {
    var status = document.getElementById('atStatus').value;
    document.getElementById('atLateMinutesWrap').style.display = (status === 'มาสาย') ? '' : 'none';
    document.getElementById('atLeaveTypeWrap').style.display = (status === 'ลาอนุมัติ' || status === 'ลาไม่อนุมัติ') ? '' : 'none';
  }
  document.getElementById('atStatus').addEventListener('change', syncConditionalFields);
  syncConditionalFields();

  document.getElementById('atSave').addEventListener('click', function (evt) {
    var status = document.getElementById('atStatus').value;
    var payload = {
      employeeId: document.getElementById('atEmp').value,
      date: document.getElementById('atDate').value,
      status: status,
      note: document.getElementById('atNote').value,
      lateMinutes: (status === 'มาสาย') ? document.getElementById('atLateMinutes').value : '',
      leaveType: (status === 'ลาอนุมัติ' || status === 'ลาไม่อนุมัติ') ? document.getElementById('atLeaveType').value : ''
    };
    withButtonGuard(evt.target, function () { return apiPost('addAttendanceLog', payload); })
      .then(function () {
        toast('บันทึกแล้ว'); document.getElementById('atNote').value = '';
        document.getElementById('atLateMinutes').value = ''; document.getElementById('atLeaveType').value = '';
        loadList();
      })
      .catch(function (e) { toast(e.message || String(e), true); });
  });

  function renderMonthStats(rows) {
    var counts = { 'ขาด': 0, 'ลาอนุมัติ': 0, 'ลาไม่อนุมัติ': 0, 'มาสาย': 0 };
    rows.forEach(function (r) { if (counts.hasOwnProperty(r['สถานะ'])) counts[r['สถานะ']]++; });
    var area = document.getElementById('atMonthStats');
    area.innerHTML =
      '<div class="statCard accentAmber"><span class="statIcon">🚫</span><div class="statLabel">ขาด</div><div class="statValue">' + counts['ขาด'] + '</div></div>' +
      '<div class="statCard"><span class="statIcon">📄</span><div class="statLabel">ลาอนุมัติ</div><div class="statValue">' + counts['ลาอนุมัติ'] + '</div></div>' +
      '<div class="statCard accentAmber"><span class="statIcon">⚠️</span><div class="statLabel">ลาไม่อนุมัติ</div><div class="statValue">' + counts['ลาไม่อนุมัติ'] + '</div></div>' +
      '<div class="statCard accentBlue"><span class="statIcon">⏰</span><div class="statLabel">มาสาย</div><div class="statValue">' + counts['มาสาย'] + '</div></div>';
  }

  document.getElementById('at_go').addEventListener('click', loadList);
  loadList();
  function loadList() {
    apiGet('attendanceLogForMonth', { month: Number(document.getElementById('at_m').value), year: Number(document.getElementById('at_y').value) }).then(function (rows) {
      renderMonthStats(rows);
      var el = document.getElementById('atList');
      if (!rows.length) { el.innerHTML = '<div class="muted">ไม่มีบันทึกผิดปกติในเดือนนี้ (ถือว่าทุกคนมาปกติ)</div>'; return; }
      el.innerHTML = rows.map(function (r) {
        var lbl = ATTENDANCE_EFFECT_LABELS[r['สถานะ']];
        var extra = '';
        if (r['สถานะ'] === 'มาสาย' && r['นาทีที่มาสาย'] !== '' && r['นาทีที่มาสาย'] !== undefined && r['นาทีที่มาสาย'] !== null) {
          extra = ' · สาย ' + esc(r['นาทีที่มาสาย']) + ' นาที';
        } else if ((r['สถานะ'] === 'ลาอนุมัติ' || r['สถานะ'] === 'ลาไม่อนุมัติ') && r['ประเภทการลา']) {
          extra = ' · ' + esc(r['ประเภทการลา']);
        }
        return '<div class="list-item"><b>' + esc(r['ชื่อพนักงาน']) + '</b> — ' + esc(r['สถานะ']) + (lbl ? ' <span class="muted">(' + lbl + ')</span>' : '') + extra + '<div class="meta">' + fmtDate(r['วันที่']) + (r['หมายเหตุ'] ? ' · ' + esc(r['หมายเหตุ']) : '') + '</div></div>';
      }).join('');
    }).catch(function (e) { toast(e.message || String(e), true); });
  }
}

/* ---- 7.5 ปฏิทินบริษัท — ดึงข้อมูลเดียวกับ Attendance (action attendanceLogForMonth เดิม) มาแสดงเป็นปฏิทินรายวัน
   1 บรรทัดต่อ 1 คนต่อ 1 เหตุการณ์ต่อวัน (ขาด/ลา/สาย) + ตารางสรุปเบี้ยขยันของทุกคนต่อท้าย — เบี้ยขยันย้ายมาอยู่หน้านี้แทน
   หน้า "สรุปคะแนน/เงิน" แล้วตามที่พี่ขอ (ไม่ได้แก้สูตรคำนวณเบี้ยขยันใดๆ เลย แค่ย้ายที่แสดงผล) ---- */
function renderAdminCalendar() {
  var state = { month: APP.month, year: APP.year };
  var html =
    '<div class="card">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">' +
    '<h3>📅 ปฏิทินบริษัท</h3>' +
    '<div style="display:flex;align-items:center;gap:10px;">' +
    '<button class="btn secondary small" id="calPrev">← ก่อนหน้า</button>' +
    '<b id="calLabel" style="min-width:78px;text-align:center;"></b>' +
    '<button class="btn secondary small" id="calNext">ถัดไป →</button>' +
    '</div></div>' +
    '<div class="cardSubtitle">ขาด/ลา/มาสายของทุกคนในแต่ละวัน — เชื่อมกับข้อมูลแท็บ "Attendance" โดยตรง ไม่ต้องกรอกซ้ำ</div>' +
    '<div id="calGrid" class="muted" style="margin-top:14px;">กำลังโหลด...</div>' +
    '</div>' +
    '<div class="card"><h3>💵 สรุปเบี้ยขยันเดือนนี้</h3><div class="cardSubtitle">คนละก้อนกับเงินพิเศษ/คะแนนโดยสิ้นเชิง ทุกคน Active ได้เท่ากันหมด หักตามนาทีมาสาย/ประเภทการลาที่เห็นในปฏิทินด้านบนเท่านั้น</div><div id="calDiligence" class="muted">กำลังโหลด...</div></div>';
  document.getElementById('content').innerHTML = html;

  document.getElementById('calPrev').addEventListener('click', function () { shiftMonth(-1); });
  document.getElementById('calNext').addEventListener('click', function () { shiftMonth(1); });

  function shiftMonth(delta) {
    var r = addMonths(state.month, state.year, delta);
    state.month = r.month; state.year = r.year;
    load();
  }

  load();

  function load() {
    var label = document.getElementById('calLabel');
    if (label) label.textContent = state.year + '-' + ('0' + state.month).slice(-2);
    var gridEl = document.getElementById('calGrid');
    var diliEl = document.getElementById('calDiligence');
    gridEl.innerHTML = '<div class="muted">กำลังโหลด...</div>';
    diliEl.innerHTML = '<div class="muted">กำลังโหลด...</div>';
    Promise.all([
      apiGet('attendanceLogForMonth', { month: state.month, year: state.year }),
      apiGet('companyDiligenceSummary', { month: state.month, year: state.year })
    ]).then(function (results) {
      if (!document.getElementById('calGrid')) return; // สลับหน้าไปแล้วระหว่างรอโหลด
      renderGrid(results[0]);
      renderDiligence(results[1]);
    }).catch(function (e) {
      if (!document.getElementById('calGrid')) return;
      gridEl.innerHTML = '<div class="muted">โหลดไม่สำเร็จ: ' + esc(e.message || String(e)) + ' <button class="btn secondary" id="calRetry" style="margin-left:8px;">ลองใหม่</button></div>';
      diliEl.innerHTML = '';
      var retryBtn = document.getElementById('calRetry');
      if (retryBtn) retryBtn.addEventListener('click', load);
      toast(e.message || String(e), true);
    });
  }

  // แปลง event 1 แถวจาก Attendance ให้เป็นข้อความบรรทัดเดียวแบบเดียวกับที่ใช้ในแท็บ "Attendance" ทุกประการ
  // (ชื่อ: มาสาย 10 นาที / ชื่อ: ลาป่วยมีใบรับรองแพทย์ / ชื่อ: ขาด) ให้อ่านแล้วเข้าใจตรงกันทั้ง 2 หน้า
  function eventLineLabel(r) {
    if (r['สถานะ'] === 'มาสาย' && r['นาทีที่มาสาย'] !== '' && r['นาทีที่มาสาย'] !== undefined && r['นาทีที่มาสาย'] !== null) {
      return 'สาย ' + r['นาทีที่มาสาย'] + ' นาที';
    }
    if ((r['สถานะ'] === 'ลาอนุมัติ' || r['สถานะ'] === 'ลาไม่อนุมัติ') && r['ประเภทการลา']) {
      return r['ประเภทการลา'];
    }
    return r['สถานะ'];
  }

  function renderGrid(events) {
    var byDay = {};
    events.forEach(function (r) {
      var d = new Date(r['วันที่']);
      var day = d.getDate();
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push({ name: r['ชื่อพนักงาน'], label: eventLineLabel(r), status: r['สถานะ'] });
    });

    var daysInMonth = new Date(state.year, state.month, 0).getDate(); // month เป็น 1-based อยู่แล้ว trick นี้ได้วันสุดท้ายของเดือนพอดี
    var firstDow = new Date(state.year, state.month - 1, 1).getDay(); // 0=อา..6=ส
    var dowLabels = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
    var today = new Date();

    var cellsHtml = '<div class="calDow">' + dowLabels.map(function (d) { return '<div>' + d + '</div>'; }).join('') + '</div>';
    cellsHtml += '<div class="calDays">';
    for (var i = 0; i < firstDow; i++) cellsHtml += '<div class="calCell calCellEmpty"></div>';
    for (var day = 1; day <= daysInMonth; day++) {
      var dayEvents = byDay[day] || [];
      var isToday = (today.getFullYear() === state.year && (today.getMonth() + 1) === state.month && today.getDate() === day);
      cellsHtml += '<div class="calCell' + (isToday ? ' calCellToday' : '') + '"><div class="calDateNum">' + day + '</div>' +
        dayEvents.map(function (ev) {
          var cls = ev.status === 'ขาด' ? 'calEvent calEventAbsent' : (ev.status === 'มาสาย' ? 'calEvent calEventLate' : 'calEvent calEventLeave');
          return '<div class="' + cls + '">' + esc(ev.name) + ': ' + esc(ev.label) + '</div>';
        }).join('') +
        '</div>';
    }
    var totalCells = firstDow + daysInMonth;
    var trailing = (7 - (totalCells % 7)) % 7;
    for (var j = 0; j < trailing; j++) cellsHtml += '<div class="calCell calCellEmpty"></div>';
    cellsHtml += '</div>';
    document.getElementById('calGrid').innerHTML = '<div style="overflow-x:auto"><div style="min-width:700px;">' + cellsHtml + '</div></div>';
  }

  function renderDiligence(rows) {
    var el = document.getElementById('calDiligence');
    if (!rows.length) { el.innerHTML = '<div class="muted">ไม่มีข้อมูล</div>'; return; }
    // พนักงานลาออก (Inactive) ที่เดือนนี้ยังทำงานอยู่จริงจะยังโผล่มาด้วย (ดู hasActivityInMonth ใน Code.gs) ใส่ป้าย
    // "ลาออกแล้ว" ให้แยกแยะจากคนที่ยังทำงานอยู่ปัจจุบัน
    el.innerHTML = '<div style="overflow-x:auto"><table class="simple"><tr><th>ชื่อ</th><th>แผนก</th><th class="colDivider moneyCell">เบี้ยขยัน</th></tr>' +
      rows.map(function (r) {
        var nameHtml = esc(r['ชื่อพนักงาน']) + (r['สถานะ'] && r['สถานะ'] !== 'Active' ? ' <span class="inactiveBadge">ลาออกแล้ว</span>' : '');
        return '<tr' + (r['สถานะ'] && r['สถานะ'] !== 'Active' ? ' class="inactiveRow"' : '') + '><td>' + nameHtml + '</td><td>' + esc(r['แผนก']) + '</td><td class="colDivider moneyCell">' + fmtNum(r['เบี้ยขยัน']) + '</td></tr>';
      }).join('') +
      '<tr class="totalsRow"><td colspan="2">รวมทั้งหมด (' + rows.length + ' คน)</td><td class="colDivider">' + fmtNum(sumField(rows, 'เบี้ยขยัน')) + '</td></tr>' +
      '</table></div>';
  }
}

/* ---- 8. ประเมิน Work Score (PHASE 2 — A ผลงาน 10 + B คุณภาพ 6 + C ความร่วมมือ 4 = เต็ม 20) ---- */
// พนักงานแผนก Support & Strategy (Business Operations Lead) ไม่ให้เลือกในนี้ — มีระบบประเมินแยกต่างหากตามที่สั่ง
// Work Score V2 (รวมหน้า): พี่ขอให้กรอกยอด Sales Field/Online "รวมอยู่ในหน้าเดียวกัน" กับการประเมิน Work Score เลย ไม่ต้องสลับแท็บ
// เลือกพนักงานแผนกไหน แพทเทิร์นการกรอกก็ต่างกันไปอัตโนมัติ (เซลส์วิ่ง/เซลส์ออนไลน์ = มีการ์ดกรอกยอดเดือนนี้โผล่ขึ้นมาก่อน
// แผนกอื่น = ไม่มีการ์ดนี้ ข้ามไปกรอกคะแนน A/B/C ตรงๆ เหมือนเดิม) — แท็บ "Sales Field"/"Sales Online" เดิมยังอยู่เหมือนเดิม
// (มีประโยชน์ตรงที่ดูสรุปยอดของทุกคนในแผนกพร้อมกันได้ทีเดียว) หน้านี้แค่เพิ่มทางลัดกรอกทีละคนแบบไม่ต้องสลับแท็บเฉยๆ
function renderAdminWorkScore() {
  var eligible = APP.employees.filter(function (e) { return e.department !== 'Support & Strategy'; });
  var html =
    '<div class="card"><h3>🎯 Performance Evaluation</h3><div class="cardSubtitle">ประเมิน Work Score เต็ม 20 — ฉันเป็นผู้ประเมินให้ทุกคนโดยตรง ไม่มีการประเมินตนเองหรือเฉลี่ยจากลูกทีม</div>' +
    monthPickerHtml('ws', APP.month, APP.year) +
    '<div id="wsWeightNote"></div>' +
    '<label>พนักงาน</label><select id="wsEmp">' + employeeOptions(eligible) + '</select>' +
    '<div id="wsExisting" class="muted" style="margin:6px 0;">กำลังโหลด...</div>' +
    '<div id="wsAutoCalc" class="calloutBox mt0" style="display:none;"></div>' +
    '<div class="calloutBox mt0">ไม่ต้องหักเพราะมาสาย/ขาด/ลา/Error — คิดแยกในคะแนนความผิด/ขาดลามาสายอยู่แล้ว ดูประวัติการทำงานประกอบได้จากแท็บ "บันทึกงาน" หรือชีต Daily_Work_Log</div></div>' +

    '<div id="wsMonthlyArea"></div>' +

    '<div class="card"><h3>📝 ให้คะแนนผลงาน</h3>' +
    '<label>A. ผลงานตามหน้าที่ (0-10)</label><input type="number" id="wsA" min="0" max="10" step="1">' +
    '<label>B. คุณภาพและความรับผิดชอบ (0-6)</label><input type="number" id="wsB" min="0" max="6" step="1">' +
    '<label id="wsCLabel">C. ความร่วมมือและทัศนคติในการทำงาน (0-4)</label><input type="number" id="wsC" min="0" max="4" step="1">' +
    '<hr class="sectionDivider">' +
    '<div class="progressLabel"><span>Work Score</span><span class="bigNum"><b id="wsSum">0</b><span class="slash"> / 20</span></span></div>' +
    '<div class="progressTrack"><div class="progressFill blue" id="wsProgressFill" style="width:0%"></div></div></div>' +

    '<div class="card"><h3>🗒️ ผู้ประเมิน & หมายเหตุ</h3>' +
    '<label>ผู้ประเมิน</label><input type="text" id="wsEvaluator" placeholder="ชื่อผู้ประเมิน">' +
    '<label>หมายเหตุ</label><textarea id="wsNote" placeholder="เช่น เดือนนี้รับงานเพิ่มและสามารถปิดงานได้เอง"></textarea>' +
    '<button class="btn" id="wsSave">✓ บันทึกคะแนน Work Score</button>' +
    '<div class="muted" style="margin-top:8px;">กดปุ่มนี้แล้วคะแนนรวม/เงินพิเศษจะไปอัปเดตที่ "สรุปคะแนน/เงิน" และ Dashboard ทันที — แค่กรอกยอดขายด้านบนเฉยๆ ยังไม่นับ ต้องกดปุ่มนี้ด้วยเสมอ</div></div>';
  document.getElementById('content').innerHTML = html;
  if (!eligible.length) { return; }

  function updateSum() {
    var elA = document.getElementById('wsA');
    if (!elA) return; // สลับหน้าไปแล้ว ไม่มีอะไรให้อัปเดต
    var a = Number(elA.value) || 0;
    var b = Number(document.getElementById('wsB').value) || 0;
    var c = Number(document.getElementById('wsC').value) || 0;
    var sum = a + b + c;
    setTextIfExists('wsSum', sum);
    var fill = document.getElementById('wsProgressFill');
    if (fill) fill.style.width = Math.max(0, Math.min(100, sum / 20 * 100)) + '%';
  }
  ['wsA', 'wsB', 'wsC'].forEach(function (id) { document.getElementById(id).addEventListener('input', updateSum); });

  // Work Score V2 (เซลส์วิ่ง): สูตรคำนวณคะแนนแนะนำ A/B จากยอด Sales Field เดือนนั้น — อ้างอิงตามเอกสาร
  // FUTAI_WORK_SCORE_FORMULA_SALES.docx ที่พี่ยืนยันแล้ว (C ยังให้พี่ตัดสินใจเองเหมือนเดิม ไม่คำนวณอัตโนมัติ)
  // ถึงเป้า (>=100%) = เต็มคะแนนของหมวดนั้น / ไม่ถึง = (ผลงานจริง ÷ เป้า) x เต็ม ปัดเป็นจำนวนเต็ม, ต่ำสุด 0
  // target <= 0 (ยังไม่ได้กรอกเป้า) คืนค่า null เพื่อแยกจากกรณี "คำนวณได้แล้วได้ 0"
  function ratioScore(actual, target, max) {
    actual = Number(actual) || 0; target = Number(target) || 0;
    if (target <= 0) return null;
    if (actual >= target) return max;
    return Math.max(0, Math.min(max, Math.round(actual / target * max)));
  }

  // Work Score V2 (รวมหน้า): การ์ดกรอกยอด Sales Field/Online เดือนนี้ — โผล่ในหน้านี้เองตามแผนกของพนักงานที่เลือก
  // ใช้ id ขึ้นต้นด้วย wsSm... แยกจาก id ในแท็บ "Sales Field"/"Sales Online" เดิม (smXxx) กันชนกัน แม้จะไม่เคยอยู่ในหน้าเดียวกันจริงก็ตาม
  function workScoreSalesFieldFormHtml() {
    return '<div class="card"><h3>🚗 Sales Field — กรอกยอดเดือนนี้</h3><div class="cardSubtitle">กรอกแล้วกด "บันทึกยอดขาย" ระบบจะคำนวณข้อ A/B ด้านล่างให้ใหม่ทันที (ข้อมูลชุดเดียวกับแท็บ "Sales Field")</div>' +
      '<div class="row"><div><label>ยอดขายส่วนตัว</label><input type="number" id="wsSmPersonalSales"></div><div><label>เป้ายอดขายส่วนตัว (เดือนนี้)</label><input type="number" id="wsSmTarget"></div></div>' +
      '<div class="row"><div><label>จำนวนลูกค้าใหม่</label><input type="number" id="wsSmNewCustomers"></div><div><label>จำนวนลูกค้าที่ดึงกลับ</label><input type="number" id="wsSmWonBack"></div></div>' +
      '<label>ยอดขายสินค้าผลักดัน</label><input type="number" id="wsSmPush">' +
      '<label>ยอดค้างชำระ</label><input type="number" id="wsSmOutstanding">' +
      '<label>หมายเหตุ</label><input type="text" id="wsSmNote">' +
      '<button class="btn secondary" id="wsSmSave">✓ บันทึกยอดขาย</button></div>';
  }
  function workScoreSalesOnlineFormHtml() {
    return '<div class="card"><h3>🛒 Sales Online — กรอกยอดเดือนนี้</h3><div class="cardSubtitle">กรอกแล้วกด "บันทึกยอดขาย" (ข้อมูลชุดเดียวกับแท็บ "Sales Online" — ยังไม่มีสูตรคำนวณคะแนนอัตโนมัติของเซลส์ออนไลน์ ให้คะแนน A/B/C ด้านล่างเองไปก่อน)</div>' +
      '<label>ยอดขาย</label><input type="number" id="wsSmSales">' +
      '<div class="row"><div><label>ลูกค้าใหม่</label><input type="number" id="wsSmOnlineNewCustomers"></div><div><label>ลูกค้าที่ดูแล</label><input type="number" id="wsSmManaged"></div></div>' +
      '<label>Order</label><input type="number" id="wsSmOrderCount">' +
      '<label>ปัญหา/Order ผิด</label><input type="number" id="wsSmOrderIssue">' +
      '<label>หมายเหตุ</label><input type="text" id="wsSmOnlineNote">' +
      '<button class="btn secondary" id="wsSmOnlineSave">✓ บันทึกยอดขาย</button></div>';
  }

  function renderMonthlyArea(emp, employeeId, month, year) {
    var area = document.getElementById('wsMonthlyArea');
    if (!emp || (emp.department !== 'Sales' && emp.department !== 'Online')) { area.innerHTML = ''; return; }
    if (emp.department === 'Sales') {
      area.innerHTML = workScoreSalesFieldFormHtml();
      apiGet('salesMonthlyOne', { kind: 'field', employeeId: employeeId, month: month, year: year }).then(function (row) {
        if (!row || !document.getElementById('wsSmPersonalSales')) return; // ไม่มีข้อมูลเดิม หรือสลับหน้าไปแล้วระหว่างรอโหลด
        setValIfExists('wsSmPersonalSales', row['ยอดขายส่วนตัว'] || '');
        setValIfExists('wsSmTarget', row['เป้ายอดขายส่วนตัว'] || '');
        setValIfExists('wsSmNewCustomers', row['จำนวนลูกค้าใหม่'] || '');
        setValIfExists('wsSmWonBack', row['จำนวนลูกค้าที่ดึงกลับ'] || '');
        setValIfExists('wsSmPush', row['ยอดขายสินค้าผลักดัน'] || '');
        setValIfExists('wsSmOutstanding', row['ยอดค้างชำระ'] || '');
        setValIfExists('wsSmNote', row['หมายเหตุ'] || '');
      }).catch(function () { /* โหลดข้อมูลเดิมไม่สำเร็จ ปล่อยเป็นฟอร์มว่างให้กรอกใหม่ */ });
      document.getElementById('wsSmSave').addEventListener('click', function (evt) {
        var payload = {
          employeeId: employeeId, month: month, year: year,
          personalSales: document.getElementById('wsSmPersonalSales').value,
          personalTarget: document.getElementById('wsSmTarget').value,
          newCustomers: document.getElementById('wsSmNewCustomers').value,
          wonBackCustomers: document.getElementById('wsSmWonBack').value,
          pushProductSales: document.getElementById('wsSmPush').value,
          outstandingAmount: document.getElementById('wsSmOutstanding').value,
          note: document.getElementById('wsSmNote').value
        };
        withButtonGuard(evt.target, function () { return apiPost('upsertSalesMonthly', { kind: 'field', payload: payload }); })
          .then(function () { toast('บันทึกยอดขายแล้ว'); loadSalesFieldSuggestion(employeeId, month, year); })
          .catch(function (e) { toast(e.message || String(e), true); });
      });
    } else {
      area.innerHTML = workScoreSalesOnlineFormHtml();
      apiGet('salesMonthlyOne', { kind: 'online', employeeId: employeeId, month: month, year: year }).then(function (row) {
        if (!row || !document.getElementById('wsSmSales')) return; // ไม่มีข้อมูลเดิม หรือสลับหน้าไปแล้วระหว่างรอโหลด
        setValIfExists('wsSmSales', row['ยอดขาย'] || '');
        setValIfExists('wsSmOnlineNewCustomers', row['ลูกค้าใหม่'] || '');
        setValIfExists('wsSmManaged', row['ลูกค้าที่ดูแล'] || '');
        setValIfExists('wsSmOrderCount', row['Order'] || '');
        setValIfExists('wsSmOrderIssue', row['ปัญหา/Order ผิด'] || '');
        setValIfExists('wsSmOnlineNote', row['หมายเหตุ'] || '');
      }).catch(function () { /* โหลดข้อมูลเดิมไม่สำเร็จ ปล่อยเป็นฟอร์มว่างให้กรอกใหม่ */ });
      document.getElementById('wsSmOnlineSave').addEventListener('click', function (evt) {
        var payload = {
          employeeId: employeeId, month: month, year: year,
          sales: document.getElementById('wsSmSales').value,
          newCustomers: document.getElementById('wsSmOnlineNewCustomers').value,
          managedCustomers: document.getElementById('wsSmManaged').value,
          orderCount: document.getElementById('wsSmOrderCount').value,
          orderIssue: document.getElementById('wsSmOrderIssue').value,
          note: document.getElementById('wsSmOnlineNote').value
        };
        withButtonGuard(evt.target, function () { return apiPost('upsertSalesMonthly', { kind: 'online', payload: payload }); })
          .then(function () { toast('บันทึกยอดขายแล้ว'); })
          .catch(function (e) { toast(e.message || String(e), true); });
      });
    }
  }

  // Work Score V2 (รอบยืนยันล่าสุด): พี่ขอให้ข้อ C ของเซลส์วิ่ง/ออนไลน์ "ให้เต็มอัตโนมัติเสมอ" (ไม่ต้องมโนแยก) เพราะ A+B
  // คำนวณจากตัวเลขจริงหมดแล้ว — ยังแก้ไขเป็นตัวเลขอื่นได้เองก่อนกดบันทึก ถ้ามีเหตุผลจะปรับลดจริงๆ (เช่น ส่งรายงานช้ามาก)
  var COOPERATION_DEFAULT_FULL = 4;
  function loadSalesFieldSuggestion(employeeId, month, year) {
    setValIfExists('wsC', COOPERATION_DEFAULT_FULL); // ให้เต็มไปก่อนเลย ไม่ต้องรอผลยอดขายก็กำหนดได้
    apiGet('salesMonthlyOne', { kind: 'field', employeeId: employeeId, month: month, year: year }).then(function (row) {
      var box = document.getElementById('wsAutoCalc');
      if (!box || !document.getElementById('wsA')) return; // สลับหน้าไปแล้วระหว่างรอโหลด — ไม่มีอะไรให้อัปเดต
      box.style.display = 'block';
      if (!row) {
        box.innerHTML = '⚠️ ยังไม่มีข้อมูล Sales Field เดือนนี้ของคนนี้ — กรอกในการ์ด "Sales Field — กรอกยอดเดือนนี้" ด้านบนก่อน ระบบจะคำนวณ A/B ให้อัตโนมัติ (ข้อ C ให้เต็ม ' + COOPERATION_DEFAULT_FULL + ' ไว้ก่อนแล้ว)';
        updateSum();
        return;
      }
      // B = ลูกค้าใหม่ + ลูกค้าที่ดึงกลับ + ยอดขายสินค้าผลักดัน (เกณฑ์คงที่ ≥10 เจ้า/≥10 เจ้า/≥50,000 บาท = เต็มข้อละ 2 คะแนน)
      var aScore = ratioScore(row['ยอดขายส่วนตัว'], row['เป้ายอดขายส่วนตัว'], 10);
      var bScore = (ratioScore(row['จำนวนลูกค้าใหม่'], 10, 2) || 0)
        + (ratioScore(row['จำนวนลูกค้าที่ดึงกลับ'], 10, 2) || 0)
        + (ratioScore(row['ยอดขายสินค้าผลักดัน'], 50000, 2) || 0);
      setValIfExists('wsA', aScore === null ? 0 : aScore);
      setValIfExists('wsB', bScore);
      box.innerHTML = (aScore === null
        ? '⚠️ ยังไม่ได้กรอก "เป้ายอดขายส่วนตัว" เดือนนี้ในแท็บ Sales Field — ตั้งข้อ A เป็น 0 ไปก่อน ไปกรอกเป้าก่อนแล้วกลับมาหน้านี้ใหม่'
        : '🧮 คำนวณ Work Score ให้อัตโนมัติจากข้อมูล Sales Field เดือนนี้แล้ว (ยอดขาย ' + fmtNum(row['ยอดขายส่วนตัว']) + ' / เป้า ' + fmtNum(row['เป้ายอดขายส่วนตัว']) + ') — A/B มาจากตัวเลขจริง, C ให้เต็ม ' + COOPERATION_DEFAULT_FULL + ' อัตโนมัติ (แก้ไขเองได้ทุกข้อก่อนกดบันทึก)') ;
      updateSum();
    }).catch(function () { var box = document.getElementById('wsAutoCalc'); if (box) box.style.display = 'none'; /* ดึงไม่สำเร็จ ไม่รบกวน ให้กรอกเองตามปกติ */ });
  }

  // ชื่อหัวข้อ C เปลี่ยนเป็น "ความร่วมมือและการส่งรายงาน" เฉพาะแผนกเซลส์ (วิ่ง/ออนไลน์) ตามที่พี่ขอ — แผนกอื่นยังใช้ชื่อเดิม
  // "ความร่วมมือและทัศนคติในการทำงาน" เพราะยังประเมินแบบเดิมอยู่ ไม่เกี่ยวกับการส่งรายงานยอดขายแบบเซลส์
  function updateCLabel(emp) {
    var isSales = emp && (emp.department === 'Sales' || emp.department === 'Online');
    setTextIfExists('wsCLabel', isSales ? 'C. ความร่วมมือและการส่งรายงาน (0-4)' : 'C. ความร่วมมือและทัศนคติในการทำงาน (0-4)');
  }

  function loadExisting() {
    var employeeId = document.getElementById('wsEmp').value;
    var month = Number(document.getElementById('ws_m').value), year = Number(document.getElementById('ws_y').value);
    var emp = APP.employees.filter(function (e) { return e.id === employeeId; })[0];
    renderMonthlyArea(emp, employeeId, month, year);
    updateCLabel(emp);
    setTextIfExists('wsExisting', 'กำลังโหลด...');
    var autoBox = document.getElementById('wsAutoCalc');
    if (autoBox) { autoBox.style.display = 'none'; autoBox.innerHTML = ''; }
    apiGet('scoreWeights', { month: month, year: year }).then(function (w) {
      var note = document.getElementById('wsWeightNote');
      if (!note) return; // สลับหน้าไปแล้วระหว่างรอโหลด
      note.innerHTML = (w && w.overridden)
        ? '<div class="calloutBox mt0">📌 เดือนนี้ใช้สัดส่วนคะแนนพิเศษ: Work Score เต็ม ' + w.workWeight + ' (ไม่นับ' + (w.workWeight === 0 ? ' เลย' : '') + ') + Error เต็ม ' + w.errorWeight + ' + Attendance เต็ม ' + w.attendanceWeight + ' — กรอกคะแนนด้านล่างได้ตามปกติ แต่จะไม่มีผลกับคะแนนรวมเดือนนี้ถ้า Work Weight = 0</div>'
        : '';
    }).catch(function () { var note = document.getElementById('wsWeightNote'); if (note) note.innerHTML = ''; });
    apiGet('workScoreDetail', { employeeId: employeeId, month: month, year: year }).then(function (d) {
      if (!document.getElementById('wsA')) return; // สลับหน้าไปแล้วระหว่างรอโหลด — ไม่มีอะไรให้อัปเดต ไม่ต้อง toast error
      if (d) {
        setValIfExists('wsA', d.workA);
        setValIfExists('wsB', d.workB);
        setValIfExists('wsC', d.workC);
        setValIfExists('wsEvaluator', d.evaluator);
        setValIfExists('wsNote', d.note);
        setTextIfExists('wsExisting', 'เคยประเมินไว้แล้ว โดย ' + esc(d.evaluator) + (d.evalDate ? (' เมื่อ ' + fmtDate(d.evalDate)) : '') + ' — แก้แล้วกดบันทึกซ้ำได้');
        updateSum();
      } else {
        setValIfExists('wsA', ''); setValIfExists('wsB', ''); setValIfExists('wsC', '');
        setValIfExists('wsEvaluator', ''); setValIfExists('wsNote', '');
        setTextIfExists('wsExisting', 'ยังไม่เคยประเมินเดือนนี้');
        updateSum();
        // Work Score V2: เซลส์วิ่ง (แผนก Sales) ยังไม่เคยประเมินเดือนนี้ → เสนอคะแนน A/B อัตโนมัติจากยอด Sales Field เดือนนั้นให้เลย
        // (emp ประกาศไว้ด้านบนของ loadExisting() แล้ว ใช้ตัวเดียวกับที่ renderMonthlyArea ใช้)
        if (emp && emp.department === 'Sales') loadSalesFieldSuggestion(employeeId, month, year);
      }
    }).catch(function (e) { if (document.getElementById('wsA')) toast(e.message || String(e), true); });
  }
  document.getElementById('wsEmp').addEventListener('change', loadExisting);
  document.getElementById('ws_go').addEventListener('click', loadExisting);
  loadExisting();

  document.getElementById('wsSave').addEventListener('click', function (evt) {
    var a = document.getElementById('wsA').value, b = document.getElementById('wsB').value, c = document.getElementById('wsC').value;
    if (a === '' || Number(a) < 0 || Number(a) > 10) { toast('ผลงานตามหน้าที่ ต้องอยู่ระหว่าง 0-10', true); return; }
    if (b === '' || Number(b) < 0 || Number(b) > 6) { toast('คุณภาพและความรับผิดชอบ ต้องอยู่ระหว่าง 0-6', true); return; }
    if (c === '' || Number(c) < 0 || Number(c) > 4) { toast('ข้อ C ต้องอยู่ระหว่าง 0-4', true); return; }
    var evaluator = document.getElementById('wsEvaluator').value.trim();
    if (!evaluator) { toast('กรุณาระบุชื่อผู้ประเมิน', true); return; }
    var payload = {
      employeeId: document.getElementById('wsEmp').value,
      month: Number(document.getElementById('ws_m').value), year: Number(document.getElementById('ws_y').value),
      workA: a, workB: b, workC: c, evaluator: evaluator, note: document.getElementById('wsNote').value
    };
    withButtonGuard(evt.target, function () { return apiPost('setWorkScore', payload); })
      .then(function () { toast('บันทึกคะแนน Work Score แล้ว — ไปดูคะแนนรวม/เงินพิเศษได้ที่ "สรุปคะแนน/เงิน"'); loadExisting(); }).catch(function (e) { toast(e.message || String(e), true); });
  });
}

/* ---- 9. สรุปคะแนน/เงิน ---- */
// เรียงตามคะแนนรวมมาก→น้อยเป็นค่าเริ่มต้นเสมอ และกรองตามกลุ่มเงินพิเศษได้ (Support/Sales Field/Sales Online — ตรงกับ INCENTIVE_GROUPS ฝั่ง Backend)
var SUMMARY_GROUP_OPTIONS = ['Support', 'Sales Field', 'Sales Online'];
function renderAdminSummary() {
  var groupFilterOptions = '<option value="">ทั้งหมด</option>' + SUMMARY_GROUP_OPTIONS.map(function (g) { return '<option value="' + g + '">' + g + '</option>'; }).join('');
  var html =
    '<div class="card"><h3>🏆 สรุปคะแนน/เงิน</h3><div class="cardSubtitle">ภาพรวม Performance Score, สิทธิ์เงินพิเศษ และ Reward Points ของทุกคนในเดือนที่เลือก</div>' +
    monthPickerHtml('cs', APP.month, APP.year) +
    '<label>กรองตามกลุ่มเงินพิเศษ</label><select id="csGroupFilter">' + groupFilterOptions + '</select>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">' +
    '<button class="btn secondary" id="csExport">⬇ ดาวน์โหลดเป็น CSV</button>' +
    '<button class="btn secondary" id="csExportPdf">⬇ ดาวน์โหลดเป็น PDF</button>' +
    '</div>' +
    '<div class="calloutBox" style="margin-top:14px;">คอลัมน์ <b>งาน/ผิด/ขาดลามาสาย/รวม</b> คือ Performance Score เต็ม 100 · <b>ดี/รางวัล/คะแนนรวม (สีส้ม)</b> แยกต่างหากโดยสิ้นเชิง ไม่รวมกับคะแนนรวม 100 คะแนนด้านหน้า · <b>เงินพิเศษ</b> คำนวณจากคะแนนรวมเท่านั้น · <b>ค่าเสียหาย</b> (คอลัมน์ขวาสุด แยกเส้นให้เห็นชัดว่าไม่เกี่ยวกับคะแนน/เงินด้านหน้าทั้งหมด) เป็นตัวเลขแสดงผลเฉยๆ จากที่กรอกไว้ตอนบันทึกเหตุการณ์ความผิด ไม่มีผลต่อคะแนน/เงินใดๆ ทั้งสิ้น · แถวล่างสุดของตารางคือยอดรวมเงินพิเศษ/ค่าเสียหายของทุกคนที่แสดงอยู่ · ตัวเลขในวงเล็บใต้หัวคอลัมน์เงินพิเศษ/ค่าเสียหาย คือเดือนที่เงินจะออกจริง/ถูกหักจริง (เงินพิเศษ +3 เดือนจากตารางนี้ ค่าเสียหาย +1 เดือน) คำนวณอัตโนมัติตามเดือนที่เลือกดูอยู่ ไม่ต้องนับเอง · <b>เบี้ยขยัน</b> ย้ายไปดู/สรุปที่หน้า "ปฏิทินบริษัท" แทนแล้ว · พนักงานที่ลาออกแล้ว (ติ๊ก Inactive) จะยังโผล่ในตารางของ<b>เดือนที่เขายังทำงานอยู่จริง</b>พร้อมป้าย "ลาออกแล้ว" ให้ตรวจสอบ/ปิดยอดย้อนหลังได้ แต่เดือนที่เขาไม่ได้ทำงานแล้วจะไม่โผล่มาอีก (เงินพิเศษของเดือนที่ลาออกจะค้างไว้ตามยอดที่เคยคำนวณตอนยัง Active อยู่จริง ไม่คำนวณซ้ำ)</div>' +
    '<div id="csOverrideNote"></div></div>' +
    '<div class="card"><div id="csList" class="muted">กำลังโหลด...</div></div>';
  document.getElementById('content').innerHTML = html;
  var lastRows = [];
  document.getElementById('cs_go').addEventListener('click', load);
  document.getElementById('csGroupFilter').addEventListener('change', render);
  load();
  function load() {
    apiGet('companyMonthlyScores', { month: Number(document.getElementById('cs_m').value), year: Number(document.getElementById('cs_y').value) }).then(function (rows) {
      if (!document.getElementById('csList')) return; // สลับหน้าไปแล้วระหว่างรอโหลด
      lastRows = rows;
      var note = document.getElementById('csOverrideNote');
      var first = rows[0];
      if (note) {
        note.innerHTML = (first && first['_weightOverridden'])
          ? '<div class="calloutBox" style="margin-top:8px;">📌 เดือนนี้ใช้สัดส่วนคะแนนพิเศษ: Work ' + first['_workWeight'] + ' + Error ' + first['_errorWeight'] + ' + Attendance ' + first['_attendanceWeight'] + ' (ปกติ 20+60+20) — ปรับได้ที่ชีต Config</div>'
          : '';
      }
      render();
    }).catch(function (e) {
      var el = document.getElementById('csList');
      if (!el) return; // สลับหน้าไปแล้วระหว่างรอโหลด
      el.innerHTML = '<div class="muted">โหลดไม่สำเร็จ: ' + esc(e.message || String(e)) + ' <button class="btn secondary" id="csRetry" style="margin-left:8px;">ลองใหม่</button></div>';
      var retryBtn = document.getElementById('csRetry');
      if (retryBtn) retryBtn.addEventListener('click', function () { el.innerHTML = '<div class="muted">กำลังโหลด...</div>'; load(); });
      toast(e.message || String(e), true);
    });
  }
  function filteredSortedRows() {
    var groupFilter = document.getElementById('csGroupFilter').value;
    return lastRows.filter(function (r) { return !groupFilter || r['กลุ่มเงินพิเศษ'] === groupFilter; })
      .slice().sort(function (a, b) { return (Number(b['คะแนนรวม']) || 0) - (Number(a['คะแนนรวม']) || 0); }); // เรียงคะแนนรวมมาก→น้อยเป็นค่าเริ่มต้น
  }
  // ค่าเสียหายจริงเป็นตัวเลขบวกที่เก็บไว้ (เช่น 500 = เสียหาย 500 บาท) แต่โชว์ในตารางเป็นค่าลบสีแดงให้เห็นชัดว่าเป็นเงินที่เสียไป
  // (0 = ไม่มีความเสียหายเดือนนี้ โชว์ปกติไม่ใช่สีแดง)
  function damageCellHtml(v) {
    var n = Number(v) || 0;
    if (n > 0) return '<span style="color:var(--red);font-weight:700;">-' + fmtNum(n) + '</span>';
    return fmtNum(0);
  }
  // คำนวณ "เดือนที่เงินออกจริง/ถูกหักจริง" จากเดือนของตารางที่กำลังดูอยู่ (cs_m/cs_y) ล้วนๆ ไม่เกี่ยวกับสูตรคำนวณคะแนน/เงิน
  // ใดๆ ทั้งสิ้น เป็นแค่ป้ายข้อความช่วยจำในหัวคอลัมน์เท่านั้น — เงินพิเศษจ่ายจริง 3 เดือนถัดจากเดือนตาราง, ค่าเสียหาย
  // ตัดรอบเดือนถัดไป ตามที่พี่กำหนด (ปีเปลี่ยนข้ามปีก็คำนวณให้ถูกต้องอัตโนมัติ เช่น ตาราง พ.ย. + 3 เดือน = ก.พ.ปีถัดไป)
  // (addMonths/sumField เป็นฟังก์ชันกลางที่ใช้ร่วมกับหน้า "ปฏิทินบริษัท" แล้ว — ดูใกล้ๆ fmtNum ด้านบนของไฟล์)
  function payoutMonthLabel(delta, tableMonth, tableYear) {
    var r = addMonths(tableMonth, tableYear, delta);
    return r.year === Number(tableYear) ? String(r.month) : (r.month + '/' + r.year); // ข้ามปีถึงจะโชว์ปีกำกับด้วย กันสับสน
  }
  // พนักงานที่ลาออกแล้ว (Inactive) แต่เดือนที่กำลังดูอยู่ยังมีข้อมูลจริง (เช่น ลาออกกลาง/ปลายเดือน) จะยังโผล่ในตาราง
  // เพื่อให้ตรวจสอบ/ปิดยอดคะแนนผิด+ค่าเสียหายย้อนหลังได้ — ใส่ป้าย "ลาออกแล้ว" ให้เห็นชัดว่าไม่ใช่พนักงานปัจจุบัน
  function nameCellHtml(r) {
    if (r['สถานะ'] && r['สถานะ'] !== 'Active') {
      return esc(r['ชื่อพนักงาน']) + ' <span class="inactiveBadge">ลาออกแล้ว</span>';
    }
    return esc(r['ชื่อพนักงาน']);
  }
  function render() {
    var rows = filteredSortedRows();
    var el = document.getElementById('csList');
    if (!rows.length) { el.innerHTML = '<div class="muted">ไม่มีข้อมูล</div>'; return; }
    var totalIncentive = sumField(rows, 'เงินพิเศษ');
    var totalDamage = sumField(rows, 'ค่าความเสียหาย');
    var tableMonth = Number(document.getElementById('cs_m').value);
    var tableYear = Number(document.getElementById('cs_y').value);
    var incentiveMonthNote = '(ออกเดือน' + payoutMonthLabel(3, tableMonth, tableYear) + ')';
    var damageMonthNote = '(หักเดือน' + payoutMonthLabel(1, tableMonth, tableYear) + ')';
    el.innerHTML = '<div style="overflow-x:auto"><table class="simple"><tr><th>ชื่อ</th><th>แผนก</th><th>กลุ่มเงินพิเศษ</th><th>งาน</th><th>ผิด</th><th>ขาด/ลา/สาย</th><th class="colDivider">รวม</th><th class="colDivider">ดี</th><th>รางวัล</th><th class="amberCell">คะแนนรวม</th><th class="colDivider">เงินพิเศษ<span class="thNote">' + incentiveMonthNote + '</span></th><th class="colDivider">ค่าเสียหาย<span class="thNote">' + damageMonthNote + '</span></th></tr>' +
      rows.map(function (r) { return '<tr' + (r['สถานะ'] && r['สถานะ'] !== 'Active' ? ' class="inactiveRow"' : '') + '><td>' + nameCellHtml(r) + '</td><td>' + esc(r['แผนก']) + '</td><td>' + esc(r['กลุ่มเงินพิเศษ']) + '</td><td>' + fmtNum(r['คะแนนงาน']) + '</td><td>' + fmtNum(r['คะแนนความผิด']) + '</td><td>' + fmtNum(r['คะแนนขาดลามาสาย']) + '</td><td class="colDivider totalCell">' + fmtNum(r['คะแนนรวม']) + '</td><td class="colDivider">' + fmtNum(r['คะแนนทำความดี']) + '</td><td>' + fmtNum(r['คะแนนแจ้งรางวัล']) + '</td><td class="amberCell">' + fmtNum(r['Reward Points สะสม']) + '</td><td class="colDivider moneyCell">' + fmtNum(r['เงินพิเศษ']) + '</td><td class="colDivider">' + damageCellHtml(r['ค่าความเสียหาย']) + '</td></tr>'; }).join('') +
      '<tr class="totalsRow"><td colspan="10">รวมทั้งหมด (' + rows.length + ' คน)</td><td class="colDivider">' + fmtNum(totalIncentive) + '</td><td class="colDivider">' + damageCellHtml(totalDamage) + '</td></tr>' +
      '</table></div>';
  }
  document.getElementById('csExport').addEventListener('click', function () {
    var rows = filteredSortedRows();
    if (!rows.length) { toast('ไม่มีข้อมูลให้ดาวน์โหลด', true); return; }
    var cols = ['รหัสพนักงาน', 'ชื่อพนักงาน', 'สถานะ', 'แผนก', 'กลุ่มเงินพิเศษ', 'คะแนนงาน', 'คะแนนความผิด', 'คะแนนขาดลามาสาย', 'คะแนนรวม', 'คะแนนทำความดี', 'คะแนนแจ้งรางวัล', 'Reward Points สะสม', 'เงินพิเศษ', 'ค่าความเสียหาย'];
    var csv = cols.join(',') + '\n' + rows.map(function (r) {
      return cols.map(function (c) {
        var v = r[c];
        if (c === 'ค่าความเสียหาย' && Number(v) > 0) v = -Number(v); // เหมือนหน้าเว็บ: โชว์เป็นค่าลบในไฟล์ที่ดาวน์โหลดด้วย
        return '"' + String(v === undefined ? '' : v).replace(/"/g, '""') + '"';
      }).join(',');
    }).join('\n');
    var a = document.createElement('a'); a.href = 'data:text/csv;charset=utf-8,﻿' + encodeURIComponent(csv); a.download = 'monthly_score.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  });
  // ดาวน์โหลดเป็น PDF — ถ่ายภาพตารางที่เห็นบนหน้าเว็บจริง (html2canvas) แล้วฝังเป็นรูปในไฟล์ PDF (jsPDF) เพื่อให้
  // ภาษาไทย/สีในตาราง/อิโมจิ 🏆 ในหัวข้อ ออกมาเหมือนที่เห็นบนจอทุกอย่าง (ไม่ใช้การวาดตัวอักษรเองซึ่งฟอนต์ไทย/อิโมจิมักเพี้ยน)
  document.getElementById('csExportPdf').addEventListener('click', function () {
    var rows = filteredSortedRows();
    if (!rows.length) { toast('ไม่มีข้อมูลให้ดาวน์โหลด', true); return; }
    if (typeof html2canvas === 'undefined' || !window.jspdf) {
      toast('โหลดไลบรารีสร้าง PDF ไม่สำเร็จ (ต้องต่ออินเทอร์เน็ต) ลองรีเฟรชหน้าแล้วลองใหม่', true);
      return;
    }
    var btn = document.getElementById('csExportPdf');
    var oldLabel = btn.textContent;
    btn.textContent = '⏳ กำลังสร้าง PDF...';
    btn.disabled = true;

    var monthSelect = document.getElementById('cs_m');
    var monthLabel = (monthSelect.options[monthSelect.selectedIndex] || {}).text || '';
    var yearVal = document.getElementById('cs_y').value;
    var groupFilter = document.getElementById('csGroupFilter').value;

    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;top:0;left:-100000px;width:1500px;background:#ffffff;padding:28px;';
    wrap.innerHTML =
      '<div style="font-size:24px;font-weight:800;color:var(--text,#2a2622);margin-bottom:4px;">🏆 สรุปคะแนน/เงิน</div>' +
      '<div style="font-size:14px;color:#57514a;margin-bottom:18px;">เดือน ' + esc(monthLabel) + ' ' + esc(yearVal) + (groupFilter ? ' · กลุ่มเงินพิเศษ: ' + esc(groupFilter) : ' · ทุกกลุ่มเงินพิเศษ') + '</div>' +
      document.getElementById('csList').innerHTML;
    document.body.appendChild(wrap);

    function cleanup() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); btn.textContent = oldLabel; btn.disabled = false; }

    html2canvas(wrap, { scale: 2, backgroundColor: '#ffffff', windowWidth: 1500 }).then(function (canvas) {
      cleanup();
      var imgData = canvas.toDataURL('image/png');
      var jsPDF = window.jspdf.jsPDF;
      // แนวตั้ง + ย่อภาพทั้งตารางให้พอดี "หน้าเดียว" เสมอ (ตามที่พี่ขอ) — คำนวณอัตราย่อจากทั้งความกว้างและความสูง
      // พร้อมกัน (เลือกตัวที่ย่อมากกว่า) แล้ววางกึ่งกลางหน้า จะไม่มีการตัดขึ้นหน้า 2 อีกต่อไป ถ้าพนักงานเยอะ/คอลัมน์เยอะ
      // ตัวหนังสือในภาพจะเล็กลงตามไปด้วย (ซูมดูในตัวเปิด PDF ได้) — ถ้าอยากได้ตัวใหญ่ขึ้น กรองกลุ่มเงินพิเศษก่อนกดดาวน์โหลด
      // จะได้แถวน้อยลง ย่อน้อยลง ตัวหนังสือใหญ่ขึ้น
      var pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
      var pageWidth = pdf.internal.pageSize.getWidth();
      var pageHeight = pdf.internal.pageSize.getHeight();
      var margin = 20;
      var availW = pageWidth - margin * 2;
      var availH = pageHeight - margin * 2;
      var scale = Math.min(availW / canvas.width, availH / canvas.height);
      var imgWidth = canvas.width * scale;
      var imgHeight = canvas.height * scale;
      var x = margin + (availW - imgWidth) / 2; // จัดกึ่งกลางแนวนอน
      var y = margin;
      pdf.addImage(imgData, 'PNG', x, y, imgWidth, imgHeight);
      pdf.save('สรุปคะแนนเงิน_' + yearVal + '-' + Number(monthSelect.value) + '.pdf');
    }).catch(function (e) {
      cleanup();
      toast('สร้าง PDF ไม่สำเร็จ: ' + (e.message || String(e)), true);
    });
  });
}

/* ---- จัดการพนักงาน (กลุ่มเงินพิเศษ + สิทธิ์เงินพิเศษ) ---- */
// ไม่ใช่หน้า "เพิ่มพนักงานใหม่" — เพิ่มพนักงานใหม่ครั้งแรกยังต้องเพิ่มแถวในชีต Employees เอง (รหัส/ชื่อ/แผนก/ตำแหน่ง)
// หน้านี้ใช้แก้ "กลุ่มเงินพิเศษ" (วัดผลงานด้วยสูตรกลุ่มไหน) และ "สิทธิ์เงินพิเศษ" (ได้รับเงินก้อนนี้จริงหรือยัง เช่น
// พนักงานทดลองงาน) ของคนที่มีอยู่แล้วในระบบเท่านั้น — คนละคอลัมน์กับ Error/Attendance/Work Score เลย ไม่กระทบสูตรคำนวณ
// คะแนนใดๆ ทั้งสิ้น พอติ๊กเปิดสิทธิ์ เดือนที่เปิดดู (รวมเดือนก่อนหน้าถ้าย้อนไปดู) จะคำนวณเงินพิเศษใหม่สดทันที
function renderAdminEmployees() {
  var html =
    '<div class="card"><h3>👤 จัดการพนักงาน</h3><div class="cardSubtitle">แก้ไข "กลุ่มเงินพิเศษ" และ "สิทธิ์เงินพิเศษ" ของพนักงานที่มีอยู่แล้ว — เพิ่มพนักงานใหม่ครั้งแรกยังต้องเพิ่มในชีต Employees เอง</div>' +
    '<div class="calloutBox mt0">ติ๊ก "มีสิทธิ์รับเงินพิเศษ" เมื่อพนักงานผ่านโปรแล้วพร้อมรับเงินก้อนนี้ — ก่อนหน้านั้นบันทึก Error/Attendance/Work Score ได้ตามปกติทุกคนเหมือนกันหมด ไม่กระทบสูตรคำนวณคะแนนใดๆ เลย แค่ยังไม่ได้รับเงินก้อนจนกว่าจะติ๊กเปิดให้<br><br>' +
    '"เริ่มมีสิทธิ์ตั้งแต่เดือน/ปี" (ไม่บังคับ) — ถ้ากำหนดไว้ รายงานของเดือนก่อนหน้านั้นจะไม่นับรวมเงินก้อนนี้ให้คนนี้ย้อนหลัง แม้จะเพิ่งมาติ๊ก "มีสิทธิ์" ทีหลังก็ตาม เช่น ติ๊กมีสิทธิ์และตั้งเริ่ม 10/2026 → เดือน 8 จะยังไม่เข้าร่วม แต่เดือน 10 เป็นต้นไปจะเข้าร่วม ถ้าปล่อยว่างไว้ = ไม่จำกัดเดือน (เข้าร่วมได้ทุกเดือนที่ติ๊กมีสิทธิ์)</div>' +
    '<div id="empMgmtList" class="muted" style="margin-top:14px;">กำลังโหลด...</div></div>';
  document.getElementById('content').innerHTML = html;
  load();

  function load() {
    apiGet('employeesForManagement', {}).then(function (rows) {
      if (!document.getElementById('empMgmtList')) return; // สลับหน้าไปแล้วระหว่างรอโหลด
      render(rows);
    }).catch(function (e) {
      var el = document.getElementById('empMgmtList');
      if (el) el.innerHTML = '<div class="muted">โหลดไม่สำเร็จ: ' + esc(e.message || String(e)) + '</div>';
    });
  }

  function groupOptionsHtml(selected) {
    var opts = '<option value=""' + (selected ? '' : ' selected') + '>— ไม่มี (ไม่เข้าเงินก้อนนี้) —</option>';
    SUMMARY_GROUP_OPTIONS.forEach(function (g) {
      opts += '<option value="' + g + '"' + (g === selected ? ' selected' : '') + '>' + g + '</option>';
    });
    return opts;
  }

  var MONTH_ABBR = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  function fromMonthOptionsHtml(selected) {
    var opts = '<option value=""' + (selected ? '' : ' selected') + '>ไม่กำหนด</option>';
    for (var m = 1; m <= 12; m++) opts += '<option value="' + m + '"' + (m === selected ? ' selected' : '') + '>' + MONTH_ABBR[m] + '</option>';
    return opts;
  }

  function render(rows) {
    var el = document.getElementById('empMgmtList');
    if (!rows.length) { el.innerHTML = '<div class="muted">ไม่มีข้อมูลพนักงาน</div>'; return; }
    el.innerHTML = '<div style="overflow-x:auto"><table class="simple"><tr><th>ชื่อ</th><th>แผนก</th><th>สถานะ</th><th>กลุ่มเงินพิเศษ</th><th>มีสิทธิ์รับเงินพิเศษ</th><th>เริ่มมีสิทธิ์ตั้งแต่</th><th></th></tr>' +
      rows.map(function (r) {
        return '<tr data-emp-id="' + esc(r.id) + '">' +
          '<td>' + esc(r.nickname) + ' (' + esc(r.fullName) + ')</td>' +
          '<td>' + esc(r.department) + '</td>' +
          '<td>' + (r.status === 'Active' ? '<span class="badge approved">Active</span>' : '<span class="badge rejected">Inactive</span>') + '</td>' +
          '<td><select class="empGroupSel">' + groupOptionsHtml(r.incentiveGroup) + '</select></td>' +
          '<td style="text-align:center;"><input type="checkbox" class="empEligibleChk"' + (r.eligible ? ' checked' : '') + '></td>' +
          '<td><div style="display:flex;gap:4px;align-items:center;">' +
            '<select class="empFromMonthSel">' + fromMonthOptionsHtml(r.eligibleFromMonth) + '</select>' +
            '<input type="number" class="empFromYearInput" placeholder="ปี" min="2000" max="2100" step="1" style="width:70px;" value="' + (r.eligibleFromYear ? r.eligibleFromYear : '') + '">' +
          '</div></td>' +
          '<td><button class="btn secondary small empSaveBtn" type="button">บันทึก</button></td>' +
          '</tr>';
      }).join('') + '</table></div>';

    Array.prototype.forEach.call(el.querySelectorAll('.empSaveBtn'), function (btn) {
      btn.addEventListener('click', function () {
        var tr = btn.closest('tr');
        var employeeId = tr.getAttribute('data-emp-id');
        var incentiveGroup = tr.querySelector('.empGroupSel').value;
        var eligible = tr.querySelector('.empEligibleChk').checked;
        var fromMonth = tr.querySelector('.empFromMonthSel').value;
        var fromYear = tr.querySelector('.empFromYearInput').value.trim();
        if ((fromMonth !== '' && fromYear === '') || (fromMonth === '' && fromYear !== '')) {
          toast('ต้องกรอกทั้งเดือนและปีที่เริ่มมีสิทธิ์คู่กัน หรือเว้นว่างทั้งคู่', true);
          return;
        }
        apiPost('setEmployeeIncentiveSettings', {
          employeeId: employeeId,
          incentiveGroup: incentiveGroup,
          eligible: eligible,
          eligibleFromMonth: fromMonth,
          eligibleFromYear: fromYear
        }).then(function () {
          toast('บันทึกแล้ว — ไปดูผลได้ที่ "สรุปคะแนน/เงิน" หรือ Dashboard ของคนนี้');
        }).catch(function (e) { toast(e.message || String(e), true); });
      });
    });
  }
}

boot();
