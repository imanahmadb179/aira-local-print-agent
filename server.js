const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const { spawn } = require('child_process');
const crypto = require('crypto');

const isWindows = os.platform() === 'win32';
const ptp = isWindows ? require('pdf-to-printer') : require('unix-print');

// --- BACKGROUND TRICK UNTUK WINDOWS ---
if (isWindows && !process.argv.includes('--hidden')) {
    // Re-spawn aplikasi ini sendiri di background tanpa jendela console
    const child = spawn(process.execPath, process.argv.slice(1).concat(['--hidden']), {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
    });
    child.unref();
    console.log('Menjalankan agen di background... (Jendela ini akan tertutup)');
    process.exit(0); // Tutup jendela hitam aslinya
}
// --------------------------------------

const app = express();
const port = 18080; // Berubah dari 8080 agar tidak konflik dengan aplikasi web

// Setup LowDB
const adapter = new FileSync('db.json');
const db = low(adapter);
db.defaults({ mappings: [], logs: [], auth: { passwordHash: null } }).write();

// Migrasi: pastikan semua mapping lama memiliki field orientation dan paperSize
// agar tidak undefined saat dipakai di proses cetak
const allMappings = db.get('mappings').value();
let migrationNeeded = false;
allMappings.forEach(m => {
    if (m.paperSize === undefined) { m.paperSize = ""; migrationNeeded = true; }
    if (m.orientation === undefined) { m.orientation = ""; migrationNeeded = true; }
    if (m.margin === undefined) { m.margin = ""; migrationNeeded = true; }
});
if (migrationNeeded) {
    db.set('mappings', allMappings).write();
    console.log('[INFO] Migrasi database: field orientation/paperSize/margin ditambahkan ke mapping lama.');
}

// Pengekstrak SumatraPDF untuk Windows
const sumatraDest = path.join(process.cwd(), 'SumatraPDF.exe');
if (isWindows && !fs.existsSync(sumatraDest)) {
    const sumatraSource = path.join(__dirname, 'node_modules', 'pdf-to-printer', 'dist', 'SumatraPDF-3.4.6-32.exe');
    try {
        const exeData = fs.readFileSync(sumatraSource);
        fs.writeFileSync(sumatraDest, exeData);
        console.log('[INFO] SumatraPDF.exe berhasil diekstrak ke direktori lokal.');
    } catch (e) {
        console.error('[ERROR] Gagal mengekstrak SumatraPDF.exe:', e.message);
    }
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, path) => {
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
}));

// Active jobs tracker
let activeJobs = [];

// --- API Pengaturan Printer ---

// Middleware Authentication
function requireAuth(req, res, next) {
    const token = req.headers['x-auth-token'];
    const auth = db.get('auth').value();
    
    // Jika password belum disetup, izinkan (meskipun seharusnya setup dulu)
    if (!auth || !auth.passwordHash) return next();
    
    if (token === auth.passwordHash) {
        next();
    } else {
        res.status(401).json({ success: false, message: 'Unauthorized. Password salah atau tidak disertakan.' });
    }
}

// --- AUTHENTICATION ROUTES ---
app.get('/api/auth/status', (req, res) => {
    const auth = db.get('auth').value();
    res.json({ isSetup: !!(auth && auth.passwordHash) });
});

app.post('/api/auth/setup', (req, res) => {
    const auth = db.get('auth').value();
    if (auth && auth.passwordHash) return res.json({ success: false, message: 'Password sudah diatur sebelumnya.' });
    
    const { password } = req.body;
    if (!password) return res.json({ success: false, message: 'Password tidak boleh kosong.' });
    
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    db.set('auth.passwordHash', hash).write();
    res.json({ success: true, token: hash, message: 'Password berhasil disimpan.' });
});

app.post('/api/auth/login', (req, res) => {
    const { password } = req.body;
    const auth = db.get('auth').value();
    
    if (!auth || !auth.passwordHash) return res.json({ success: false, message: 'Belum ada password di-setup.' });
    
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    if (auth.passwordHash === hash) {
        res.json({ success: true, token: hash, message: 'Login berhasil.' });
    } else {
        res.json({ success: false, message: 'Password salah.' });
    }
});

