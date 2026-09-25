/**
 * ============================================================================
 *  SISTEM INFORMASI MAGANG & E-LOGBOOK — SMA IT INSAN CENDIKIA
 *  Backend: Google Apps Script (code.gs)
 *  DB     : Google Sheets (5 tab + 3 tab pendukung)
 * ============================================================================
 *  CARA PAKAI:
 *  1. Jalankan fungsi `setupSpreadsheet()` SEKALI dari editor Apps Script
 *     (pilih fungsi ini di dropdown lalu klik Run) untuk membuat seluruh tab
 *     + header + akun admin pertama secara otomatis.
 *  2. Deploy > New deployment > Web app > Execute as: Me, Who has access: Anyone.
 *  3. Salin URL deployment ke `API_URL` pada js/app.js (frontend).
 *  4. Login pertama pakai akun admin default (lihat log setelah setupSpreadsheet
 *     dijalankan) lalu segera ganti password-nya.
 *
 *  CATATAN SKEMA (perluasan dari dokumen spesifikasi):
 *  - Tab `Users` kolom J = session_expires_at (Timestamp) — dibutuhkan untuk
 *    expiry session token (poin 7.A pada spesifikasi).
 *  - Tab tersembunyi tambahan: `_ProcessedRequests` (idempotency client_uuid),
 *    `_PasswordResets` (token reset password), `_ErrorLogs`, `_SchemaVersion`.
 * ============================================================================
 */

const SCHEMA_VERSION = 1;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 jam
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 menit
const PHOTO_FOLDER_ROOT_NAME = "Magang_Bukti_Kegiatan";

const SHEET_USERS = "Users";
const SHEET_PLACEMENTS = "Placements";
const SHEET_LOGBOOKS = "Daily_Logbooks";
const SHEET_WEEKLY = "Weekly_Summaries";
const SHEET_EVALUATIONS = "Evaluations";
const SHEET_PROCESSED = "_ProcessedRequests";
const SHEET_RESETS = "_PasswordResets";
const SHEET_ERRORLOG = "_ErrorLogs";
const SHEET_SCHEMA = "_SchemaVersion";

const HEADERS = {
  [SHEET_USERS]: [
    "id", "identity_number", "name", "email", "password_hash", "salt",
    "role", "phone_number", "session_token", "session_expires_at",
    "parent_consent", "consent_at"
  ],
  [SHEET_PLACEMENTS]: [
    "id", "student_id", "mentor_id", "guru_id", "company_name",
    "department", "start_date", "end_date", "status"
  ],
  [SHEET_LOGBOOKS]: [
    "id", "placement_id", "date", "work_mode", "category", "activity_desc",
    "obstacles", "photo_drive_url", "status", "is_locked", "mentor_notes",
    "updated_at", "client_uuid"
  ],
  [SHEET_WEEKLY]: [
    "id", "placement_id", "week_number", "summary_text", "best_moment",
    "next_target", "status", "guru_notes", "client_uuid"
  ],
  [SHEET_EVALUATIONS]: [
    "id", "placement_id", "mentor_score", "logbook_score", "report_score",
    "presentation_score", "final_score", "predicate"
  ],
  [SHEET_PROCESSED]: ["client_uuid", "processed_at"],
  [SHEET_RESETS]: ["token", "user_id", "expires_at", "used"],
  [SHEET_ERRORLOG]: ["timestamp", "function_name", "message", "action"],
  [SHEET_SCHEMA]: ["version", "updated_at"]
};

// ============================================================================
// SETUP (jalankan sekali secara manual)
// ============================================================================
function setupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(HEADERS).forEach((name) => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]);
      sh.setFrozenRows(1);
    }
  });

  const schemaSh = ss.getSheetByName(SHEET_SCHEMA);
  if (schemaSh.getLastRow() < 2) {
    schemaSh.appendRow([SCHEMA_VERSION, new Date()]);
  }

  // Buat akun admin pertama jika belum ada admin sama sekali
  const usersSh = ss.getSheetByName(SHEET_USERS);
  const rows = usersSh.getDataRange().getValues();
  const hasAdmin = rows.slice(1).some((r) => r[6] === "admin");
  if (!hasAdmin) {
    const salt = Utilities.getUuid();
    const defaultPassword = "Admin@" + Math.floor(1000 + Math.random() * 9000);
    const hash = hashPassword(defaultPassword, salt);
    usersSh.appendRow([
      "USR-001", "ADM-001", "Admin POKJA Magang", "admin@sekolah.sch.id",
      hash, salt, "admin", "", "", "", false, ""
    ]);
    Logger.log(
      "=== AKUN ADMIN PERTAMA DIBUAT ===\nEmail: admin@sekolah.sch.id\nPassword: %s\nSEGERA GANTI setelah login pertama.",
      defaultPassword
    );
  }

  // Buat folder root penyimpanan foto bukti kegiatan bila belum ada
  const existing = DriveApp.getFoldersByName(PHOTO_FOLDER_ROOT_NAME);
  if (!existing.hasNext()) {
    DriveApp.createFolder(PHOTO_FOLDER_ROOT_NAME);
  }

  // Trigger backup harian (idempotent: hapus trigger lama dengan nama sama dulu)
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (t.getHandlerFunction() === "dailyBackup") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("dailyBackup").timeBased().everyDays(1).atHour(2).create();

  Logger.log("Setup selesai. Total sheet: %s", Object.keys(HEADERS).length);
}

