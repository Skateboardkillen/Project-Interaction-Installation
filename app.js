const express  = require('express');
const path     = require('path');
const multer   = require('multer');
const QRCode   = require('qrcode');
const { randomUUID } = require('crypto');
const { Redis } = require('@upstash/redis');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// ── Clients ────────────────────────────────────────────────────────────────
const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Multer — memory storage, no disk write needed ──────────────────────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files are accepted'));
    },
});

// ── Redis keys ─────────────────────────────────────────────────────────────
const KEY_TOKEN       = 'session:current_token';
const KEY_UPLOAD      = 'session:latest_upload';
const KEY_LEADERBOARD = 'leaderboard';
const TTL_TOKEN       = 60 * 60;
const TTL_UPLOAD      = 60 * 60 * 2;

// ── Gemini prompt ──────────────────────────────────────────────────────────
const GEMINI_PROMPT = `You are the language evaluation AI for an exclusive job application process. Your sole criterion is linguistic sophistication — vocabulary range, sentence complexity, formal register, and precision of expression. You are deliberately elitist about language and utterly unimpressed by mediocrity.

Analyze the handwritten responses on this job application form image.

SCORING GUIDE (0–100, language sophistication only):
  90–100 : Exceptional command of English — rare vocabulary, intricate syntax, flawless formal register
  70–89  : Strong — above-average vocabulary, mostly complex structures, clear formal tone
  50–69  : Adequate — moderate vocabulary, mixed sentence complexity, some formal language
  30–49  : Basic — limited vocabulary, simple sentences, mostly plain or informal language
  0–29   : Poor — very simple or broken language, minimal vocabulary, little to no formal register

Also extract the applicant's full name from the "Name:" field at the top of the form. If the name field is blank or illegible, use "Anonymous".

Write exactly ONE short, arrogant, condescending remark (1–2 sentences max) from the perspective of an overly corporate AI evaluator who takes language sophistication extremely seriously. Be subtly elitist and cutting — as if mildly offended by anything below perfection.

Respond with valid JSON only — no markdown, no code fences, no explanation:
{"score": <integer 0-100>, "name": "<applicant name>", "comment": "<arrogant remark>"}`;

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
    const token = randomUUID();
    await redis.set(KEY_TOKEN, token, { ex: TTL_TOKEN });
    await redis.del(KEY_UPLOAD);

    const base      = `${req.protocol}://${req.get('host')}`;
    const mobileUrl = `${base}/mobile-upload?token=${token}`;
    const qrDataUrl = await QRCode.toDataURL(mobileUrl, {
        width:           320,
        margin:          2,
        color: { dark: '#00ff41', light: '#000000' },
    });
    res.render('upload', { qrDataUrl, mobileUrl });
});

app.get('/mobile-upload', async (req, res) => {
    const { token }    = req.query;
    const currentToken = await redis.get(KEY_TOKEN);
    const invalid      = !token || token !== currentToken;
    res.render('mobileUpload', { token: invalid ? null : token, invalid });
});

// Receive photo, analyze with Gemini, store result + push to leaderboard
app.post('/upload/submit', upload.single('formPhoto'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file received' });

    const { token }    = req.body;
    const currentToken = await redis.get(KEY_TOKEN);
    if (!token || token !== currentToken) {
        return res.status(403).json({ error: 'Invalid or expired session. Please scan the QR code again.' });
    }

    try {
        let score   = null;
        let name    = 'Anonymous';
        let comment = 'Our systems were unable to complete the evaluation.';

        try {
            const model  = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
            const result = await model.generateContent([
                {
                    inlineData: {
                        data:     req.file.buffer.toString('base64'),
                        mimeType: req.file.mimetype,
                    },
                },
                GEMINI_PROMPT,
            ]);

            const raw  = result.response.text().trim().replace(/^```json\n?/, '').replace(/\n?```$/, '');
            const data = JSON.parse(raw);
            score   = Math.min(100, Math.max(0, Math.round(data.score)));
            name    = (data.name || 'Anonymous').trim();
            comment = data.comment || comment;
        } catch (geminiErr) {
            console.error('Gemini analysis failed:', geminiErr.message);
        }

        const entry = { score, name, comment, ts: Date.now() };

        // Store current session result (for result page)
        await redis.set(KEY_UPLOAD, entry, { ex: TTL_UPLOAD });

        // Append to persistent leaderboard (only if we got a valid score)
        if (score !== null) {
            await redis.lpush(KEY_LEADERBOARD, JSON.stringify(entry));
        }

        res.json({ ok: true });

    } catch (err) {
        console.error('Upload processing failed:', err);
        res.status(500).json({ error: 'Processing failed. Please try again.' });
    }
});

app.get('/upload/status', async (req, res) => {
    const data = await redis.get(KEY_UPLOAD);
    res.json(data || { pending: true });
});

app.post('/upload/clear', async (req, res) => {
    await redis.del(KEY_UPLOAD);
    res.json({ ok: true });
});

app.get('/result', async (req, res) => {
    const data = await redis.get(KEY_UPLOAD);
    if (!data) return res.redirect('/upload');
    res.render('result', {
        score:   data.score,
        name:    data.name   || 'Anonymous',
        comment: data.comment,
    });
});

app.get('/leaderboard', async (req, res) => {
    const raw     = await redis.lrange(KEY_LEADERBOARD, 0, -1);
    const entries = raw
        .map(e => typeof e === 'string' ? JSON.parse(e) : e)
        .sort((a, b) => b.score - a.score);
    res.render('leaderboard', { entries });
});

// ── Start ──────────────────────────────────────────────────────────────────
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

module.exports = app;
