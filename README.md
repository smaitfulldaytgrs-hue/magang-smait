# Sistem Informasi Magang & E-Logbook — SMA IT Insan Cendikia

PWA (GitHub Pages) + Google Apps Script + Google Sheets, sesuai `prompt_note_aplikasi_web_magang.md`.

## Struktur
```
index.html      SPA (Alpine.js + Tailwind CDN) — login, dashboard, logbook, jurnal, admin
manifest.json   PWA install
sw.js           Service worker (cache app shell + offline queue trigger)
css/style.css   Design tokens (warna, tipografi, badge status) sesuai spek §5.D
js/app.js       Semua logic frontend + API_URL (WAJIB diisi, lihat langkah 3)
js/db.js        Wrapper IndexedDB (antrean offline logbook/jurnal)
code.gs         Backend Google Apps Script (taruh di Apps Script editor Google Sheets)
assets/         Icon PWA placeholder (192px & 512px) — ganti dengan logo sekolah
```

## Langkah Setup

1. **Buat Google Sheet baru** (mis. "DB_MagangIC") di Google Drive sekolah (akun Workspace, bukan Gmail biasa — kuota lebih tinggi, lihat spek §7.B).
2. Buka **Extensions → Apps Script**, hapus isi `Code.gs` default, tempel seluruh isi `code.gs` di sini.
3. Di dropdown fungsi, pilih **`setupSpreadsheet`** lalu klik ▶ Run. Ini otomatis membuat:
   - 5 tab utama (`Users`, `Placements`, `Daily_Logbooks`, `Weekly_Summaries`, `Evaluations`)
   - 4 tab pendukung tersembunyi (`_ProcessedRequests`, `_PasswordResets`, `_ErrorLogs`, `_SchemaVersion`)
   - 1 akun admin pertama (email `admin@sekolah.sch.id`, password ditampilkan di **View → Logs**)
   - Folder Drive `Magang_Bukti_Kegiatan` untuk foto
   - Trigger backup harian jam 02:00
4. **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Salin URL yang muncul (`https://script.google.com/macros/s/XXXX/exec`)
5. Buka `js/app.js`, ganti baris pertama:
   ```js
   const API_URL = "https://script.google.com/macros/s/XXXX/exec";
   ```
6. Push seluruh folder ini ke repo GitHub, aktifkan **GitHub Pages** (branch `main`, folder root).
7. Login pertama pakai akun admin default → tambah pengguna (mentor/guru/siswa) via menu **Pengguna**, buat penempatan via menu **Penempatan**.

## Yang sudah diimplementasikan
- Auth: login, session token + expiry 8 jam, request/confirm reset password via email.
- Logbook harian: CRUD draft, kirim (lock), state machine `Draft → Submitted → Approved/Revision Needed`, review mentor.
- Jurnal mingguan: draft, kirim, verifikasi guru pendamping.
- Evaluasi: input skor 4 komponen, hitung otomatis `NA = 0.60×Mentor + 0.40×avg(Logbook,Laporan,Presentasi)` + predikat.
- Admin: tambah pengguna, impor massal siswa (CSV sederhana), assign penempatan, rekap nilai.
- Keamanan: `LockService` cegah race condition tulis, idempotency via `client_uuid`, `password_hash`/`salt` tidak pernah dikirim ke client, validasi `session_token` di tiap request tertulis.
- PWA: manifest, service worker (cache-first shell, network-first API), antrean offline via IndexedDB + kompresi foto Canvas API sebelum upload.
- Backup harian otomatis ke folder Drive `Backup/` (retensi 30 hari) + Version History bawaan Sheets.
- Error logging ke tab `_ErrorLogs`.

## Belum diimplementasikan penuh (lanjutan, lihat spek §7)
Butuh Google Docs template & sedikit kerja tambahan, sengaja tidak dipaksakan di MVP ini:
- **Generate PDF laporan portofolio + sertifikat QR code** — perlu template Google Docs dengan placeholder (`{{nama}}`, dst.) lalu fungsi `generatePortfolioPDF(placement_id)` di `code.gs` (kerangka fungsi & alur sudah dijelaskan di dokumen spek §7.D, tinggal disambungkan begitu template Docs sekolah siap).
- **Notifikasi WhatsApp** — saat ini notifikasi status pakai `MailApp` (email); WhatsApp Business API perlu langganan pihak ketiga terpisah.
- **Reminder H-1 belum isi logbook** — perlu trigger harian tambahan yang scan `Placements` aktif vs `Daily_Logbooks` hari ini, lalu `MailApp.sendEmail` ke siswa yang belum isi.
- **Checkbox konsen orang tua** — kolom `parent_consent`/`consent_at` sudah ada di skema `Users` dan form `create_user`/`bulk_import_students` bisa diisi manual; form UI checkbox saat pembuatan akun belum ditambahkan di frontend, tinggal tambah 1 field.
- Halaman kebijakan privasi ringkas.

## Uji sebelum go-live (checklist wajib, sesuai spek §8.6)
- [ ] Request `doPost` tanpa `session_token` valid ditolak (`status: unauthorized`)
- [ ] Dua submit logbook bersamaan tidak saling timpa (LockService)
- [ ] `doGet`/`doPost` tidak pernah mengembalikan `password_hash`/`salt`
- [ ] Retry sinkronisasi offline tidak menduplikasi data (cek `client_uuid` di `_ProcessedRequests`)
- [ ] Coba isi logbook dalam kondisi pesawat/offline, pastikan tersimpan lokal lalu tersinkron otomatis saat online