// ============================================================================
// ENTRY POINTS
// ============================================================================
function doGet(e) {
  try {
    const action = e.parameter.action;
    const auth = validateSessionToken(e.parameter.session_token);
    if (!auth.valid) {
      return responseJSON({ status: "unauthorized", message: "Sesi tidak valid, silakan login ulang." });
    }

    switch (action) {
      case "dashboard_summary":
        return handleDashboardSummary(e.parameter, auth);
      case "list_logbooks":
        return handleListLogbooks(e.parameter, auth);
      case "list_weekly":
        return handleListWeekly(e.parameter, auth);
      case "list_placements":
        return handleListPlacements(e.parameter, auth);
      case "list_evaluations":
        return handleListEvaluations(e.parameter, auth);
      case "list_users":
        return handleListUsers(e.parameter, auth);
      case "get_placement":
        return handleGetPlacement(e.parameter, auth);
      default:
        return responseJSON({ status: "error", message: "Aksi tidak dikenal: " + action });
    }
  } catch (err) {
    logError("doGet", err, e.parameter && e.parameter.action);
    return responseJSON({ status: "error", message: "Terjadi kesalahan server." });
  }
}

function doPost(e) {
  let action = "unknown";
  try {
    const data = JSON.parse(e.postData.contents);
    action = data.action;

    const PUBLIC_ACTIONS = ["login", "request_password_reset", "confirm_password_reset"];
    let auth = { valid: true };
    if (PUBLIC_ACTIONS.indexOf(action) === -1) {
      auth = validateSessionToken(data.session_token);
      if (!auth.valid) {
        return responseJSON({ status: "unauthorized", message: "Sesi tidak valid, silakan login ulang." });
      }
    }

    switch (action) {
      case "login":
        return handleLogin(data);
      case "logout":
        return handleLogout(data, auth);
      case "request_password_reset":
        return handleRequestPasswordReset(data);
      case "confirm_password_reset":
        return handleConfirmPasswordReset(data);
      case "save_logbook":
        return handleSaveLogbook(data, auth);
      case "submit_logbook":
        return handleSubmitLogbook(data, auth);
      case "delete_logbook":
        return handleDeleteLogbook(data, auth);
      case "validate_logbook":
        return handleValidateLogbook(data, auth);
      case "save_weekly":
        return handleSaveWeekly(data, auth);
      case "submit_weekly":
        return handleSubmitWeekly(data, auth);
      case "verify_weekly":
        return handleVerifyWeekly(data, auth);
      case "upload_photo":
        return handleUploadPhoto(data, auth);
      case "save_evaluation":
        return handleSaveEvaluation(data, auth);
      case "create_placement":
        return handleCreatePlacement(data, auth);
      case "update_placement":
        return handleUpdatePlacement(data, auth);
      case "create_user":
        return handleCreateUser(data, auth);
      case "bulk_import_students":
        return handleBulkImportStudents(data, auth);
      default:
        return responseJSON({ status: "error", message: "Aksi tidak valid: " + action });
    }
  } catch (err) {
    logError("doPost", err, action);
    return responseJSON({ status: "error", message: "Terjadi kesalahan server: " + err.toString() });
  }
}

// ============================================================================
// AUTH
// ============================================================================
function hashPassword(password, salt) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    password + "::" + salt
  );
  return digest.map((b) => ("0" + (b & 0xff).toString(16)).slice(-2)).join("");
}

