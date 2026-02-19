const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const xml2js = require("xml2js");
const cors = require("cors");
const { execFile } = require("child_process");
const sharp = require("sharp");
const { log } = require("console");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 2. SETTING FOLDER STATIS (PENTING!)
// Ini akan membuat semua file di dalam folder 'public' bisa diakses langsung
app.use(express.static(path.join(__dirname, "public")));

const usersPath = path.join(__dirname, 'users.json');

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    try {
        const data = fs.readFileSync(usersPath, 'utf8');
        const users = JSON.parse(data);
        const userFound = users.find(u => u.username === username && u.password === password);

        if (userFound) {
            res.json({ status: 'OK', message: 'Login berhasil', user: userFound });
        } else {
            // Server mengirimkan status 401 dan pesan error
            res.status(401).json({ status: 'ERROR', message: 'Username atau password salah' });
        }
    } catch (err) {
        res.status(500).json({ status: 'ERROR', message: 'Server database error' });
    }
});


app.post('/register', (req, res) => {
    const { username, password } = req.body;

    try {
        const data = fs.readFileSync(usersPath, 'utf8');
        let users = JSON.parse(data);

        // Cek apakah username sudah ada
        if (users.find(u => u.username === username)) {
            return res.status(400).json({ status: 'ERROR', message: 'Username sudah digunakan' });
        }

        // Tambah user baru ke file users.json
        users.push({ username, password });
        fs.writeFileSync(usersPath, JSON.stringify(users, null, 2), 'utf8');

        console.log(`👤 User baru terdaftar: ${username}`);
        res.json({ status: 'OK', message: 'Registrasi berhasil' });
    } catch (err) {
        console.error("❌ Gagal mendaftarkan user:", err);
        res.status(500).json({ status: 'ERROR', message: 'Gagal menyimpan data ke server' });
    }
});

// Route untuk menampilkan halaman register
app.get('/register.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.use("/uploads", express.static("uploads"));

// 3. ROUTING HALAMAN (SOLUSI CANNOT GET)
// Saat akses '/', kirim login.html dari folder public
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Agar link /login.html di ngrok juga bekerja
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Agar halaman utama bisa diakses setelah login
app.get('/index-final.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index-final.html'));
});
app.use("/uploads", express.static("uploads"));

/* ========== FOLDER SETUP ========== */
const uploadDirbase = "uploads/photos";
const kmlDir = "kml";
// Maksimum jarak (meter) untuk menganggap placemark cocok
const MAX_DISTANCE = 20; // ubah sesuai kebutuhan 
fs.mkdirSync(uploadDirbase, { recursive: true });
fs.mkdirSync(kmlDir, { recursive: true });
// Pastikan folder induk ada
if (!fs.existsSync(uploadDirbase)) fs.mkdirSync(uploadDirbase, { recursive: true });
if (!fs.existsSync(kmlDir)) fs.mkdirSync(kmlDir, { recursive: true });

/* ========== UPLOAD CONFIG ========== */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDirbase);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "_" + file.originalname);
  }
});
const upload = multer({ storage });

/* ========== HELPER: RENAME FILE ========== */
function renamePhotoFile(currentFilePath, placemark, kmlFileName, username) {
  try {
    const date = new Date();
    const dateStr = date.getFullYear() + 
                   String(date.getMonth() + 1).padStart(2, '0') + 
                   String(date.getDate()).padStart(2, '0');
    
    const placemarkName = placemark.name?.[0] || 'Unknown';
    const kmlName = kmlFileName.replace('.kml', '');
    
    const cleanPlacemark = placemarkName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
    const cleanKML = kmlName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
    
    const newFilename = `${cleanPlacemark}_${cleanKML}_${dateStr}.jpg`;
    
    // BUAT FOLDER USER JIKA BELUM ADA
    const userPhotoDir = path.join(uploadDirBase, username);
    if (!fs.existsSync(userPhotoDir)) fs.mkdirSync(userPhotoDir, { recursive: true });

    const absoluteCurrentPath = path.resolve(currentFilePath);
    const absoluteNewPath = path.resolve(userPhotoDir, newFilename);
    
    if (fs.existsSync(absoluteCurrentPath)) {
      fs.renameSync(absoluteCurrentPath, absoluteNewPath);
      // Return path relatif untuk URL (misal: uploads/photos/admin/file.jpg)
      return `${username}/${newFilename}`;
    }
    return path.basename(currentFilePath);
  } catch (e) {
    console.error("Rename Error:", e);
    return path.basename(currentFilePath);
  }
}