app.post('/api/auth/change', requireAuth, (req, res) => {
    const { oldPassword, newPassword } = req.body;
    const auth = db.get('auth').value();
    
    if (!auth || !auth.passwordHash) return res.json({ success: false, message: 'Belum ada password di-setup.' });
    if (!newPassword || newPassword.trim() === '') return res.json({ success: false, message: 'Password baru tidak boleh kosong.' });
    
    const oldHash = crypto.createHash('sha256').update(oldPassword).digest('hex');
    if (auth.passwordHash !== oldHash) {
        return res.json({ success: false, message: 'Password lama salah.' });
    }
    
    const newHash = crypto.createHash('sha256').update(newPassword).digest('hex');
    db.set('auth.passwordHash', newHash).write();
    res.json({ success: true, token: newHash, message: 'Password berhasil diubah.' });
});

app.get('/api/mappings', requireAuth, (req, res) => {
    const mappings = db.get('mappings').value();
    res.json({ success: true, mappings });
});

app.post('/api/mappings', requireAuth, (req, res) => {
    const { type, printerName, paperSize, orientation, margin } = req.body;
    if (!type || !printerName) {
        return res.status(400).json({ success: false, message: 'Tipe dan Nama Printer wajib diisi' });
    }
    
    const existing = db.get('mappings').find({ type }).value();
    const paperSizeVal = paperSize ? paperSize.trim() : "";
    const orientationVal = orientation || "";
    const marginVal = margin ? margin.trim() : "";
    
    if (existing) {
        db.get('mappings').find({ type }).assign({ printerName, paperSize: paperSizeVal, orientation: orientationVal, margin: marginVal }).write();
    } else {
        db.get('mappings').push({ type, printerName, paperSize: paperSizeVal, orientation: orientationVal, margin: marginVal }).write();
    }
    res.json({ success: true, message: 'Pengaturan berhasil disimpan' });
});

app.delete('/api/mappings/:type', requireAuth, (req, res) => {
    const { type } = req.params;
    db.get('mappings').remove({ type }).write();
    res.json({ success: true, message: 'Pengaturan berhasil dihapus' });
});

app.get('/api/logs', requireAuth, (req, res) => {
    const { status, page = 1, limit = 10 } = req.query;
    
    // Hapus log yang lebih tua dari 7 hari
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    db.get('logs').remove(log => new Date(log.timestamp) < sevenDaysAgo).write();

    let logsQuery = db.get('logs');
    if (status && status !== 'all') {
        logsQuery = logsQuery.filter({ status });
    }
    
    const total = logsQuery.size().value();
    const logs = logsQuery.orderBy(['timestamp'], ['desc'])
                          .drop((Number(page) - 1) * Number(limit))
                          .take(Number(limit))
                          .value();
                          
    res.json({ success: true, logs, total, page: Number(page), limit: Number(limit) });
});

// API Job Print Berjalan
app.get('/api/jobs', requireAuth, (req, res) => {
    res.json({ success: true, jobs: activeJobs });
});

app.delete('/api/jobs/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const job = activeJobs.find(j => j.id === id);
    if (job) {
        job.isCancelled = true;
        job.status = 'Dibatalkan pengguna';
        res.json({ success: true, message: 'Job berhasil dibatalkan' });
    } else {
        res.status(404).json({ success: false, message: 'Job tidak ditemukan' });
    }
});

app.get('/printers', requireAuth, async (req, res) => {
    try {
        let printers = await ptp.getPrinters();
        if (!isWindows) {
            printers = printers.map(p => ({
                deviceId: p.printer,
                name: p.printer
            }));
        }
        res.json({ success: true, printers });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message || error });
    }
});

// API untuk mematikan agent (penting karena sekarang berjalan di background)
app.post('/api/shutdown', requireAuth, (req, res) => {
    res.json({ success: true, message: 'Mematikan Local Print Agent...' });
    setTimeout(() => {
        process.exit(0);
    }, 1000);
});