function handleLogin(data) {
  const sh = sheet(SHEET_USERS);
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const emailOrId = (data.identifier || "").toLowerCase().trim();
    if (
      String(r[3]).toLowerCase() === emailOrId ||
      String(r[1]).toLowerCase() === emailOrId
    ) {
      const hash = hashPassword(data.password || "", r[5]);
      if (hash !== r[4]) {
        return responseJSON({ status: "error", message: "Identitas atau kata sandi salah." });
      }
      const token = Utilities.getUuid();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      sh.getRange(i + 1, 9).setValue(token);       // I: session_token
      sh.getRange(i + 1, 10).setValue(expiresAt);  // J: session_expires_at
      return responseJSON({
        status: "success",
        session_token: token,
        expires_at: expiresAt.toISOString(),
        user: { id: r[0], name: r[2], email: r[3], role: r[6], phone_number: r[7] }
      });
    }
  }
  return responseJSON({ status: "error", message: "Identitas atau kata sandi salah." });
}

function handleLogout(data, auth) {
  const sh = sheet(SHEET_USERS);
  const rowIdx = findRowIndexById(sh, 0, auth.userId);
  if (rowIdx > 0) {
    sh.getRange(rowIdx, 9).setValue("");
    sh.getRange(rowIdx, 10).setValue("");
  }
  return responseJSON({ status: "success" });
}

function validateSessionToken(token) {
  if (!token) return { valid: false };
  const sh = sheet(SHEET_USERS);
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][8] === token) {
      const expiresAt = rows[i][9];
      if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
        return { valid: false, reason: "expired" };
      }
      return { valid: true, userId: rows[i][0], role: rows[i][6], name: rows[i][2] };
    }
  }
  return { valid: false };
}

function handleRequestPasswordReset(data) {
  const usersSh = sheet(SHEET_USERS);
  const rows = usersSh.getDataRange().getValues();
  const row = rows.slice(1).find((r) => String(r[3]).toLowerCase() === String(data.email || "").toLowerCase());
  // Selalu balas sukses walau email tidak ditemukan (hindari user enumeration)
  if (!row) return responseJSON({ status: "success", message: "Jika email terdaftar, tautan reset telah dikirim." });

  const token = Utilities.getUuid();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  sheet(SHEET_RESETS).appendRow([token, row[0], expiresAt, false]);

  const resetUrl = (data.reset_base_url || "") + "?token=" + token;
  try {
    MailApp.sendEmail({
      to: row[3],
      subject: "Reset Password - Sistem Informasi Magang",
      body: "Halo " + row[2] + ",\n\nKlik tautan berikut untuk mengatur ulang password Anda (berlaku 15 menit):\n" + resetUrl + "\n\nJika Anda tidak meminta ini, abaikan email ini."
    });
  } catch (err) {
    logError("handleRequestPasswordReset", err, "request_password_reset");
  }
  return responseJSON({ status: "success", message: "Jika email terdaftar, tautan reset telah dikirim." });
}

function handleConfirmPasswordReset(data) {
  const resetSh = sheet(SHEET_RESETS);
  const rows = resetSh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === data.token) {
      if (rows[i][3] === true) {
        return responseJSON({ status: "error", message: "Tautan reset sudah pernah dipakai." });
      }
      if (new Date(rows[i][2]).getTime() < Date.now()) {
        return responseJSON({ status: "error", message: "Tautan reset sudah kedaluwarsa." });
      }
      const usersSh = sheet(SHEET_USERS);
      const uRow = findRowIndexById(usersSh, 0, rows[i][1]);
      if (uRow < 0) return responseJSON({ status: "error", message: "Akun tidak ditemukan." });

      const newSalt = Utilities.getUuid();
      const newHash = hashPassword(data.new_password || "", newSalt);
      usersSh.getRange(uRow, 5).setValue(newHash);
      usersSh.getRange(uRow, 6).setValue(newSalt);
      resetSh.getRange(i + 1, 4).setValue(true);
      return responseJSON({ status: "success", message: "Password berhasil diperbarui, silakan login." });
    }
  }
  return responseJSON({ status: "error", message: "Token reset tidak valid." });
}

