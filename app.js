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
    if (!json || json.success !== true) {
      var serverErr = new Error((json && json.error) || 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์');
      serverErr.serverReported = true; // เซิร์ฟเวอร์ตอบกลับเองว่าทำไม่สำเร็จ (ต่างจากเน็ตหลุด/หมดเวลา ที่ไม่รู้ว่าฝั่งเซิร์ฟเวอร์ทำไปแล้วหรือยัง)
      throw serverErr;
    }
    return json.data;
  }).catch(function (e) { var wrapped = new Error(friendlyErrorMessage(e)); wrapped.serverReported = !!(e && e.serverReported); throw wrapped; });
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

// เหลือโหมดเดียวคือผู้ดูแลระบบ (ถอดโหมดพนักงาน/หน้าบันทึกงานออกแล้ว) — เปิดเว็บมาจะเจอหน้ากรอกรหัสผ่านเลย ไม่ต้องใส่ ?mode=admin
function getInitialMode() { return 'admin'; }

var APP = { mode: getInitialMode(), employees: [], departments: [], errorTypes: [], severityLevels: [], impactOptions: [], workTypesByDept: {}, attendanceStatuses: [], leaveTypes: [], reportRewardDefaults: { self: null, external: null }, goodDeedPoints: null, month: null, year: null, tab: null, adminUnlocked: false };

