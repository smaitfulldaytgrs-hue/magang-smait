/**
 * app.js — logic utama Sistem Informasi Magang (frontend PWA).
 * Ganti API_URL di bawah dengan URL deployment Web App Google Apps Script Anda.
 */
const API_URL = "https://script.google.com/macros/s/AKfycbwZs-n_57n6jkug248_sls9GlzLcPHhOjdEFkx8BVXxSOFQONYHwrWOLvBCN2E2OlRS/exec";

const STATUS_META = {
  Draft: { badge: "badge-draft", icon: "✎" },
  Submitted: { badge: "badge-submitted", icon: "⏳" },
  Approved: { badge: "badge-approved", icon: "✓" },
  "Revision Needed": { badge: "badge-revision", icon: "⚠" },
  "Verified Academic": { badge: "badge-approved", icon: "✓" }
};

function appState() {
  return {
    // ---------- state dasar ----------
    session: JSON.parse(localStorage.getItem("magang_session") || "null"),
    view: "dashboard",
    online: navigator.onLine,
    toasts: [],
    loading: false,
    syncing: false,

    // ---------- form login ----------
    loginForm: { identifier: "", password: "" },
    loginError: "",
    loginLoading: false,

    // ---------- data cache ----------
    placement: null,
    dashboard: {},
    logbooks: [],
    weeklyList: [],
    evaluations: [],
    users: [],
    placements: [],
    reviewQueue: [],

    // ---------- form logbook ----------
    logbookForm: this_defaultLogbookForm(),
    logbookFormError: "",
    logbookFormLoading: false,
    photoPreview: null,
    photoBase64: null,

    // ---------- form weekly ----------
    weeklyForm: { id: null, week_number: 1, summary_text: "", best_moment: "", next_target: "" },
    weeklyFormLoading: false,

    // ---------- admin forms ----------
    bulkImportRows: [],
    bulkImportRaw: "",
    newUserForm: { identity_number: "", name: "", email: "", role: "siswa", phone_number: "" },
    newPlacementForm: { student_id: "", mentor_id: "", guru_id: "", company_name: "", department: "", start_date: "", end_date: "" },
    evaluationForm: { placement_id: "", mentor_score: "", logbook_score: "", report_score: "", presentation_score: "" },

    // ---------- kredensial sementara (hanya di memori, tidak disimpan) ----------
    credentials: [],
    pwForm: { old_password: "", new_password: "", confirm: "" },
    pwLoading: false,

    // ==========================================================
    init() {
      window.addEventListener("online", () => { this.online = true; this.syncQueue(); });
      window.addEventListener("offline", () => { this.online = false; });
      // Kata sandi sementara tidak bisa ditampilkan lagi: cegah tertutup tak sengaja.
      window.addEventListener("beforeunload", (e) => {
        if (this.credentials.length) { e.preventDefault(); e.returnValue = ""; }
      });
      navigator.serviceWorker && navigator.serviceWorker.addEventListener("message", (evt) => {
        if (evt.data && evt.data.type === "SYNC_QUEUE") this.syncQueue();
      });
      if (this.session) {
        this.loadDashboard();
        this.syncQueue();
      }
    },

    navItemsForRole() {
      const role = this.session ? this.session.user.role : null;
      if (role === "siswa") {
        return [
          { key: "dashboard", label: "Beranda", icon: "🏠" },
          { key: "logbook", label: "Logbook", icon: "📝" },
          { key: "weekly", label: "Jurnal", icon: "📅" },
          { key: "profile", label: "Profil", icon: "👤" }
        ];
      }
      if (role === "mentor") {
        return [
          { key: "dashboard", label: "Beranda", icon: "🏠" },
          { key: "review_queue", label: "Review", icon: "📋" },
          { key: "profile", label: "Profil", icon: "👤" }
        ];
      }
      if (role === "guru") {
        return [
          { key: "dashboard", label: "Beranda", icon: "🏠" },
          { key: "review_queue", label: "Review", icon: "📋" },
          { key: "weekly", label: "Jurnal", icon: "📅" },
          { key: "profile", label: "Profil", icon: "👤" }
        ];
      }
      if (role === "admin") {
        return [
          { key: "dashboard", label: "Beranda", icon: "🏠" },
          { key: "admin_users", label: "Pengguna", icon: "👥" },
          { key: "admin_placements", label: "Penempatan", icon: "🏢" },
          { key: "admin_evaluations", label: "Nilai", icon: "🏆" }
        ];
      }
      return [];
    },

    goto(view) {
      this.view = view;
      if (view === "logbook") this.loadLogbooks();
      if (view === "weekly") this.loadWeekly();
      if (view === "review_queue") this.loadReviewQueue();
      if (view === "profile") this.loadProfile();
      if (view === "admin_users") this.loadUsers();
      if (view === "admin_placements") this.loadPlacements();
      if (view === "admin_evaluations") this.loadPlacements();
    },

    // ================= TOAST =================
    toast(message, type = "info", ms = 4000) {
      const id = Date.now() + Math.random();
      this.toasts.push({ id, message, type });
      setTimeout(() => { this.toasts = this.toasts.filter((t) => t.id !== id); }, ms);
    },

    // ================= API LAYER =================
    async apiGet(action, params = {}) {
      const qs = new URLSearchParams({ action, session_token: this.session ? this.session.session_token : "", ...params });
      const res = await fetch(API_URL + "?" + qs.toString());
      const json = await res.json();
      this.handleAuthErrors(json);
      return json;
    },

    async apiPost(action, payload = {}, { queueOffline = false, quiet = false } = {}) {
      const body = { action, session_token: this.session ? this.session.session_token : "", ...payload };
      let json;
      try {
        const res = await fetch(API_URL, { method: "POST", body: JSON.stringify(body) });
        json = await res.json();
        // sw.js membalas {status:"offline"} (bukan melempar error) saat jaringan mati.
        // Perlakukan sama dengan gagal jaringan supaya masuk antrean.
        if (json && json.status === "offline") throw new Error("offline");
      } catch (err) {
        if (queueOffline) {
          const client_uuid = payload.client_uuid || uuidv4();
          await queueAdd({
            client_uuid,
            action,
            user_id: this.session ? this.session.user.id : null, // cegah kirim ke akun lain di HP yang sama
            payload: { ...body, client_uuid },
            savedAt: Date.now(),
            attempts: 0
          });
          this.toast("Tersimpan di HP, akan terkirim otomatis saat online.", "warn");
          return { status: "offline_queued", client_uuid };
        }
        if (!quiet) this.toast("Gagal terhubung ke server.", "error");
        return { status: "error", message: "network" };
      }
      this.handleAuthErrors(json);
      return json;
    },

    handleAuthErrors(json) {
      if (json && json.status === "unauthorized") {
        this.toast(json.message || "Sesi berakhir, silakan login ulang.", "error");
        this.logout(true);
      }
    },

    async syncQueue() {
      // Tanpa sesi tidak ada token valid: antrean dibiarkan, dikirim setelah login.
      if (this.syncing || !this.session) return;
      this.syncing = true;
      const MAX_ATTEMPTS = 5;
      const TRANSIENT = /sibuk|kesalahan server/i;
      let sent = 0;
      let failed = 0;
      try {
        const items = (await queueAll())
          .filter((it) => !it.failed)
          .filter((it) => !it.user_id || it.user_id === this.session.user.id)
          .sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0)); // urut waktu, bukan urut uuid

        for (const item of items) {
          // Token dari saat antre sudah basi setelah login ulang: pakai token sesi sekarang.
          const payload = { ...item.payload, session_token: this.session.session_token };

          let res;
          try {
            res = await fetch(API_URL, { method: "POST", body: JSON.stringify(payload) });
          } catch (err) {
            break; // masih offline, coba lagi nanti
          }

          let json;
          try {
            json = await res.json();
          } catch (err) {
            json = { status: "error", message: "Respons server tidak valid." };
          }

          if (json.status === "offline") break; // balasan sw.js saat jaringan mati

          if (json.status === "success") {
            await queueRemove(item.client_uuid);
            sent++;
            continue;
          }

          if (json.status === "unauthorized") {
            // Jangan hapus item. Setelah login ulang antrean dikirim lagi.
            this.handleAuthErrors(json);
            break;
          }

          // status "error"
          const attempts = (item.attempts || 0) + 1;
          const transient = TRANSIENT.test(json.message || "");
          if (!transient || attempts >= MAX_ATTEMPTS) {
            // Ditolak server (mis. "Logbook terkunci") atau gagal berulang:
            // tandai gagal, simpan agar tidak hilang, JANGAN sumbat item lain.
            await queueAdd({ ...item, attempts, failed: true, error: json.message || "error" });
            failed++;
            continue;
          }
          await queueAdd({ ...item, attempts });
          break; // gangguan sementara, coba lagi nanti
        }
      } finally {
        this.syncing = false;
      }

      if (sent) {
        this.toast(sent + " data offline berhasil dikirim.", "success");
        this.refreshCurrentView();
      }
      if (failed) {
        this.toast(failed + " data offline ditolak server dan tidak terkirim. Cek ulang lalu isi kembali.", "error", 8000);
      }
    },

    refreshCurrentView() {
      if (this.view === "logbook") this.loadLogbooks();
      else if (this.view === "weekly") this.loadWeekly();
      else if (this.view === "dashboard") this.loadDashboard();
      else if (this.view === "review_queue") this.loadReviewQueue();
    },

    // ================= AUTH =================
    async login() {
      this.loginError = "";
      this.loginLoading = true;
      try {
        const res = await fetch(API_URL, {
          method: "POST",
          body: JSON.stringify({ action: "login", identifier: this.loginForm.identifier, password: this.loginForm.password })
        });
        const json = await res.json();
        if (json.status === "success") {
          this.session = json;
          localStorage.setItem("magang_session", JSON.stringify(json));
          this.toast("Selamat datang, " + json.user.name, "success");
          this.loadDashboard();
          this.syncQueue();
        } else {
          this.loginError = json.message || "Login gagal.";
        }
      } catch (err) {
        this.loginError = "Tidak bisa terhubung ke server. Cek koneksi internet.";
      } finally {
        this.loginLoading = false;
      }
    },

    async logout(silent) {
      if (!silent) await this.apiPost("logout", {}, { quiet: true });
      this.session = null;
      this.credentials = [];
      localStorage.removeItem("magang_session");
      this.view = "dashboard";
    },

    // ================= DASHBOARD =================
    async loadDashboard() {
      const json = await this.apiGet("dashboard_summary");
      if (json.status === "success") this.dashboard = json.data;
      if (this.session.user.role === "siswa") this.loadProfile();
    },

    async loadProfile() {
      const json = await this.apiGet("get_placement");
      if (json.status === "success") this.placement = json.data;
      const ev = await this.apiGet("list_evaluations");
      if (ev.status === "success") this.evaluations = ev.data;
    },

    // ================= LOGBOOK =================
    async loadLogbooks() {
      const json = await this.apiGet("list_logbooks");
      if (json.status === "success") {
        this.logbooks = json.data.sort((a, b) => (a.date < b.date ? 1 : -1));
      }
    },

    openNewLogbook() {
      this.logbookForm = this_defaultLogbookForm();
      this.photoPreview = null;
      this.photoBase64 = null;
      this.logbookFormError = "";
      this.view = "logbook_form";
    },

    editLogbook(entry) {
      if (entry.is_locked === true) {
        this.toast("Logbook ini terkunci dan tidak bisa diedit.", "warn");
        return;
      }
      this.logbookForm = { ...entry };
      this.photoPreview = entry.photo_drive_url || null;
      this.photoBase64 = null;
      this.logbookFormError = "";
      this.view = "logbook_form";
    },

    async onPhotoSelected(fileInput) {
      const file = fileInput.files[0];
      if (!file) return;
      this.toast("Mengompres foto...", "info", 1500);
      const compressed = await compressImageToBase64(file, 1280, 0.7, 300);
      this.photoBase64 = compressed.base64;
      this.photoPreview = compressed.dataUrl;
    },

    async saveLogbookDraft() {
      if (!this.logbookForm.date || !this.logbookForm.activity_desc) {
        this.logbookFormError = "Tanggal dan deskripsi kegiatan wajib diisi.";
        return;
      }
      this.logbookFormLoading = true;
      try {
        let photoUrl = this.logbookForm.photo_drive_url || "";
        let photoSkipped = false;
        if (this.photoBase64) {
          const up = this.online
            ? await this.apiPost("upload_photo", {
                placement_id: this.placement ? this.placement.id : this.logbookForm.placement_id,
                photo_base64: this.photoBase64,
                mime_type: "image/jpeg",
                file_name: "bukti_" + this.logbookForm.date + ".jpg"
              }, { quiet: true })
            : null;
          if (up && up.status === "success") photoUrl = up.photo_drive_url;
          else photoSkipped = true; // offline / upload gagal: beri tahu, jangan diam
        }
        const payload = {
          id: this.logbookForm.id || null,
          placement_id: this.placement ? this.placement.id : this.logbookForm.placement_id,
          date: this.logbookForm.date,
          work_mode: this.logbookForm.work_mode,
          category: this.logbookForm.category,
          activity_desc: this.logbookForm.activity_desc,
          obstacles: this.logbookForm.obstacles,
          photo_drive_url: photoUrl,
          client_uuid: uuidv4()
        };
        const json = await this.apiPost("save_logbook", payload, { queueOffline: true });
        if (json.status === "success" || json.status === "offline_queued") {
          this.toast(json.status === "success" ? "Draft tersimpan." : "Draft disimpan lokal (offline).", "success");
          if (photoSkipped) {
            this.toast("Foto belum terunggah. Buka draft ini saat online lalu pilih foto lagi.", "warn", 8000);
          }
          this.view = "logbook";
          this.loadLogbooks();
        } else {
          this.logbookFormError = json.message || "Gagal menyimpan.";
        }
      } finally {
        this.logbookFormLoading = false;
      }
    },

    async submitLogbook(entry) {
      if (!confirm("Kirim logbook ini? Setelah dikirim, data tidak bisa diedit lagi kecuali diminta revisi.")) return;
      const json = await this.apiPost("submit_logbook", { id: entry.id, client_uuid: uuidv4() }, { queueOffline: true });
      if (json.status === "success" || json.status === "offline_queued") {
        this.toast("Logbook dikirim.", "success");
        this.loadLogbooks();
      } else {
        this.toast(json.message || "Gagal mengirim.", "error");
      }
    },

    async deleteLogbook(entry) {
      if (!confirm("Hapus draft ini?")) return;
      const json = await this.apiPost("delete_logbook", { id: entry.id });
      if (json.status === "success") {
        this.toast("Draft dihapus.", "success");
        this.loadLogbooks();
      } else {
        this.toast(json.message || "Gagal menghapus.", "error");
      }
    },

    // ================= JURNAL MINGGUAN =================
    async loadWeekly() {
      const json = await this.apiGet("list_weekly");
      if (json.status === "success") this.weeklyList = json.data.sort((a, b) => a.week_number - b.week_number);
    },

    openNewWeekly() {
      const nextWeek = this.weeklyList.length ? Math.max(...this.weeklyList.map((w) => Number(w.week_number))) + 1 : 1;
      this.weeklyForm = { id: null, week_number: nextWeek, summary_text: "", best_moment: "", next_target: "" };
      this.view = "weekly_form";
    },

    editWeekly(w) {
      this.weeklyForm = { ...w };
      this.view = "weekly_form";
    },

    async saveWeeklyDraft() {
      this.weeklyFormLoading = true;
      try {
        const payload = {
          id: this.weeklyForm.id || null,
          placement_id: this.placement ? this.placement.id : this.weeklyForm.placement_id,
          week_number: this.weeklyForm.week_number,
          summary_text: this.weeklyForm.summary_text,
          best_moment: this.weeklyForm.best_moment,
          next_target: this.weeklyForm.next_target,
          client_uuid: uuidv4()
        };
        const json = await this.apiPost("save_weekly", payload, { queueOffline: true });
        if (json.status === "success" || json.status === "offline_queued") {
          this.toast("Jurnal mingguan tersimpan.", "success");
          this.view = "weekly";
          this.loadWeekly();
        } else {
          this.toast(json.message || "Gagal menyimpan.", "error");
        }
      } finally {
        this.weeklyFormLoading = false;
      }
    },

    async submitWeekly(w) {
      if (!confirm("Kirim jurnal minggu ke-" + w.week_number + "?")) return;
      const json = await this.apiPost("submit_weekly", { id: w.id });
      if (json.status === "success") { this.toast("Jurnal dikirim.", "success"); this.loadWeekly(); }
    },

    // ================= MENTOR / GURU REVIEW =================
    async loadReviewQueue() {
      const role = this.session.user.role;
      if (role === "mentor") {
        const json = await this.apiGet("list_logbooks", { status: "Submitted" });
        if (json.status === "success") this.reviewQueue = json.data;
      } else if (role === "guru") {
        const json = await this.apiGet("list_weekly");
        if (json.status === "success") this.reviewQueue = json.data.filter((w) => w.status === "Submitted");
      }
    },

    async validateLogbook(entry, decision) {
      let notes = "";
      if (decision === "reject") {
        notes = prompt("Catatan revisi untuk siswa:") || "";
        if (!notes) return;
      }
      const json = await this.apiPost("validate_logbook", {
        id: entry.id,
        decision: decision === "reject" ? "revision" : "approve",
        mentor_notes: notes
      });
      if (json.status === "success") {
        this.toast("Status diperbarui.", "success");
        this.loadReviewQueue();
      }
    },

    async verifyWeekly(w) {
      const notes = prompt("Catatan guru pendamping (opsional):") || "";
      const json = await this.apiPost("verify_weekly", { id: w.id, guru_notes: notes });
      if (json.status === "success") { this.toast("Jurnal diverifikasi.", "success"); this.loadReviewQueue(); }
    },

    // ================= ADMIN =================
    async loadUsers() {
      const json = await this.apiGet("list_users");
      if (json.status === "success") this.users = json.data;
    },

    async loadPlacements() {
      const json = await this.apiGet("list_placements");
      if (json.status === "success") this.placements = json.data;
      if (!this.users.length) this.loadUsers();
    },

    async createUser() {
      const json = await this.apiPost("create_user", this.newUserForm);
      if (json.status === "success") {
        this.credentials = [{
          user_id: json.id,
          name: this.newUserForm.name,
          identity_number: this.newUserForm.identity_number,
          email: this.newUserForm.email,
          temp_password: json.temp_password
        }];
        this.toast("Pengguna dibuat. Kata sandi sementara ada di kartu atas.", "success", 6000);
        this.newUserForm = { identity_number: "", name: "", email: "", role: "siswa", phone_number: "" };
        this.loadUsers();
      } else {
        this.toast(json.message || "Gagal membuat pengguna.", "error");
      }
    },

    async createPlacement() {
      const json = await this.apiPost("create_placement", this.newPlacementForm);
      if (json.status === "success") {
        this.toast("Penempatan dibuat.", "success");
        this.newPlacementForm = { student_id: "", mentor_id: "", guru_id: "", company_name: "", department: "", start_date: "", end_date: "" };
        this.loadPlacements();
      } else {
        this.toast(json.message || "Gagal membuat penempatan.", "error");
      }
    },

    parseBulkImport() {
      // Format CSV sederhana: identity_number,name,email,phone_number,company_name,department,start_date,end_date
      const lines = this.bulkImportRaw.trim().split("\n").filter(Boolean);
      this.bulkImportRows = lines.map((line) => {
        const [identity_number, name, email, phone_number, company_name, department, start_date, end_date] = line.split(",").map((s) => s.trim());
        return { identity_number, name, email, phone_number, company_name, department, start_date, end_date };
      });
    },

    async submitBulkImport() {
      if (!this.bulkImportRows.length) { this.toast("Belum ada baris untuk diimpor.", "warn"); return; }
      const json = await this.apiPost("bulk_import_students", { students: this.bulkImportRows });
      if (json.status === "success") {
        const rows = this.bulkImportRows;
        this.credentials = json.created.map((c, i) => ({
          user_id: c.user_id,
          name: c.name,
          identity_number: rows[i] ? rows[i].identity_number : "",
          email: rows[i] ? rows[i].email : "",
          temp_password: c.temp_password
        }));
        this.toast(json.created.length + " siswa berhasil diimpor. Unduh kata sandi sementara sekarang.", "success", 8000);
        this.bulkImportRaw = "";
        this.bulkImportRows = [];
        this.loadUsers();
        this.loadPlacements();
      } else {
        this.toast(json.message || "Gagal impor massal.", "error");
      }
    },

    // ---------- kredensial & password ----------
    csvCell(v) {
      let s = String(v === undefined || v === null ? "" : v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // cegah formula injection di Excel
      return '"' + s.replace(/"/g, '""') + '"';
    },

    downloadCredentials() {
      if (!this.credentials.length) return;
      const lines = [["nama", "id_login", "email", "kata_sandi_sementara"].join(",")];
      this.credentials.forEach((c) => {
        lines.push([c.name, c.identity_number, c.email, c.temp_password].map((v) => this.csvCell(v)).join(","));
      });
      const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "kredensial-" + new Date().toISOString().slice(0, 10) + ".csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    clearCredentials() {
      if (!confirm("Tutup kartu ini? Kata sandi sementara tidak bisa dilihat lagi. Sudah diunduh atau dicatat?")) return;
      this.credentials = [];
    },

    async resetUserPassword(u) {
      if (!confirm("Reset kata sandi " + u.name + "? Kata sandi lama tidak berlaku dan sesi login pengguna ini diputus.")) return;
      const json = await this.apiPost("admin_reset_password", { user_id: u.id });
      if (json.status === "success") {
        this.credentials = [{
          user_id: u.id,
          name: u.name,
          identity_number: u.identity_number,
          email: u.email,
          temp_password: json.temp_password
        }];
        this.toast("Kata sandi direset. Lihat kartu di atas.", "success");
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else {
        this.toast(json.message || "Gagal reset kata sandi.", "error");
      }
    },

    async changePassword() {
      const f = this.pwForm;
      if (f.new_password.length < 8) { this.toast("Kata sandi baru minimal 8 karakter.", "warn"); return; }
      if (f.new_password !== f.confirm) { this.toast("Ulangi kata sandi baru dengan sama persis.", "warn"); return; }
      if (f.new_password === f.old_password) { this.toast("Kata sandi baru harus berbeda dari yang lama.", "warn"); return; }
      this.pwLoading = true;
      try {
        const json = await this.apiPost("change_password", {
          old_password: f.old_password,
          new_password: f.new_password
        }, { quiet: false });
        if (json.status === "success") {
          this.toast("Kata sandi berhasil diganti.", "success");
          this.pwForm = { old_password: "", new_password: "", confirm: "" };
        } else if (json.status !== "unauthorized") {
          this.toast(json.message || "Gagal mengganti kata sandi.", "error");
        }
      } finally {
        this.pwLoading = false;
      }
    },

    async saveEvaluation() {
      const json = await this.apiPost("save_evaluation", this.evaluationForm);
      if (json.status === "success") {
        this.toast("Nilai akhir: " + json.final_score + " (" + json.predicate + ")", "success", 6000);
      } else {
        this.toast(json.message || "Gagal menyimpan nilai.", "error");
      }
    },

    // ================= HELPER TAMPILAN =================
    statusBadgeClass(status) {
      return (STATUS_META[status] || {}).badge || "badge-draft";
    },
    statusIcon(status) {
      return (STATUS_META[status] || {}).icon || "•";
    }
  };
}

function this_defaultLogbookForm() {
  return {
    id: null,
    date: new Date().toISOString().slice(0, 10),
    work_mode: "WFO",
    category: "Administrasi",
    activity_desc: "",
    obstacles: "",
    photo_drive_url: ""
  };
}

/**
 * Kompresi gambar di browser via Canvas API sebelum diunggah,
 * agar ukuran foto ~5MB dari kamera HP turun jadi ~300KB.
 */
function compressImageToBase64(file, maxDimension = 1280, quality = 0.7, targetKB = 300) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDimension) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else if (height > maxDimension) {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);

        let q = quality;
        let dataUrl = canvas.toDataURL("image/jpeg", q);
        // Turunkan kualitas bertahap sampai mendekati target ukuran
        while (dataUrl.length * 0.75 / 1024 > targetKB && q > 0.3) {
          q -= 0.1;
          dataUrl = canvas.toDataURL("image/jpeg", q);
        }
        resolve({ dataUrl, base64: dataUrl.split(",")[1] });
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