// ============================================================================
// LOGBOOK HARIAN — CRUD + STATE MACHINE LOCKING
// ============================================================================
function handleSaveLogbook(data, auth) {
  if (data.client_uuid && isDuplicateRequest(data.client_uuid)) {
    return responseJSON({ status: "success", message: "Sudah diproses sebelumnya (idempotent)." });
  }
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const sh = sheet(SHEET_LOGBOOKS);

    if (data.id) {
      const rowIdx = findRowIndexById(sh, 0, data.id);
      if (rowIdx < 0) return responseJSON({ status: "error", message: "Data tidak ditemukan." });
      const row = sh.getRange(rowIdx, 1, 1, 13).getValues()[0];

      if (row[8] !== "Draft" && row[8] !== "Revision Needed") {
        return responseJSON({ status: "error", message: "Logbook terkunci, tidak bisa diedit." });
      }
      sh.getRange(rowIdx, 3).setValue(data.date || row[2]);
      sh.getRange(rowIdx, 4).setValue(data.work_mode || row[3]);
      sh.getRange(rowIdx, 5).setValue(data.category || row[4]);
      sh.getRange(rowIdx, 6).setValue(data.activity_desc || row[5]);
      sh.getRange(rowIdx, 7).setValue(data.obstacles || row[6]);
      if (data.photo_drive_url) sh.getRange(rowIdx, 8).setValue(data.photo_drive_url);
      sh.getRange(rowIdx, 9).setValue("Draft");
      sh.getRange(rowIdx, 10).setValue(false);
      sh.getRange(rowIdx, 12).setValue(new Date());
      if (data.client_uuid) markRequestProcessed(data.client_uuid);
      return responseJSON({ status: "success", message: "Draft logbook diperbarui.", id: row[0] });
    }

    const newId = nextId(sh, "LOG");
    sh.appendRow([
      newId, data.placement_id, data.date, data.work_mode, data.category,
      data.activity_desc, data.obstacles || "", data.photo_drive_url || "",
      "Draft", false, "", new Date(), data.client_uuid || ""
    ]);
    if (data.client_uuid) markRequestProcessed(data.client_uuid);
    return responseJSON({ status: "success", message: "Draft logbook dibuat.", id: newId });
  } catch (err) {
    logError("handleSaveLogbook", err, "save_logbook");
    return responseJSON({ status: "error", message: "Server sibuk, coba lagi." });
  } finally {
    lock.releaseLock();
  }
}

function handleSubmitLogbook(data, auth) {
  if (data.client_uuid && isDuplicateRequest(data.client_uuid)) {
    return responseJSON({ status: "success", message: "Sudah diproses sebelumnya (idempotent)." });
  }
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const sh = sheet(SHEET_LOGBOOKS);
    const rowIdx = findRowIndexById(sh, 0, data.id);
    if (rowIdx < 0) return responseJSON({ status: "error", message: "Data tidak ditemukan." });

    const status = sh.getRange(rowIdx, 9).getValue();
    const isLocked = sh.getRange(rowIdx, 10).getValue();
    if (isLocked === true || (status !== "Draft" && status !== "Revision Needed")) {
      return responseJSON({ status: "error", message: "Laporan sudah dikirim & terkunci!" });
    }

    sh.getRange(rowIdx, 9).setValue("Submitted");
    sh.getRange(rowIdx, 10).setValue(true);
    sh.getRange(rowIdx, 12).setValue(new Date());
    if (data.client_uuid) markRequestProcessed(data.client_uuid);
    notifyRoleAboutLogbook(rowIdx, "Submitted");
    return responseJSON({ status: "success", message: "Logbook berhasil dikirim dan dikunci." });
  } catch (err) {
    logError("handleSubmitLogbook", err, "submit_logbook");
    return responseJSON({ status: "error", message: "Server sibuk, coba lagi." });
  } finally {
    lock.releaseLock();
  }
}

function handleDeleteLogbook(data, auth) {
  const sh = sheet(SHEET_LOGBOOKS);
  const rowIdx = findRowIndexById(sh, 0, data.id);
  if (rowIdx < 0) return responseJSON({ status: "error", message: "Data tidak ditemukan." });
  const status = sh.getRange(rowIdx, 9).getValue();
  if (status !== "Draft") {
    return responseJSON({ status: "error", message: "Hanya draft yang boleh dihapus." });
  }
  sh.deleteRow(rowIdx);
  return responseJSON({ status: "success", message: "Draft dihapus." });
}

// Mentor/Guru: approve atau minta revisi
function handleValidateLogbook(data, auth) {
  if (auth.role !== "mentor" && auth.role !== "guru" && auth.role !== "admin") {
    return responseJSON({ status: "unauthorized", message: "Hanya mentor/guru yang bisa memvalidasi." });
  }
  const newStatus = data.decision === "approve" ? "Approved" : "Revision Needed";
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const sh = sheet(SHEET_LOGBOOKS);
    const rowIdx = findRowIndexById(sh, 0, data.id);
    if (rowIdx < 0) return responseJSON({ status: "error", message: "Data tidak ditemukan." });

    sh.getRange(rowIdx, 9).setValue(newStatus);
    sh.getRange(rowIdx, 10).setValue(newStatus === "Approved"); // lock permanen jika approved
    sh.getRange(rowIdx, 11).setValue(data.mentor_notes || "");
    sh.getRange(rowIdx, 12).setValue(new Date());
    notifyRoleAboutLogbook(rowIdx, newStatus);
    return responseJSON({ status: "success", message: "Status logbook diperbarui menjadi " + newStatus + "." });
  } catch (err) {
    logError("handleValidateLogbook", err, "validate_logbook");
    return responseJSON({ status: "error", message: "Server sibuk, coba lagi." });
  } finally {
    lock.releaseLock();
  }
}