/* ========== HELPER: EVIDENCE TYPE MATCHING ========== */
function matchesEvidenceType(placemarkName, evidenceType) {
  const name = (placemarkName || '').toUpperCase();
  const et = (evidenceType || '').toUpperCase();
  
  // Jika tipe yang dipilih ODP, maka nama placemark WAJIB ada kata 'ODP'
  // dan TIDAK BOLEH mengandung kata 'TIANG' atau 'TB' (mencegah salah sasaran)
  if (et === 'ODP') {
    return name.includes('ODP');
  } 
  
  if (et === 'TIANG') {
    // Tiang biasanya ditandai dengan TB atau TIANG
    return name.includes('TB') || name.includes('TIANG') || name.includes('COBA');
  }

  if (et === 'ODC') {
    return name.includes('ODC');
  }

  return false;
}

/* ========== HAVERSINE DISTANCE ========== */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000; // meters
  const toRad = x => x * Math.PI / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ========== UPLOAD WITH GPS (KAMERA) - AUTO UPDATE KML ========== */
app.post("/upload", upload.single("photo"), async (req, res) => {
  console.log("📸 UPLOAD CAMERA + GPS");
  console.log("BODY:", req.body);
  console.log("FILE:", req.file);

  const { latitude, longitude, evidenceType, username } = req.body;

  // Validate username
  if (!username) {
    return res.status(400).json({ status: "ERROR", error: "Username tidak boleh kosong" });
  }

  // Create user-specific KML directory
  const userKmlDir = path.join(kmlDir, username);
  fs.mkdirSync(userKmlDir, { recursive: true });

  if (!req.file) {
    return res.status(400).json({ status: "ERROR", error: "Foto tidak ada" });
  }

  const lat = parseFloat(latitude);
  const lon = parseFloat(longitude);

  if (isNaN(lat) || isNaN(lon)) {
    return res.status(400).json({ status: "ERROR", error: "GPS tidak valid" });
  }

  const photoPath = req.file.path;

  try {
    const kmlFiles = fs.readdirSync(userKmlDir).filter(f => f.endsWith(".kml"));

    console.log(`🔎 Found ${kmlFiles.length} KML files to scan`);

    let bestMatch = null;
    let bestDistance = Infinity;
    let bestKmlFile = null;

    for (const filename of kmlFiles) {
      try {
        const filePath = path.join(userKmlDir, filename);
        const xml = fs.readFileSync(filePath, "utf-8");
        const kmlObject = await xml2js.parseStringPromise(xml);

        const doc = kmlObject.kml?.Document?.[0];
        let placemarks = [];
        if (doc?.Placemark) placemarks = doc.Placemark;
        else if (doc?.Folder) {
          doc.Folder.forEach(f => { if (f.Placemark) placemarks = placemarks.concat(f.Placemark); });
        }

        console.log(`📄 Scanning ${filename} with ${placemarks.length} placemarks`);

        for (const pm of placemarks) {
          const pmName = pm.name?.[0] || '(no name)';
          if (!matchesEvidenceType(pmName, evidenceType)) continue;

          const coords = pm.Point?.[0]?.coordinates?.[0];
          if (!coords) continue;

          const parts = coords.split(',').map(s => parseFloat(s.trim()));
          const [pmLon, pmLat] = parts;
          if (isNaN(pmLat) || isNaN(pmLon)) continue;

          const distance = haversine(lat, lon, pmLat, pmLon);
          console.log(`  • Placemark '${pmName}' at ${pmLat},${pmLon} -> distance ${distance.toFixed(2)} m`);

          if (distance < bestDistance) {
            bestDistance = distance;
            bestMatch = { placemark: pm, kmlObject };
            bestKmlFile = filename;
          }
        }
      } catch (fileErr) {
        console.error(`⚠️ Error reading/parsing ${filename}:`, fileErr.message);
        continue;
      }
    }

    if (!bestMatch || bestDistance > MAX_DISTANCE) {
      return res.status(400).json({
        status: "ERROR",
        error: `Tidak ada ${evidenceType} dalam radius ${MAX_DISTANCE} meter`,
        bestDistance: bestDistance
      });
    }

    const placemarkName = bestMatch.placemark.name?.[0] || "Tanpa Nama";

    const newFilename = renamePhotoFile(photoPath, bestMatch.placemark, bestKmlFile, username);
    const imageURL = `http://localhost:${PORT}/uploads/photos/${newFilename}`;

    bestMatch.placemark.description = [
      `<b>Update Evidence (Camera)</b><br>
       <img src="${imageURL}" width="300"><br>
       <b>Koordinat:</b> ${lat}, ${lon}<br>
       <b>Waktu:</b> ${new Date().toLocaleString("id-ID")}`
    ];

    try {
      const builder = new xml2js.Builder({ xmldec: { version: '1.0', encoding: 'UTF-8' } });
      const xmlOut = builder.buildObject(bestMatch.kmlObject);
      fs.writeFileSync(path.join(userKmlDir, bestKmlFile), xmlOut, 'utf-8');
      console.log(`✅ Wrote updated KML to ${bestKmlFile} (distance ${bestDistance.toFixed(2)} m)`);

      res.json({
        status: "OK",
        placemark: placemarkName,
        kml: bestKmlFile,
        scan_details: `✅ UPDATE BERHASIL\nPlacemark: ${placemarkName}\nKML: ${bestKmlFile}\nJarak: ${bestDistance.toFixed(2)} m`
      });
    } catch (writeErr) {
      console.error('❌ Failed to write KML:', writeErr);
      return res.status(500).json({ status: 'ERROR', error: 'Gagal menyimpan KML: ' + writeErr.message });
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "ERROR", error: err.message });
  }
});

