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
  if (!CONFIG || !CONFIG.API_URL || CONFIG.API_URL.indexOf('YOUR_DEPLOYMENT_ID_HERE') !== -1) {
    return Promise.reject(new Error('ยังไม่ได้ตั้งค่า API_URL ใน config.js — กรุณา Deploy Apps Script แล้วนำ URL มาใส่ก่อนใช้งาน'));
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
  if (!CONFIG || !CONFIG.API_URL || CONFIG.API_URL.indexOf('YOUR_DEPLOYMENT_ID_HERE') !== -1) {
    return Promise.reject(new Error('ยังไม่ได้ตั้งค่า API_URL ใน config.js — กรุณา Deploy Apps Script แล้วนำ URL มาใส่ก่อนใช้งาน'));
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

var APP = { mode: getInitialMode(), employees: [], departments: [], errorTypes: [], severityLevels: [], month: null, year: null, tab: null };

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
  apiGet('bootstrap', {}).then(function (data) {
    APP.employees = data.employees; APP.departments = data.departments;
    APP.errorTypes = data.errorTypes; APP.severityLevels = data.severityLevels;
    APP.month = data.month; APP.year = data.year;
    renderShell();
  }).catch(function (e) {
    document.getElementById('content').innerHTML = '<div class="card"><h3>โหลดไม่สำเร็จ</h3><p class="muted">' + esc(e.message || e) + '</p><button class="btn secondary" onclick="boot()">ลองใหม่อีกครั้ง</button></div>';
  });
}

function renderShell() {
  var titleEl = document.getElementById('headerTitle');
  var toggleEl = document.getElementById('modeToggle');
  if (APP.mode === 'admin') {
    titleEl.textContent = 'FUTAI — Admin';
    toggleEl.textContent = 'โหมดพนักงาน';
    toggleEl.onclick = function () { APP.mode = 'employee'; renderShell(); };
    setupAdminTabs();
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
    area.innerHTML = dailyFormHtml('e');
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
function dailyFormHtml(prefix) {
  return '<div class="card"><h3>บันทึกงานวันนี้</h3>' +
    '<label>วันที่</label><input type="date" id="' + prefix + '_date" value="' + todayStr() + '">' +
    '<label>งานที่ทำ</label><input type="text" id="' + prefix + '_task" placeholder="เช่น จัดของ / เช็กของ / ส่งของ">' +
    '<div class="row"><div><label>จำนวน</label><input type="number" id="' + prefix + '_qty"></div><div><label>หน่วย</label><input type="text" id="' + prefix + '_unit" placeholder="รายการ / เจ้า / ชิ้น"></div></div>' +
    '<label>หมายเหตุ</label><input type="text" id="' + prefix + '_note">' +
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
    var task = document.getElementById(prefix + '_task').value.trim();
    if (!task) { toast('กรอกงานที่ทำก่อน', true); return; }
    pending.push({ task: task, qty: document.getElementById(prefix + '_qty').value, unit: document.getElementById(prefix + '_unit').value, note: document.getElementById(prefix + '_note').value });
    document.getElementById(prefix + '_task').value = ''; document.getElementById(prefix + '_qty').value = ''; document.getElementById(prefix + '_unit').value = ''; document.getElementById(prefix + '_note').value = '';
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

/* ===================== ADMIN MODE ===================== */
var ADMIN_TABS = [
  { key: 'work', label: 'บันทึกงาน', render: renderAdminWork },
  { key: 'salesfield', label: 'Sales Field', render: function () { renderAdminSalesMonthly('field'); } },
  { key: 'salesonline', label: 'Sales Online', render: function () { renderAdminSalesMonthly('online'); } },
  { key: 'error', label: 'Error', render: renderAdminError },
  { key: 'gooddeed', label: 'Good Deed', render: renderAdminGoodDeed },
  { key: 'reward', label: 'Report Reward', render: renderAdminReward },
  { key: 'attendance', label: 'Attendance', render: renderAdminAttendance },
  { key: 'workscore', label: 'ประเมินคะแนน', render: renderAdminWorkScore },
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
      document.getElementById('awArea').innerHTML = dailyFormHtml('aw');
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
function renderAdminSalesMonthly(kind) {
  var dept = kind === 'field' ? 'Sales' : 'Online';
  var list = APP.employees.filter(function (e) { return e.department === dept; });
  var html = monthPickerHtml('sm', APP.month, APP.year) +
    '<div class="card"><h3>กรอกยอดประจำเดือน (' + (kind === 'field' ? 'Sales Field' : 'Sales Online') + ')</h3>' +
    '<label>พนักงาน</label><select id="smEmp">' + employeeOptions(list) + '</select>' +
    '<label>ยอดขาย</label><input type="number" id="smSales">' +
    '<div class="row"><div><label>ลูกค้าใหม่</label><input type="number" id="smNew"></div><div><label>ลูกค้าไม่เคลื่อนไหว</label><input type="number" id="smInactive"></div></div>' +
    '<label>ยอดขายสินค้าผลักดัน</label><input type="number" id="smPush">' +
    '<label>ยอดค้างชำระ</label><input type="number" id="smOutstanding">' +
    '<button class="btn" id="smSave">บันทึก</button></div>' +
    '<div class="card"><h3>สรุปเดือนนี้</h3><div id="smList" class="muted">กำลังโหลด...</div></div>';
  document.getElementById('content').innerHTML = html;

  document.getElementById('sm_go').addEventListener('click', load);
  load();
  document.getElementById('smSave').addEventListener('click', function (evt) {
    var payload = {
      employeeId: document.getElementById('smEmp').value,
      month: Number(document.getElementById('sm_m').value), year: Number(document.getElementById('sm_y').value),
      sales: document.getElementById('smSales').value, newCustomers: document.getElementById('smNew').value,
      inactiveCustomers: document.getElementById('smInactive').value, pushProductSales: document.getElementById('smPush').value,
      outstandingAmount: document.getElementById('smOutstanding').value
    };
    withButtonGuard(evt.target, function () { return apiPost('upsertSalesMonthly', { kind: kind, payload: payload }); })
      .then(function () { toast('บันทึกแล้ว'); load(); }).catch(function (e) { toast(e.message || String(e), true); });
  });

  function load() {
    var m = Number(document.getElementById('sm_m').value), y = Number(document.getElementById('sm_y').value);
    apiGet('salesMonthlyAll', { kind: kind, month: m, year: y }).then(function (rows) {
      var el = document.getElementById('smList');
      if (!rows.length) { el.innerHTML = '<div class="muted">ยังไม่มีข้อมูลเดือนนี้</div>'; return; }
      el.innerHTML = '<div style="overflow-x:auto"><table class="simple"><tr><th>ชื่อ</th><th>ยอดขาย</th><th>ลูกค้าใหม่</th><th>ไม่เคลื่อนไหว</th><th>สินค้าผลักดัน</th><th>ค้างชำระ</th></tr>' +
        rows.map(function (r) { return '<tr><td>' + esc(r['ชื่อพนักงาน']) + '</td><td>' + fmtNum(r['ยอดขาย']) + '</td><td>' + fmtNum(r['ลูกค้าใหม่']) + '</td><td>' + fmtNum(r['ลูกค้าไม่เคลื่อนไหว']) + '</td><td>' + fmtNum(r['ยอดขายสินค้าผลักดัน']) + '</td><td>' + fmtNum(r['ยอดค้างชำระ']) + '</td></tr>'; }).join('') + '</table></div>';
    }).catch(function (e) { toast(e.message || String(e), true); });
  }
}

/* ---- 4. Error ---- */
function renderAdminError() {
  var deptOptions = APP.departments.map(function (d) { return '<option value="' + d + '">' + d + '</option>'; }).join('');
  var typeOptions = APP.errorTypes.map(function (t) { return '<option value="' + t['รหัสประเภท'] + '" data-severity="' + t['ระดับเริ่มต้น'] + '">' + esc(t['ชื่อประเภทความผิด']) + '</option>'; }).join('');
  var severityOptions = APP.severityLevels.map(function (s) { return '<option value="' + s.level + '">' + esc(s.label) + ' (' + fmtNum(s.points) + ')</option>'; }).join('');
  var empChecklist = APP.employees.map(function (e) { return '<label><input type="checkbox" class="respChk" value="' + e.id + '"> ' + esc(e.name) + ' — ' + esc(e.department) + '</label>'; }).join('');

  var html = '<div class="card"><h3>บันทึกเหตุการณ์ความผิด</h3>' +
    '<label>วันที่เกิดเหตุ</label><input type="date" id="eDate" value="' + todayStr() + '">' +
    '<label>แผนก</label><select id="eDept">' + deptOptions + '</select>' +
    '<label>ประเภทความผิด</label><select id="eType">' + typeOptions + '</select>' +
    '<label>ระดับความรุนแรง</label><select id="eSeverity">' + severityOptions + '</select>' +
    '<div class="muted" id="eSeverityDesc"></div>' +
    '<label>รายละเอียดเหตุการณ์</label><textarea id="eDesc"></textarea>' +
    '<label>ค่าเสียหายจริง (บาท ถ้ามี — ไม่มีผลต่อคะแนน)</label><input type="number" id="eDamage">' +
    '<label>เหตุผล (กรอกเฉพาะถ้าปรับระดับต่างจากค่าเริ่มต้น)</label><input type="text" id="eReason">' +
    '<label>ผู้รับผิดชอบ (เลือกได้หลายคน — ทุกคนได้คะแนนเต็มตามระดับ ไม่หาร)</label>' +
    '<div class="checklist">' + empChecklist + '</div>' +
    '<button class="btn" id="eSave">บันทึกเหตุการณ์</button></div>' +
    '<div class="card"><h3>เหตุการณ์เดือนนี้</h3>' + monthPickerHtml('el', APP.month, APP.year) + '<div id="elList" class="muted">กำลังโหลด...</div></div>';
  document.getElementById('content').innerHTML = html;

  function syncSeverityToType() {
    var typeSel = document.getElementById('eType');
    var opt = typeSel.options[typeSel.selectedIndex];
    if (opt) document.getElementById('eSeverity').value = opt.getAttribute('data-severity');
    var lvl = Number(document.getElementById('eSeverity').value);
    var info = APP.severityLevels.filter(function (s) { return s.level === lvl; })[0];
    document.getElementById('eSeverityDesc').textContent = info ? info.desc : '';
  }
  document.getElementById('eSeverity').addEventListener('change', function () {
    var lvl = Number(this.value);
    var info = APP.severityLevels.filter(function (s) { return s.level === lvl; })[0];
    document.getElementById('eSeverityDesc').textContent = info ? info.desc : '';
  });
  document.getElementById('eType').addEventListener('change', syncSeverityToType);
  syncSeverityToType();

  document.getElementById('eSave').addEventListener('click', function (evt) {
    var typeSel = document.getElementById('eType');
    var defaultSeverity = Number(typeSel.options[typeSel.selectedIndex].getAttribute('data-severity'));
    var chosenSeverity = Number(document.getElementById('eSeverity').value);
    var responsibleIds = Array.prototype.slice.call(document.querySelectorAll('.respChk:checked')).map(function (c) { return c.value; });
    if (!responsibleIds.length) { toast('เลือกผู้รับผิดชอบอย่างน้อย 1 คน', true); return; }
    var payload = {
      date: document.getElementById('eDate').value, department: document.getElementById('eDept').value, errorTypeId: typeSel.value,
      severityOverride: chosenSeverity !== defaultSeverity ? chosenSeverity : '', overrideReason: document.getElementById('eReason').value,
      description: document.getElementById('eDesc').value, damageAmount: document.getElementById('eDamage').value, responsibleIds: responsibleIds
    };
    withButtonGuard(evt.target, function () { return apiPost('submitErrorEvent', payload); })
      .then(function (r) { toast('บันทึกแล้ว ' + r.eventId + ' (' + r.pointsPerPerson + ' คะแนน/คน)'); renderAdminError(); })
      .catch(function (e) { toast(e.message || String(e), true); });
  });

  document.getElementById('el_go').addEventListener('click', loadEvents);
  loadEvents();
  function loadEvents() {
    apiGet('errorEventsForMonth', { month: Number(document.getElementById('el_m').value), year: Number(document.getElementById('el_y').value) }).then(function (rows) {
      var el = document.getElementById('elList');
      if (!rows.length) { el.innerHTML = '<div class="muted">ไม่มีข้อมูลเดือนนี้</div>'; return; }
      el.innerHTML = rows.map(function (r) {
        return '<div class="list-item"><b>' + esc(r['รหัสเหตุการณ์']) + '</b> — ' + esc(r['ชื่อประเภทความผิด']) + ' (ระดับ ' + r['ระดับ'] + ', ' + r['คะแนนต่อคน'] + ')<div class="meta">' + fmtDate(r['วันที่']) + ' · ' + esc(r['แผนก']) + ' · ผู้รับผิดชอบ: ' + esc(r['ผู้รับผิดชอบ']) + '</div></div>';
      }).join('');
    }).catch(function (e) { toast(e.message || String(e), true); });
  }
}

/* ---- 5. Good Deed ---- */
function renderAdminGoodDeed() {
  var categories = ['ปิดไฟ/ปิดอุปกรณ์', 'ทำความสะอาดพื้นที่ส่วนรวม', 'ช่วยงานส่วนรวม', 'ช่วยแก้ปัญหาให้บริษัท', 'แจ้งปัญหาที่ช่วยป้องกันความเสียหาย', 'อื่นๆ'];
  var html = '<div class="card"><h3>บันทึกทำความดี</h3>' +
    '<label>วันที่</label><input type="date" id="gdDate" value="' + todayStr() + '">' +
    '<label>พนักงาน</label><select id="gdEmp">' + employeeOptions(APP.employees) + '</select>' +
    '<label>ประเภท</label><select id="gdCat">' + categories.map(function (c) { return '<option>' + c + '</option>'; }).join('') + '</select>' +
    '<label>รายละเอียด</label><textarea id="gdDesc"></textarea>' +
    '<label>คะแนน</label><input type="number" id="gdPoints" value="1">' +
    '<button class="btn" id="gdSave">บันทึก</button></div>' +
    '<div class="card"><h3>รายการเดือนนี้</h3>' + monthPickerHtml('gdm', APP.month, APP.year) + '<div id="gdList" class="muted">กำลังโหลด...</div></div>';
  document.getElementById('content').innerHTML = html;

  document.getElementById('gdSave').addEventListener('click', function (evt) {
    var payload = {
      date: document.getElementById('gdDate').value, employeeId: document.getElementById('gdEmp').value,
      category: document.getElementById('gdCat').value, description: document.getElementById('gdDesc').value, points: document.getElementById('gdPoints').value
    };
    withButtonGuard(evt.target, function () { return apiPost('addGoodDeed', payload); })
      .then(function () { toast('บันทึกแล้ว'); loadList(); }).catch(function (e) { toast(e.message || String(e), true); });
  });

  document.getElementById('gdm_go').addEventListener('click', loadList);
  loadList();
  function loadList() {
    apiGet('goodDeedForMonth', { month: Number(document.getElementById('gdm_m').value), year: Number(document.getElementById('gdm_y').value) }).then(function (rows) {
      var el = document.getElementById('gdList');
      if (!rows.length) { el.innerHTML = '<div class="muted">ยังไม่มีข้อมูล</div>'; return; }
      el.innerHTML = rows.map(function (r) { return '<div class="list-item"><b>' + esc(r['ชื่อพนักงาน']) + '</b> — ' + esc(r['ประเภท']) + ' (+' + fmtNum(r['คะแนน']) + ')<div class="meta">' + fmtDate(r['วันที่']) + ' · ' + esc(r['รายละเอียด']) + '</div></div>'; }).join('');
    }).catch(function (e) { toast(e.message || String(e), true); });
  }
}

/* ---- 6. Report Reward ---- */
function renderAdminReward() {
  var html = '<div class="card"><h3>ให้รางวัลผู้แจ้งปัญหา</h3>' +
    '<label>วันที่</label><input type="date" id="rwDate" value="' + todayStr() + '">' +
    '<label>ผู้แจ้ง</label><select id="rwEmp">' + employeeOptions(APP.employees) + '</select>' +
    '<label>เรื่อง</label><input type="text" id="rwSubject">' +
    '<label>รายละเอียด</label><textarea id="rwDesc"></textarea>' +
    '<label>คะแนน/รางวัล</label><input type="number" id="rwPoints" value="1">' +
    '<label>สถานะ</label><select id="rwStatus"><option>Approved</option><option>Pending</option><option>Rejected</option></select>' +
    '<button class="btn" id="rwSave">บันทึก</button></div>' +
    '<div class="card"><h3>รายการเดือนนี้</h3>' + monthPickerHtml('rwm', APP.month, APP.year) + '<div id="rwList" class="muted">กำลังโหลด...</div></div>';
  document.getElementById('content').innerHTML = html;

  document.getElementById('rwSave').addEventListener('click', function (evt) {
    var payload = {
      date: document.getElementById('rwDate').value, reporterId: document.getElementById('rwEmp').value,
      subject: document.getElementById('rwSubject').value, description: document.getElementById('rwDesc').value,
      points: document.getElementById('rwPoints').value, status: document.getElementById('rwStatus').value
    };
    withButtonGuard(evt.target, function () { return apiPost('addReportReward', payload); })
      .then(function () { toast('บันทึกแล้ว'); loadList(); }).catch(function (e) { toast(e.message || String(e), true); });
  });

  document.getElementById('rwm_go').addEventListener('click', loadList);
  loadList();
  function statusBadge(s) { var cls = s === 'Approved' ? 'approved' : (s === 'Rejected' ? 'rejected' : 'pending'); return '<span class="badge ' + cls + '">' + s + '</span>'; }
  function loadList() {
    apiGet('reportRewardForMonth', { month: Number(document.getElementById('rwm_m').value), year: Number(document.getElementById('rwm_y').value) }).then(function (rows) {
      var el = document.getElementById('rwList');
      if (!rows.length) { el.innerHTML = '<div class="muted">ยังไม่มีข้อมูล</div>'; return; }
      el.innerHTML = rows.map(function (r) {
        return '<div class="list-item">' + statusBadge(r['สถานะ']) + ' <b>' + esc(r['ชื่อผู้แจ้ง']) + '</b> — ' + esc(r['เรื่อง']) + ' (+' + fmtNum(r['คะแนน']) + ')<div class="meta">' + fmtDate(r['วันที่']) + '</div>' +
          '<select class="stChg" data-id="' + r['รหัสรายการ'] + '"><option ' + (r['สถานะ'] === 'Pending' ? 'selected' : '') + '>Pending</option><option ' + (r['สถานะ'] === 'Approved' ? 'selected' : '') + '>Approved</option><option ' + (r['สถานะ'] === 'Rejected' ? 'selected' : '') + '>Rejected</option></select></div>';
      }).join('');
      Array.prototype.forEach.call(el.querySelectorAll('.stChg'), function (sel) {
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

/* ---- 7. Attendance ---- */
function renderAdminAttendance() {
  var html = monthPickerHtml('at', APP.month, APP.year) +
    '<div class="card"><h3>กรอกขาด/ลา/สาย</h3>' +
    '<label>พนักงาน</label><select id="atEmp">' + employeeOptions(APP.employees) + '</select>' +
    '<div class="row"><div><label>ขาดงาน (วัน)</label><input type="number" id="atAbsent" value="0"></div><div><label>ลา (วัน)</label><input type="number" id="atLeave" value="0"></div><div><label>สาย (ครั้ง)</label><input type="number" id="atLate" value="0"></div></div>' +
    '<button class="btn" id="atSave">บันทึก</button></div>';
  document.getElementById('content').innerHTML = html;
  document.getElementById('at_go').addEventListener('click', function () { toast('เลือกเดือน/ปีแล้วกรอกข้อมูลด้านล่างได้เลย'); });
  document.getElementById('atSave').addEventListener('click', function (evt) {
    var payload = {
      employeeId: document.getElementById('atEmp').value, month: Number(document.getElementById('at_m').value), year: Number(document.getElementById('at_y').value),
      absent: document.getElementById('atAbsent').value, leave: document.getElementById('atLeave').value, late: document.getElementById('atLate').value
    };
    withButtonGuard(evt.target, function () { return apiPost('setAttendance', payload); })
      .then(function () { toast('บันทึกแล้ว'); }).catch(function (e) { toast(e.message || String(e), true); });
  });
}

/* ---- 8. ประเมินคะแนน (Work Score) ---- */
function renderAdminWorkScore() {
  var html = monthPickerHtml('ws', APP.month, APP.year) +
    '<div class="card"><h3>ให้คะแนนงาน (0-60)</h3>' +
    '<label>พนักงาน</label><select id="wsEmp">' + employeeOptions(APP.employees) + '</select>' +
    '<label>คะแนนงาน (0-60)</label><input type="number" id="wsScore" min="0" max="60">' +
    '<label>หมายเหตุ</label><textarea id="wsNote" placeholder="เช่น งานครบและตรงเวลา"></textarea>' +
    '<button class="btn" id="wsSave">บันทึกคะแนน</button></div>';
  document.getElementById('content').innerHTML = html;
  document.getElementById('ws_go').addEventListener('click', function () { toast('เลือกเดือน/ปีแล้วกดบันทึกคะแนนได้เลย'); });
  document.getElementById('wsSave').addEventListener('click', function (evt) {
    var score = document.getElementById('wsScore').value;
    if (score === '' || Number(score) < 0 || Number(score) > 60) { toast('คะแนนต้องอยู่ระหว่าง 0-60', true); return; }
    var payload = { employeeId: document.getElementById('wsEmp').value, month: Number(document.getElementById('ws_m').value), year: Number(document.getElementById('ws_y').value), score: score, note: document.getElementById('wsNote').value };
    withButtonGuard(evt.target, function () { return apiPost('setWorkScore', payload); })
      .then(function () { toast('บันทึกคะแนนงานแล้ว'); }).catch(function (e) { toast(e.message || String(e), true); });
  });
}

/* ---- 9. สรุปคะแนน/เงิน ---- */
function renderAdminSummary() {
  var html = monthPickerHtml('cs', APP.month, APP.year) +
    '<div class="card"><button class="btn secondary" id="csExport">ดาวน์โหลดเป็น CSV</button></div>' +
    '<div class="card"><div id="csList" class="muted">กำลังโหลด...</div></div>';
  document.getElementById('content').innerHTML = html;
  var lastRows = [];
  document.getElementById('cs_go').addEventListener('click', load);
  load();
  function load() {
    apiGet('companyMonthlyScores', { month: Number(document.getElementById('cs_m').value), year: Number(document.getElementById('cs_y').value) }).then(function (rows) {
      lastRows = rows;
      var el = document.getElementById('csList');
      el.innerHTML = '<div style="overflow-x:auto"><table class="simple"><tr><th>ชื่อ</th><th>แผนก</th><th>งาน</th><th>ผิด</th><th>ขาด/ลา/สาย</th><th>รวม</th><th>ดี</th><th>รางวัล</th><th>เงินพิเศษ</th></tr>' +
        rows.map(function (r) { return '<tr><td>' + esc(r['ชื่อพนักงาน']) + '</td><td>' + esc(r['แผนก']) + '</td><td>' + fmtNum(r['คะแนนงาน']) + '</td><td>' + fmtNum(r['คะแนนความผิด']) + '</td><td>' + fmtNum(r['คะแนนขาดลามาสาย']) + '</td><td><b>' + fmtNum(r['คะแนนรวม']) + '</b></td><td>' + fmtNum(r['คะแนนทำความดี']) + '</td><td>' + fmtNum(r['คะแนนแจ้งรางวัล']) + '</td><td>' + fmtNum(r['เงินพิเศษ']) + '</td></tr>'; }).join('') + '</table></div>';
    }).catch(function (e) { toast(e.message || String(e), true); });
  }
  document.getElementById('csExport').addEventListener('click', function () {
    if (!lastRows.length) { toast('ไม่มีข้อมูลให้ดาวน์โหลด', true); return; }
    var cols = ['รหัสพนักงาน', 'ชื่อพนักงาน', 'แผนก', 'คะแนนงาน', 'คะแนนความผิด', 'คะแนนขาดลามาสาย', 'คะแนนรวม', 'คะแนนทำความดี', 'คะแนนแจ้งรางวัล', 'เงินพิเศษ'];
    var csv = cols.join(',') + '\n' + lastRows.map(function (r) { return cols.map(function (c) { return '"' + String(r[c] === undefined ? '' : r[c]).replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
    var a = document.createElement('a'); a.href = 'data:text/csv;charset=utf-8,﻿' + encodeURIComponent(csv); a.download = 'monthly_score.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  });
}

boot();