function handleListLogbooks(params, auth) {
  const sh = sheet(SHEET_LOGBOOKS);
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  let placementIds = resolvePlacementIdsForRole(auth, params);

  const result = rows.slice(1)
    .filter((r) => placementIds === null || placementIds.indexOf(r[1]) !== -1)
    .filter((r) => !params.status || r[8] === params.status)
    .map((r) => rowToObject(headers, r));
  return responseJSON({ status: "success", data: result });
}

// ============================================================================
// JURNAL MINGGUAN
// ============================================================================
function handleSaveWeekly(data, auth) {
  if (data.client_uuid && isDuplicateRequest(data.client_uuid)) {
    return responseJSON({ status: "success", message: "Sudah diproses sebelumnya (idempotent)." });
  }
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const sh = sheet(SHEET_WEEKLY);
    if (data.id) {
      const rowIdx = findRowIndexById(sh, 0, data.id);
      if (rowIdx < 0) return responseJSON({ status: "error", message: "Data tidak ditemukan." });
      const status = sh.getRange(rowIdx, 7).getValue();
      if (status !== "Draft") return responseJSON({ status: "error", message: "Jurnal sudah terkirim, tidak bisa diedit." });
      sh.getRange(rowIdx, 4).setValue(data.summary_text || "");
      sh.getRange(rowIdx, 5).setValue(data.best_moment || "");
      sh.getRange(rowIdx, 6).setValue(data.next_target || "");
      if (data.client_uuid) markRequestProcessed(data.client_uuid);
      return responseJSON({ status: "success", id: data.id });
    }
    const newId = nextId(sh, "WKL");
    sh.appendRow([
      newId, data.placement_id, data.week_number, data.summary_text || "",
      data.best_moment || "", data.next_target || "", "Draft", "", data.client_uuid || ""
    ]);
    if (data.client_uuid) markRequestProcessed(data.client_uuid);
    return responseJSON({ status: "success", id: newId });
  } catch (err) {
    logError("handleSaveWeekly", err, "save_weekly");
    return responseJSON({ status: "error", message: "Server sibuk, coba lagi." });
  } finally {
    lock.releaseLock();
  }
}

function handleSubmitWeekly(data, auth) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const sh = sheet(SHEET_WEEKLY);
    const rowIdx = findRowIndexById(sh, 0, data.id);
    if (rowIdx < 0) return responseJSON({ status: "error", message: "Data tidak ditemukan." });
    sh.getRange(rowIdx, 7).setValue("Submitted");
    return responseJSON({ status: "success", message: "Jurnal mingguan dikirim." });
  } finally {
    lock.releaseLock();
  }
}

function handleVerifyWeekly(data, auth) {
  if (auth.role !== "guru" && auth.role !== "admin") {
    return responseJSON({ status: "unauthorized", message: "Hanya guru pendamping yang bisa verifikasi." });
  }
  const sh = sheet(SHEET_WEEKLY);
  const rowIdx = findRowIndexById(sh, 0, data.id);
  if (rowIdx < 0) return responseJSON({ status: "error", message: "Data tidak ditemukan." });
  sh.getRange(rowIdx, 7).setValue("Verified Academic");
  sh.getRange(rowIdx, 8).setValue(data.guru_notes || "");
  return responseJSON({ status: "success", message: "Jurnal terverifikasi." });
}

function handleListWeekly(params, auth) {
  const sh = sheet(SHEET_WEEKLY);
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  let placementIds = resolvePlacementIdsForRole(auth, params);
  const result = rows.slice(1)
    .filter((r) => placementIds === null || placementIds.indexOf(r[1]) !== -1)
    .map((r) => rowToObject(headers, r));
  return responseJSON({ status: "success", data: result });
}