// Endpoint pendukung lainnya (kml-list, upload-kml, dll) pastikan tetap ada di bawah sini

/* ========== PROCESS PHOTO WITH OCR ========== */
app.post("/process-photo", upload.single("photo"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Foto tidak ada" });
  }

  const { evidenceType, description, username } = req.body;
  
  // Validate username
  if (!username) {
    return res.status(400).json({ status: "ERROR", error: "Username tidak boleh kosong" });
  }

  // Create user-specific KML directory
  const userKmlDir = path.join(kmlDir, username);
  fs.mkdirSync(userKmlDir, { recursive: true });

  const photoPath = path.resolve(req.file.path);
  let scanLogs = [];

  console.log("📸 REQUEST MASUK - PROCESS PHOTO");
  console.log("📁 FOTO:", photoPath);

  execFile("python", ["OCR.py", photoPath], { maxBuffer: 10 * 1024 * 1024 }, async (err, stdout, stderr) => {
    console.log("🔍 OCR STDOUT:", stdout);
    console.log("❌ OCR STDERR:", stderr);

    if (err) {
      console.error("❌ OCR Error:", err);
      return res.status(500).json({ status: "ERROR", error: "OCR gagal: " + err.message });
    }

    const lines = stdout.trim().split("\n");
    if (lines.length < 2 || lines[0] === "NOT_FOUND") {
      scanLogs.push("❌ OCR: Koordinat tidak ditemukan di foto");
      return res.json({
        status: "OK",
        latitude: null,
        longitude: null,
        scan_details: scanLogs.join('\n'),
        message: "Koordinat tidak ditemukan"
      });
    }

    let lat = parseFloat(lines[0]);
    let lon = parseFloat(lines[1]);

    if (isNaN(lat) || isNaN(lon)) {
      scanLogs.push("❌ OCR: Koordinat tidak valid");
      return res.json({
        status: "OK",
        latitude: null,
        longitude: null,
        scan_details: scanLogs.join('\n'),
        message: "Koordinat tidak valid"
      });
    }

    // BATASI 6 DESIMAL
    lat = Number(lat.toFixed(6));
    lon = Number(lon.toFixed(6));

    scanLogs.push(`📍 OCR berhasil: Lat ${lat}, Lon ${lon}`);

    // ============================
    // CARI PLACEMARK TERDEKAT
    // ============================
    const kmlFiles = fs.readdirSync(userKmlDir).filter(f => f.endsWith(".kml"));
    let bestMatch = null;
    let bestDistance = Infinity;
    let bestKmlFile = null;

    for (const filename of kmlFiles) {
      const xml = fs.readFileSync(path.join(userKmlDir, filename), "utf-8");
      const kmlObject = await new Promise(resolve => xml2js.parseString(xml, (err, r) => resolve(r)));

      const doc = kmlObject.kml?.Document?.[0];
      let placemarks = [];
      if (doc?.Placemark) placemarks = doc.Placemark;
      else if (doc?.Folder) {
        doc.Folder.forEach(f => { if (f.Placemark) placemarks = placemarks.concat(f.Placemark); });
      }

      for (const pm of placemarks) {
        if (!matchesEvidenceType(pm.name?.[0], evidenceType)) continue;
        const coords = pm.Point?.[0]?.coordinates?.[0];
        if (!coords) continue;

        const parts = coords.split(',').map(s => parseFloat(s.trim()));
        const [pmLon, pmLat] = parts;
        const distance = haversine(lat, lon, pmLat, pmLon);

        if (distance < bestDistance) {
          bestDistance = distance;
          bestMatch = { kmlObject, placemark: pm };
          bestKmlFile = filename;
        }

      }
    }
    // ✅ VALIDASI SETELAH SEMUA PLACEMARK DICEK
    if (!bestMatch || bestDistance > MAX_DISTANCE) {
      return res.status(400).json({
        status: "ERROR",
        error: `Tidak ada ${evidenceType} dalam radius ${MAX_DISTANCE} meter`,
        bestDistance: bestDistance
      });
    }

    if (!bestMatch) {
      scanLogs.push("❌ Tidak ada placemark cocok ditemukan");
      return res.json({
        status: "OK",
        latitude: lat,
        longitude: lon,
        scan_details: scanLogs.join('\n'),
        message: "Placemark tidak ditemukan"
      });
    }

    const placemarkName = bestMatch.placemark.name?.[0] || "Tanpa Nama";
    const kmlTarget = bestKmlFile;

    // Rename file agar rapi
    const newFilename = renamePhotoFile(photoPath, bestMatch.placemark, kmlTarget, username);
    const imageURL = `http://localhost:${PORT}/uploads/photos/${newFilename}`;
    const now = new Date().toLocaleString("id-ID");

    // Update Deskripsi XML
    const evidenceDescription = `<b>Update Evidence (Upload)</b><br><img src="${imageURL}" width="300"><br><b>Koordinat:</b> ${lat}, ${lon}<br><b>Waktu:</b> ${now}`;
    bestMatch.placemark.description = [evidenceDescription];

    // SIMPAN PERMANEN KE DISK
    console.log("📌 Updating placemark:", placemarkName);

    const builder = new xml2js.Builder();
    const updatedXML = builder.buildObject(bestMatch.kmlObject);
    fs.writeFileSync(path.join(userKmlDir, kmlTarget), updatedXML, "utf-8");
    console.log("✅ KML tersimpan:", path.join(userKmlDir, kmlTarget));

    scanLogs.push(`✅ BERHASIL: ${placemarkName} di ${kmlTarget} telah diperbarui.`);

    res.json({
      status: "OK",
      latitude: lat,
      longitude: lon,
      kml: kmlTarget,
      placemark: placemarkName,
      image: imageURL,
      scan_details: scanLogs.join('\n')
    });
  });
});