app.post('/print', async (req, res) => {
    let { url, printerName, type } = req.body;

    if (!url) {
        return res.status(400).json({ success: false, message: 'URL dokumen wajib diisi!' });
    }

    let paperSize = "";
    let orientation = "";
    let margin = "";
    if (type) {
        const mapping = db.get('mappings').find({ type }).value();
        if (mapping && mapping.printerName) {
            printerName = mapping.printerName;
            paperSize = mapping.paperSize || "";
            orientation = mapping.orientation || "";
            margin = mapping.margin || "";
            
            try {
                const urlObj = new URL(url);
                if (paperSize) urlObj.searchParams.set('paperSize', paperSize);
                if (orientation) urlObj.searchParams.set('orientation', orientation);
                if (margin) urlObj.searchParams.set('margin', margin);
                url = urlObj.toString();
            } catch(e) {
                console.warn("[WARNING] Invalid URL format for appending parameters", e);
            }
            
            console.log(`[INFO] Tipe '${type}' diarahkan ke printer: ${printerName}` + (paperSize ? ` dengan kertas ${paperSize}` : '') + (orientation ? ` (${orientation})` : '') + (margin ? ` (margin: ${margin})` : ''));
        } else if (!printerName) {
             return res.status(400).json({ success: false, message: `Tipe dokumen '${type}' belum didaftarkan di Local Print Agent. Buka dashboard agent (http://127.0.0.1:18080) dan tambahkan mapping untuk tipe ini.` });
        }
    }

    if (!printerName) {
        return res.status(400).json({ success: false, message: 'Nama Printer atau Tipe wajib diisi!' });
    }

    const jobId = Date.now().toString();
    // FIX: Gunakan os.tmpdir() agar path selalu writable baik saat dev maupun saat dijalankan sebagai .exe
    const tempFilePath = path.join(os.tmpdir(), `aira_print_${jobId}.pdf`);
    
    const jobInfo = {
        id: jobId,
        url,
        type: type || '-',
        printerName,
        paperSize: paperSize || 'Default',
        orientation: orientation || 'Default',
        status: 'Mengunduh dokumen...',
        startTime: new Date().toISOString(),
        isCancelled: false
    };
    activeJobs.push(jobInfo);

    // FIX: Helper cleanup terpusat agar tidak ada file temp yang tertinggal
    const cleanupTempFile = async () => {
        try {
            if (fs.existsSync(tempFilePath)) {
                await fs.remove(tempFilePath);
            }
        } catch (rmErr) {
            console.error('[WARNING] Gagal menghapus temporary file:', rmErr.message);
        }
    };

    try {
        console.log(`[INFO] Mengunduh dokumen dari: ${url}`);
        
        const http = require('http');
        const https = require('https');

        const response = await axios({
            url: url,
            method: 'GET',
            responseType: 'stream',
            timeout: 60000, // Ditingkatkan ke 60 detik karena dompdf di Laravel kadang lama prosesnya
            httpAgent: new http.Agent({ keepAlive: false }),
            httpsAgent: new https.Agent({ keepAlive: false }),
            headers: {
                // Header ini sangat penting untuk backend PHP (terutama artisan serve) yang single-thread
                // agar koneksi langsung diputus dan tidak nyangkut (hang) pada print kedua dan seterusnya
                'Connection': 'close'
            }
        });

        if (jobInfo.isCancelled) throw new Error('Dibatalkan sebelum file selesai diunduh');

        const writer = fs.createWriteStream(tempFilePath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            // Gunakan 'close' alih-alih 'finish' agar memastikan file PDF benar-benar tidak lagi di-lock oleh sistem operasi
            writer.on('close', () => {
                if (response.data && typeof response.data.destroy === 'function') {
                    response.data.destroy(); // Hancurkan socket agar PHP (artisan serve) tidak hang
                }
                resolve();
            });
            writer.on('error', (writeErr) => {
                reject(new Error('Gagal menulis file PDF sementara: ' + writeErr.message));
            });
        });

        // FIX: Validasi ukuran file agar tidak mencetak file PDF kosong/rusak
        const stat = fs.statSync(tempFilePath);
        if (stat.size < 100) {
            throw new Error('File PDF yang diunduh tidak valid atau kosong. Periksa URL sumber dokumen.');
        }
        if (jobInfo.isCancelled) throw new Error('Dibatalkan sebelum proses cetak dimulai');
        jobInfo.status = 'Sedang mencetak...';
        console.log(`[INFO] Mencetak ke printer: ${printerName} | Ukuran file: ${fs.statSync(tempFilePath).size} bytes`);
        
        // Fix untuk linux karena unix-print tidak menangani spasi nama printer dengan benar yang menyebabkan perintah lp gagal/timeout
        const windowsPrintOptions = { 
            printer: printerName, 
            sumatraPdfPath: sumatraDest,
            scale: 'shrink', // Menggunakan shrink agar dokumen yang terlalu besar akan dikecilkan agar pas, mencegah terpotong
            monochrome: true
        };
        if (paperSize) {
            windowsPrintOptions.paperSize = paperSize;
        }
        if (orientation) {
            windowsPrintOptions.orientation = orientation;
        }

        let linuxLpCommand = `lp "${tempFilePath}" -d "${printerName}" -o fit-to-page -o print-scaling=fit -o page-left=0 -o page-right=0 -o page-top=0 -o page-bottom=0`;
        if (paperSize) linuxLpCommand += ` -o media="${paperSize}"`;
        if (orientation === 'landscape') linuxLpCommand += ` -o landscape`;
        else if (orientation === 'portrait') linuxLpCommand += ` -o portrait`;

        const printPromise = isWindows 
            ? ptp.print(tempFilePath, windowsPrintOptions) 
            : execAsync(linuxLpCommand);

        await Promise.race([
            printPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Proses cetak timeout. Printer mungkin offline, mati, atau antrean penuh.')), 60000))
        ]);

        if (jobInfo.isCancelled) throw new Error('Dibatalkan saat proses cetak (Spooler sudah menerimanya, tapi mungkin tidak tercetak)');

        // FIX: Tulis log SEBELUM kirim response agar urutan logis & tidak bisa gagal silent
        try {
            db.get('logs').push({
                timestamp: new Date().toISOString(),
                url: url,
                type: type || '-',
                printerName: printerName,
                status: 'sukses',
                message: `Berhasil dicetak | Kertas: ${paperSize || 'Default'} | Orientasi: ${orientation || 'Default'}`
            }).write();
        } catch (logErr) {
            console.error('[WARNING] Gagal menyimpan log sukses:', logErr.message);
        }

        // Cleanup file temp setelah log tercatat
        await cleanupTempFile();

        if (!res.headersSent) {
            res.json({ success: true, message: `Berhasil mencetak ke ${printerName}` });
        }

    } catch (error) {
        console.error('[ERROR] Gagal mencetak:', error.message);
        
        // Pastikan cleanup tetap berjalan saat error
        await cleanupTempFile();

        // Tulis log error dengan try/catch agar tidak menyembunyikan error asli
        try {
            db.get('logs').push({
                timestamp: new Date().toISOString(),
                url: url,
                type: type || '-',
                printerName: printerName || '-',
                status: 'gagal',
                message: error.message || String(error)
            }).write();
        } catch (logErr) {
            console.error('[WARNING] Gagal menyimpan log error:', logErr.message);
        }

        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Gagal mencetak: ' + (error.message || String(error)) });
        }
    } finally {
        // Hapus dari list job berjalan dengan jeda sedikit agar UI sempat memperbarui
        setTimeout(() => {
            activeJobs = activeJobs.filter(j => j.id !== jobId);
        }, 1500);
    }
});

app.listen(port, () => {
    console.log(`🚀 Local Print Agent berjalan di http://localhost:${port}`);
    console.log(`Panggil GET http://localhost:${port}/printers untuk melihat daftar nama printer Anda.`);
    
    // Otomatis buka browser ke halaman dashboard
    const dashboardUrl = `http://localhost:${port}`;
    if (isWindows) {
        execAsync(`start ${dashboardUrl}`).catch(() => {});
    } else if (os.platform() === 'darwin') {
        execAsync(`open ${dashboardUrl}`).catch(() => {});
    } else {
        execAsync(`xdg-open ${dashboardUrl}`).catch(() => {});
    }
});
