const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 1. Baca package.json
const pkgPath = path.join(__dirname, 'package.json');
const pkgData = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

// 2. Increment versi (patch)
let [major, minor, patch] = pkgData.version.split('.').map(Number);
patch += 1;
const newVersion = `${major}.${minor}.${patch}`;
pkgData.version = newVersion;

// Simpan kembali package.json
fs.writeFileSync(pkgPath, JSON.stringify(pkgData, null, 2));
console.log(`[INFO] Versi diupdate ke v${newVersion} di package.json`);

// 3. Update versi di index.html
const indexPath = path.join(__dirname, 'public', 'index.html');
let indexHtml = fs.readFileSync(indexPath, 'utf8');

// Gunakan regex untuk mereplace versi lama dengan versi baru
// Mencari: AIRA Local Print Agent vX.Y.Z
indexHtml = indexHtml.replace(/AIRA Local Print Agent v\d+\.\d+\.\d+/, `AIRA Local Print Agent v${newVersion}`);

fs.writeFileSync(indexPath, indexHtml);
console.log(`[INFO] Versi diupdate ke v${newVersion} di public/index.html`);

// 4. Jalankan proses build (pkg)
console.log('[INFO] Memulai proses build executable...');
try {
    execSync('npx pkg . --targets node16-linux-x64,node16-win-x64 --output dist/AIRA-Print-Agent', { stdio: 'inherit' });
    console.log(`[SUCCESS] Build aplikasi versi ${newVersion} selesai!`);
} catch (err) {
    console.error('[ERROR] Proses build gagal:', err.message);
    process.exit(1);
}
