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
   5) มี Timeout (20 วินาที) และข้อความแจ้งเตือนภาษาไทยสำหรับ: ออฟไลน์/เน็ตหลุด/หมดเวลา/เซิร์ฟเวอร์ error
   ===================================================================== */

/* ===================== ชั้นเชื่อมต่อ API (fetch layer) ===================== */

var API_TIMEOUT_MS = 20000;

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

var APP = { mode: getInitialMode(), employees: [], departments: [], errorTypes: [], severityLevels: [], impactOptions: [], workTypesByDept: {}, attendanceStatuses: [], reportRewardDefaults: { self: null, external: null }, goodDeedPoints: null, month: null, year: null, tab: null, adminUnlocked: false };

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
function esc(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function fmtDate(v) { if (!v) return ''; var d = new Date(v); if (isNaN(d)) return String(v); return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + d.getFullYear(); }
function fmtNum(v) { if (typeof v === 'number') return (Math.round(v * 100) / 100).toString(); return v === undefined || v === null || v === '' ? '-' : String(v); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function monthPickerHtml(id, month, year) {
  var months = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  var mOpts = '', yOpts = '';
  for (var m = 1; m <= 12; m++) mOpts += '<option value="' + m + '"' + (m === month ? ' selected' : '') + '>' + months[m] + '</option>';
  for (var y = year - 1; y <= year + 1; y++) yOpts += '<option value="' + y + '"' + (y === year ? ' selected' : '') + '>' + y + '</option>';
  return '<div class="month-picker"><select id="' + id + '_m">' + mOpts + '</select><select id="' + id + '_y">' + yOpts + '</select><button class="btn small secondary" id="' + id + '_go">ดู</button></div>';
}

function employeeOptions(list) { return list.map(function (e) { return '<option value="' + e.id + '">' + esc(e.name) + '</option>'; }).join(''); }

/* ===================== boot ===================== */
function boot() {
  // ห่อด้วย try/catch กันไว้อีกชั้น: ถ้ามีอะไร throw แบบ synchronous ก่อนถึง .catch() (เช่น config.js โหลดไม่สำเร็จ)
  // อย่างน้อยหน้าเว็บต้องเปลี่ยนจาก "กำลังโหลด..." เป็นข้อความ error ให้เห็น ไม่ใช่ค้างเฉยๆ ตลอดไป
  try {
    apiGet('bootstrap', {}).then(function (data) {
      APP.employees = data.employees; APP.departments = data.departments;
      APP.errorTypes = data.errorTypes; APP.severityLevels = data.severityLevels; APP.impactOptions = data.impactOptions || [];
      APP.workTypesByDept = data.workTypesByDept || {}; APP.attendanceStatuses = data.attendanceStatuses || ['ปกติ', 'ขาด', 'ลา', 'มาสาย'];
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

function renderShell() {
  var titleEl = document.getElementById('headerTitle');
  var toggleEl = document.getElementById('modeToggle');
  if (APP.mode === 'admin') {
    titleEl.textContent = 'FUTAI — Admin';
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
    titleEl.textContent = 'FUTAI — บันทึกงาน';
    toggleEl.textContent = 'สำหรับผู้ดูแลระบบ';
    toggleEl.onclick = function () { APP.mode = 'admin'; renderShell(); };
    document.getElementById('tabbar').style.display = 'none';
    document.getElementById('tabbar').innerHTML = '';
    renderEmployeeHome();
  }
}

/* ===================== EMPLOYEE MODE (ไม่มี Login) ===================== */
function renderEmployeeHome() {
  var html = '<div class="card">' +
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
  return '<div class="card"><h3>บันทึกงานวันนี้</h3>' +
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
  return '<div class="card"><h3>บันทึกงานประจำสัปดาห์ (บัญชี)</h3>' +
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
var ADMIN_TABS = [
  { key: 'work', label: 'บันทึกงาน', render: renderAdminWork },
  { key: 'salesfield', label: 'Sales Field', render: function () { renderAdminSalesMonthly('field'); } },
  { key: 'salesonline', label: 'Sales Online', render: function () { renderAdminSalesMonthly('online'); } },
  { key: 'error', label: 'Error', render: renderAdminError },
  { key: 'gooddeed', label: 'Good Deed', render: renderAdminGoodDeed },
  { key: 'attendance', label: 'Attendance', render: renderAdminAttendance },
  { key: 'workscore', label: 'ประเมิน Work Score', render: renderAdminWorkScore },
  { key: 'summary', label: 'สรุปคะแนน/เงิน', render: renderAdminSummary }
];

function setupAdminTabs() {
  var bar = document.getElementById('tabbar');
  bar.style.display = 'flex';
  bar.innerHTML = ADMIN_TABS.map(function (t) { return '<button data-key="' + t.key + '">' + t.label + '</button>'; }).join('');
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

/* ---- 1. บันทึกงาน (Admin บันทึกแทน/ดูประวัติของใครก็ได้) ---- */
function renderAdminWork() {
  var html = '<div class="card"><label>เลือกพนักงาน</label><select id="awEmp"><option value="">— เลือกชื่อ —</option>' + employeeOptions(APP.employees) + '</select></div>' +
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
    formHtml = '<label>ยอดขายส่วนตัว</label><input type="number" id="smPersonalSales">' +
      '<div class="row"><div><label>จำนวนลูกค้าใหม่</label><input type="number" id="smNewCustomers"></div><div><label>จำนวนลูกค้าที่ดึงกลับ</label><input type="number" id="smWonBack"></div></div>' +
      '<label>ยอดขายสินค้าผลักดัน</label><input type="number" id="smPush">' +
      '<label>ยอดค้างชำระ</label><input type="number" id="smOutstanding">' +
      '<label>หมายเหตุ</label><input type="text" id="smNote">';
    cols = [
      { key: 'ยอดขายส่วนตัว', label: 'ยอดขายส่วนตัว' }, { key: 'จำนวนลูกค้าใหม่', label: 'ลูกค้าใหม่' },
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
  var html = monthPickerHtml('sm', APP.month, APP.year) +
    '<div class="card"><h3>กรอกยอดประจำเดือน (' + (kind === 'field' ? 'Sales Field' : 'Sales Online') + ')</h3>' +
    '<label>พนักงาน</label><select id="smEmp">' + employeeOptions(list) + '</select>' +
    formHtml +
    '<button class="btn" id="smSave">บันทึก</button></div>' +
    '<div class="card"><h3>สรุปเดือนนี้</h3><div id="smList" class="muted">กำลังโหลด...</div></div>';
  document.getElementById('content').innerHTML = html;

  document.getElementById('sm_go').addEventListener('click', load);
  load();
  document.getElementById('smSave').addEventListener('click', function (evt) {
    var payload = kind === 'field' ? {
      employeeId: document.getElementById('smEmp').value,
      month: Number(document.getElementById('sm_m').value), year: Number(document.getElementById('sm_y').value),
      personalSales: document.getElementById('smPersonalSales').value, newCustomers: document.getElementById('smNewCustomers').value,
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
      if (!rows.length) { el.innerHTML = '<div class="muted">ยังไม่มีข้อมูลเดือนนี้</div>'; return; }
      el.innerHTML = '<div style="overflow-x:auto"><table class="simple"><tr><th>ชื่อ</th>' + cols.map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('') + '</tr>' +
        rows.map(function (r) { return '<tr><td>' + esc(r['ชื่อพนักงาน']) + '</td>' + cols.map(function (c) { return '<td>' + (c.key === 'หมายเหตุ' ? esc(r[c.key]) : fmtNum(r[c.key])) + '</td>'; }).join('') + '</tr>'; }).join('') + '</table></div>';
    }).catch(function (e) { toast(e.message || String(e), true); });
  }
}

/* ---- 4. Error ---- */
// ผู้รับผิดชอบใช้แบบ "+ เพิ่มผู้รับผิดชอบ" ทีละแถว (เพิ่ม/ลบได้ไม่จำกัด) แทน Checklist รายชื่อทั้งหมด
// เริ่มต้นด้วย 1 แถวว่างให้เลยเพื่อไม่ต้องกดเพิ่มเองตั้งแต่แถวแรก
function renderAdminError() {
  var deptOptions = APP.departments.map(function (d) { return '<option value="' + d + '">' + d + '</option>'; }).join('');
  // PHASE 1 (รอบแก้ Error 5 ระดับ): "ประเภทความผิด" ไม่ผูกระดับความรุนแรงแล้ว (ตัด data-severity ออก) — ระดับเริ่มต้นมาจาก
  // Dropdown "ผลกระทบ" แยกต่างหากด้านล่างแทน เพราะ Error ประเภทเดียวกันเกิดผลกระทบต่างกันได้ในแต่ละครั้ง
  var typeOptions = APP.errorTypes.map(function (t) { return '<option value="' + t['รหัสประเภท'] + '">' + esc(t['ชื่อประเภทความผิด']) + '</option>'; }).join('');
  var impactOptions = APP.impactOptions.map(function (i) { return '<option value="' + esc(i.key) + '" data-level="' + i.defaultLevel + '">' + esc(i.label) + ' (' + fmtNum(i.defaultPoints) + ')</option>'; }).join('');
  var severityOptions = APP.severityLevels.map(function (s) { return '<option value="' + s.level + '">' + esc(s.label) + ' (' + fmtNum(s.points) + ')</option>'; }).join('');

  var html = '<div class="card"><h3>บันทึกเหตุการณ์ความผิด</h3>' +
    '<label>วันที่เกิดเหตุ</label><input type="date" id="eDate" value="' + todayStr() + '">' +
    '<label>แผนก</label><select id="eDept">' + deptOptions + '</select>' +
    '<label>ประเภทความผิด</label><select id="eType">' + typeOptions + '</select>' +
    '<label>ผลกระทบ (กำหนดระดับความรุนแรงเริ่มต้นให้อัตโนมัติ)</label><select id="eImpact">' + impactOptions + '</select>' +
    '<div class="muted" id="eImpactDesc"></div>' +
    '<label>ระดับความรุนแรง (ปรับเองได้ — เลือกระดับ 5 ถ้าเสียหายเป็นเงินจริง+ตั้งใจปกปิด)</label><select id="eSeverity">' + severityOptions + '</select>' +
    '<div class="muted" id="eSeverityDesc"></div>' +
    '<label>รายละเอียดเหตุการณ์</label><textarea id="eDesc"></textarea>' +
    '<label>ค่าเสียหายจริง (บาท ถ้ามี — ไม่มีผลต่อคะแนน)</label><input type="number" id="eDamage">' +
    '<label>เหตุผล (กรอกเฉพาะถ้าปรับระดับต่างจากค่าเริ่มต้นตามผลกระทบที่เลือก)</label><input type="text" id="eReason">' +
    '<label>ผู้รับผิดชอบ (ทุกคนได้คะแนนเต็มตามระดับ ไม่หาร)</label>' +
    '<div id="eRespRows"></div>' +
    '<button class="btn secondary" id="eAddResp">+ เพิ่มผู้รับผิดชอบ</button>' +
    '<label style="margin-top:16px;">ผู้แจ้งปัญหา (ถ้ามี — เว้นว่างได้ถ้าไม่มีคนแจ้งเป็นพิเศษ เช่นหัวหน้าเจอเอง)</label>' +
    '<select id="eReporter"><option value="">— ไม่มี / ไม่ระบุ —</option>' + employeeOptions(APP.employees) + '</select>' +
    '<div class="muted" id="eReporterHint" style="display:none;"></div>' +
    '<button class="btn" id="eSave" style="margin-left:8px;">บันทึกเหตุการณ์</button></div>' +
    '<div class="card"><h3>เหตุการณ์เดือนนี้</h3>' + monthPickerHtml('el', APP.month, APP.year) + '<div id="elList" class="muted">กำลังโหลด...</div></div>';
  document.getElementById('content').innerHTML = html;

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

  var respCount = 0;
  function addRespRow() {
    respCount++;
    var row = document.createElement('div');
    row.className = 'row';
    row.style.alignItems = 'center';
    row.innerHTML = '<div><select class="eRespSel">' + employeeOptions(APP.employees) + '</select></div>' +
      '<div style="flex:0 0 auto;"><button class="btn small danger eRespRemove" type="button">ลบ</button></div>';
    document.getElementById('eRespRows').appendChild(row);
    row.querySelector('.eRespSel').addEventListener('change', syncReporterHint);
    row.querySelector('.eRespRemove').addEventListener('click', function () {
      row.remove();
      if (!document.querySelectorAll('.eRespSel').length) addRespRow(); // เหลืออย่างน้อย 1 แถวเสมอ
      syncReporterHint();
    });
  }
  document.getElementById('eAddResp').addEventListener('click', function () { addRespRow(); syncReporterHint(); });
  addRespRow(); // เริ่มด้วย 1 แถวว่างให้เลย

  // PHASE 1 (รอบแก้ Error 5 ระดับ): "ผลกระทบ" เป็นตัวกำหนดระดับความรุนแรงเริ่มต้น (ไม่ใช่ "ประเภทความผิด" อีกต่อไป)
  function syncSeverityToImpact() {
    var impactSel = document.getElementById('eImpact');
    var opt = impactSel.options[impactSel.selectedIndex];
    if (opt) document.getElementById('eSeverity').value = opt.getAttribute('data-level');
    var impactInfo = APP.impactOptions.filter(function (i) { return i.key === impactSel.value; })[0];
    document.getElementById('eImpactDesc').textContent = impactInfo ? impactInfo.desc : '';
    var lvl = Number(document.getElementById('eSeverity').value);
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
  function loadEvents() {
    apiGet('errorEventsForMonth', { month: Number(document.getElementById('el_m').value), year: Number(document.getElementById('el_y').value) }).then(function (rows) {
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
  var html = '<div class="card"><h3>บันทึกทำความดี</h3>' +
    '<label>วันที่</label><input type="date" id="gdDate" value="' + todayStr() + '">' +
    '<label>พนักงาน</label><select id="gdEmp">' + employeeOptions(APP.employees) + '</select>' +
    '<label>ประเภท</label><select id="gdCat">' + categories.map(function (c) { return '<option>' + c + '</option>'; }).join('') + '</select>' +
    '<label>รายละเอียด</label><textarea id="gdDesc"></textarea>' +
    '<div class="muted">ได้ Reward Points +' + fmtNum(pts) + ' คะแนน (ค่าคงที่ต่อรายการ ปรับได้ที่ Config &gt; Cfg_GoodDeedPoints) เมื่อสถานะเป็น Approved</div>' +
    '<button class="btn" id="gdSave">บันทึก</button></div>' +
    '<div class="card"><h3>รายการเดือนนี้</h3>' + monthPickerHtml('gdm', APP.month, APP.year) + '<div id="gdList" class="muted">กำลังโหลด...</div></div>';
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
function renderAdminAttendance() {
  var statusOptions = APP.attendanceStatuses.map(function (s) { return '<option value="' + s + '">' + esc(s) + '</option>'; }).join('');
  var html = '<div class="card"><h3>บันทึกการมาทำงาน (เฉพาะวันที่ผิดปกติ)</h3>' +
    '<label>พนักงาน</label><select id="atEmp">' + employeeOptions(APP.employees) + '</select>' +
    '<label>วันที่</label><input type="date" id="atDate" value="' + todayStr() + '">' +
    '<label>สถานะ</label><select id="atStatus">' + statusOptions + '</select>' +
    '<label>หมายเหตุ</label><input type="text" id="atNote" placeholder="ไม่บังคับ">' +
    '<button class="btn" id="atSave">บันทึก</button></div>' +
    '<div class="card"><h3>ประวัติเดือนนี้</h3>' + monthPickerHtml('at', APP.month, APP.year) + '<div id="atList" class="muted">กำลังโหลด...</div></div>';
  document.getElementById('content').innerHTML = html;

  document.getElementById('atSave').addEventListener('click', function (evt) {
    var payload = {
      employeeId: document.getElementById('atEmp').value,
      date: document.getElementById('atDate').value,
      status: document.getElementById('atStatus').value,
      note: document.getElementById('atNote').value
    };
    withButtonGuard(evt.target, function () { return apiPost('addAttendanceLog', payload); })
      .then(function () { toast('บันทึกแล้ว'); document.getElementById('atNote').value = ''; loadList(); })
      .catch(function (e) { toast(e.message || String(e), true); });
  });

  document.getElementById('at_go').addEventListener('click', loadList);
  loadList();
  function loadList() {
    apiGet('attendanceLogForMonth', { month: Number(document.getElementById('at_m').value), year: Number(document.getElementById('at_y').value) }).then(function (rows) {
      var el = document.getElementById('atList');
      if (!rows.length) { el.innerHTML = '<div class="muted">ไม่มีบันทึกผิดปกติในเดือนนี้ (ถือว่าทุกคนมาปกติ)</div>'; return; }
      el.innerHTML = rows.map(function (r) {
        return '<div class="list-item"><b>' + esc(r['ชื่อพนักงาน']) + '</b> — ' + esc(r['สถานะ']) + '<div class="meta">' + fmtDate(r['วันที่']) + (r['หมายเหตุ'] ? ' · ' + esc(r['หมายเหตุ']) : '') + '</div></div>';
      }).join('');
    }).catch(function (e) { toast(e.message || String(e), true); });
  }
}

/* ---- 8. ประเมิน Work Score (PHASE 2 — A ผลงาน 10 + B คุณภาพ 6 + C ความร่วมมือ 4 = เต็ม 20) ---- */
// พนักงานแผนก Support & Strategy (Business Operations Lead) ไม่ให้เลือกในนี้ — มีระบบประเมินแยกต่างหากตามที่สั่ง
function renderAdminWorkScore() {
  var eligible = APP.employees.filter(function (e) { return e.department !== 'Support & Strategy'; });
  var html = monthPickerHtml('ws', APP.month, APP.year) +
    '<div class="card"><h3>ประเมิน Work Score (เต็ม 20)</h3>' +
    '<div class="meta">ไม่ต้องหักเพราะมาสาย/ขาด/ลา/Error — คิดแยกในคะแนนความผิด/ขาดลามาสายอยู่แล้ว ดูประวัติการทำงานประกอบได้จากแท็บ "บันทึกงาน" หรือชีต Daily_Work_Log</div>' +
    '<label>พนักงาน</label><select id="wsEmp">' + employeeOptions(eligible) + '</select>' +
    '<div id="wsExisting" class="meta" style="margin:6px 0;">กำลังโหลด...</div>' +
    '<label>A. ผลงานตามหน้าที่ (0-10)</label><input type="number" id="wsA" min="0" max="10" step="1">' +
    '<label>B. คุณภาพและความรับผิดชอบ (0-6)</label><input type="number" id="wsB" min="0" max="6" step="1">' +
    '<label>C. ความร่วมมือและทัศนคติในการทำงาน (0-4)</label><input type="number" id="wsC" min="0" max="4" step="1">' +
    '<div class="meta">รวม Work Score = <b id="wsSum">0</b> / 20</div>' +
    '<label>ผู้ประเมิน</label><input type="text" id="wsEvaluator" placeholder="ชื่อผู้ประเมิน">' +
    '<label>หมายเหตุ</label><textarea id="wsNote" placeholder="เช่น เดือนนี้รับงานเพิ่มและสามารถปิดงานได้เอง"></textarea>' +
    '<button class="btn" id="wsSave">บันทึกคะแนน Work Score</button></div>';
  document.getElementById('content').innerHTML = html;
  if (!eligible.length) { return; }

  function updateSum() {
    var a = Number(document.getElementById('wsA').value) || 0;
    var b = Number(document.getElementById('wsB').value) || 0;
    var c = Number(document.getElementById('wsC').value) || 0;
    document.getElementById('wsSum').textContent = a + b + c;
  }
  ['wsA', 'wsB', 'wsC'].forEach(function (id) { document.getElementById(id).addEventListener('input', updateSum); });

  function loadExisting() {
    var employeeId = document.getElementById('wsEmp').value;
    var month = Number(document.getElementById('ws_m').value), year = Number(document.getElementById('ws_y').value);
    document.getElementById('wsExisting').textContent = 'กำลังโหลด...';
    apiGet('workScoreDetail', { employeeId: employeeId, month: month, year: year }).then(function (d) {
      if (d) {
        document.getElementById('wsA').value = d.workA;
        document.getElementById('wsB').value = d.workB;
        document.getElementById('wsC').value = d.workC;
        document.getElementById('wsEvaluator').value = d.evaluator;
        document.getElementById('wsNote').value = d.note;
        document.getElementById('wsExisting').textContent = 'เคยประเมินไว้แล้ว โดย ' + esc(d.evaluator) + (d.evalDate ? (' เมื่อ ' + fmtDate(d.evalDate)) : '') + ' — แก้แล้วกดบันทึกซ้ำได้';
      } else {
        document.getElementById('wsA').value = ''; document.getElementById('wsB').value = ''; document.getElementById('wsC').value = '';
        document.getElementById('wsEvaluator').value = ''; document.getElementById('wsNote').value = '';
        document.getElementById('wsExisting').textContent = 'ยังไม่เคยประเมินเดือนนี้';
      }
      updateSum();
    }).catch(function (e) { toast(e.message || String(e), true); });
  }
  document.getElementById('wsEmp').addEventListener('change', loadExisting);
  document.getElementById('ws_go').addEventListener('click', loadExisting);
  loadExisting();

  document.getElementById('wsSave').addEventListener('click', function (evt) {
    var a = document.getElementById('wsA').value, b = document.getElementById('wsB').value, c = document.getElementById('wsC').value;
    if (a === '' || Number(a) < 0 || Number(a) > 10) { toast('ผลงานตามหน้าที่ ต้องอยู่ระหว่าง 0-10', true); return; }
    if (b === '' || Number(b) < 0 || Number(b) > 6) { toast('คุณภาพและความรับผิดชอบ ต้องอยู่ระหว่าง 0-6', true); return; }
    if (c === '' || Number(c) < 0 || Number(c) > 4) { toast('ความร่วมมือและทัศนคติ ต้องอยู่ระหว่าง 0-4', true); return; }
    var evaluator = document.getElementById('wsEvaluator').value.trim();
    if (!evaluator) { toast('กรุณาระบุชื่อผู้ประเมิน', true); return; }
    var payload = {
      employeeId: document.getElementById('wsEmp').value,
      month: Number(document.getElementById('ws_m').value), year: Number(document.getElementById('ws_y').value),
      workA: a, workB: b, workC: c, evaluator: evaluator, note: document.getElementById('wsNote').value
    };
    withButtonGuard(evt.target, function () { return apiPost('setWorkScore', payload); })
      .then(function () { toast('บันทึกคะแนน Work Score แล้ว'); loadExisting(); }).catch(function (e) { toast(e.message || String(e), true); });
  });
}

/* ---- 9. สรุปคะแนน/เงิน ---- */
// เรียงตามคะแนนรวมมาก→น้อยเป็นค่าเริ่มต้นเสมอ และกรองตามกลุ่มเงินพิเศษได้ (Support/Sales Field/Sales Online — ตรงกับ INCENTIVE_GROUPS ฝั่ง Backend)
var SUMMARY_GROUP_OPTIONS = ['Support', 'Sales Field', 'Sales Online'];
function renderAdminSummary() {
  var groupFilterOptions = '<option value="">ทั้งหมด</option>' + SUMMARY_GROUP_OPTIONS.map(function (g) { return '<option value="' + g + '">' + g + '</option>'; }).join('');
  var html = monthPickerHtml('cs', APP.month, APP.year) +
    '<div class="card"><label>กรองตามกลุ่มเงินพิเศษ</label><select id="csGroupFilter">' + groupFilterOptions + '</select>' +
    '<button class="btn secondary" id="csExport" style="margin-top:10px;">ดาวน์โหลดเป็น CSV</button></div>' +
    '<div class="card"><div id="csList" class="muted">กำลังโหลด...</div></div>';
  document.getElementById('content').innerHTML = html;
  var lastRows = [];
  document.getElementById('cs_go').addEventListener('click', load);
  document.getElementById('csGroupFilter').addEventListener('change', render);
  load();
  function load() {
    apiGet('companyMonthlyScores', { month: Number(document.getElementById('cs_m').value), year: Number(document.getElementById('cs_y').value) }).then(function (rows) {
      lastRows = rows;
      render();
    }).catch(function (e) { toast(e.message || String(e), true); });
  }
  function filteredSortedRows() {
    var groupFilter = document.getElementById('csGroupFilter').value;
    return lastRows.filter(function (r) { return !groupFilter || r['กลุ่มเงินพิเศษ'] === groupFilter; })
      .slice().sort(function (a, b) { return (Number(b['คะแนนรวม']) || 0) - (Number(a['คะแนนรวม']) || 0); }); // เรียงคะแนนรวมมาก→น้อยเป็นค่าเริ่มต้น
  }
  function render() {
    var rows = filteredSortedRows();
    var el = document.getElementById('csList');
    if (!rows.length) { el.innerHTML = '<div class="muted">ไม่มีข้อมูล</div>'; return; }
    el.innerHTML = '<div style="overflow-x:auto"><table class="simple"><tr><th>ชื่อ</th><th>แผนก</th><th>กลุ่มเงินพิเศษ</th><th>งาน</th><th>ผิด</th><th>ขาด/ลา/สาย</th><th>รวม</th><th>ดี</th><th>รางวัล</th><th>Reward Points สะสม</th><th>เงินพิเศษ</th></tr>' +
      rows.map(function (r) { return '<tr><td>' + esc(r['ชื่อพนักงาน']) + '</td><td>' + esc(r['แผนก']) + '</td><td>' + esc(r['กลุ่มเงินพิเศษ']) + '</td><td>' + fmtNum(r['คะแนนงาน']) + '</td><td>' + fmtNum(r['คะแนนความผิด']) + '</td><td>' + fmtNum(r['คะแนนขาดลามาสาย']) + '</td><td><b>' + fmtNum(r['คะแนนรวม']) + '</b></td><td>' + fmtNum(r['คะแนนทำความดี']) + '</td><td>' + fmtNum(r['คะแนนแจ้งรางวัล']) + '</td><td>' + fmtNum(r['Reward Points สะสม']) + '</td><td>' + fmtNum(r['เงินพิเศษ']) + '</td></tr>'; }).join('') + '</table></div>';
  }
  document.getElementById('csExport').addEventListener('click', function () {
    var rows = filteredSortedRows();
    if (!rows.length) { toast('ไม่มีข้อมูลให้ดาวน์โหลด', true); return; }
    var cols = ['รหัสพนักงาน', 'ชื่อพนักงาน', 'แผนก', 'กลุ่มเงินพิเศษ', 'คะแนนงาน', 'คะแนนความผิด', 'คะแนนขาดลามาสาย', 'คะแนนรวม', 'คะแนนทำความดี', 'คะแนนแจ้งรางวัล', 'Reward Points สะสม', 'เงินพิเศษ'];
    var csv = cols.join(',') + '\n' + rows.map(function (r) { return cols.map(function (c) { return '"' + String(r[c] === undefined ? '' : r[c]).replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
    var a = document.createElement('a'); a.href = 'data:text/csv;charset=utf-8,﻿' + encodeURIComponent(csv); a.download = 'monthly_score.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  });
}

boot();