// ============================================================================
// EVALUASI & NILAI AKHIR — NA_M = 0.60*mentor_score + 0.40*avg(logbook,report,presentation)
// ============================================================================
function handleSaveEvaluation(data, auth) {
  if (["admin", "guru", "mentor"].indexOf(auth.role) === -1) {
    return responseJSON({ status: "unauthorized", message: "Tidak berwenang mengisi nilai." });
  }
  const sh = sheet(SHEET_EVALUATIONS);
  const mentorScore = Number(data.mentor_score) || 0;
  const logbookScore = Number(data.logbook_score) || 0;
  const reportScore = Number(data.report_score) || 0;
  const presentationScore = Number(data.presentation_score) || 0;
  const nlS = (logbookScore + reportScore + presentationScore) / 3;
  const finalScore = Math.round((0.6 * mentorScore + 0.4 * nlS) * 100) / 100;
  const predicate = finalScore >= 90 ? "Sangat Baik (A)" : finalScore >= 75 ? "Baik (B)" : "Cukup (C)";

  let rowIdx = -1;
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][1] === data.placement_id) { rowIdx = i + 1; break; }
  }
  if (rowIdx > 0) {
    sh.getRange(rowIdx, 3, 1, 6).setValues([[mentorScore, logbookScore, reportScore, presentationScore, finalScore, predicate]]);
  } else {
    const newId = nextId(sh, "EVL");
    sh.appendRow([newId, data.placement_id, mentorScore, logbookScore, reportScore, presentationScore, finalScore, predicate]);
  }
  return responseJSON({ status: "success", final_score: finalScore, predicate: predicate });
}

function handleListEvaluations(params, auth) {
  const sh = sheet(SHEET_EVALUATIONS);
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  let placementIds = resolvePlacementIdsForRole(auth, params);
  const result = rows.slice(1)
    .filter((r) => placementIds === null || placementIds.indexOf(r[1]) !== -1)
    .map((r) => rowToObject(headers, r));
  return responseJSON({ status: "success", data: result });
}

// ============================================================================
// PENEMPATAN (PLACEMENTS) — admin
// ============================================================================
function handleCreatePlacement(data, auth) {
  requireRole(auth, ["admin"]);
  const sh = sheet(SHEET_PLACEMENTS);
  const newId = nextId(sh, "PLC");
  sh.appendRow([
    newId, data.student_id, data.mentor_id, data.guru_id, data.company_name,
    data.department, data.start_date, data.end_date, "active"
  ]);
  return responseJSON({ status: "success", id: newId });
}

function handleUpdatePlacement(data, auth) {
  requireRole(auth, ["admin"]);
  const sh = sheet(SHEET_PLACEMENTS);
  const rowIdx = findRowIndexById(sh, 0, data.id);
  if (rowIdx < 0) return responseJSON({ status: "error", message: "Penempatan tidak ditemukan." });
  const fields = ["id", "student_id", "mentor_id", "guru_id", "company_name", "department", "start_date", "end_date", "status"];
  fields.forEach((f, idx) => {
    if (data[f] !== undefined && idx > 0) sh.getRange(rowIdx, idx + 1).setValue(data[f]);
  });
  return responseJSON({ status: "success" });
}

function handleGetPlacement(params, auth) {
  const sh = sheet(SHEET_PLACEMENTS);
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  let target;
  if (auth.role === "siswa") {
    target = rows.slice(1).find((r) => r[1] === auth.userId);
  } else if (params.placement_id) {
    target = rows.slice(1).find((r) => r[0] === params.placement_id);
  }
  if (!target) return responseJSON({ status: "error", message: "Penempatan tidak ditemukan." });
  return responseJSON({ status: "success", data: rowToObject(headers, target) });
}

function handleListPlacements(params, auth) {
  const sh = sheet(SHEET_PLACEMENTS);
  const rows = sh.getDataRange().getValues();
  const headers = rows[0];
  let list = rows.slice(1);
  if (auth.role === "siswa") list = list.filter((r) => r[1] === auth.userId);
  else if (auth.role === "mentor") list = list.filter((r) => r[2] === auth.userId);
  else if (auth.role === "guru") list = list.filter((r) => r[3] === auth.userId);
  return responseJSON({ status: "success", data: list.map((r) => rowToObject(headers, r)) });
}

// ============================================================================
// USERS — admin: create + bulk import (proyeksi field aman ke client)
// ============================================================================
function handleCreateUser(data, auth) {
  requireRole(auth, ["admin"]);
  const sh = sheet(SHEET_USERS);
  const newId = nextId(sh, "USR");
  const salt = Utilities.getUuid();
  const tempPassword = data.password || Utilities.getUuid().slice(0, 8);
  const hash = hashPassword(tempPassword, salt);
  sh.appendRow([
    newId, data.identity_number, data.name, data.email, hash, salt,
    data.role, data.phone_number || "", "", "",
    !!data.parent_consent, data.parent_consent ? new Date() : ""
  ]);
  return responseJSON({ status: "success", id: newId, temp_password: tempPassword });
}

