# Gambar Sumur

Aplikasi gambar sumur di browser untuk membuat chart azimuth dan inklinasi, casing setting depth, serta drilling summary. Data diisi dari Excel atau langsung di layar, lalu gambar bisa diunduh sebagai PNG, JPG, atau PDF.

## Cara membuka

Klik dua kali `Buka Chart.bat`, atau buka `Migas Program.html` di browser. Tidak perlu memasang server.

## Isi program

- **Azimuth Polar Chart** — busur azimuth dan inklinasi per sumur. Data bisa diunggah dari Excel (`.xlsx`, `.xls`, `.csv`) atau diisi manual.
- **Casing Setting Depth** — rangkaian casing dan liner terhadap kedalaman, dengan kolom formasi di samping gambar.
- **Drilling Summary** — grafik waktu terhadap kedalaman (ft-MD atau ft-TVD), lengkap dengan formasi, casing, dan tanda masalah sumur.
- **Box & Whisker** — sebaran nilai per kolom, misalnya mud weight per formasi. Salin tabel dari Excel beserta header; header menjadi sumbu X. Warna tiap kolom memakai palet formasi dan bisa diubah.

## Drilling Summary

Di bawah pratinjau ada keterangan yang bisa dinyalakan atau dimatikan. Tiap tombol menyembunyikan garis kedalaman atau satu jenis masalah dari grafik. Angka di sampingnya menghitung masalah yang sedang menyala. Kalau semua jenis menyala, semua masalah dihitung. Kalau hanya sebagian, yang dihitung hanya jenis yang menyala. Mematikan garis kedalaman tidak mengurangi angka itu.

Angka dan tombol itu berada di luar gambar. Unduhan hanya berisi grafik. Keterangan di dalam grafik diletakkan di tengah, di bawah sumbu Day.

## Simpan dan buka lagi

**Simpan** menulis satu berkas JSON untuk ketiga chart. **Buka** memuat berkas itu kembali. Isian terakhir juga tersimpan di browser lewat local storage.

## Multi-well Drilling Summary (update 2026-10-26)

Drilling Summary now supports multiple wells:

- **Tambah sumur / Duplikat** — each well keeps its own progress, events, formations, TD, and casing link.
- **Satu sumur** — edit the active well (click a well in the list to switch without losing data).
- **Bandingkan semua** — overlay progress curves of all visible wells on one chart (toggle eye checkbox per well).
- **Kosongkan** — clears only the active well; other wells stay intact.
- Project JSON and localStorage remain backward-compatible with older single-well files.

## 2026-10-29 updates

- **Save / Load** (device + VPS via API)
- **Box & Whisker multi-plot** (add plots without deleting)
- **AutoML** section (AutoML-Alex on VPS)

See `SETUP_VPS.md`.
