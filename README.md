# Gambar Sumur

Aplikasi gambar sumur di browser untuk membuat chart azimuth dan inklinasi, casing setting depth, serta drilling summary. Data diisi dari Excel atau langsung di layar, lalu gambar bisa diunduh sebagai PNG, JPG, atau PDF.

## Cara membuka

Klik dua kali `Buka Chart.bat`, atau buka `Migas Program.html` di browser. Tidak perlu memasang server.

## Isi program

- **Azimuth Polar Chart** — busur azimuth dan inklinasi per sumur. Data bisa diunggah dari Excel (`.xlsx`, `.xls`, `.csv`) atau diisi manual.
- **Casing Setting Depth** — rangkaian casing dan liner terhadap kedalaman, dengan kolom formasi di samping gambar.
- **Drilling Summary** — grafik waktu terhadap kedalaman (ft-MD atau ft-TVD), lengkap dengan formasi, casing, dan tanda masalah sumur.

## Drilling Summary

Di bawah pratinjau ada keterangan yang bisa dinyalakan atau dimatikan. Tiap tombol menyembunyikan garis kedalaman atau satu jenis masalah dari grafik. Angka di sampingnya menghitung masalah yang sedang menyala. Kalau semua jenis menyala, semua masalah dihitung. Kalau hanya sebagian, yang dihitung hanya jenis yang menyala. Mematikan garis kedalaman tidak mengurangi angka itu.

Angka dan tombol itu berada di luar gambar. Unduhan hanya berisi grafik. Keterangan di dalam grafik diletakkan di tengah, di bawah sumbu Day.

## Simpan dan buka lagi

**Simpan** menulis satu berkas JSON untuk ketiga chart. **Buka** memuat berkas itu kembali. Isian terakhir juga tersimpan di browser lewat local storage.
