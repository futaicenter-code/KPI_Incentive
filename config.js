/* =====================================================================
   FUTAI — ตั้งค่าเชื่อมต่อ Backend (Google Apps Script)
   ไฟล์นี้เป็นไฟล์เดียวที่ต้องแก้หลัง Deploy Apps Script เป็น Web App แล้ว
   ห้ามใส่ Key/Secret ใดๆ ในไฟล์นี้ — ใส่ได้แค่ URL ของ Apps Script (/exec)
   เพราะไฟล์นี้จะถูก push ขึ้น GitHub (Public) ให้ GitHub Pages เสิร์ฟออกไป
   ===================================================================== */

var CONFIG = {
  // แก้ URL นี้เป็น URL จริงที่ได้จากตอน Deploy > New deployment > Web app ของ Apps Script
  // ต้องลงท้ายด้วย /exec เสมอ (ไม่ใช่ /dev)
  API_URL: "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID_HERE/exec"
};
