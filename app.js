const express = require('express');
const path    = require('path');
const multer  = require('multer');
const QRCode  = require('qrcode');
const fs      = require('fs');

const app  = express();
const PORT = 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// ── File upload (multer) ───────────────────────────────────────────────────
// /tmp is the only writable path on Vercel (and works fine locally too)
const uploadDir = '/tmp/uploads';
try { fs.mkdirSync(uploadDir, { recursive: true }); } catch {}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename:    (req, file, cb) => {
        const ts  = Date.now();
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, `form-${ts}${ext}`);
    },
});
const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB cap
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files are accepted'));
    },
});

// ── Upload state (polling replaces SSE — works on serverless) ─────────────
// Stored in module-level memory; survives across requests on a warm instance.
let latestUpload = null;

// ── Routes ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.render('index', { username: 'User', date: new Date().toLocaleDateString() });
});

app.get('/waitingView', (req, res) => {
    res.render('waitingView', { username: 'User', date: new Date().toLocaleDateString() });
});

app.get('/installation-explanation', (req, res) => {
    res.render('installationExplanation');
});

app.get('/application', (req, res) => {
    res.render('application');
});

app.get('/upload', async (req, res) => {
    const base      = `${req.protocol}://${req.get('host')}`;
    const mobileUrl = `${base}/mobile-upload`;
    const qrDataUrl = await QRCode.toDataURL(mobileUrl, {
        width:           320,
        margin:          2,
        color: { dark: '#00ff41', light: '#000000' },
    });
    res.render('upload', { qrDataUrl, mobileUrl });
});

// Mobile-friendly photo capture page
app.get('/mobile-upload', (req, res) => {
    res.render('mobileUpload');
});

// Receive uploaded photo from phone
app.post('/upload/submit', upload.single('formPhoto'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    latestUpload = { filename: req.file.filename, path: req.file.path, ts: Date.now() };
    res.json({ ok: true, filename: req.file.filename });
});

// Polling endpoint — desktop page calls this every 2 s
app.get('/upload/status', (req, res) => {
    res.json(latestUpload || { pending: true });
});

// Clear upload state (called when desktop page moves on)
app.post('/upload/clear', (req, res) => {
    latestUpload = null;
    res.json({ ok: true });
});

// Serve uploaded images from /tmp
app.get('/uploads/:filename', (req, res) => {
    const file = path.join(uploadDir, path.basename(req.params.filename));
    res.sendFile(file, err => { if (err) res.status(404).send('Not found'); });
});

// Result page — shows the uploaded image
app.get('/result', (req, res) => {
    if (!latestUpload) return res.redirect('/upload');
    res.render('result', { filename: latestUpload.filename });
});

// ── Start ──────────────────────────────────────────────────────────────────
if (require.main === module) {
    app.listen(process.env.PORT || PORT, () => {
        console.log(`Server running at http://localhost:${process.env.PORT || PORT}`);
    });
}

module.exports = app;
