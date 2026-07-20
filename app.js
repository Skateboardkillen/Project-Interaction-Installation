require('dotenv').config();
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
const KEY_PRINT_QUEUE = 'print:queue';
const TTL_TOKEN       = 60 * 60;
const TTL_UPLOAD      = 60 * 60 * 2;

// Shared secret the printer's Python script presents when polling for jobs.
const PRINTER_SECRET = process.env.PRINTER_SECRET;

// Score needed to pass — shared by the result page and the printed ticket.
const PASS_THRESHOLD = 90;
function getStatus(score) {
    if (score === null || score === undefined) return null;
    return score >= PASS_THRESHOLD ? 'ACCEPTED' : 'FAILED';
}

// ── Gemini prompt ──────────────────────────────────────────────────────────
const GEMINI_PROMPT = `You are the language evaluation AI for an exclusive job application process. Your sole criterion is linguistic sophistication — vocabulary range, sentence complexity, formal register, and precision of expression. You are deliberately elitist about language and utterly unimpressed by mediocrity.

This image shows a printed job application form. The form contains PRE-PRINTED questions — ignore those entirely. You must evaluate ONLY the handwritten text that the applicant has added by hand (written answers, ticked checkboxes, filled-in fields).

CRITICAL RULES:
- If there is NO handwritten content at all (blank form, nothing filled in), assign a score of 0 and comment accordingly.
- Ignore all pre-printed text, headers, instructions, and checkbox labels on the form — these were not written by the applicant.
- Only judge the language in the applicant's own handwritten responses.
- Ticked checkboxes alone (with no written text) count as minimal effort.

SCORING GUIDE (0–100, handwritten responses only):
  90–100 : Exceptional — rare vocabulary, intricate syntax, flawless formal register in the written answers
  70–89  : Strong — above-average vocabulary, clear formal tone in the written answers
  50–69  : Adequate — moderate vocabulary, some formal language in the written answers
  30–49  : Basic — limited vocabulary, simple sentences in the written answers
  1–29   : Poor — very basic or minimal written content
  0      : Nothing written — the form is blank or only has ticked boxes with no written responses

Also extract the applicant's full name from the handwritten entry on the "Name:" line at the top. If that line is blank, use "Anonymous".

Write exactly ONE short, arrogant, condescending remark (1–2 sentences max) from the perspective of an overly corporate AI evaluator. Be subtly elitist and cutting. If the form is blank, be especially dismissive.

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

    const base =
        process.env.APP_URL ||
        (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
        `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.get('host')}`;
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
        // Signal immediately so the desktop poll shows "processing" without waiting for Gemini
        await redis.set(KEY_UPLOAD, { received: true, processing: true }, { ex: TTL_UPLOAD });

        let score   = null;
        let name    = 'Anonymous';
        let comment = 'Our systems were unable to complete the evaluation.';

        const MODELS   = ['gemini-2.5-flash', 'gemini-1.5-flash-latest'];
        const MAX_TRIES = 4;
        const sleep     = ms => new Promise(r => setTimeout(r, ms));

        outer: for (const modelName of MODELS) {
            for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
                try {
                    const model  = genAI.getGenerativeModel({ model: modelName });
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
                    break outer; // success — stop all retries
                } catch (err) {
                    const msg = err.message || '';
                    const isRetryable = msg.includes('503') || msg.includes('429') || msg.includes('overloaded');
                    console.error(`Gemini [${modelName}] attempt ${attempt} failed: ${msg.slice(0, 120)}`);
                    if (isRetryable && attempt < MAX_TRIES) {
                        await sleep(attempt * 4000); // 4s, 8s, 12s
                    } else {
                        break; // non-retryable or out of attempts — try next model
                    }
                }
            }
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
        status:  getStatus(data.score),
    });
});

// Called client-side by the result page once it renders — queues the
// current session's result for the printer to pick up.
app.post('/print/enqueue', async (req, res) => {
    const data = await redis.get(KEY_UPLOAD);
    if (!data) return res.json({ ok: false, reason: 'no-result' });
    if (data.printed) return res.json({ ok: true, reason: 'already-queued' });

    await redis.rpush(KEY_PRINT_QUEUE, JSON.stringify({
        name:    data.name || 'Anonymous',
        score:   data.score,
        comment: data.comment,
        status:  getStatus(data.score),
        ts:      Date.now(),
    }));
    await redis.set(KEY_UPLOAD, { ...data, printed: true }, { ex: TTL_UPLOAD });

    res.json({ ok: true });
});

// Polled by the printer's Python script (on a separate network) to fetch
// and dequeue the next print job. Requires the shared PRINTER_SECRET.
app.get('/print/next', async (req, res) => {
    if (!PRINTER_SECRET) return res.status(500).json({ error: 'PRINTER_SECRET not configured' });

    const key = req.get('x-printer-key');
    if (key !== PRINTER_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const raw = await redis.lpop(KEY_PRINT_QUEUE);
    if (!raw) return res.json({ job: null });

    const job = typeof raw === 'string' ? JSON.parse(raw) : raw;
    res.json({ job });
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