/* ========== OCR PREVIEW ENDPOINT ========== */
app.post("/ocr-preview", upload.single("photo"), (req, res) => {
  const photoPath = req.file.path;

  execFile("python", ["ocr.py", photoPath], { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
    try {
      if (error) {
        console.error("❌ OCR Error:", error);
        return res.status(500).json({ error: "OCR failed: " + error.message });
      }
      const text = stdout.trim();
      res.json({ status: "OK", text: text, preview: text.substring(0, 100) + "..." });
    } catch (execErr) {
      res.status(500).json({ error: "Terjadi kesalahan: " + execErr.message });
    }
  });
});

/* ========== UPLOAD KML FILE ========== */
/* ========== UPLOAD KML FILE (FIXED) ========== */
app.post("/upload-kml", upload.single("kml"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "File KML tidak ada" });

    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ error: "Username tidak boleh kosong" });
    }

    // Create user-specific KML directory
    const userKmlDir = path.join(kmlDir, username);
    fs.mkdirSync(userKmlDir, { recursive: true });

    const kmlContent = fs.readFileSync(req.file.path, 'utf-8');
    const parsed = await xml2js.parseStringPromise(kmlContent);
    
    // Perbaikan: Ambil placemarks dari variabel 'parsed', bukan 'kmlObject'
    const doc = parsed.kml?.Document?.[0];
    let placemarks = [];
    if (doc?.Placemark) {
        placemarks = doc.Placemark;
    } else if (doc?.Folder) {
        doc.Folder.forEach(f => { if (f.Placemark) placemarks = placemarks.concat(f.Placemark); });
    }

    const newPath = path.join(userKmlDir, req.file.originalname);
    fs.copyFileSync(req.file.path, newPath);
    fs.unlinkSync(req.file.path);
    
    res.json({
      status: "OK",
      message: "KML berhasil diupload",
      filename: req.file.originalname,
      placemarks: placemarks.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ========== LIST KML FILES ========== */
app.get("/kml-list", (req, res) => {
  try {
    const { username } = req.query;
    if (!username) {
      return res.status(400).json({ error: "Username tidak boleh kosong" });
    }
    
    const userKmlDir = path.join(kmlDir, username);
    fs.mkdirSync(userKmlDir, { recursive: true });
    
    const kmlFiles = fs.readdirSync(userKmlDir).filter(f => f.endsWith(".kml"));
    res.json({ kml_files: kmlFiles });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ========== START SERVER ========== */
try {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
    console.log(`📦 KML Directory: ${path.resolve(kmlDir)}`);
    console.log(`📸 Upload Directory: ${path.resolve(uploadDirbase)}`);
  });
  
  server.on('error', (err) => {
    console.error('❌ Server error:', err);
  });
} catch (err) {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
}