// จำว่าผ่านรหัสผ่านหน้า "สรุปคะแนน/เงิน" แล้วในแท็บนี้ (sessionStorage = อยู่แค่แท็บนี้ ปิดแท็บแล้วต้องใส่ใหม่)
// รหัสผ่านเดิมที่เคยใช้เข้าโหมด Admin (Cfg_AdminPassword) ย้ายมาล็อกบางหน้าแทน: Dashboard, ประเมิน Work Score, คะแนนพัฒนาตัวเอง, สรุปคะแนน/เงิน, สรุปรายปี, จัดการพนักงาน
// (รหัสเดียวกัน ใส่ครั้งเดียวผ่านทุกหน้าในแท็บนี้) หน้าที่เหลือ (Error, Good Deed, Attendance, ปฏิทินบริษัท) เข้าได้เลยไม่ต้องใส่รหัส
function isSummaryUnlockedThisTab() {
  try { return sessionStorage.getItem('futai_summary_unlocked') === '1'; } catch (e) { return false; }
}
function markSummaryUnlockedThisTab() {
  try { sessionStorage.setItem('futai_summary_unlocked', '1'); } catch (e) { /* ถ้า sessionStorage ใช้ไม่ได้ก็แค่ต้องใส่รหัสใหม่ทุกครั้งที่เปิดหน้านี้ */ }
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

// V3: โครงสร้างคะแนนเต็มรายเดือน (Work/Error/ขาดลามาสาย/พัฒนาตัวเอง/อายุงาน + ตัวคูณคะแนนหัก Error) — Backend ส่งมาให้ทุกแถวของ companyMonthlyScores
// (_workWeight ฯลฯ) และใน scoreWeights/workScoreBulk/selfDevBulk (workWeight ฯลฯ) หน้าเว็บอ่านจากตรงนี้ทั้งหมด ไม่ Hardcode 20/60/20 แล้ว
// เพราะแต่ละเดือนไม่เหมือนกัน (ส.ค./ก.ย./ต.ค. 2026 ต่างกัน — ดูชีต Score_Structure) ค่าที่ไม่มีมา (Backend เก่า) ใช้โครงเดิม 20/60/20
function weightsOf(src) {
  function pick(a, b, d) {
    if (src && typeof src[a] === 'number') return src[a];
    if (src && typeof src[b] === 'number') return src[b];
    return d;
  }
  var w = {
    work: pick('_workWeight', 'workWeight', 20), error: pick('_errorWeight', 'errorWeight', 60), att: pick('_attendanceWeight', 'attendanceWeight', 20),
    selfDev: pick('_selfDevWeight', 'selfDevWeight', 0), tenure: pick('_tenureWeight', 'tenureWeight', 0), errorScale: pick('_errorDeductScale', 'errorDeductScale', 1)
  };
  w.total = w.work + w.error + w.att + w.selfDev + w.tenure;
  return w;
}
function structureText(w) {
  var parts = [];
  if (w.work > 0) parts.push('Work ' + w.work);
  if (w.error > 0) parts.push('Error ' + w.error);
  if (w.att > 0) parts.push('ขาดลามาสาย ' + w.att);
  if (w.selfDev > 0) parts.push('พัฒนาตัวเอง ' + w.selfDev);
  if (w.tenure > 0) parts.push('อายุงาน ' + w.tenure);
  return parts.join(' + ') + ' = ' + w.total;
}
// กล่องบอกโครงสร้างคะแนนของเดือนที่กำลังดู (+ หมายเหตุพิเศษของเดือนนั้น เช่น ไม่นับ Work Score / หัก Error ครึ่งเดียว)
function structureNoteHtml(w, style) {
  var notes = [];
  if (w.work === 0) notes.push('เดือนนี้ไม่นับ Work Score');
  if (w.errorScale !== 1) {
    var lv = (APP.severityLevels || []).filter(function (s) { return typeof s.points === 'number'; });
    notes.push('คะแนนที่หักต่อเหตุการณ์ Error × ' + w.errorScale + (lv.length ? ' (ระดับ ' + lv.map(function (s) { return s.level; }).join('/') + ' หัก ' + lv.map(function (s) { return fmtNum(s.points * w.errorScale); }).join('/') + ')' : ''));
  }
  return '<div class="calloutBox" style="' + (style || 'margin-top:8px;') + '">📌 โครงสร้างคะแนนเดือนนี้: <b>' + esc(structureText(w)) + '</b>' + (notes.length ? ' · ' + esc(notes.join(' · ')) : '') + '</div>';
}
// ช่องคะแนนที่อาจเป็น PENDING (ข้อความยาวบอกสาเหตุ) — ในตารางสรุปโชว์แค่ "PENDING" สั้นๆ เอาเมาส์ชี้ดูสาเหตุเต็มได้ (ตัวเลขโชว์ปกติ)
function pendingShortHtml(v) {
  if (typeof v === 'string' && v.indexOf('PENDING') === 0) return '<span class="muted" title="' + esc(v) + '">PENDING</span>';
  return fmtNum(v);
}

// คะแนนรวมที่เป็น PENDING — โชว์ "PENDING" + สาเหตุเต็มเป็นบรรทัดเล็กๆ ใต้ (สาเหตุอาจมีหลายอย่างพร้อมกัน เช่น รอ Work Score / รอคะแนนพัฒนาตัวเอง / ยังไม่กรอกวันเริ่มงาน)
function pendingBlockHtml(v) {
  if (typeof v === 'string' && v.indexOf('PENDING') === 0) {
    var reason = v.replace(/^PENDING\s*-?\s*/, '');
    return '<span class="muted">PENDING</span>' + (reason ? '<div class="muted" style="font-size:11px;font-weight:400;white-space:normal;min-width:130px;max-width:230px;">' + esc(reason) + '</div>' : '');
  }
  return fmtNum(v);
}
// ช่องคะแนนของหมวดที่เดือนนี้ไม่มีในโครงสร้าง (เต็ม 0) โชว์ "–" แทนเลข 0 — เลข 0 จริงๆ (ได้ 0 คะแนน) ต้องเห็นต่างจาก "ไม่มีหมวดนี้"
function compCellHtml(v, weight) {
  if (weight === 0) return '<span class="muted" title="เดือนนี้ไม่มีหมวดนี้ในโครงสร้างคะแนน">–</span>';
  return pendingShortHtml(v);
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

function renderShell() {
  var titleEl = document.getElementById('headerTitle');
  var subtitleEl = document.getElementById('headerSubtitle');
  var toggleEl = document.getElementById('modeToggle');
  titleEl.textContent = 'FUTAI Performance';
  subtitleEl.textContent = 'โหมดผู้ดูแลระบบ';
  if (toggleEl) { toggleEl.style.display = 'none'; toggleEl.onclick = null; } // ไม่มีโหมดพนักงานให้สลับแล้ว
  APP.mode = 'admin';
  setupAdminTabs(); // ไม่มีรหัสผ่านเข้าโหมด Admin แล้ว — ล็อกรหัสเฉพาะหน้า "สรุปคะแนน/เงิน" (ดู renderSummaryPasswordGate)
}

/* (เดิมมี "โหมดพนักงาน" หน้าบันทึกงานประจำวัน/ประจำสัปดาห์ตรงนี้ — ถอดออกแล้วตามที่พี่สั่ง เหลือเฉพาะหน้าผู้ดูแลระบบ) */

/* ===================== หน้า "สรุปคะแนน/เงิน": กล่องกรอกรหัสผ่าน ===================== */
// ใช้รหัสผ่านตัวเดิม (Cfg_AdminPassword ในชีต Config) ตรวจผ่าน action adminAuth เดิม — ถ้ายังเป็น PENDING = ยังไม่ล็อก (ใส่อะไรก็เข้าได้)
// หมายเหตุ: เป็นการกันคนไม่รู้รหัสไม่ให้เปิดหน้านี้ในเว็บ ไม่ใช่ระบบ Login เต็มรูปแบบ (ตามสเปกเดิมที่ตั้งไว้)
function renderSummaryPasswordGate(onUnlocked, pageTitle) {
  var html = '<div class="card"><h3>🔒 ' + esc(pageTitle || 'สรุปคะแนน/เงิน') + '</h3>' +
    '<div class="cardSubtitle">หน้านี้มีรหัสผ่าน — ใส่รหัสผ่านเพื่อเข้าใช้งาน (ใส่ครั้งเดียวผ่านทุกหน้าที่ล็อกในแท็บนี้)</div>' +
    '<label>รหัสผ่าน</label><input type="password" id="summaryPw" autocomplete="off">' +
    '<button class="btn" id="summaryPwGo">เข้าดูหน้านี้</button>' +
    '</div>';
  document.getElementById('content').innerHTML = html;
  var goBtn = document.getElementById('summaryPwGo');
  function submitPw() {
    var pw = document.getElementById('summaryPw').value;
    withButtonGuard(goBtn, function () { return apiPost('adminAuth', { password: pw }); })
      .then(function () {
        markSummaryUnlockedThisTab();
        if (document.getElementById('summaryPwGo')) onUnlocked(); // ถ้าสลับแท็บไปแล้วระหว่างรอ ไม่ต้องเด้งกลับมาหน้านี้
      })
      .catch(function (e) { toast(e.message || String(e), true); });
  }
  goBtn.addEventListener('click', submitPw);
  document.getElementById('summaryPw').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') submitPw(); });
  document.getElementById('summaryPw').focus();
}

/* ===================== ADMIN MODE ===================== */
// PHASE 2: ใส่แท็บ "ประเมิน Work Score" กลับเข้าเมนูแล้ว (ตอน PHASE 1 ถอดออกไปก่อนเพราะ Work Score ยังไม่คำนวณ)
// UI/UX Redesign: เพิ่มแท็บ "Dashboard" ใหม่ (renderAdminDashboard — ใช้ข้อมูลจาก action companyMonthlyScores เดิม
// ไม่มี Backend/Action ใหม่) + ใส่ icon ให้ทุกแท็บ เพื่อให้ Sidebar/Bottom-nav ดูเป็น Application จริง
// ย้ายแท็บ "ประเมิน Work Score" มาอยู่เหนือแท็บ "Error" ตามที่พี่ขอ (เดิมอยู่ล่างสุดก่อน "สรุปคะแนน/เงิน")
// เป็นการจัดลำดับเมนูอย่างเดียว ไม่กระทบ Logic/การคำนวณใดๆ
var ADMIN_TABS = [
  { key: 'dashboard', label: 'Dashboard', icon: '📊', render: renderAdminDashboard },
  { key: 'workscore', label: 'ประเมิน Work Score', icon: '🎯', render: renderAdminWorkScore },
  { key: 'selfdev', label: 'คะแนนพัฒนาตัวเอง', icon: '🌱', render: renderAdminSelfDev },
  { key: 'error', label: 'Error', icon: '⚠️', render: renderAdminError },
  { key: 'gooddeed', label: 'Good Deed', icon: '🌟', render: renderAdminGoodDeed },
  { key: 'attendance', label: 'Attendance', icon: '🗓️', render: renderAdminAttendance },
  { key: 'calendar', label: 'ปฏิทินบริษัท', icon: '📅', render: renderAdminCalendar },
  { key: 'summary', label: 'สรุปคะแนน/เงิน', icon: '💰', render: renderAdminSummary },
  { key: 'annual', label: 'สรุปรายปี', icon: '📈', render: renderAdminAnnualSummary },
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
  if (!isSummaryUnlockedThisTab()) { renderSummaryPasswordGate(renderAdminDashboard, 'Dashboard'); return; } // ล็อกด้วยรหัสเดียวกับหน้าอื่นที่มีรหัส
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
      // ตัวหารของแต่ละหมวดดึงมาจาก Backend สดๆ ทุกครั้ง (_workWeight/_errorWeight/... ดู weightsOf) เพราะโครงสร้างคะแนนแต่ละเดือน
      // ไม่เหมือนกัน (ชีต Score_Structure) — ไม่ Hardcode 20/60/20/100 อีกต่อไป หมวดที่เดือนนี้ไม่มี (เต็ม 0) ไม่โชว์การ์ด
      var wt = weightsOf(r);
      var totalW = wt.total;
      area.innerHTML =
        structureNoteHtml(wt, 'margin-bottom:12px;') +
        '<div class="statGrid">' +
        statCardHtml('accentCoral', '🏆', 'คะแนนรวม (Performance)', r['คะแนนรวม'], totalW) +
        (wt.work > 0 ? statCardHtml('accentBlue', '🎯', 'Work Score', r['คะแนนงาน'], wt.work) : '') +
        (wt.error > 0 ? statCardHtml('accentAmber', '⚠️', 'Error Score', r['คะแนนความผิด'], wt.error) : '') +
        (wt.att > 0 ? statCardHtml('accentGreen', '🗓️', 'Attendance', r['คะแนนขาดลามาสาย'], wt.att) : '') +
        (wt.selfDev > 0 ? statCardHtml('accentGreen', '🌱', 'พัฒนาตัวเอง', r['คะแนนพัฒนาตัวเอง'], wt.selfDev) : '') +
        (wt.tenure > 0 ? statCardHtml('accentAmber', '🏅', 'อายุงาน', r['คะแนนอายุงาน'], wt.tenure, r['_tenureNote']) : '') +
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

    '<div class="card"><h3>📋 ข้อมูลเหตุการณ์</h3>' +
    '<div id="eEditBanner" class="calloutBox amber" style="display:none;margin-bottom:12px;">✏️ กำลังแก้ไขเหตุการณ์ <b id="eEditBannerId"></b> — บันทึกจะอัปเดตรายการเดิม ไม่สร้างรายการใหม่ <button class="btn secondary small" id="eCancelEdit" style="margin-left:8px;">ยกเลิกการแก้ไข</button></div>' +
    '<div class="row"><div><label>วันที่เกิดเหตุ</label><input type="date" id="eDate" value="' + todayStr() + '"></div>' +
    '<div><label>แผนก (อัตโนมัติจากผู้รับผิดชอบที่เลือกด้านล่าง)</label><input type="text" id="eDept" readonly placeholder="— เลือกผู้รับผิดชอบก่อน —"></div></div>' +
    '<div id="eScaleNote"></div>' +
    '<label>ประเภทความผิด</label><select id="eType">' + typeOptions + '</select>' +
    '<label>รายละเอียดเหตุการณ์</label><textarea id="eDesc"></textarea>' +
    '<label>ค่าเสียหายจริง (บาท ถ้ามี — ไม่มีผลต่อคะแนน)</label><input type="number" id="eDamage"></div>' +

    '<div class="card"><h3>👥 ผู้รับผิดชอบ &amp; ผู้แจ้ง</h3><div class="cardSubtitle">ทุกคนได้คะแนนเต็มตามระดับ ไม่หารเฉลี่ย — เลือกได้แม้ผู้รับผิดชอบมาจากคนละแผนกกัน (ระบบแยกแผนกให้อัตโนมัติ ดูด้านล่าง)</div>' +
    '<label>ผู้รับผิดชอบ</label>' +
    '<div id="eRespRows"></div>' +
    '<button class="btn secondary small" id="eAddResp">+ เพิ่มผู้รับผิดชอบ</button>' +
    '<label style="margin-top:18px;">ผู้แจ้งปัญหา (ถ้ามี — เว้นว่างได้ถ้าไม่มีคนแจ้งเป็นพิเศษ เช่นหัวหน้าเจอเอง)</label>' +
    '<select id="eReporter"><option value="">— ไม่มี / ไม่ระบุ —</option>' + employeeOptionsWithDept(APP.employees) + '</select>' +
    '<div class="muted" id="eReporterHint" style="display:none;"></div></div>' +

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

  // สถานะโหมดแก้ไข — null = กำลังบันทึกเหตุการณ์ใหม่ (ปกติ), มีค่า = กำลังแก้ไขเหตุการณ์เดิมตามรหัสนี้ (กดปุ่ม "แก้ไข"
  // จากรายการ "เหตุการณ์เดือนนี้" ด้านล่าง) พี่ขอให้แก้วันที่/ผู้รับผิดชอบ/ฯลฯ ของเหตุการณ์ที่กรอกผิดไปแล้วได้
  var editingEventId = null;
  function setEditMode(eventId) {
    editingEventId = eventId;
    document.getElementById('eEditBanner').style.display = eventId ? '' : 'none';
    document.getElementById('eEditBannerId').textContent = eventId || '';
    document.getElementById('eSave').textContent = eventId ? '✓ บันทึกการแก้ไข' : '✓ บันทึกเหตุการณ์';
  }
  document.getElementById('eCancelEdit').addEventListener('click', function () { resetFormToAddMode(); });

  // V3: คะแนนที่หักต่อเหตุการณ์ Error ถูกคูณด้วย "ตัวคูณ" ของเดือนที่เหตุการณ์เกิด (ชีต Score_Structure — ต.ค. 2026 เป็นต้นไป 0.5 = หักครึ่งเดียว)
  // ตัวเลขในการ์ด "ระดับความรุนแรง" เป็นค่าเต็มตาม Config จึงต้องบอกให้ชัดว่าเดือนนี้หักจริงเท่าไหร่ — ดึง scoreWeights ของเดือนที่เลือก (แคชไว้ต่อเดือน)
  var scaleCache = {};
  function getScaleWeights(month, year) {
    var key = year + '-' + month;
    if (scaleCache[key]) return Promise.resolve(scaleCache[key]);
    return apiGet('scoreWeights', { month: month, year: year }).then(function (w) { scaleCache[key] = w; return w; });
  }
  function refreshScaleNote() {
    var dateEl = document.getElementById('eDate'), noteEl = document.getElementById('eScaleNote');
    if (!dateEl || !noteEl) return;
    var v = dateEl.value;
    var m = /^(\d{4})-(\d{2})-/.exec(v || '');
    if (!m) { noteEl.innerHTML = ''; return; }
    var month = Number(m[2]), year = Number(m[1]);
    getScaleWeights(month, year).then(function (w) {
      var el2 = document.getElementById('eScaleNote'), d2 = document.getElementById('eDate');
      if (!el2 || !d2 || d2.value !== v) return; // สลับหน้า/เปลี่ยนวันที่ไปแล้วระหว่างรอโหลด
      var wt = weightsOf(w);
      if (wt.errorScale === 1) { el2.innerHTML = ''; return; }
      var lv = (APP.severityLevels || []).filter(function (s) { return typeof s.points === 'number'; });
      el2.innerHTML = '<div class="calloutBox amber" style="margin:8px 0;">📌 เหตุการณ์ที่เกิดเดือน ' + month + '/' + year + ': ระบบหักคะแนน Error เพียง <b>× ' + wt.errorScale + '</b> ของตัวเลขในการ์ด "ระดับความรุนแรง"' +
        (lv.length ? ' (หักจริงระดับ ' + lv.map(function (s) { return s.level; }).join('/') + ' = ' + lv.map(function (s) { return fmtNum(s.points * wt.errorScale); }).join('/') + ')' : '') + ' — ตามโครงสร้างคะแนนของเดือนนั้น</div>';
    }).catch(function (err) {
      var el3 = document.getElementById('eScaleNote'), d3 = document.getElementById('eDate');
      if (el3 && d3 && d3.value === v) el3.innerHTML = '<div class="calloutBox amber" style="margin:8px 0;">⚠️ ตรวจตัวคูณคะแนนหัก Error ของเดือน ' + month + '/' + year + ' ไม่ได้ (' + esc((err && err.message) || String(err)) + ') — ตัวเลขในการ์ด "ระดับความรุนแรง" อาจไม่ใช่ที่ระบบหักจริง ตรวจชีต Score_Structure</div>';
    });
  }
  document.getElementById('eDate').addEventListener('change', refreshScaleNote);
  refreshScaleNote();

  function resetFormToAddMode() {
    setEditMode(null);
    document.getElementById('eDate').value = todayStr();
    refreshScaleNote();
    document.getElementById('eType').selectedIndex = 0;
    document.getElementById('eDesc').value = '';
    document.getElementById('eDamage').value = '';
    document.getElementById('eReason').value = '';
    document.getElementById('eReporter').value = '';
    document.getElementById('eRespRows').innerHTML = '';
    addRespRow();
    document.getElementById('eImpact').selectedIndex = 0;
    if (document.getElementById('eImpact')._cardSync) document.getElementById('eImpact')._cardSync();
    syncSeverityToImpact();
    syncReporterHint();
    syncDeptFromResponsible();
  }

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

  // เปิดฟอร์มนี้ในโหมดแก้ไขเหตุการณ์เดิม (กดปุ่ม "✏️ แก้ไข" จากรายการ "เหตุการณ์เดือนนี้" ด้านล่าง) — ดึงรายละเอียด
  // เต็มจาก Backend มาพรีฟิลทุกช่อง ตั้งค่า "ผลกระทบ"/"ระดับความรุนแรง" ตรงๆ ผ่าน ._cardSync() เท่านั้น (ไม่ dispatch
  // 'change') กัน syncSeverityToImpact() รีเซ็ตระดับทับค่าที่เคย override ไว้ตอนบันทึกครั้งแรก
  function startEdit(eventId) {
    apiGet('errorEventDetail', { eventId: eventId }).then(function (d) {
      document.getElementById('eDate').value = d.date;
      refreshScaleNote();
      document.getElementById('eType').value = d.errorTypeId;
      document.getElementById('eDesc').value = d.description || '';
      document.getElementById('eDamage').value = d.damageAmount;
      document.getElementById('eReason').value = d.overrideReason || '';

      document.getElementById('eRespRows').innerHTML = '';
      var ids = (d.responsibleIds && d.responsibleIds.length) ? d.responsibleIds : [''];
      ids.forEach(function (id) {
        addRespRow();
        var sels = document.querySelectorAll('.eRespSel');
        sels[sels.length - 1].value = id;
      });

      document.getElementById('eReporter').value = d.reporterId || '';

      var impactSel = document.getElementById('eImpact');
      impactSel.value = d.impact;
      if (impactSel._cardSync) impactSel._cardSync();
      var impactInfo = APP.impactOptions.filter(function (i) { return i.key === impactSel.value; })[0];
      document.getElementById('eImpactDesc').textContent = impactInfo ? impactInfo.desc : '';

      var severitySel = document.getElementById('eSeverity');
      severitySel.value = String(d.level);
      if (severitySel._cardSync) severitySel._cardSync();
      var sevInfo = APP.severityLevels.filter(function (s) { return s.level === d.level; })[0];
      document.getElementById('eSeverityDesc').textContent = sevInfo ? sevInfo.desc : '';

      syncReporterHint();
      syncDeptFromResponsible();
      setEditMode(eventId);
      document.getElementById('eEditBanner').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }).catch(function (e) { toast(e.message || String(e), true); });
  }

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
    var isEdit = !!editingEventId;
    if (isEdit) payload.eventId = editingEventId;
    withButtonGuard(evt.target, function () { return apiPost(isEdit ? 'updateErrorEvent' : 'submitErrorEvent', payload); })
      .then(function (r) {
        var msg = (isEdit ? 'แก้ไขแล้ว ' : 'บันทึกแล้ว ') + r.eventId + ' (' + r.pointsPerPerson + ' คะแนน/คน)';
        if (r.reward) msg += ' + ให้รางวัลผู้แจ้ง ' + fmtNum(r.reward.points) + ' คะแนน (' + (r.reward.isSelfReport ? 'สารภาพเอง' : 'แจ้งจากคนอื่น') + ')';
        toast(msg);
        if (isEdit) { resetFormToAddMode(); loadEvents(); } else { renderAdminError(); }
      })
      .catch(function (e) { toast(e.message || String(e), true); });
  });

  function statusBadge(s) { var cls = s === 'Approved' ? 'approved' : (s === 'Rejected' ? 'rejected' : 'pending'); return '<span class="badge ' + cls + '">' + s + '</span>'; }

  document.getElementById('el_go').addEventListener('click', loadEvents);
  loadEvents();
  function renderMonthStats(rows, scale) {
    var stats = document.getElementById('eMonthStats');
    scale = (typeof scale === 'number') ? scale : 1;
    var totalDeduct = rows.reduce(function (s, r) { return s + (Number(r['คะแนนต่อคน']) || 0); }, 0) * scale;
    var respSet = {};
    rows.forEach(function (r) { String(r['ผู้รับผิดชอบ'] || '').split(',').forEach(function (n) { n = n.trim(); if (n) respSet[n] = true; }); });
    stats.innerHTML =
      '<div class="statCard accentAmber"><span class="statIcon">🗂️</span><div class="statLabel">Error เดือนนี้</div><div class="statValue">' + rows.length + '</div></div>' +
      '<div class="statCard accentAmber"><span class="statIcon">📉</span><div class="statLabel">คะแนนที่ถูกหักรวม' + (scale !== 1 ? ' (× ' + scale + ')' : '') + '</div><div class="statValue">' + fmtNum(totalDeduct) + '</div></div>' +
      '<div class="statCard accentAmber"><span class="statIcon">👥</span><div class="statLabel">จำนวนผู้รับผิดชอบ</div><div class="statValue">' + Object.keys(respSet).length + '</div></div>';
  }
  function loadEvents() {
    var lm = Number(document.getElementById('el_m').value), ly = Number(document.getElementById('el_y').value);
    // ดึงรายการเหตุการณ์ + ตัวคูณคะแนนหักของเดือนนั้นพร้อมกัน (ขนาน ไม่รอกัน) — ถ้าดึงตัวคูณไม่ได้ ยังโชว์รายการได้ (ค่าเต็มตามที่บันทึก)
    // แต่ต้องมีแถบเตือนชัดๆ ว่าตัวเลขอาจไม่ใช่ที่ระบบหักจริง (ห้ามเงียบแล้วโชว์เหมือนหักเต็ม)
    Promise.all([
      apiGet('errorEventsForMonth', { month: lm, year: ly }),
      getScaleWeights(lm, ly).then(function (w) { return { scale: weightsOf(w).errorScale }; }, function (err) { return { scale: 1, error: (err && err.message) || String(err) }; })
    ]).then(function (res) {
      var rows = res[0], scale = res[1].scale;
      var scaleWarnHtml = res[1].error
        ? '<div class="calloutBox amber" style="margin-bottom:8px;">⚠️ ตรวจตัวคูณคะแนนหัก Error ของเดือนนี้ไม่ได้ (' + esc(res[1].error) + ') — ตัวเลขด้านล่างเป็นค่าเต็มตามที่บันทึก อาจไม่ใช่ที่ระบบหักจริง ตรวจชีต Score_Structure</div>' : '';
      renderMonthStats(rows, scale);
      var el = document.getElementById('elList');
      if (!rows.length) { el.innerHTML = scaleWarnHtml + '<div class="muted">ไม่มีข้อมูลเดือนนี้</div>'; return; }
      el.innerHTML = scaleWarnHtml + rows.map(function (r) {
        var reporterHtml = r['รหัสรางวัล']
          ? '<div class="meta">ผู้แจ้ง: ' + esc(r['ชื่อผู้แจ้ง']) + ' (' + esc(r['ประเภทการแจ้ง']) + ', +' + fmtNum(r['คะแนนรางวัลผู้แจ้ง']) + ' คะแนน) ' + statusBadge(r['สถานะรางวัล']) +
            ' <select class="rwStChg" data-id="' + r['รหัสรางวัล'] + '"><option ' + (r['สถานะรางวัล'] === 'Pending' ? 'selected' : '') + '>Pending</option><option ' + (r['สถานะรางวัล'] === 'Approved' ? 'selected' : '') + '>Approved</option><option ' + (r['สถานะรางวัล'] === 'Rejected' ? 'selected' : '') + '>Rejected</option></select></div>'
          : '';
        // ปุ่ม "✏️ แก้ไข"/"🗑️ ลบ" ตามที่พี่ขอ — ให้แก้/ลบเหตุการณ์ย้อนหลังได้ (วันที่ผิด/ผู้รับผิดชอบผิด ฯลฯ) จากตรงนี้เลย
        var actionsHtml = '<div class="rowActions" style="margin-top:6px;">' +
          '<button class="btn secondary small elEdit" data-id="' + esc(r['รหัสเหตุการณ์']) + '">✏️ แก้ไข</button> ' +
          '<button class="btn secondary small elDelete" data-id="' + esc(r['รหัสเหตุการณ์']) + '" style="color:#c0392b;border-color:#c0392b;">🗑️ ลบ</button></div>';
        return '<div class="list-item"><b>' + esc(r['รหัสเหตุการณ์']) + '</b> — ' + esc(r['ชื่อประเภทความผิด']) + ' — ' + esc(r['ผลกระทบ']) + ' (ระดับ ' + r['ระดับ'] + ', ' + r['คะแนนต่อคน'] + (scale !== 1 ? ' → หักจริง ' + fmtNum((Number(r['คะแนนต่อคน']) || 0) * scale) : '') + ')<div class="meta">' + fmtDate(r['วันที่']) + ' · ' + esc(r['แผนก']) + ' · ผู้รับผิดชอบ: ' + esc(r['ผู้รับผิดชอบ']) + '</div>' + reporterHtml + actionsHtml + '</div>';
      }).join('');
      Array.prototype.forEach.call(el.querySelectorAll('.rwStChg'), function (sel) {
        sel.addEventListener('change', function () {
          sel.disabled = true;
          apiPost('updateReportRewardStatus', { id: sel.getAttribute('data-id'), status: sel.value })
            .then(function () { sel.disabled = false; toast('อัปเดตแล้ว'); })
            .catch(function (e) { sel.disabled = false; toast(e.message || String(e), true); });
        });
      });
      Array.prototype.forEach.call(el.querySelectorAll('.elEdit'), function (btn) {
        btn.addEventListener('click', function () { startEdit(btn.getAttribute('data-id')); });
      });
      Array.prototype.forEach.call(el.querySelectorAll('.elDelete'), function (btn) {
        btn.addEventListener('click', function () {
          var eventId = btn.getAttribute('data-id');
          if (!confirm('ยืนยันลบเหตุการณ์ ' + eventId + ' ทั้งรายการ? (ลบผู้รับผิดชอบ/ผู้แจ้งที่ผูกกันไว้ด้วย กู้คืนไม่ได้)')) return;
          btn.disabled = true;
          apiPost('deleteErrorEvent', { eventId: eventId })
            .then(function () {
              toast('ลบแล้ว ' + eventId);
              if (editingEventId === eventId) resetFormToAddMode();
              loadEvents();
            })
            .catch(function (e) { btn.disabled = false; toast(e.message || String(e), true); });
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

/* ---- 7. Attendance (ตารางกรอกสรุปรายเดือนของทุกคน) ---- */
// เดิมเป็นฟอร์มกรอกทีละวันทีละรายการ — เปลี่ยนเป็นตารางเดียวแบบไฟล์ Excel "สรุปการขาด ลา มาสาย" กรอกสรุปท้ายเดือนของทุกคนในหน้าเดียว
// (ลาป่วย-มีใบ/ไม่มีใบ/ลากิจ/ลาพักร้อน รวมวันลา มาสาย(ครั้ง) มาสายรวม(นาที) OT หมายเหตุ + ลาไม่อนุมัติ/ขาด ต่อท้ายตาราง)
// บันทึกลงชีต Attendance_Monthly ผ่าน action saveAttendanceMonthly (ส่งเฉพาะแถวที่แก้) — ลา 4 ประเภทนับเป็น "ลาอนุมัติ" ในคะแนน 20 คะแนน
// เดิม ส่วน "ลาไม่อนุมัติ"/"ขาด" มีช่องแยก ใช้อัตราหักตาม Config เหมือนเดิมทุกประการ และเดือนไหนคนไหนมีแถวรายเดือน ระบบใช้ตัวเลขนี้แทน
// รายการรายวันเดิมของคนนั้นเดือนนั้น (ไม่นับซ้ำ) — เดือนที่ไม่ได้กรอกตารางจะใช้รายการรายวันเดิมตามปกติ
function renderAdminAttendance() {
  var COLS = [
    { key: 'sickCert', label: 'ลาป่วย<br>มีใบ', unit: '(วัน)', kind: 'num' },
    { key: 'sickNoCert', label: 'ลาป่วย<br>ไม่มีใบ', unit: '(วัน)', kind: 'num' },
    { key: 'personal', label: 'ลากิจ', unit: '(วัน)', kind: 'num' },
    { key: 'vacation', label: 'ลาพักร้อน', unit: '(วัน)', kind: 'num' },
    { key: '_leaveTotal', label: 'รวมวันลา', unit: '(วัน)', kind: 'calc' },
    { key: 'lateCount', label: 'มาสาย', unit: '(ครั้ง)', kind: 'num' },
    { key: 'lateMinutes', label: 'มาสายรวม', unit: '(นาที)', kind: 'num' },
    { key: 'ot', label: 'OT', unit: '(ชม.)', kind: 'num' },
    { key: 'note', label: 'หมายเหตุ', unit: '', kind: 'text' },
    { key: 'unapproved', label: 'ลาไม่<br>อนุมัติ', unit: '(วัน)', kind: 'num', divider: true },
    { key: 'absent', label: 'ขาด', unit: '(วัน)', kind: 'num' }
  ];
  var LEAVE_KEYS = ['sickCert', 'sickNoCert', 'personal', 'vacation'];
  var DAY_KEYS = LEAVE_KEYS.concat(['unapproved', 'absent']);
  var NUM_RE = /^(\d+(\.\d*)?|\.\d+)$/; // ตัวเลขธรรมดา ไม่รับจุลภาค/เครื่องหมายลบ (ช่องว่าง = ไม่กรอก)

  var MONTHS_TH = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  var state = { month: APP.month, year: APP.year, showInactive: false, rows: [], dirty: {}, seq: 0, saving: false };
  var trByEmp = {};
  var rowMeta = {};   // ข้อมูลตั้งต้นของแต่ละแถวที่โหลดมา (hasRow/dailyCount) ใช้ทำคำเตือนสด
  var gridEl = null;  // กรอบตารางของการ render "รอบนี้" — ผลโหลดเก่าจากรอบ render ก่อนหน้า (สลับแท็บไปมา) เจอกรอบคนละตัวก็ทิ้งทันที
  function isAlive() { return !!gridEl && document.getElementById('atGrid') === gridEl; }

  var html =
    '<div class="card"><h3>🗓️ Attendance</h3><div class="cardSubtitle">กรอกสรุปขาด/ลา/มาสายของ "ทุกคน" ทั้งเดือนในตารางเดียว (เหมือนไฟล์ Excel สรุปท้ายเดือน) — ช่องที่เว้นว่างถือว่าไม่มี ไม่ต้องพิมพ์ 0</div>' +
    monthPickerHtml('at', state.month, state.year) +
    '<label style="display:flex;align-items:center;gap:6px;font-weight:400;margin-top:10px;"><input type="checkbox" id="atShowInactive" style="width:auto;"> แสดงพนักงานที่ลาออกแล้วด้วย (สำหรับลงย้อนหลัง)</label>' +
    '<div class="calloutBox" style="margin-top:12px;">' +
    '<b>วิธีคิดคะแนน:</b> ลา 4 ประเภท (ป่วย-มีใบ/ป่วย-ไม่มีใบ/ลากิจ/ลาพักร้อน) รวมกันนับเป็น "ลาอนุมัติ" · ช่อง "ลาไม่อนุมัติ" และ "ขาด" นับแยก — หักคะแนนตามอัตราใน Config เหมือนเดิม · หน่วยเป็น <b>วัน</b> ครึ่งวันพิมพ์ 0.5<br>' +
    '<b>เบี้ยขยัน:</b> ดูจาก "มาสายรวม (นาที)" และช่องลา 4 ประเภทที่มีวัน > 0 (ลาไม่อนุมัติ/ขาด/OT ไม่กระทบเบี้ยขยัน) · <b>OT</b> เก็บไว้ดูเฉยๆ ไม่มีผลต่อคะแนนหรือเงิน<br>' +
    '<b>สำคัญ:</b> คนไหนมีข้อมูลในตารางเดือนนี้ ระบบใช้ตัวเลขในตารางนี้ <b>แทน</b> รายการรายวันเดิมของคนนั้นทั้งหมด (ไม่นับรวมกัน) · พิมพ์ 0 = กรอกแล้วว่าไม่มี · ลบทุกช่องของแถว (รวมหมายเหตุ) แล้วบันทึก = ล้างข้อมูลรายเดือนของคนนั้น กลับไปใช้รายการรายวันเดิม (ถ้ามี) · ถ้ากรอกนาทีสายแต่ลืมใส่จำนวนครั้ง ระบบนับเป็นสาย 1 ครั้งให้</div></div>' +
    '<div class="card"><div id="atError" class="calloutBox amber" style="display:none;margin-bottom:12px;"></div><div id="atGrid" class="muted">กำลังโหลด...</div></div>';
  document.getElementById('content').innerHTML = html;

  gridEl = document.getElementById('atGrid');
  var chk = document.getElementById('atShowInactive');
  document.getElementById('at_go').addEventListener('click', function () { requestLoad(); });
  chk.addEventListener('change', function () { requestLoad(); });
  loadTable();

  /* ---------- ข้อความ error บนหน้า (toast หายเร็วเกินไปสำหรับข้อความยาว) ---------- */
  function showError(msg) {
    var box = isAlive() ? document.getElementById('atError') : null;
    if (!box) return;
    if (!msg) { box.style.display = 'none'; box.textContent = ''; return; }
    box.textContent = msg; box.style.display = '';
  }

  /* ---------- โหลด/เปลี่ยนเดือน ---------- */
  function dirtyCount() { return Object.keys(state.dirty).length; }

  // เปลี่ยนเดือน/ปี หรือสลับ "แสดงที่ลาออกแล้ว" = โหลดตารางใหม่ ซึ่งทิ้งสิ่งที่แก้ค้างอยู่ — ถามก่อนเสมอ ถ้ายกเลิกให้คืนค่า dropdown/ติ๊กเดิม
  function requestLoad() {
    if (state.saving || !isAlive()) return;
    var mSel = document.getElementById('at_m'), ySel = document.getElementById('at_y');
    if (dirtyCount() && !confirm('มีข้อมูลที่แก้ไขแล้วแต่ยังไม่ได้บันทึก ' + dirtyCount() + ' แถว — ถ้าโหลดใหม่ตอนนี้ ข้อมูลที่แก้จะหายไป ต้องการโหลดต่อไหม?')) {
      mSel.value = state.month; ySel.value = state.year; chk.checked = state.showInactive;
      return;
    }
    state.month = Number(mSel.value); state.year = Number(ySel.value); state.showInactive = chk.checked;
    return loadTable();
  }

  function loadTable() {
    if (!isAlive()) return Promise.resolve();
    var seq = ++state.seq;
    showError('');
    gridEl.className = 'muted';
    gridEl.innerHTML = '<div class="muted">กำลังโหลด...</div>';
    return apiGet('attendanceMonthlyForMonth', { month: state.month, year: state.year, includeInactive: state.showInactive ? 'true' : '' }).then(function (data) {
      if (seq !== state.seq || !isAlive()) return; // โหลดซ้อน หรือสลับหน้า/แท็บไปแล้ว (ตารางรอบใหม่คนละกรอบกัน) — ทิ้งผลเก่า ไม่ไปเขียนทับของใหม่
      state.rows = data.rows || [];
      state.dirty = {};
      renderTable();
    }).catch(function (e) {
      if (seq !== state.seq || !isAlive()) return;
      gridEl.innerHTML = '<div class="muted">โหลดไม่สำเร็จ: ' + esc(e.message || String(e)) + ' <button class="btn secondary" id="atRetry" style="margin-left:8px;">ลองใหม่</button></div>';
      var retry = document.getElementById('atRetry');
      if (retry) retry.addEventListener('click', function () { loadTable(); });
      toast(e.message || String(e), true);
    });
  }

  /* ---------- วาดตาราง ---------- */
  function cellHtml(r, c) {
    if (c.kind === 'calc') return '<td class="atCalc atLeaveTotal" style="text-align:center;font-weight:600;"></td>';
    var v = r[c.key];
    v = (v === '' || v === null || v === undefined) ? '' : v;
    var attrs = c.kind === 'text' ? 'type="text" maxlength="500" class="atIn atNote"' : 'type="text" inputmode="decimal" autocomplete="off" class="atIn"';
    var sizing = c.kind === 'text' ? 'width:170px;' : 'width:64px;text-align:center;';
    return '<td' + (c.divider ? ' class="colDivider"' : '') + '><input ' + attrs + ' style="' + sizing + 'padding:6px 4px;box-sizing:border-box;" data-emp="' + esc(r.employeeId) + '" data-key="' + c.key + '" value="' + esc(v) + '"></td>';
  }

  function nameCellHtml(r) {
    var inactive = r.status && r.status !== 'Active';
    var hint = '';
    if (r.dailyCount > 0) {
      hint = r.hasRow
        ? '<div style="font-size:11px;color:#b45309;">มีรายวันเดิม ' + r.dailyCount + ' รายการ (ไม่นับ — ใช้ตารางนี้แทน)</div>'
        : '<div style="font-size:11px;color:#b45309;">มีรายวันเดิม ' + r.dailyCount + ' รายการ (ยังใช้ค่ารายวันอยู่ จนกว่าจะกรอกตาราง)</div>';
    }
    return '<td class="atName" style="min-width:120px;">' +
      '<div><b>' + esc(r.nickname || r.employeeId) + '</b>' + (inactive ? ' <span class="inactiveBadge">ลาออกแล้ว</span>' : '') + ' <span class="atDirty" style="display:none;color:#d97706;font-size:11px;">● แก้ไข</span></div>' +
      '<div class="muted" style="font-size:11px;">' + esc(r.department || '') + '</div>' + hint +
      '<div class="atWarn" style="font-size:11px;color:#b45309;"></div></td>';
  }

  function renderTable() {
    var area = gridEl;
    if (!isAlive()) return;
    if (!state.rows.length) { area.innerHTML = '<div class="muted">ไม่มีพนักงานให้กรอกในเดือนนี้</div>'; return; }

    var head = '<tr><th class="atName" style="text-align:left;">ชื่อ</th>' + COLS.map(function (c) {
      return '<th' + (c.divider ? ' class="colDivider"' : '') + ' style="text-align:center;white-space:nowrap;line-height:1.25;">' + c.label + (c.unit ? '<div class="muted" style="font-weight:400;font-size:11px;">' + c.unit + '</div>' : '') + '</th>';
    }).join('') + '</tr>';

    var body = state.rows.map(function (r) {
      return '<tr class="atRow' + ((r.status && r.status !== 'Active') ? ' inactiveRow' : '') + '" data-emp="' + esc(r.employeeId) + '">' + nameCellHtml(r) + COLS.map(function (c) { return cellHtml(r, c); }).join('') + '</tr>';
    }).join('');

    var foot = '<tr class="atTotals"><td class="atName" style="font-weight:700;">รวมทั้งหมด</td>' + COLS.map(function (c) {
      return '<td' + (c.divider ? ' class="colDivider"' : '') + ' style="text-align:center;font-weight:700;" data-total="' + c.key + '"></td>';
    }).join('') + '</tr>';

    var saveBar = function (id) {
      return '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:' + (id === 'atSave' ? '0 0 12px' : '14px 0 0') + ';"><button class="btn" id="' + id + '">✓ บันทึกทั้งตาราง</button><span class="muted atSaveHint" style="font-size:13px;"></span></div>';
    };

    rowMeta = {};
    state.rows.forEach(function (r) { rowMeta[r.employeeId] = r; });
    area.className = '';
    area.innerHTML = '<div id="atLoadedLabel" style="font-weight:600;margin-bottom:10px;">📅 กำลังกรอกข้อมูลเดือน ' + MONTHS_TH[state.month] + ' ' + state.year + (state.showInactive ? ' <span class="muted" style="font-weight:400;">(รวมพนักงานที่ลาออกแล้ว)</span>' : '') + '</div>' + saveBar('atSave') +
      '<div style="overflow-x:auto;"><table class="simple" id="atTable">' + head + body + foot + '</table></div>' +
      saveBar('atSave2');

    // ให้คอลัมน์ชื่อตรึงซ้ายเวลาเลื่อนดูคอลัมน์อื่น (มือถือ) — ใช้สีพื้นเดียวกับการ์ดที่ครอบอยู่ ไม่เดาสีเอง ปรับตามธีมอัตโนมัติ
    var bg = '#fff';
    try {
      var cardEl = area.closest('.card');
      var cs = cardEl ? window.getComputedStyle(cardEl).backgroundColor : '';
      if (cs && cs !== 'transparent' && cs !== 'rgba(0, 0, 0, 0)') bg = cs;
    } catch (e) { /* ใช้สีขาวไปก่อน */ }
    Array.prototype.forEach.call(area.querySelectorAll('.atName'), function (el) {
      el.style.position = 'sticky'; el.style.left = '0'; el.style.zIndex = '1'; el.style.background = bg; el.style.boxShadow = '1px 0 0 rgba(0,0,0,.08)';
    });

    trByEmp = {};
    Array.prototype.forEach.call(area.querySelectorAll('tr.atRow'), function (tr) { trByEmp[tr.getAttribute('data-emp')] = tr; });
    Object.keys(trByEmp).forEach(function (id) { refreshRow(id); });
    refreshTotals();
    updateSaveHint();

    var table = document.getElementById('atTable');
    table.addEventListener('input', onInput);
    table.addEventListener('keydown', onKeyDown);
    table.addEventListener('focusin', function (ev) { if (ev.target && ev.target.classList && ev.target.classList.contains('atIn') && ev.target.type === 'text') { try { ev.target.select(); } catch (e) { /* ไม่เป็นไร */ } } });
    document.getElementById('atSave').addEventListener('click', onSave);
    document.getElementById('atSave2').addEventListener('click', onSave);
  }

  /* ---------- อ่านค่า/คำนวณสดในตาราง ---------- */
  function parseCell(str) {
    var s = String(str === undefined || str === null ? '' : str).trim();
    if (s === '') return { ok: true, blank: true, n: 0 };
    if (!NUM_RE.test(s)) return { ok: false, blank: false, n: 0 };
    return { ok: true, blank: false, n: Number(s) };
  }

  function inputsOf(tr) { return tr.querySelectorAll('input.atIn'); }
  function inputOf(tr, key) { return tr.querySelector('input[data-key="' + key + '"]'); }

  // อัปเดตผลรวมวันลาของแถว + ไฮไลต์ช่องที่ไม่ใช่ตัวเลข + คำเตือนใต้ชื่อ
  function refreshRow(empId) {
    var tr = trByEmp[empId];
    if (!tr) return;
    var leaveTotal = 0, dayTotal = 0, anyBad = false;
    Array.prototype.forEach.call(inputsOf(tr), function (inp) {
      if (inp.getAttribute('data-key') === 'note') return;
      var p = parseCell(inp.value);
      inp.style.borderColor = p.ok ? '' : '#dc2626';
      inp.style.background = p.ok ? '' : '#fef2f2';
      inp.classList.toggle('atBad', !p.ok);
      if (!p.ok) anyBad = true;
    });
    LEAVE_KEYS.forEach(function (k) { leaveTotal += parseCell(inputOf(tr, k).value).n; });
    DAY_KEYS.forEach(function (k) { dayTotal += parseCell(inputOf(tr, k).value).n; });
    var totalCell = tr.querySelector('.atLeaveTotal');
    if (totalCell) totalCell.textContent = leaveTotal > 0 ? fmtNum(leaveTotal) : '';

    var warn = '';
    var lateCount = parseCell(inputOf(tr, 'lateCount').value), lateMin = parseCell(inputOf(tr, 'lateMinutes').value);
    if (anyBad) warn = '⚠ มีช่องที่ไม่ใช่ตัวเลข (ขอบแดง)';
    else if (dayTotal > 31) warn = '⚠ รวมวันลา/ขาดเกิน 31 วัน';
    else if (lateMin.n > 0 && lateCount.n === 0) warn = '⚠ มีนาทีสายแต่ไม่ได้ใส่จำนวนครั้ง — ระบบนับเป็นสาย 1 ครั้ง';
    else {
      // คนที่ยังไม่เคยมีแถวรายเดือนแต่มีรายการรายวันเดิม — พอเริ่มกรอก ตัวเลขในตารางจะ "แทน" รายวันทั้งหมด (ช่องที่เว้นว่างนับเป็น 0) เตือนไว้ก่อนกดบันทึก
      var meta = rowMeta[empId];
      if (state.dirty[empId] && meta && !meta.hasRow && meta.dailyCount > 0) {
        var anyFilled = false;
        Array.prototype.forEach.call(inputsOf(tr), function (inp) { if (String(inp.value).trim() !== '') anyFilled = true; });
        if (anyFilled) warn = 'ℹ️ บันทึกแล้วจะใช้ตัวเลขในแถวนี้แทนรายวันเดิม ' + meta.dailyCount + ' รายการ (ช่องว่าง = 0)';
      }
    }
    var warnEl = tr.querySelector('.atWarn');
    if (warnEl) warnEl.textContent = warn;

    var dirty = !!state.dirty[empId];
    var dirtyEl = tr.querySelector('.atDirty');
    if (dirtyEl) dirtyEl.style.display = dirty ? '' : 'none';
  }

  function refreshTotals() {
    var sums = {};
    COLS.forEach(function (c) { sums[c.key] = 0; });
    Object.keys(trByEmp).forEach(function (id) {
      var tr = trByEmp[id], leave = 0;
      COLS.forEach(function (c) {
        if (c.kind !== 'num') return;
        var n = parseCell(inputOf(tr, c.key).value).n;
        sums[c.key] += n;
        if (LEAVE_KEYS.indexOf(c.key) !== -1) leave += n;
      });
      sums._leaveTotal += leave;
    });
    COLS.forEach(function (c) {
      if (c.kind === 'text') return;
      var cell = document.querySelector('#atTable [data-total="' + c.key + '"]');
      if (cell) cell.textContent = sums[c.key] > 0 ? fmtNum(sums[c.key]) : '-';
    });
  }

  function updateSaveHint() {
    var n = dirtyCount();
    Array.prototype.forEach.call(document.querySelectorAll('.atSaveHint'), function (el) {
      el.textContent = n ? ('แก้ไขแล้ว ' + n + ' แถว — ยังไม่ได้บันทึก') : 'ยังไม่มีการแก้ไข';
      el.style.color = n ? '#d97706' : '';
    });
  }

  function onInput(ev) {
    var inp = ev.target;
    if (!inp || !inp.classList || !inp.classList.contains('atIn')) return;
    var empId = inp.getAttribute('data-emp');
    state.dirty[empId] = true;
    showError('');
    refreshRow(empId); refreshTotals(); updateSaveHint();
  }

  // Enter / ลูกศรขึ้น-ลง = ไปช่องเดิมของแถวถัดไป/ก่อนหน้า (กรอกแนวตั้งเร็วเหมือนใน Excel)
  function onKeyDown(ev) {
    var inp = ev.target;
    if (!inp || !inp.classList || !inp.classList.contains('atIn')) return;
    var dir = 0;
    if (ev.key === 'Enter' || ev.key === 'ArrowDown') dir = 1;
    else if (ev.key === 'ArrowUp') dir = -1;
    if (!dir) return;
    var trs = Array.prototype.slice.call(document.querySelectorAll('#atTable tr.atRow'));
    var idx = trs.indexOf(inp.closest('tr'));
    var next = trs[idx + dir];
    if (!next) return;
    ev.preventDefault();
    var target = inputOf(next, inp.getAttribute('data-key'));
    if (target) target.focus();
  }

  /* ---------- บันทึก ---------- */
  function readRowPayload(empId) {
    var tr = trByEmp[empId];
    var o = { employeeId: empId };
    COLS.forEach(function (c) { if (c.kind !== 'calc') o[c.key] = inputOf(tr, c.key).value; });
    return o;
  }

  // ล็อกทั้งตารางระหว่างรอผลบันทึก — กันพิมพ์เพิ่ม/กดปุ่มอื่นระหว่างนั้น (ไม่งั้นสิ่งที่พิมพ์ระหว่างรอจะถูกโหลดทับหายตอนบันทึกเสร็จ)
  function setBusy(b) {
    state.saving = b;
    if (!isAlive()) return;
    Array.prototype.forEach.call(document.querySelectorAll('#atGrid input, #atGrid button, #at_m, #at_y, #at_go, #atShowInactive'), function (el) { el.disabled = b; });
  }

  function onSave(evt) {
    if (state.saving) return;
    var ids = Object.keys(state.dirty);
    if (!ids.length) { toast('ยังไม่มีการแก้ไขที่ต้องบันทึก'); return; }

    // ตารางที่เห็นเป็นของเดือนที่ "โหลดอยู่" เท่านั้น — ถ้าเลือกเดือนใหม่ในช่องด้านบนแต่ยังไม่กด "ดู" ห้ามบันทึก (กันเข้าใจผิดว่ากำลังกรอกเดือนที่เลือก)
    var pickM = Number(document.getElementById('at_m').value), pickY = Number(document.getElementById('at_y').value);
    if (pickM !== state.month || pickY !== state.year) {
      showError('ช่องเลือกเดือนด้านบนเป็น ' + MONTHS_TH[pickM] + ' ' + pickY + ' แต่ตารางนี้ยังเป็นของเดือน ' + MONTHS_TH[state.month] + ' ' + state.year + ' — ถ้าต้องการกรอกเดือน ' + MONTHS_TH[pickM] + ' ให้กดปุ่ม "ดู" ก่อน (หรือเลือกกลับเป็นเดือน ' + MONTHS_TH[state.month] + ' ถ้าจะบันทึกเดือนนี้)');
      return;
    }

    // เช็คเฉพาะแถวที่แก้ — ค่าแปลกๆ ในแถวที่ไม่ได้แตะ (เช่นพิมพ์ผิดในชีตเอง) ไม่ควรขวางการบันทึกแถวอื่น
    var bad = null;
    ids.some(function (id) { var tr = trByEmp[id]; bad = tr ? tr.querySelector('input.atBad') : null; return !!bad; });
    if (bad) {
      showError('มีช่องที่กรอกไม่ใช่ตัวเลข (ขอบแดง) — พิมพ์เฉพาะตัวเลข เช่น 1 หรือ 0.5 (ไม่ใช้จุลภาค/เครื่องหมายลบ) แล้วกดบันทึกอีกครั้ง');
      bad.focus();
      return;
    }

    var rows = ids.map(readRowPayload);
    var month = state.month, year = state.year;
    showError('');
    // ต้องเรียก withButtonGuard ก่อน setBusy เสมอ (setBusy ปิดปุ่มทุกปุ่มรวมปุ่มที่กด ถ้าปิดก่อน withButtonGuard จะนึกว่ากำลังบันทึกอยู่แล้วแล้วไม่ทำอะไร)
    var pending = withButtonGuard(evt.currentTarget || evt.target, function () { return apiPost('saveAttendanceMonthly', { month: month, year: year, rows: rows }); });
    if (!pending) return; // กำลังบันทึกอยู่แล้ว (กดซ้ำ) — ไม่ทำซ้ำ
    setBusy(true);
    pending
      .then(function (r) {
        var savedN = (r && r.saved !== undefined) ? r.saved : rows.length, clearedN = (r && r.cleared) ? r.cleared : 0;
        var parts = [];
        if (savedN) parts.push('บันทึกแล้ว ' + savedN + ' แถว');
        if (clearedN) parts.push('ล้างข้อมูล ' + clearedN + ' แถว (กลับไปใช้รายวันเดิมถ้ามี)');
        toast(parts.length ? parts.join(' · ') : 'บันทึกแล้ว (ไม่มีข้อมูลที่ต้องเปลี่ยน)');
        state.dirty = {};
        return loadTable();
      })
      .catch(function (e) {
        // เซิร์ฟเวอร์ตอบเองว่าไม่ผ่าน (เช่นตัวเลขผิด) = แก้ตามข้อความแล้วบันทึกใหม่ได้เลย ; เน็ตหลุด/หมดเวลา = ไม่รู้ว่าฝั่งเซิร์ฟเวอร์เขียนไปหรือยัง
        var msg = e.message || String(e);
        showError(e.serverReported
          ? 'บันทึกไม่สำเร็จ: ' + msg + ' — แก้ตามข้อความแล้วกดบันทึกใหม่ได้เลย (ข้อมูลที่พิมพ์ไว้ยังอยู่)'
          : 'บันทึกไม่แน่ชัด: ' + msg + ' — ข้อมูลอาจถูกบันทึกไปแล้ว ให้กดปุ่ม "ดู" โหลดตารางใหม่เพื่อตรวจสอบ (หรือกดบันทึกซ้ำได้เลย ปลอดภัย ไม่ทำให้ข้อมูลซ้ำ) — ข้อมูลที่พิมพ์ไว้ยังอยู่');
        toast(msg, true);
      })
      .then(function () { setBusy(false); });
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
    '<div class="cardSubtitle">ขาด/ลา/มาสายรายวันของทุกคน — แสดงเฉพาะรายการรายวันเดิมเท่านั้น (เดือนที่กรอกสรุปรายเดือนในตารางแท็บ "Attendance" จะไม่มีรายการในปฏิทินนี้ แต่ตัวเลขถูกนำไปคิดคะแนนและเบี้ยขยันด้านล่างแล้ว)</div>' +
    '<div id="calGrid" class="muted" style="margin-top:14px;">กำลังโหลด...</div>' +
    '</div>' +
    '<div class="card"><h3>💵 สรุปเบี้ยขยันเดือนนี้</h3><div class="cardSubtitle">คนละก้อนกับเงินพิเศษ/คะแนนโดยสิ้นเชิง ทุกคน Active ได้เท่ากันหมด หักตามนาทีมาสายรวม/ประเภทการลาของเดือนนั้น (จากตารางรายเดือนในแท็บ "Attendance" หรือจากรายการรายวันในปฏิทินด้านบน) เท่านั้น</div><div id="calDiligence" class="muted">กำลังโหลด...</div></div>';
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
// ทุกแผนกรวมถึง Support & Strategy (กิ๊ฟ) เลือกประเมินได้ด้วยเกณฑ์เดียวกัน (เดิมตัดแผนกนี้ออก ยกเลิกแล้วตามที่พี่สั่ง)
// Work Score V2 (รวมหน้า): พี่ขอให้กรอกยอด Sales Field/Online "รวมอยู่ในหน้าเดียวกัน" กับการประเมิน Work Score เลย ไม่ต้องสลับแท็บ
// เลือกพนักงานแผนกไหน แพทเทิร์นการกรอกก็ต่างกันไปอัตโนมัติ (เซลส์วิ่ง/เซลส์ออนไลน์ = มีการ์ดกรอกยอดเดือนนี้โผล่ขึ้นมาก่อน
// แผนกอื่น = ไม่มีการ์ดนี้ ข้ามไปกรอกคะแนน A/B/C ตรงๆ เหมือนเดิม) — แท็บ "Sales Field"/"Sales Online" แยกต่างหากถูกลบออกไปแล้ว
// ตามที่พี่ขอ (ไม่ต้องการให้กรอกข้อมูลชุดเดียวกันได้จาก 2 ที่) การ์ดนี้ในหน้า Work Score จึงเป็นจุดเดียวที่กรอกยอดขายรายเดือน
// ของเซลส์วิ่ง/เซลส์ออนไลน์ได้แล้วทั้งระบบ (ไม่มีตารางสรุปยอดรวมทุกคนพร้อมกันอีกต่อไป ต้องเลือกดูทีละคนจากตรงนี้)
function renderAdminWorkScore() {
  if (!isSummaryUnlockedThisTab()) { renderSummaryPasswordGate(renderAdminWorkScore, 'ประเมิน Work Score'); return; } // ล็อกด้วยรหัสเดียวกับหน้าอื่นที่มีรหัส
  var eligible = APP.employees.slice(); // ทุกแผนก รวม Support & Strategy (กิ๊ฟ) — เดิมตัดแผนกนี้ออก ยกเลิกแล้วตามที่พี่สั่ง
  var html =
    '<div class="card"><h3>🎯 Performance Evaluation</h3><div class="cardSubtitle">ประเมิน Work Score เต็ม 20 — ฉันเป็นผู้ประเมินให้ทุกคนโดยตรง ไม่มีการประเมินตนเองหรือเฉลี่ยจากลูกทีม</div>' +
    monthPickerHtml('ws', APP.month, APP.year) +
    '<div id="wsWeightNote"></div>' +
    '<label>พนักงาน</label><select id="wsEmp">' + employeeOptions(eligible) + '</select>' +
    '<div id="wsExisting" class="muted" style="margin:6px 0;">กำลังโหลด...</div>' +
    '<div id="wsAutoCalc" class="calloutBox mt0" style="display:none;"></div>' +
    '<div class="calloutBox mt0">ไม่ต้องหักเพราะมาสาย/ขาด/ลา/Error — คิดแยกในคะแนนความผิด/ขาดลามาสายอยู่แล้ว</div></div>' +

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
    '<button class="btn" id="wsSave">✓ บันทึกคะแนน Work Score</button> ' +
    '<button class="btn secondary" id="wsDelete" style="display:none;color:#c0392b;border-color:#c0392b;">🗑️ ลบการประเมินนี้ (เลือกคนผิด)</button>' +
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
  // ใช้ id ขึ้นต้นด้วย wsSm... (ของเดิมตอนยังมีแท็บแยกใช้ smXxx) เป็นจุดเดียวที่กรอกยอดขายรายเดือนได้แล้วทั้งระบบ
  function workScoreSalesFieldFormHtml() {
    return '<div class="card"><h3>🚗 Sales Field — กรอกยอดเดือนนี้</h3><div class="cardSubtitle">กรอกแล้วกด "บันทึกยอดขาย" ระบบจะคำนวณข้อ A/B ด้านล่างให้ใหม่ทันที</div>' +
      '<div class="row"><div><label>ยอดขายส่วนตัว</label><input type="number" id="wsSmPersonalSales"></div><div><label>เป้ายอดขายส่วนตัว (เดือนนี้)</label><input type="number" id="wsSmTarget"></div></div>' +
      '<div class="row"><div><label>จำนวนลูกค้าใหม่</label><input type="number" id="wsSmNewCustomers"></div><div><label>จำนวนลูกค้าที่ดึงกลับ</label><input type="number" id="wsSmWonBack"></div></div>' +
      '<label>ยอดขายสินค้าผลักดัน</label><input type="number" id="wsSmPush">' +
      '<label>ยอดค้างชำระ</label><input type="number" id="wsSmOutstanding">' +
      '<label>หมายเหตุ</label><input type="text" id="wsSmNote">' +
      '<button class="btn secondary" id="wsSmSave">✓ บันทึกยอดขาย</button></div>';
  }
  function workScoreSalesOnlineFormHtml() {
    return '<div class="card"><h3>🛒 Sales Online — กรอกยอดเดือนนี้</h3><div class="cardSubtitle">กรอกแล้วกด "บันทึกยอดขาย" เพื่อเก็บไว้เป็นข้อมูลรายงานยอดขายออนไลน์เฉยๆ — ยังไม่มีสูตรคำนวณคะแนนอัตโนมัติของเซลส์ออนไลน์ ให้คะแนน A/B/C ด้านล่างเองไปก่อน (ไม่มีผลต่อคะแนน/เงินพิเศษของตัวเลขชุดนี้เอง)</div>' +
      '<label>ยอดขาย</label><input type="number" id="wsSmSales">' +
      '<div class="row"><div><label>ลูกค้าใหม่</label><input type="number" id="wsSmOnlineNewCustomers"></div><div><label>ลูกค้าที่ดูแล</label><input type="number" id="wsSmManaged"></div></div>' +
      '<label>Order</label><input type="number" id="wsSmOrderCount">' +
      '<label>ปัญหา/Order ผิด</label><input type="number" id="wsSmOrderIssue">' +
      '<label>หมายเหตุ</label><input type="text" id="wsSmOnlineNote">' +
      '<button class="btn secondary" id="wsSmOnlineSave">✓ บันทึกยอดขาย</button></div>';
  }

  // Work Score V2 (โหลดหน้าเดียวเร็วขึ้น): เดิมฟังก์ชันนี้ยิง apiGet('salesMonthlyOne', ...) เองทุกครั้งที่สลับคน — ตอนนี้
  // อ่านจากแคช wsBulk (โหลดมาแล้วทั้งเดือนตอนเปิดหน้า/เปลี่ยนเดือน) แทน ไม่มีการยิง Server ตอนสลับคนอีกต่อไป สลับเร็วทันที
  function renderMonthlyArea(emp, employeeId, month, year) {
    var area = document.getElementById('wsMonthlyArea');
    if (!emp || (emp.department !== 'Sales' && emp.department !== 'Online')) { area.innerHTML = ''; return; }
    if (emp.department === 'Sales') {
      area.innerHTML = workScoreSalesFieldFormHtml();
      var row = wsBulk && wsBulk.salesField[employeeId];
      if (row) {
        setValIfExists('wsSmPersonalSales', row['ยอดขายส่วนตัว'] || '');
        setValIfExists('wsSmTarget', row['เป้ายอดขายส่วนตัว'] || '');
        setValIfExists('wsSmNewCustomers', row['จำนวนลูกค้าใหม่'] || '');
        setValIfExists('wsSmWonBack', row['จำนวนลูกค้าที่ดึงกลับ'] || '');
        setValIfExists('wsSmPush', row['ยอดขายสินค้าผลักดัน'] || '');
        setValIfExists('wsSmOutstanding', row['ยอดค้างชำระ'] || '');
        setValIfExists('wsSmNote', row['หมายเหตุ'] || '');
      }
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
          .then(function () { toast('บันทึกยอดขายแล้ว'); return loadBulkThenRender(); })
          .catch(function (e) { toast(e.message || String(e), true); });
      });
    } else {
      area.innerHTML = workScoreSalesOnlineFormHtml();
      var rowOnline = wsBulk && wsBulk.salesOnline[employeeId];
      if (rowOnline) {
        setValIfExists('wsSmSales', rowOnline['ยอดขาย'] || '');
        setValIfExists('wsSmOnlineNewCustomers', rowOnline['ลูกค้าใหม่'] || '');
        setValIfExists('wsSmManaged', rowOnline['ลูกค้าที่ดูแล'] || '');
        setValIfExists('wsSmOrderCount', rowOnline['Order'] || '');
        setValIfExists('wsSmOrderIssue', rowOnline['ปัญหา/Order ผิด'] || '');
        setValIfExists('wsSmOnlineNote', rowOnline['หมายเหตุ'] || '');
      }
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
          .then(function () { toast('บันทึกยอดขายแล้ว'); return loadBulkThenRender(); })
          .catch(function (e) { toast(e.message || String(e), true); });
      });
    }
  }

  // Work Score V2 (รอบยืนยันล่าสุด): พี่ขอให้ข้อ C ของเซลส์วิ่ง/ออนไลน์ "ให้เต็มอัตโนมัติเสมอ" (ไม่ต้องมโนแยก) เพราะ A+B
  // คำนวณจากตัวเลขจริงหมดแล้ว — ยังแก้ไขเป็นตัวเลขอื่นได้เองก่อนกดบันทึก ถ้ามีเหตุผลจะปรับลดจริงๆ (เช่น ส่งรายงานช้ามาก)
  // Work Score V2 (โหลดหน้าเดียวเร็วขึ้น): เดิมฟังก์ชันนี้ยิง apiGet('salesMonthlyOne', ...) เองทุกครั้งที่สลับคน — ตอนนี้
  // อ่านจากแคช wsBulk แทน (ไม่มีการยิง Server ตอนสลับคนอีกต่อไป) ชื่อ/พฤติกรรมคำนวณเหมือนเดิมทุกประการ
  var COOPERATION_DEFAULT_FULL = 4;
  function applySalesFieldSuggestion(employeeId) {
    setValIfExists('wsC', COOPERATION_DEFAULT_FULL); // ให้เต็มไปก่อนเลย ไม่ต้องรอผลยอดขายก็กำหนดได้
    var box = document.getElementById('wsAutoCalc');
    if (!box || !document.getElementById('wsA')) return; // สลับหน้าไปแล้ว — ไม่มีอะไรให้อัปเดต
    var row = wsBulk && wsBulk.salesField[employeeId];
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
      ? '⚠️ ยังไม่ได้กรอก "เป้ายอดขายส่วนตัว" เดือนนี้ — ตั้งข้อ A เป็น 0 ไปก่อน กรอกเป้าในการ์ด "Sales Field — กรอกยอดเดือนนี้" ด้านบนแล้วกด "บันทึกยอดขาย" อีกครั้ง ระบบจะคำนวณ A ให้ใหม่ทันที'
      : '🧮 คำนวณ Work Score ให้อัตโนมัติจากข้อมูล Sales Field เดือนนี้แล้ว (ยอดขาย ' + fmtNum(row['ยอดขายส่วนตัว']) + ' / เป้า ' + fmtNum(row['เป้ายอดขายส่วนตัว']) + ') — A/B มาจากตัวเลขจริง, C ให้เต็ม ' + COOPERATION_DEFAULT_FULL + ' อัตโนมัติ (แก้ไขเองได้ทุกข้อก่อนกดบันทึก)') ;
    updateSum();
  }

  // ชื่อหัวข้อ C เปลี่ยนเป็น "ความร่วมมือและการส่งรายงาน" เฉพาะแผนกเซลส์ (วิ่ง/ออนไลน์) ตามที่พี่ขอ — แผนกอื่นยังใช้ชื่อเดิม
  // "ความร่วมมือและทัศนคติในการทำงาน" เพราะยังประเมินแบบเดิมอยู่ ไม่เกี่ยวกับการส่งรายงานยอดขายแบบเซลส์
  function updateCLabel(emp) {
    var isSales = emp && (emp.department === 'Sales' || emp.department === 'Online');
    setTextIfExists('wsCLabel', isSales ? 'C. ความร่วมมือและการส่งรายงาน (0-4)' : 'C. ความร่วมมือและทัศนคติในการทำงาน (0-4)');
  }

  // Work Score V2 (โหลดหน้าเดียวเร็วขึ้น ตามที่พี่ขอ — "โหลดแต่ละคนนานอ่ะ"): เดิมสลับพนักงานใน Dropdown แต่ละครั้งจะยิง
  // apiGet ใหม่ 2-3 รอบเสมอ (scoreWeights + workScoreDetail + salesMonthlyOne) ซึ่ง Apps Script ตอบช้าโดยธรรมชาติ ยิ่งสลับ
  // หลายคนยิ่งสะสมเวลารอ — ตอนนี้เปลี่ยนมาโหลดข้อมูล "ทุกคนในเดือนนั้น" มาครั้งเดียวด้วย workScoreBulk แล้วเก็บไว้ใน wsBulk
  // สลับคนใน Dropdown เดิมจะอ่านจากแคชนี้ล้วนๆ (renderFromCache) ไม่มีการยิง Server อีกเลย จนกว่าจะกดเปลี่ยนเดือน/บันทึก
  // ใหม่ (loadBulkThenRender) — แต่ละแผนกยังขึ้นฟอร์มไม่เหมือนกันเหมือนเดิมทุกประการ (Sales/Online มีการ์ดเพิ่ม แผนกอื่นไม่มี)
  var wsBulk = null; // { month, year, weights, detail:{empId:{...}}, salesField:{empId:{...}}, salesOnline:{empId:{...}} }

  function renderFromCache() {
    var employeeId = document.getElementById('wsEmp').value;
    var month = Number(document.getElementById('ws_m').value), year = Number(document.getElementById('ws_y').value);
    var emp = APP.employees.filter(function (e) { return e.id === employeeId; })[0];
    renderMonthlyArea(emp, employeeId, month, year);
    updateCLabel(emp);
    var autoBox = document.getElementById('wsAutoCalc');
    if (autoBox) { autoBox.style.display = 'none'; autoBox.innerHTML = ''; }
    var note = document.getElementById('wsWeightNote');
    if (note) {
      var w = wsBulk ? wsBulk.weights : null;
      // V3: โครงสร้างคะแนนของเดือนนี้ (Work/Error/ขาดลามาสาย/พัฒนาตัวเอง/อายุงาน) + หมายเหตุ เช่น เดือนที่ไม่นับ Work Score (Work เต็ม 0)
      // กรอกได้ตามปกติแต่ไม่มีผลกับคะแนนรวมเดือนนั้น
      note.innerHTML = (w && typeof w.workWeight === 'number')
        ? structureNoteHtml(weightsOf(w), 'margin-top:0;') + (w.workWeight === 0 ? '<div class="muted" style="margin:6px 0;">เดือนนี้กรอกคะแนน Work Score ได้ตามปกติ แต่จะไม่มีผลกับคะแนนรวมเดือนนี้ (Work เต็ม 0)</div>' : '')
        : '';
    }
    var d = wsBulk ? wsBulk.detail[employeeId] : null;
    var delBtn = document.getElementById('wsDelete');
    if (d) {
      setValIfExists('wsA', d.workA);
      setValIfExists('wsB', d.workB);
      setValIfExists('wsC', d.workC);
      setValIfExists('wsEvaluator', d.evaluator);
      setValIfExists('wsNote', d.note);
      setTextIfExists('wsExisting', 'เคยประเมินไว้แล้ว โดย ' + esc(d.evaluator) + (d.evalDate ? (' เมื่อ ' + fmtDate(d.evalDate)) : '') + ' — แก้แล้วกดบันทึกซ้ำได้');
      if (delBtn) { delBtn.style.display = ''; delBtn.disabled = false; }
      updateSum();
    } else {
      setValIfExists('wsA', ''); setValIfExists('wsB', ''); setValIfExists('wsC', '');
      setValIfExists('wsEvaluator', ''); setValIfExists('wsNote', '');
      setTextIfExists('wsExisting', 'ยังไม่เคยประเมินเดือนนี้');
      if (delBtn) delBtn.style.display = 'none';
      updateSum();
      // Work Score V2: เซลส์วิ่ง (แผนก Sales) ยังไม่เคยประเมินเดือนนี้ → เสนอคะแนน A/B อัตโนมัติจากยอด Sales Field เดือนนั้นให้เลย
      if (emp && emp.department === 'Sales') applySalesFieldSuggestion(employeeId);
    }
  }

  function loadBulkThenRender() {
    var month = Number(document.getElementById('ws_m').value), year = Number(document.getElementById('ws_y').value);
    setTextIfExists('wsExisting', 'กำลังโหลด...');
    var note = document.getElementById('wsWeightNote'); if (note) note.innerHTML = '';
    var delBtnLoading = document.getElementById('wsDelete'); if (delBtnLoading) delBtnLoading.style.display = 'none';
    return apiGet('workScoreBulk', { month: month, year: year }).then(function (bulk) {
      if (!document.getElementById('wsEmp')) return; // สลับหน้าไปแล้วระหว่างรอโหลด
      wsBulk = {
        month: month, year: year,
        weights: (bulk && bulk.weights) || {},
        detail: (bulk && bulk.detail) || {},
        salesField: (bulk && bulk.salesField) || {},
        salesOnline: (bulk && bulk.salesOnline) || {}
      };
      renderFromCache();
    }).catch(function (e) { if (document.getElementById('wsEmp')) toast(e.message || String(e), true); });
  }
  document.getElementById('wsEmp').addEventListener('change', renderFromCache); // สลับคน = อ่านแคช ไม่ยิง Server แล้ว เร็วทันที
  document.getElementById('ws_go').addEventListener('click', loadBulkThenRender); // เปลี่ยนเดือน/ปี = โหลดแคชใหม่ทั้งเดือน
  loadBulkThenRender();

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
      .then(function () { toast('บันทึกคะแนน Work Score แล้ว — ไปดูคะแนนรวม/เงินพิเศษได้ที่ "สรุปคะแนน/เงิน"'); loadBulkThenRender(); }).catch(function (e) { toast(e.message || String(e), true); });
  });

  // "ลบการประเมินนี้" — ใช้ตอนเผลอเลือกพนักงานผิดคนตอนประเมิน (ข้อมูลที่กรอกถูกแต่ลงผิดคน) ปุ่มนี้โชว์เฉพาะตอนที่คนนี้
  // เคยถูกประเมินเดือนนี้แล้วเท่านั้น (ดู renderFromCache) กดแล้วล้างคะแนน Work Score ของ "คนนี้ เดือนนี้" กลับไปเป็น
  // "ยังไม่เคยประเมิน" ไม่กระทบคะแนน Error/ขาดลามาสาย/ทำความดีของคนนี้เลย (คนละชีตกัน คำนวณแยกอิสระจากกันเสมอ)
  var wsDeleteBtn = document.getElementById('wsDelete');
  if (wsDeleteBtn) {
    wsDeleteBtn.addEventListener('click', function () {
      var employeeId = document.getElementById('wsEmp').value;
      var month = Number(document.getElementById('ws_m').value), year = Number(document.getElementById('ws_y').value);
      var emp = APP.employees.filter(function (e) { return e.id === employeeId; })[0];
      var empLabel = emp ? emp.name : employeeId;
      if (!confirm('ยืนยันลบการประเมิน Work Score ของ "' + empLabel + '" เดือน ' + month + '/' + year + ' ทิ้ง?\n\n' +
        'ใช้ตอนเผลอเลือกพนักงานผิดคนตอนประเมิน — จะล้างเฉพาะคะแนน Work Score ของคนนี้เดือนนี้กลับเป็น "ยังไม่เคยประเมิน" ' +
        'ไม่กระทบคะแนน Error/ขาดลามาสาย/ทำความดีของคนนี้เลย กู้คืนไม่ได้')) return;
      wsDeleteBtn.disabled = true;
      apiPost('deleteWorkScore', { employeeId: employeeId, month: month, year: year })
        .then(function () { toast('ลบการประเมินแล้ว — เลือกพนักงานที่ถูกต้องแล้วประเมินใหม่ได้เลย'); loadBulkThenRender(); })
        .catch(function (e) { wsDeleteBtn.disabled = false; toast(e.message || String(e), true); });
    });
  }
}

/* ---- 8.5 คะแนนการพัฒนาตัวเอง (V3 — พี่ให้ 0-10 เองทุกเดือน เริ่ม ต.ค. 2026 ตามชีต Score_Structure) ---- */
// แพทเทิร์นเดียวกับหน้า Work Score: โหลดข้อมูล "ทั้งเดือน ทุกคน" ครั้งเดียว (action selfDevBulk) แล้วสลับพนักงานจากแคชในเครื่อง ไม่ยิง Server
// ตอนสลับคน — คะแนนเต็มของเดือน (ปัจจุบัน 10) อ่านจาก Backend ทุกครั้งไม่ Hardcode เดือนที่โครงสร้างไม่มีส่วนนี้ (เต็ม 0 เช่น ก.ย./ส.ค. 2026)
// หน้านี้จะไม่ให้กรอก (Backend ก็ปฏิเสธอีกชั้น) มีตาราง "สรุปเดือนนี้" ให้เห็นว่าใครให้แล้ว/ยัง กดแถวเพื่อเลือกคนนั้นกรอกต่อได้เลย
// ทุกแผนกรวมถึง Support & Strategy เลือกให้คะแนนได้ (เหมือน Work Score)
var _lastSelfDevEvaluator = ''; // จำชื่อผู้ประเมินล่าสุดไว้ในหน้าเว็บ (ในหน่วยความจำเท่านั้น) ไม่ต้องพิมพ์ใหม่ทุกคน
function renderAdminSelfDev() {
  if (!isSummaryUnlockedThisTab()) { renderSummaryPasswordGate(renderAdminSelfDev, 'คะแนนพัฒนาตัวเอง'); return; } // ล็อกด้วยรหัสเดียวกับหน้าอื่นที่มีรหัส
  var eligible = APP.employees.slice(); // ทุกแผนก รวม Support & Strategy (กิ๊ฟ) — เดิมตัดแผนกนี้ออก ยกเลิกแล้วตามที่พี่สั่ง
  var html =
    '<div class="card"><h3>🌱 คะแนนการพัฒนาตัวเอง</h3><div class="cardSubtitle">พี่ให้คะแนนเองทุกเดือน (เหมือน Work Score) — ใช้เมื่อโครงสร้างคะแนนของเดือนนั้นมีส่วนนี้ (ตอนนี้เริ่มตั้งแต่ ต.ค. 2026 เต็ม 10)</div>' +
    monthPickerHtml('sd', APP.month, APP.year) +
    '<div id="sdWeightNote"></div></div>' +

    '<div class="card"><h3>📝 ให้คะแนน</h3>' +
    '<label>พนักงาน</label><select id="sdEmp">' + employeeOptions(eligible) + '</select>' +
    '<div id="sdExisting" class="muted" style="margin:6px 0;">กำลังโหลด...</div>' +
    '<label id="sdScoreLabel">คะแนนการพัฒนาตัวเอง</label><input type="number" id="sdScore" min="0" step="0.5">' +
    '<label>ผู้ประเมิน</label><input type="text" id="sdEvaluator" placeholder="ชื่อผู้ประเมิน">' +
    '<label>หมายเหตุ</label><textarea id="sdNote" placeholder="เช่น ไปอบรม/เรียนคอร์สออนไลน์/อ่านหนังสือที่เกี่ยวกับงาน"></textarea>' +
    '<button class="btn" id="sdSave">✓ บันทึกคะแนนการพัฒนาตัวเอง</button> ' +
    '<button class="btn secondary" id="sdDelete" style="display:none;color:#c0392b;border-color:#c0392b;">🗑️ ลบคะแนนนี้ (เลือกคนผิด)</button>' +
    '<div class="muted" style="margin-top:8px;">กดบันทึกแล้วคะแนนรวม/เงินพิเศษจะไปอัปเดตที่ "สรุปคะแนน/เงิน" และ Dashboard ทันที — เดือนที่มีส่วนนี้ ใครยังไม่ได้ให้คะแนน คะแนนรวมของคนนั้นจะเป็น PENDING และยังไม่นับเข้าเงินพิเศษ</div></div>' +

    '<div class="card"><h3>📋 สรุปเดือนนี้</h3><div id="sdSummary" class="muted">กำลังโหลด...</div></div>';
  document.getElementById('content').innerHTML = html;
  if (!eligible.length) return;

  var sdBulk = null; // { month, year, weights, detail:{empId:{score,evaluator,evalDate,note}} }
  var sdSeq = 0;     // กันคำตอบเก่า (เปลี่ยนเดือนรัวๆ) มาทับเดือนที่เลือกล่าสุด

  function maxScore() { return sdBulk ? weightsOf(sdBulk.weights).selfDev : 0; }

  function renderSummary() {
    var el = document.getElementById('sdSummary'); if (!el) return;
    var max = maxScore();
    if (!sdBulk) { el.textContent = 'กำลังโหลด...'; return; }
    if (!(max > 0)) { el.innerHTML = '<span class="muted">เดือนนี้ไม่มีส่วนคะแนนการพัฒนาตัวเอง</span>'; return; }
    var done = eligible.filter(function (e) { return sdBulk.detail[e.id]; }).length;
    el.innerHTML = '<div class="muted" style="margin-bottom:8px;">ให้คะแนนแล้ว <b>' + done + ' / ' + eligible.length + '</b> คน — กดที่แถวเพื่อเลือกคนนั้น</div>' +
      '<div style="overflow-x:auto"><table class="simple" id="sdSummaryTable"><tr><th>ชื่อ</th><th>แผนก</th><th>คะแนน</th><th>ผู้ประเมิน</th></tr>' +
      eligible.map(function (e) {
        var d = sdBulk.detail[e.id];
        return '<tr data-emp="' + esc(e.id) + '" style="cursor:pointer;"><td>' + esc(e.nickname || e.name) + '</td><td>' + esc(e.department) + '</td>' +
          '<td>' + (d ? ('<b>' + fmtNum(d.score) + '</b> / ' + max) : '<span class="muted">ยังไม่ให้</span>') + '</td><td>' + (d ? esc(d.evaluator) : '') + '</td></tr>';
      }).join('') + '</table></div>';
    Array.prototype.forEach.call(el.querySelectorAll('tr[data-emp]'), function (tr) {
      tr.addEventListener('click', function () { setValIfExists('sdEmp', tr.getAttribute('data-emp')); renderFromCache(); window.scrollTo(0, 0); });
    });
  }

  function renderFromCache() {
    var employeeId = document.getElementById('sdEmp') && document.getElementById('sdEmp').value;
    if (!employeeId) return;
    var max = maxScore();
    var note = document.getElementById('sdWeightNote');
    var scoreEl = document.getElementById('sdScore'), saveBtn = document.getElementById('sdSave'), delBtn = document.getElementById('sdDelete');
    if (!sdBulk) return;
    var month = sdBulk.month, year = sdBulk.year;
    if (note) {
      note.innerHTML = max > 0
        ? structureNoteHtml(weightsOf(sdBulk.weights), 'margin-top:8px;')
        : '<div class="calloutBox amber" style="margin-top:8px;">เดือน ' + month + '/' + year + ' โครงสร้างคะแนนไม่มีส่วนการพัฒนาตัวเอง (เต็ม 0) — ไม่ต้องให้คะแนนเดือนนี้ (เริ่มใช้ตั้งแต่เดือนที่กำหนดในชีต Score_Structure) · ' + esc(structureText(weightsOf(sdBulk.weights))) + '</div>';
    }
    setTextIfExists('sdScoreLabel', 'คะแนนการพัฒนาตัวเอง (0-' + max + ')');
    if (scoreEl) { scoreEl.max = String(max); scoreEl.disabled = !(max > 0); }
    if (saveBtn) saveBtn.disabled = !(max > 0);
    var d = sdBulk.detail[employeeId];
    if (max > 0 && d) {
      setValIfExists('sdScore', d.score);
      setValIfExists('sdEvaluator', d.evaluator);
      setValIfExists('sdNote', d.note);
      setTextIfExists('sdExisting', 'เคยให้คะแนนไว้แล้ว โดย ' + d.evaluator + (d.evalDate ? (' เมื่อ ' + fmtDate(d.evalDate)) : '') + ' — แก้แล้วกดบันทึกซ้ำได้');
      if (delBtn) { delBtn.style.display = ''; delBtn.disabled = false; }
    } else {
      setValIfExists('sdScore', ''); setValIfExists('sdNote', '');
      setValIfExists('sdEvaluator', _lastSelfDevEvaluator);
      setTextIfExists('sdExisting', max > 0 ? 'ยังไม่ได้ให้คะแนนเดือนนี้' : '');
      if (delBtn) delBtn.style.display = 'none';
    }
    renderSummary();
  }

  // forMonth/forYear: ใช้ตอนโหลดซ้ำหลังบันทึก/ลบ — ต้องโหลดเดือนเดียวกับที่เพิ่งบันทึกจริง (ไม่ตามช่องเลือกที่ผู้ใช้อาจเพิ่งเปลี่ยนแต่ยังไม่กด "ดู")
  // แล้วปรับช่องเลือกให้ตรงกับข้อมูลที่แสดง กันหน้าจอโชว์ข้อมูลเดือนหนึ่งแต่ช่องเลือกเป็นอีกเดือน
  function loadBulkThenRender(forMonth, forYear) {
    if (forMonth && forYear) { setValIfExists('sd_m', forMonth); setValIfExists('sd_y', forYear); }
    var month = Number(document.getElementById('sd_m').value), year = Number(document.getElementById('sd_y').value);
    var mySeq = ++sdSeq;
    // ระหว่างโหลดและเมื่อโหลดไม่สำเร็จ ต้องไม่ค้างข้อมูล/คะแนนของเดือนเก่าไว้ให้กดบันทึกหรือลบ (Apps Script ช้า/หมดเวลาบ่อย) — ปิดปุ่มจนกว่าจะโหลดสำเร็จ
    // กันเคสบันทึกคะแนนผิดเดือน หรือกดบันทึกซ้ำคะแนนที่เพิ่งลบไปแล้วระหว่างรอโหลดใหม่
    sdBulk = null;
    var saveBtnLoading = document.getElementById('sdSave'), scoreLoading = document.getElementById('sdScore');
    if (saveBtnLoading) saveBtnLoading.disabled = true;
    if (scoreLoading) scoreLoading.disabled = true;
    setTextIfExists('sdExisting', 'กำลังโหลด...');
    var noteLoading = document.getElementById('sdWeightNote'); if (noteLoading) noteLoading.innerHTML = ''; // ไม่ค้างโครงสร้างคะแนนของเดือนเก่าไว้ข้างช่องเลือกเดือนใหม่
    renderSummary();
    var delBtnLoading = document.getElementById('sdDelete'); if (delBtnLoading) delBtnLoading.style.display = 'none';
    return apiGet('selfDevBulk', { month: month, year: year }).then(function (bulk) {
      if (!document.getElementById('sdEmp') || mySeq !== sdSeq) return; // สลับหน้าไปแล้ว หรือมีการเปลี่ยนเดือนใหม่กว่านี้ระหว่างรอโหลด
      sdBulk = { month: month, year: year, weights: (bulk && bulk.weights) || {}, detail: (bulk && bulk.detail) || {} };
      renderFromCache();
    }).catch(function (e) { if (document.getElementById('sdEmp') && mySeq === sdSeq) { sdBulk = null; setTextIfExists('sdExisting', 'โหลดไม่สำเร็จ — กด "ดู" เพื่อลองใหม่ (ปุ่มบันทึกถูกปิดไว้จนกว่าจะโหลดสำเร็จ)'); setTextIfExists('sdSummary', 'โหลดไม่สำเร็จ'); toast(e.message || String(e), true); } });
  }
  document.getElementById('sdEmp').addEventListener('change', renderFromCache);
  document.getElementById('sd_go').addEventListener('click', function () { loadBulkThenRender(); });
  loadBulkThenRender();

  document.getElementById('sdSave').addEventListener('click', function (evt) {
    if (!sdBulk) { toast('ยังโหลดข้อมูลเดือนนี้ไม่เสร็จ', true); return; }
    var max = maxScore();
    var raw = document.getElementById('sdScore').value;
    if (!(max > 0)) { toast('เดือนนี้โครงสร้างคะแนนไม่มีส่วนการพัฒนาตัวเอง', true); return; }
    if (raw === '' || isNaN(Number(raw)) || Number(raw) < 0 || Number(raw) > max) { toast('คะแนนการพัฒนาตัวเอง ต้องอยู่ระหว่าง 0-' + max, true); return; }
    var evaluator = document.getElementById('sdEvaluator').value.trim();
    if (!evaluator) { toast('กรุณาระบุชื่อผู้ประเมิน', true); return; }
    var payload = {
      employeeId: document.getElementById('sdEmp').value,
      month: sdBulk.month, year: sdBulk.year, // ใช้เดือน/ปีของข้อมูลที่โหลดมาจริง (ไม่ใช่ช่องเลือกที่อาจเพิ่งเปลี่ยนแต่ยังไม่กด "ดู") กันบันทึกผิดเดือน
      score: raw, evaluator: evaluator, note: document.getElementById('sdNote').value
    };
    withButtonGuard(evt.target, function () { return apiPost('setSelfDevScore', payload); })
      .then(function () { _lastSelfDevEvaluator = evaluator; toast('บันทึกคะแนนการพัฒนาตัวเองแล้ว — ไปดูคะแนนรวม/เงินพิเศษได้ที่ "สรุปคะแนน/เงิน"'); loadBulkThenRender(payload.month, payload.year); })
      .catch(function (e) { toast(e.message || String(e), true); });
  });

  // "ลบคะแนนนี้" — ใช้ตอนเผลอเลือกพนักงานผิดคน (โชว์เฉพาะคนที่เคยได้คะแนนเดือนนี้แล้ว) ล้างเฉพาะคะแนนการพัฒนาตัวเองของ "คนนี้ เดือนนี้"
  // ไม่กระทบ Work Score/Error/ขาดลามาสาย ของคนนี้เลย
  var sdDeleteBtn = document.getElementById('sdDelete');
  sdDeleteBtn.addEventListener('click', function () {
    if (!sdBulk) return;
    var employeeId = document.getElementById('sdEmp').value;
    var emp = APP.employees.filter(function (e) { return e.id === employeeId; })[0];
    var empLabel = emp ? emp.name : employeeId;
    if (!confirm('ยืนยันลบคะแนนการพัฒนาตัวเองของ "' + empLabel + '" เดือน ' + sdBulk.month + '/' + sdBulk.year + ' ทิ้ง?\n\n' +
      'ใช้ตอนเผลอเลือกพนักงานผิดคน — จะล้างเฉพาะคะแนนส่วนนี้ของคนนี้เดือนนี้กลับเป็น "ยังไม่ได้ให้คะแนน" ไม่กระทบ Work Score/Error/ขาดลามาสายเลย กู้คืนไม่ได้')) return;
    sdDeleteBtn.disabled = true;
    var delMonth = sdBulk.month, delYear = sdBulk.year;
    apiPost('deleteSelfDevScore', { employeeId: employeeId, month: delMonth, year: delYear })
      .then(function () { toast('ลบคะแนนแล้ว — เลือกพนักงานที่ถูกต้องแล้วให้คะแนนใหม่ได้เลย'); loadBulkThenRender(delMonth, delYear); })
      .catch(function (e) { sdDeleteBtn.disabled = false; toast(e.message || String(e), true); });
  });
}

/* ---- 9. สรุปคะแนน/เงิน ---- */
// เรียงตามคะแนนรวมมาก→น้อยเป็นค่าเริ่มต้นเสมอ และกรองตามกลุ่มเงินพิเศษได้ (Support/Sales Field/Sales Online — ตรงกับ INCENTIVE_GROUPS ฝั่ง Backend)
var SUMMARY_GROUP_OPTIONS = ['Support', 'Sales Field', 'Sales Online'];
function renderAdminSummary() {
  if (!isSummaryUnlockedThisTab()) { renderSummaryPasswordGate(renderAdminSummary); return; } // ต้องใส่รหัสผ่านก่อนเห็นคะแนน/เงินของทุกคน
  var groupFilterOptions = '<option value="">ทั้งหมด</option>' + SUMMARY_GROUP_OPTIONS.map(function (g) { return '<option value="' + g + '">' + g + '</option>'; }).join('');
  var html =
    '<div class="card"><h3>🏆 สรุปคะแนน/เงิน</h3><div class="cardSubtitle">ภาพรวม Performance Score, สิทธิ์เงินพิเศษ และ Reward Points ของทุกคนในเดือนที่เลือก</div>' +
    monthPickerHtml('cs', APP.month, APP.year) +
    '<label>กรองตามกลุ่มเงินพิเศษ</label><select id="csGroupFilter">' + groupFilterOptions + '</select>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">' +
    '<button class="btn secondary" id="csExport">⬇ ดาวน์โหลดเป็น CSV</button>' +
    '<button class="btn secondary" id="csExportPdf">⬇ ดาวน์โหลดเป็น PDF</button>' +
    '</div>' +
    '<div class="calloutBox" style="margin-top:14px;">คอลัมน์ <b>งาน/ผิด/ขาดลามาสาย/พัฒนา/อายุงาน/รวม</b> คือ Performance Score เต็ม 100 (คะแนนเต็มของแต่ละหมวดต่างกันตามเดือน ดูกล่อง "โครงสร้างคะแนนเดือนนี้" ด้านล่าง · ช่อง <b>–</b> = เดือนนี้ไม่มีหมวดนั้น · <b>PENDING</b> = ข้อมูลของหมวดนั้นยังไม่ครบ เช่น ยังไม่ประเมิน/ยังไม่ให้คะแนนพัฒนาตัวเอง/ยังไม่กรอกวันเริ่มงาน — เอาเมาส์ชี้ดูสาเหตุ คนที่ PENDING จะยังไม่นับเข้าเงินพิเศษ) · <b>ดี/รางวัล/คะแนนรวม (สีส้ม)</b> แยกต่างหากโดยสิ้นเชิง ไม่รวมกับคะแนนรวม 100 คะแนนด้านหน้า · <b>เงินพิเศษ</b> คำนวณจากคะแนนรวมเท่านั้น · <b>ค่าเสียหาย</b> (คอลัมน์ขวาสุด แยกเส้นให้เห็นชัดว่าไม่เกี่ยวกับคะแนน/เงินด้านหน้าทั้งหมด) เป็นตัวเลขแสดงผลเฉยๆ จากที่กรอกไว้ตอนบันทึกเหตุการณ์ความผิด ไม่มีผลต่อคะแนน/เงินใดๆ ทั้งสิ้น · แถวล่างสุดของตารางคือยอดรวมเงินพิเศษ/ค่าเสียหายของทุกคนที่แสดงอยู่ · ตัวเลขในวงเล็บใต้หัวคอลัมน์เงินพิเศษ/ค่าเสียหาย คือเดือนที่เงินจะออกจริง/ถูกหักจริง (เงินพิเศษ +3 เดือนจากตารางนี้ ค่าเสียหาย +1 เดือน) คำนวณอัตโนมัติตามเดือนที่เลือกดูอยู่ ไม่ต้องนับเอง · <b>เบี้ยขยัน</b> ย้ายไปดู/สรุปที่หน้า "ปฏิทินบริษัท" แทนแล้ว · พนักงานที่ลาออกแล้ว (ติ๊ก Inactive) จะยังโผล่ในตารางของ<b>เดือนที่เขายังทำงานอยู่จริง</b>พร้อมป้าย "ลาออกแล้ว" ให้เห็นคะแนน/ค่าเสียหายย้อนหลังไว้ตรวจสอบ/ปิดยอดได้ (คำนวณสดล่าสุดเสมอ) แต่คอลัมน์ <b>เงินพิเศษ</b> จะขึ้น "-" เสมอ เพราะลาออกก่อนถึงเดือนที่เงินก้อนนี้จะออกจริง จึงตัดออกจากกองไม่เข้าร่วมรับส่วนแบ่งใดๆ ทั้งสิ้น (ส่วนแบ่งที่เหลือจะตกไปอยู่กับคนที่ยัง Active ในกองแทนโดยอัตโนมัติ) เดือนที่เขาไม่ได้ทำงานแล้วจะไม่โผล่มาอีกเลย</div>' +
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
        // V3: โชว์โครงสร้างคะแนนของเดือนที่ดูอยู่เสมอ (ไม่ใช่เฉพาะเดือนที่ Override) — แต่ละเดือนไม่เหมือนกัน ดูชีต Score_Structure
        note.innerHTML = first ? structureNoteHtml(weightsOf(first)) : '';
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
    var wt = weightsOf(rows[0]); // โครงสร้างคะแนนเดือนเดียวกันทุกแถว (Backend ส่งแนบมาทุกแถว)
    function capNote(max) { return max > 0 ? '<span class="thNote">/' + max + '</span>' : ''; }
    var incentiveMonthNote = '(ออกเดือน' + payoutMonthLabel(3, tableMonth, tableYear) + ')';
    var damageMonthNote = '(หักเดือน' + payoutMonthLabel(1, tableMonth, tableYear) + ')';
    el.innerHTML = '<div style="overflow-x:auto"><table class="simple"><tr><th>ชื่อ</th><th>แผนก</th><th>กลุ่มเงินพิเศษ</th><th>งาน' + capNote(wt.work) + '</th><th>ผิด' + capNote(wt.error) + '</th><th>ขาด/ลา/สาย' + capNote(wt.att) + '</th><th>พัฒนา' + capNote(wt.selfDev) + '</th><th>อายุงาน' + capNote(wt.tenure) + '</th><th class="colDivider">รวม' + capNote(wt.total) + '</th><th class="colDivider">ดี</th><th>รางวัล</th><th class="amberCell">คะแนนรวม</th><th class="colDivider">เงินพิเศษ<span class="thNote">' + incentiveMonthNote + '</span></th><th class="colDivider">ค่าเสียหาย<span class="thNote">' + damageMonthNote + '</span></th></tr>' +
      rows.map(function (r) { return '<tr' + (r['สถานะ'] && r['สถานะ'] !== 'Active' ? ' class="inactiveRow"' : '') + '><td>' + nameCellHtml(r) + '</td><td>' + esc(r['แผนก']) + '</td><td>' + esc(r['กลุ่มเงินพิเศษ']) + '</td><td>' + compCellHtml(r['คะแนนงาน'], wt.work) + '</td><td>' + compCellHtml(r['คะแนนความผิด'], wt.error) + '</td><td>' + compCellHtml(r['คะแนนขาดลามาสาย'], wt.att) + '</td><td>' + compCellHtml(r['คะแนนพัฒนาตัวเอง'], wt.selfDev) + '</td><td>' + compCellHtml(r['คะแนนอายุงาน'], wt.tenure) + '</td><td class="colDivider totalCell">' + pendingBlockHtml(r['คะแนนรวม']) + '</td><td class="colDivider">' + fmtNum(r['คะแนนทำความดี']) + '</td><td>' + fmtNum(r['คะแนนแจ้งรางวัล']) + '</td><td class="amberCell">' + fmtNum(r['Reward Points สะสม']) + '</td><td class="colDivider moneyCell">' + fmtNum(r['เงินพิเศษ']) + '</td><td class="colDivider">' + damageCellHtml(r['ค่าความเสียหาย']) + '</td></tr>'; }).join('') +
      '<tr class="totalsRow"><td colspan="12">รวมทั้งหมด (' + rows.length + ' คน)</td><td class="colDivider">' + fmtNum(totalIncentive) + '</td><td class="colDivider">' + damageCellHtml(totalDamage) + '</td></tr>' +
      '</table></div>';
  }
  document.getElementById('csExport').addEventListener('click', function () {
    var rows = filteredSortedRows();
    if (!rows.length) { toast('ไม่มีข้อมูลให้ดาวน์โหลด', true); return; }
    var cols = ['รหัสพนักงาน', 'ชื่อพนักงาน', 'สถานะ', 'แผนก', 'กลุ่มเงินพิเศษ', 'คะแนนงาน', 'คะแนนความผิด', 'คะแนนขาดลามาสาย', 'คะแนนพัฒนาตัวเอง', 'คะแนนอายุงาน', 'คะแนนรวม', 'คะแนนทำความดี', 'คะแนนแจ้งรางวัล', 'Reward Points สะสม', 'เงินพิเศษ', 'ค่าความเสียหาย'];
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

/* ---- 9.5 สรุปรายปี (งาน+ผิด+ขาดลามาสาย เฉลี่ยหลายเดือน + อายุงาน — สำหรับขึ้นเงินเดือน/โบนัสประจำปี) ---- */
// พี่ขอ "โชว์ตัวเลขดิบเทียบทุกคน ให้พี่ตัดสินใจเอง" — ไม่มีสูตรแปลงคะแนนเฉลี่ย/อายุงานเป็น % ขึ้นเงินเดือนหรือจำนวนเงินโบนัส
// อัตโนมัติ (หลักการเดิมของระบบทุกจุดที่เกี่ยวกับเงิน ไม่เดาสูตรให้) เลือกช่วงเดือน/ปีแบบต่อเนื่อง (จาก → ถึง) แล้วเรียก
// action "annualSummary" ครั้งเดียว (Backend เฉลี่ย "คะแนนรวม" ของเดือนที่นับได้ให้เสร็จแล้ว ดู getAnnualSummary/computeTenure
// ใน Code.gs) — "อายุงาน" ต้องกรอก "วันเริ่มงาน" ในชีต Employees เองก่อน (ไม่มีฟอร์มเว็บให้กรอก ระบบเดาให้ไม่ได้)
// ประเภทที่เลือกดูแบบ "รายเดือน" ในตารางขาด/ลา/มาสายของหน้าสรุปรายปี (key = ชื่อฟิลด์ที่ Backend getAnnualAttendance ส่งมา)
var ATT_VIEW_METRICS = [
  { key: 'absent', label: 'ขาด', unit: 'วัน' },
  { key: 'leaveTotal', label: 'รวมวันลา', unit: 'วัน' },
  { key: 'sickCert', label: 'ลาป่วย-มีใบ', unit: 'วัน' },
  { key: 'sickNoCert', label: 'ลาป่วย-ไม่มีใบ', unit: 'วัน' },
  { key: 'personal', label: 'ลากิจ', unit: 'วัน' },
  { key: 'vacation', label: 'ลาพักร้อน', unit: 'วัน' },
  { key: 'unapproved', label: 'ลาไม่อนุมัติ', unit: 'วัน' },
  { key: 'lateCount', label: 'มาสาย', unit: 'ครั้ง' },
  { key: 'lateMinutes', label: 'มาสายรวม', unit: 'นาที' },
  { key: 'ot', label: 'OT', unit: 'ชม.' }
];
var _annualRenderSeq = 0; // นับครั้งที่เปิดหน้า "สรุปรายปี" — คำตอบของการเปิดหน้ารอบก่อน (ที่มาช้า) จะถูกทิ้ง ไม่ไปทับตารางของรอบปัจจุบัน
function renderAdminAnnualSummary() {
  if (!isSummaryUnlockedThisTab()) { renderSummaryPasswordGate(renderAdminAnnualSummary, 'สรุปรายปี'); return; } // ล็อกด้วยรหัสเดียวกับหน้าอื่นที่มีรหัส
  var myRender = ++_annualRenderSeq;
  var MONTHS_TH = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  function miniYearMonthSelectHtml(idPrefix, month, year) {
    var mOpts = '', yOpts = '';
    for (var m = 1; m <= 12; m++) mOpts += '<option value="' + m + '"' + (m === month ? ' selected' : '') + '>' + MONTHS_TH[m] + '</option>';
    for (var y = year - 3; y <= year + 1; y++) yOpts += '<option value="' + y + '"' + (y === year ? ' selected' : '') + '>' + y + '</option>';
    return '<select id="' + idPrefix + '_m">' + mOpts + '</select> <select id="' + idPrefix + '_y">' + yOpts + '</select>';
  }

  var html =
    '<div class="card"><h3>📈 สรุปรายปี</h3><div class="cardSubtitle">คะแนนรวม Performance (เต็ม 100/เดือน — คะแนนเต็มของแต่ละหมวดต่างกันตามเดือน ดูกล่อง "โครงสร้างคะแนนเดือนนี้" ในหน้า "สรุปคะแนน/เงิน") เฉลี่ยของเดือนที่เลือก + อายุงาน — ใช้ประกอบการตัดสินใจขึ้นเงินเดือน/ให้โบนัสประจำปีเอง ระบบไม่มีสูตรแปลงเป็น % ขึ้นเงินเดือน/บาทโบนัสอัตโนมัติ</div>' +
    '<div class="row"><div><label>จากเดือน/ปี</label>' + miniYearMonthSelectHtml('asFrom', 1, APP.year) + '</div>' +
    '<div><label>ถึงเดือน/ปี</label>' + miniYearMonthSelectHtml('asTo', APP.month, APP.year) + '</div></div>' +
    '<button class="btn" id="as_go" style="margin-top:10px;">ดูสรุป</button>' +
    '<div class="calloutBox mt0" style="margin-top:14px;">คอลัมน์ <b>คะแนนเฉลี่ย</b> = ค่าเฉลี่ย "คะแนนรวม" ของเดือนที่ <b>นับได้</b> เท่านั้น (เดือนที่ยังเป็น PENDING — ยังไม่ประเมิน Work Score / ยังไม่ให้คะแนนพัฒนาตัวเอง / ยังไม่กรอกวันเริ่มงาน — จะไม่ถูกนับเข้าค่าเฉลี่ย แต่โชว์คอลัมน์ "นับได้" ให้เห็นว่านับได้กี่เดือนจากกี่เดือนที่เลือก กันเข้าใจผิดว่าข้อมูลครบแล้ว) · <b>อายุงาน</b> คำนวณ ณ วันสุดท้ายของเดือน "ถึง" ที่เลือก จากคอลัมน์ "วันเริ่มงาน" ในชีต Employees (กรอกเองทีละคนตรงในชีตเลย ไม่มีฟอร์มเว็บให้กรอก — ตอนนี้ข้อมูลนี้ใช้คิดคะแนนอายุงานรายเดือนด้วย ถ้าไม่กรอกคะแนนรวมของเดือนที่มีหมวดอายุงานจะเป็น PENDING) คนที่ยังไม่กรอกจะโชว์ "ยังไม่กรอกวันเริ่มงาน" ตรงไปตรงมา · ไม่รวมเบี้ยขยัน/เงินพิเศษ/Reward Points เพราะเป็นเงินคนละก้อนกันอยู่แล้ว ดูที่หน้า "สรุปคะแนน/เงิน"/"ปฏิทินบริษัท" แทน · พนักงานลาออกแล้วที่มีข้อมูลจริงอยู่ในช่วงที่เลือกจะยังโผล่ในตารางพร้อมป้าย "ลาออกแล้ว" ให้เห็นไว้อ้างอิง</div>' +
    '</div>' +
    '<div class="card"><div id="asList" class="muted">กำลังโหลด...</div></div>' +
    '<div class="card"><h3>🗓 ขาด ลา มาสาย ตามช่วงที่เลือก</h3><div class="cardSubtitle">ตารางสรุปขาด/ลา/มาสายรายคนของ "ช่วงเดือน" ด้านบน (เหมือนชีตสรุปรายปีใน Excel) — ตัวเลขชุดเดียวกับที่ใช้คิดคะแนนขาดลามาสายและเบี้ยขยันของแต่ละเดือน</div>' +
    '<div class="row"><div><label>แสดงแบบ</label><select id="aaView">' +
      '<option value="total">รวมทั้งช่วง (ทุกประเภท)</option>' +
      ATT_VIEW_METRICS.map(function (mt) { return '<option value="' + mt.key + '">รายเดือน: ' + mt.label + ' (' + mt.unit + ')</option>'; }).join('') +
    '</select></div></div>' +
    '<div id="aaList" class="muted" style="margin-top:12px;">กำลังโหลด...</div>' +
    '<div class="calloutBox mt0" style="margin-top:14px;">ช่อง <b>–</b> = เดือนนั้น <b>ยังไม่มีข้อมูล</b> (ไม่ใช่ 0) · ช่อง <b>0</b> = มีข้อมูลเดือนนั้นแล้วและไม่มีรายการ · <b>รวมวันลา</b> = ลาป่วย+ลากิจ+ลาพักร้อน (ไม่รวม "ลาไม่อนุมัติ" และ "ขาด" ซึ่งหักคะแนนและแยกเป็นคอลัมน์ต่างหาก) · ข้อมูลมาจาก <b>ตารางรายเดือน</b> (แท็บ Attendance) ถ้าเดือนนั้นมี ไม่งั้นรวมจากรายการรายวัน</div></div>';
  document.getElementById('content').innerHTML = html;

  var lastRows = [];
  var lastAtt = null;      // ผลล่าสุดของ annualAttendance (null = ยังไม่โหลด/โหลดไม่สำเร็จ)
  var attSeq = 0;          // กันผลโหลดเก่าทับผลใหม่ (กดดูสรุปรัวๆ)
  var mainSeq = 0;         // เหมือนกัน แต่สำหรับตารางคะแนนด้านบน
  function stale(seq, cur) { return myRender !== _annualRenderSeq || seq !== cur; }
  document.getElementById('as_go').addEventListener('click', load);
  document.getElementById('aaView').addEventListener('change', renderAtt);
  load();

  function load() {
    var fromMonth = Number(document.getElementById('asFrom_m').value), fromYear = Number(document.getElementById('asFrom_y').value);
    var toMonth = Number(document.getElementById('asTo_m').value), toYear = Number(document.getElementById('asTo_y').value);
    var el = document.getElementById('asList');
    if (el) el.innerHTML = '<div class="muted">กำลังโหลด...</div>';
    loadAtt(fromMonth, fromYear, toMonth, toYear);
    var mySeqMain = ++mainSeq;
    apiGet('annualSummary', { fromMonth: fromMonth, fromYear: fromYear, toMonth: toMonth, toYear: toYear }).then(function (rows) {
      if (stale(mySeqMain, mainSeq) || !document.getElementById('asList')) return; // มีการโหลดใหม่กว่า หรือสลับหน้าไปแล้วระหว่างรอโหลด
      lastRows = rows;
      render();
    }).catch(function (e) {
      if (stale(mySeqMain, mainSeq)) return;
      var el2 = document.getElementById('asList');
      if (!el2) return;
      el2.innerHTML = '<div class="muted">โหลดไม่สำเร็จ: ' + esc(e.message || String(e)) + ' <button class="btn secondary" id="asRetry" style="margin-left:8px;">ลองใหม่</button></div>';
      var retryBtn = document.getElementById('asRetry');
      if (retryBtn) retryBtn.addEventListener('click', load);
      toast(e.message || String(e), true);
    });
  }

  function nameCellHtml(r) {
    var name = esc(r.nickname) + ' (' + esc(r.fullName) + ')';
    return (r.status && r.status !== 'Active') ? (name + ' <span class="inactiveBadge">ลาออกแล้ว</span>') : name;
  }

  // เรียงคะแนนเฉลี่ยมาก→น้อยเป็นค่าเริ่มต้นเสมอ (เหมือนหน้า "สรุปคะแนน/เงิน") — คนที่ยังนับไม่ได้เลย (avgTotalScore = null) ให้ไปอยู่ล่างสุด
  function sortedRows() {
    return lastRows.slice().sort(function (a, b) {
      var av = (a.avgTotalScore === null || a.avgTotalScore === undefined) ? -1 : a.avgTotalScore;
      var bv = (b.avgTotalScore === null || b.avgTotalScore === undefined) ? -1 : b.avgTotalScore;
      return bv - av;
    });
  }

  function render() {
    var rows = sortedRows();
    var el = document.getElementById('asList');
    if (!rows.length) { el.innerHTML = '<div class="muted">ไม่มีข้อมูล</div>'; return; }
    el.innerHTML = '<div style="overflow-x:auto"><table class="simple"><tr><th>ชื่อ</th><th>แผนก</th><th>อายุงาน</th><th class="colDivider">คะแนนเฉลี่ย</th><th>นับได้</th></tr>' +
      rows.map(function (r) {
        var avgCell = (r.avgTotalScore === null || r.avgTotalScore === undefined) ? '<span class="muted">ยังนับไม่ได้เลย</span>' : fmtNum(r.avgTotalScore);
        return '<tr' + (r.status && r.status !== 'Active' ? ' class="inactiveRow"' : '') + '>' +
          '<td>' + nameCellHtml(r) + '</td>' +
          '<td>' + esc(r.department) + '</td>' +
          '<td>' + esc(r.tenureLabel) + '</td>' +
          '<td class="colDivider totalCell">' + avgCell + '</td>' +
          '<td>' + r.monthsCounted + ' / ' + r.monthsSelected + ' เดือน</td>' +
          '</tr>';
      }).join('') +
      '</table></div>';
  }

  /* ---- ส่วนตาราง "ขาด ลา มาสาย" (action annualAttendance) — โหลดแยกจากตารางคะแนน: ส่วนไหนพัง อีกส่วนยังใช้ได้ ---- */
  function loadAtt(fromMonth, fromYear, toMonth, toYear) {
    var mySeq = ++attSeq;
    lastAtt = null;
    var el = document.getElementById('aaList');
    if (el) el.innerHTML = '<div class="muted">กำลังโหลด...</div>';
    apiGet('annualAttendance', { fromMonth: fromMonth, fromYear: fromYear, toMonth: toMonth, toYear: toYear }).then(function (rows) {
      if (stale(mySeq, attSeq) || !document.getElementById('aaList')) return; // มีการโหลดใหม่กว่า หรือสลับหน้าไปแล้ว
      lastAtt = rows || [];
      renderAtt();
    }).catch(function (e) {
      if (stale(mySeq, attSeq)) return;
      var el2 = document.getElementById('aaList');
      if (!el2) return;
      el2.innerHTML = '<div class="muted">โหลดตารางขาด/ลา/มาสายไม่สำเร็จ: ' + esc(e.message || String(e)) + ' <button class="btn secondary" id="aaRetry" style="margin-left:8px;">ลองใหม่</button><br>(ถ้าเพิ่งอัปเดตไฟล์เว็บ ต้อง Deploy Apps Script เวอร์ชันใหม่ด้วย ตารางนี้ถึงจะใช้ได้)</div>';
      var rb = document.getElementById('aaRetry');
      if (rb) rb.addEventListener('click', function () {
        loadAtt(Number(document.getElementById('asFrom_m').value), Number(document.getElementById('asFrom_y').value), Number(document.getElementById('asTo_m').value), Number(document.getElementById('asTo_y').value));
      });
    });
  }

  function attCellHtml(v, hasData) {
    if (!hasData) return '<span class="muted" title="ยังไม่มีข้อมูลเดือนนี้">–</span>';
    if (!v) return '<span class="muted">0</span>';
    return '<b>' + fmtNum(v) + '</b>';
  }

  function attNameCellHtml(r) {
    var name = esc(r.nickname || r.employeeId);
    if (r.status && r.status !== 'Active') name += ' <span class="inactiveBadge">ลาออกแล้ว</span>';
    return '<span title="' + esc((r.fullName || '') + (r.department ? ' · ' + r.department : '')) + '">' + name + '</span>';
  }

  function renderAtt() {
    var el = document.getElementById('aaList');
    var viewSel = document.getElementById('aaView');
    if (!el || !viewSel || lastAtt === null) return;
    var rows = lastAtt;
    if (!rows.length) { el.innerHTML = '<div class="muted">ไม่มีข้อมูล</div>'; return; }
    var view = viewSel.value;
    var multiYear = rows[0].monthly.some(function (m) { return m.year !== rows[0].monthly[0].year; });
    var html;

    if (view === 'total') {
      var hasOther = rows.some(function (r) { return r.totals.otherLeave > 0; });
      var cols = [
        { key: 'absent', label: 'ขาด<br><small>(วัน)</small>' },
        { key: 'sickCert', label: 'ลาป่วย<br>มีใบ' },
        { key: 'sickNoCert', label: 'ลาป่วย<br>ไม่มีใบ' },
        { key: 'personal', label: 'ลากิจ' },
        { key: 'vacation', label: 'ลาพักร้อน' }
      ];
      if (hasOther) cols.push({ key: 'otherLeave', label: 'ลาอื่นๆ<br><small>(ไม่ระบุประเภท)</small>' });
      cols.push({ key: 'leaveTotal', label: 'รวมวันลา', divider: true });
      cols.push({ key: 'unapproved', label: 'ลาไม่<br>อนุมัติ' });
      cols.push({ key: 'lateCount', label: 'มาสาย<br><small>(ครั้ง)</small>', divider: true });
      cols.push({ key: 'lateMinutes', label: 'มาสาย<br><small>(นาที)</small>' });
      cols.push({ key: 'ot', label: 'OT<br><small>(ชม.)</small>' });
      var sums = {};
      cols.forEach(function (c) { sums[c.key] = 0; });
      var anyData = rows.some(function (r) { return r.monthsWithData > 0; });
      html = '<div style="overflow-x:auto;"><table class="simple" id="aaTable"><tr><th class="aaName">ชื่อ</th><th>แผนก</th>' +
        cols.map(function (c) { return '<th' + (c.divider ? ' class="colDivider"' : '') + ' style="text-align:center;">' + c.label + '</th>'; }).join('') +
        '<th class="colDivider" style="text-align:center;">เดือนที่มีข้อมูล</th></tr>' +
        rows.map(function (r) {
          cols.forEach(function (c) { sums[c.key] += r.totals[c.key] || 0; });
          var incomplete = r.monthsWithData < r.monthsSelected;
          return '<tr' + (r.status && r.status !== 'Active' ? ' class="inactiveRow"' : '') + '>' +
            '<td class="aaName">' + attNameCellHtml(r) + '</td>' +
            '<td>' + esc(r.department) + '</td>' +
            cols.map(function (c) { return '<td' + (c.divider ? ' class="colDivider"' : '') + ' style="text-align:center;">' + attCellHtml(r.totals[c.key], r.monthsWithData > 0) + '</td>'; }).join('') +
            '<td class="colDivider" style="text-align:center;">' + (incomplete ? '<span class="muted">' : '') + r.monthsWithData + ' / ' + r.monthsSelected + (incomplete ? '</span>' : '') + '</td>' +
            '</tr>';
        }).join('') +
        '<tr class="aaFoot"><td class="aaName"><b>รวมทั้งหมด</b></td><td></td>' +
        cols.map(function (c) { return '<td' + (c.divider ? ' class="colDivider"' : '') + ' style="text-align:center;">' + (anyData ? '<b>' + fmtNum(Math.round(sums[c.key] * 100) / 100) + '</b>' : '<span class="muted">–</span>') + '</td>'; }).join('') +
        '<td class="colDivider"></td></tr></table></div>';
    } else {
      var metric = null;
      ATT_VIEW_METRICS.forEach(function (mt) { if (mt.key === view) metric = mt; });
      if (!metric) { el.innerHTML = ''; return; }
      var months = rows[0].monthly;
      var colSums = months.map(function () { return 0; });
      var colHas = months.map(function (m, i) { return rows.some(function (r) { return r.monthly[i].hasData; }); });
      var grand = 0;
      var anyData2 = rows.some(function (r) { return r.monthsWithData > 0; });
      html = '<div style="overflow-x:auto;"><table class="simple" id="aaTable"><tr><th class="aaName">ชื่อ</th>' +
        months.map(function (m) { return '<th style="text-align:center;">' + MONTHS_TH[m.month] + (multiYear ? '<br><small>' + m.year + '</small>' : '') + '</th>'; }).join('') +
        '<th class="colDivider" style="text-align:center;">รวม<br><small>(' + metric.unit + ')</small></th></tr>' +
        rows.map(function (r) {
          grand += r.totals[metric.key] || 0;
          return '<tr' + (r.status && r.status !== 'Active' ? ' class="inactiveRow"' : '') + '>' +
            '<td class="aaName">' + attNameCellHtml(r) + '</td>' +
            r.monthly.map(function (m, i) {
              if (m.hasData) colSums[i] += m[metric.key] || 0;
              return '<td style="text-align:center;">' + attCellHtml(m[metric.key], m.hasData) + '</td>';
            }).join('') +
            '<td class="colDivider totalCell" style="text-align:center;">' + attCellHtml(r.totals[metric.key], r.monthsWithData > 0) + '</td></tr>';
        }).join('') +
        '<tr class="aaFoot"><td class="aaName"><b>รวมทั้งหมด</b></td>' +
        colSums.map(function (v, i) { return '<td style="text-align:center;">' + (colHas[i] ? '<b>' + fmtNum(Math.round(v * 100) / 100) + '</b>' : '<span class="muted">–</span>') + '</td>'; }).join('') +
        '<td class="colDivider" style="text-align:center;">' + (anyData2 ? '<b>' + fmtNum(Math.round(grand * 100) / 100) + '</b>' : '<span class="muted">–</span>') + '</td></tr></table></div>';
    }

    // เดือนที่ "ไม่มีข้อมูลเลยสักคน" ในช่วงที่เลือก — เตือนให้เห็นชัด กันเข้าใจผิดว่าเป็นศูนย์ทั้งบริษัท
    var emptyMonths = rows[0].monthly.filter(function (m, i) { return !rows.some(function (r) { return r.monthly[i].hasData; }); });
    if (emptyMonths.length) {
      html += '<div class="muted" style="margin-top:10px;">เดือนที่ยังไม่มีข้อมูลเลย: ' + emptyMonths.map(function (m) { return MONTHS_TH[m.month] + (multiYear ? ' ' + m.year : ''); }).join(', ') + ' (ยังไม่ได้กรอกตารางรายเดือน)</div>';
    }
    el.innerHTML = html;

    // ตรึงคอลัมน์ชื่อไว้ซ้ายเวลาเลื่อนดูมือถือ (ใช้สีพื้นเดียวกับการ์ด เหมือนตาราง Attendance)
    var bg = '#fff';
    try {
      var cardEl = el.closest('.card');
      var cs = cardEl ? window.getComputedStyle(cardEl).backgroundColor : '';
      if (cs && cs !== 'transparent' && cs !== 'rgba(0, 0, 0, 0)') bg = cs;
    } catch (e) { /* ใช้สีขาวไปก่อน */ }
    Array.prototype.forEach.call(el.querySelectorAll('.aaName'), function (c) {
      c.style.position = 'sticky'; c.style.left = '0'; c.style.zIndex = '1'; c.style.background = bg; c.style.boxShadow = '1px 0 0 rgba(0,0,0,.08)';
    });
  }
}

/* ---- จัดการพนักงาน (กลุ่มเงินพิเศษ + สิทธิ์เงินพิเศษ) ---- */
// ไม่ใช่หน้า "เพิ่มพนักงานใหม่" — เพิ่มพนักงานใหม่ครั้งแรกยังต้องเพิ่มแถวในชีต Employees เอง (รหัส/ชื่อ/แผนก/ตำแหน่ง)
// หน้านี้ใช้แก้ "กลุ่มเงินพิเศษ" (วัดผลงานด้วยสูตรกลุ่มไหน) และ "สิทธิ์เงินพิเศษ" (ได้รับเงินก้อนนี้จริงหรือยัง เช่น
// พนักงานทดลองงาน) ของคนที่มีอยู่แล้วในระบบเท่านั้น — คนละคอลัมน์กับ Error/Attendance/Work Score เลย ไม่กระทบสูตรคำนวณ
// คะแนนใดๆ ทั้งสิ้น พอติ๊กเปิดสิทธิ์ เดือนที่เปิดดู (รวมเดือนก่อนหน้าถ้าย้อนไปดู) จะคำนวณเงินพิเศษใหม่สดทันที
function renderAdminEmployees() {
  if (!isSummaryUnlockedThisTab()) { renderSummaryPasswordGate(renderAdminEmployees, 'จัดการพนักงาน'); return; } // ล็อกด้วยรหัสเดียวกับหน้าอื่นที่มีรหัส
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
    // V3: เตือนคนที่ยังไม่มี/กรอกวันเริ่มงานผิด (เฉพาะ Active) — ถ้าไม่แก้ คะแนนรวมของเดือนที่มีหมวดอายุงาน (ส.ค. 2026 เป็นต้นไป) จะเป็น PENDING และไม่นับเข้าเงินพิเศษ
    var badHire = rows.filter(function (r) { return r.status === 'Active' && r.hireDateStatus && r.hireDateStatus !== 'ok'; });
    var hireWarnHtml = badHire.length
      ? '<div class="calloutBox amber" style="margin-bottom:12px;">⚠️ <b>' + badHire.length + ' คนยังไม่มี/กรอกวันเริ่มงานไม่ถูกต้อง</b>: ' + badHire.map(function (r) { return esc(r.nickname || r.fullName); }).join(', ') +
        ' — ไปพิมพ์ "วันเริ่มงาน" ในชีต Employees เป็นปี <b>ค.ศ.</b> แบบ 2023-03-15 (ห้ามปี พ.ศ.) ก่อน ไม่งั้นคะแนนรวมของเดือนที่มีหมวด "อายุงาน" ของคนเหล่านี้จะเป็น PENDING และยังไม่นับเข้าเงินพิเศษ</div>'
      : '';
    el.innerHTML = hireWarnHtml + '<div style="overflow-x:auto"><table class="simple"><tr><th>ชื่อ</th><th>แผนก</th><th>สถานะ</th><th>วันเริ่มงาน</th><th>กลุ่มเงินพิเศษ</th><th>มีสิทธิ์รับเงินพิเศษ</th><th>เริ่มมีสิทธิ์ตั้งแต่</th><th></th></tr>' +
      rows.map(function (r) {
        // "วันเริ่มงาน" แสดงผลอย่างเดียว (ดูอย่างเดียวในหน้านี้ ไว้ตรวจว่ากรอกครบหรือยัง) — ใช้คำนวณอายุงานในหน้า "สรุปรายปี"
        // แก้ค่าต้องพิมพ์ตรงในชีต Employees เอง ตามที่ยืนยันแล้ว (ไม่มีฟอร์มเว็บให้แก้จุดนี้โดยเจตนา)
        // V3: วันเริ่มงานใช้คิดคะแนนอายุงานรายเดือนด้วยแล้ว — Backend ส่ง hireDateStatus มาบอกว่าอ่านได้ไหม (ok/missing/unreadable/future)
        var hireDateCell;
        if (r.hireDateStatus === 'missing' || (!r.hireDateStatus && !r.hireDate)) hireDateCell = '<span style="color:#c0392b;font-weight:700;">ยังไม่กรอก</span>';
        else if (r.hireDateStatus === 'unreadable') hireDateCell = '<span style="color:#c0392b;font-weight:700;" title="อ่านเป็นวันที่ไม่ได้ หรือเป็นปีก่อน ค.ศ. 1990 (มักเกิดจากพิมพ์ปี 2 หลัก/ปี พ.ศ.) — พิมพ์เป็น ปี ค.ศ. 4 หลัก เช่น 2023-03-15">อ่านไม่ออก: ' + esc(fmtDate(r.hireDate)) + '</span>';
        else if (r.hireDateStatus === 'future') hireDateCell = '<span style="color:#c0392b;font-weight:700;" title="เป็นวันในอนาคต — มักพิมพ์ปี พ.ศ. แทน ค.ศ.">⚠ ' + esc(fmtDate(r.hireDate)) + ' (อนาคต?)</span>';
        else hireDateCell = esc(fmtDate(r.hireDate));
        return '<tr data-emp-id="' + esc(r.id) + '">' +
          '<td>' + esc(r.nickname) + ' (' + esc(r.fullName) + ')</td>' +
          '<td>' + esc(r.department) + '</td>' +
          '<td>' + (r.status === 'Active' ? '<span class="badge approved">Active</span>' : '<span class="badge rejected">Inactive</span>') + '</td>' +
          '<td>' + hireDateCell + '</td>' +
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