function handleBulkImportStudents(data, auth) {
  requireRole(auth, ["admin"]);
  const usersSh = sheet(SHEET_USERS);
  const placementsSh = sheet(SHEET_PLACEMENTS);
  const rowsIn = data.students || []; // [{identity_number,name,email,phone_number,company_name,department,mentor_id,guru_id,start_date,end_date}]
  const created = [];
  rowsIn.forEach((s) => {
    const newUserId = nextId(usersSh, "USR");
    const salt = Utilities.getUuid();
    const tempPassword = Utilities.getUuid().slice(0, 8);
    const hash = hashPassword(tempPassword, salt);
    usersSh.appendRow([
      newUserId, s.identity_number, s.name, s.email, hash, salt,
      "siswa", s.phone_number || "", "", "", false, ""
    ]);
    const newPlacementId = nextId(placementsSh, "PLC");
    placementsSh.appendRow([
      newPlacementId, newUserId, s.mentor_id || "", s.guru_id || "",
      s.company_name || "", s.department || "", s.start_date || "", s.end_date || "", "active"
    ]);
    created.push({ user_id: newUserId, placement_id: newPlacementId, name: s.name, temp_password: tempPassword });
  });
  return responseJSON({ status: "success", created: created });
}

function handleListUsers(params, auth) {
  requireRole(auth, ["admin", "guru", "mentor"]);
  const sh = sheet(SHEET_USERS);
  const rows = sh.getDataRange().getValues();
  let list = rows.slice(1);
  if (params.role) list = list.filter((r) => r[6] === params.role);
  return responseJSON({ status: "success", data: list.map(projectUserPublicFields) });
}

// Proyeksi kolom aman: JANGAN PERNAH kirim password_hash/salt ke client
function projectUserPublicFields(row) {
  return { id: row[0], identity_number: row[1], name: row[2], email: row[3], role: row[6], phone_number: row[7] };
}

// ============================================================================
// UPLOAD FOTO (kompresi dilakukan di sisi klien sebelum dikirim)
// ============================================================================
function handleUploadPhoto(data, auth) {
  try {
    const folder = getOrCreatePlacementFolder(data.placement_id);
    const blob = Utilities.newBlob(
      Utilities.base64Decode(data.photo_base64),
      data.mime_type || "image/jpeg",
      data.file_name || "bukti_" + new Date().getTime() + ".jpg"
    );
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return responseJSON({ status: "success", photo_drive_url: file.getUrl() });
  } catch (err) {
    logError("handleUploadPhoto", err, "upload_photo");
    return responseJSON({ status: "error", message: "Gagal unggah foto: " + err.toString() });
  }
}

function getOrCreatePlacementFolder(placementId) {
  const rootIter = DriveApp.getFoldersByName(PHOTO_FOLDER_ROOT_NAME);
  const root = rootIter.hasNext() ? rootIter.next() : DriveApp.createFolder(PHOTO_FOLDER_ROOT_NAME);
  const subIter = root.getFoldersByName(placementId);
  return subIter.hasNext() ? subIter.next() : root.createFolder(placementId);
}

// ============================================================================
// DASHBOARD
// ============================================================================
function handleDashboardSummary(params, auth) {
  const placementIds = resolvePlacementIdsForRole(auth, params);
  const logbookRows = sheet(SHEET_LOGBOOKS).getDataRange().getValues().slice(1);
  const weeklyRows = sheet(SHEET_WEEKLY).getDataRange().getValues().slice(1);

  const myLogs = logbookRows.filter((r) => placementIds === null || placementIds.indexOf(r[1]) !== -1);
  const summary = {
    total_logbook: myLogs.length,
    draft: myLogs.filter((r) => r[8] === "Draft").length,
    submitted: myLogs.filter((r) => r[8] === "Submitted").length,
    approved: myLogs.filter((r) => r[8] === "Approved").length,
    revision_needed: myLogs.filter((r) => r[8] === "Revision Needed").length,
    weekly_total: weeklyRows.filter((r) => placementIds === null || placementIds.indexOf(r[1]) !== -1).length
  };
  return responseJSON({ status: "success", data: summary });
}

