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
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

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

// ── SSE: notify the upload page when a photo arrives ──────────────────────
const uploadClients = [];

function broadcastUpload(data) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    uploadClients.forEach(client => client.write(payload));
    uploadClients.length = 0; // clear after broadcast
}

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
    broadcastUpload({ filename: req.file.filename, path: req.file.path });
    res.json({ ok: true, filename: req.file.filename });
});

// SSE endpoint — desktop upload page listens here
app.get('/upload/events', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    // Keep-alive ping every 20 s
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);

    uploadClients.push(res);
    req.on('close', () => {
        clearInterval(ping);
        const i = uploadClients.indexOf(res);
        if (i !== -1) uploadClients.splice(i, 1);
    });
});

// ── Start ──────────────────────────────────────────────────────────────────
if (require.main === module) {
    app.listen(process.env.PORT || PORT, () => {
        console.log(`Server running at http://localhost:${process.env.PORT || PORT}`);
    });
}

module.exports = app;