// ============================================================================
// HELPER — akses generik sheet, role scoping, idempotency, logging
// ============================================================================
function sheet(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function rowToObject(headers, row) {
  const obj = {};
  headers.forEach((h, i) => (obj[h] = row[i]));
  return obj;
}

function findRowIndexById(sh, colIndex, id) {
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][colIndex] === id) return i + 1; // 1-based, sudah +header
  }
  return -1;
}

function nextId(sh, prefix) {
  const lastRow = sh.getLastRow();
  const num = lastRow < 1 ? 1 : lastRow; // header di row1, jadi lastRow = jumlah data + 1
  return prefix + "-" + String(num).padStart(3, "0") + "-" + String(Math.floor(Math.random() * 90) + 10);
}

function requireRole(auth, roles) {
  if (roles.indexOf(auth.role) === -1) {
    throw new Error("unauthorized: role " + auth.role + " tidak diizinkan.");
  }
}

// Siswa hanya lihat placement miliknya; mentor/guru lihat placement bimbingannya;
// admin lihat semua (return null = tanpa filter).
function resolvePlacementIdsForRole(auth, params) {
  if (auth.role === "admin") {
    return params.placement_id ? [params.placement_id] : null;
  }
  const placementsSh = sheet(SHEET_PLACEMENTS);
  const rows = placementsSh.getDataRange().getValues().slice(1);
  if (auth.role === "siswa") return rows.filter((r) => r[1] === auth.userId).map((r) => r[0]);
  if (auth.role === "mentor") return rows.filter((r) => r[2] === auth.userId).map((r) => r[0]);
  if (auth.role === "guru") return rows.filter((r) => r[3] === auth.userId).map((r) => r[0]);
  return [];
}

function isDuplicateRequest(clientUuid) {
  const sh = sheet(SHEET_PROCESSED);
  const rows = sh.getDataRange().getValues();
  return rows.slice(1).some((r) => r[0] === clientUuid);
}

function markRequestProcessed(clientUuid) {
  sheet(SHEET_PROCESSED).appendRow([clientUuid, new Date()]);
}

function logError(functionName, err, action) {
  try {
    sheet(SHEET_ERRORLOG).appendRow([new Date(), functionName, err.toString(), action || ""]);
  } catch (e) {
    // sheet log sendiri gagal, sudah tidak bisa apa-apa lagi selain diam
  }
}

// Placeholder notifikasi: kirim email ke siswa/mentor/guru terkait saat status berubah.
// Diaktifkan hanya jika phone_number/email tersedia dan MailApp kuota masih ada.
function notifyRoleAboutLogbook(rowIdx, newStatus) {
  try {
    const logRow = sheet(SHEET_LOGBOOKS).getRange(rowIdx, 1, 1, 13).getValues()[0];
    const placementRow = sheet(SHEET_PLACEMENTS).getDataRange().getValues()
      .find((r) => r[0] === logRow[1]);
    if (!placementRow) return;
    const usersRows = sheet(SHEET_USERS).getDataRange().getValues();

    let targetUserId;
    let subject, body;
    if (newStatus === "Submitted") {
      targetUserId = placementRow[2]; // mentor
      subject = "Logbook baru menunggu review";
      body = "Ada logbook baru berstatus Submitted yang menunggu review Anda.";
    } else {
      targetUserId = placementRow[1]; // siswa
      subject = "Status logbook Anda: " + newStatus;
      body = "Logbook tanggal " + logRow[2] + " kini berstatus " + newStatus + ".";
    }
    const targetUser = usersRows.find((r) => r[0] === targetUserId);
    if (targetUser && targetUser[3]) {
      MailApp.sendEmail({ to: targetUser[3], subject: subject, body: body });
    }
  } catch (err) {
    logError("notifyRoleAboutLogbook", err, "notify");
  }
}

// ============================================================================
// BACKUP HARIAN (time-driven trigger, dibuat otomatis oleh setupSpreadsheet)
// ============================================================================
function dailyBackup() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const file = DriveApp.getFileById(ss.getId());
    const rootIter = DriveApp.getFoldersByName("Backup");
    const backupFolder = rootIter.hasNext() ? rootIter.next() : DriveApp.getRootFolder().createFolder("Backup");
    const dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
    file.makeCopy("Backup_MagangIC_" + dateStr, backupFolder);

    // Retensi 30 hari: hapus backup lebih lama dari itu
    const files = backupFolder.getFiles();
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    while (files.hasNext()) {
      const f = files.next();
      if (f.getDateCreated().getTime() < cutoff) f.setTrashed(true);
    }
  } catch (err) {
    logError("dailyBackup", err, "trigger");
  }
}

function responseJSON(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
