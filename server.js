import 'dotenv/config';
import express from 'express';
import bcrypt from 'bcrypt';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import { createCanvas, loadImage } from 'canvas';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';

ffmpeg.setFfmpegPath(ffmpegStatic);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'db.sqlite');
// Video → Frames → Collage
async function extractFrames(videoPath) {
    return new Promise((resolve, reject) => {
      const frameDir = path.join('public', 'temp', `frames_${Date.now()}`);
      fs.mkdirSync(frameDir, { recursive: true });
  
      ffmpeg(videoPath)
        .outputOptions('-vf', 'fps=1')
        .output(path.join(frameDir, 'frame_%04d.png'))
        .on('end', () => {
          const frames = fs.readdirSync(frameDir)
            .filter(f => f.endsWith('.png'))
            .map(f => path.join(frameDir, f))
            .sort();
          resolve({ frames, frameDir });
        })
        .on('error', reject)
        .run();
    });
  }
  
  async function collageFrames(frames) {
    if (!frames.length) throw new Error('No frames');
  
    const SAMPLE = 320;
    const imgs = await Promise.all(frames.map(p => loadImage(p)));
    const heights = imgs.map(i => Math.round((SAMPLE / i.width) * i.height));
    const maxH = Math.max(...heights, 200);
    const canvas = createCanvas(SAMPLE * imgs.length, maxH);
    const ctx = canvas.getContext('2d');
  
    imgs.forEach((img, i) => {
      const h = heights[i];
      ctx.drawImage(img, i * SAMPLE, (maxH - h) / 2, SAMPLE, h);
    });
  
    return canvas.toBuffer('image/jpeg', { quality: 0.85 });
  }

// Open DB
const db = await open({
  filename: DB_PATH,
  driver: sqlite3.Database,
});

// Run migrations
await db.exec(fs.readFileSync(path.join(__dirname, 'migrations', 'init.sql'), 'utf8'));

// Express
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(cookieParser());

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-prod';

// Auth Middleware
const ensureAuth = (req, res, next) => {
  const token = req.cookies.jwt;
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      return next();
    } catch (err) {
      res.clearCookie('jwt');
    }
  }
  res.redirect('/login');
};

const ensureAuthAPI = (req, res, next) => {
  let token = req.cookies.jwt;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      return next();
    } catch (err) {}
  }
  res.status(401).json({ error: 'Unauthorized' });
};

// Multer – accepts 'media' field (from frontend)
const upload = multer({ dest: 'public/uploads/' }).single('media');
if (!fs.existsSync('public/uploads')) fs.mkdirSync('public/uploads', { recursive: true });
if (!fs.existsSync('public/temp')) fs.mkdirSync('public/temp', { recursive: true });

// Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
app.get('/test-gemini', async (req, res) => {
    try {
      const result = await model.generateContent('Say "Hello"');
      res.send(await result.response.text());
    } catch (e) {
      res.status(500).send(e.message);
    }
  });


// === ROUTES ===

// Root → Dashboard
app.get('/', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// === AUTH ===
app.get('/signup', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signup – LocalHub</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f4f4f4;padding:2rem;}
  .card{background:#fff;padding:2rem;border-radius:1rem;box-shadow:0 4px 12px rgba(0,0,0,.1);max-width:500px;margin:auto;}
  input,button{margin:0.5rem 0;padding:0.75rem;width:100%;border-radius:0.5rem;border:1px solid #ccc;}
  button{background:#2563eb;color:#fff;cursor:pointer;}
  #map{height:200px;margin:1rem 0;border-radius:0.5rem;}
  .status{margin:0.5rem 0;font-size:0.9rem;}
</style>
</head><body>
<div class="card">
<h2>Create Shop Account</h2>
<form id="signupForm">
  <input type="email" name="email" placeholder="Email" required><br>
  <input type="password" name="password" placeholder="Password" required><br>
  <input type="text" name="shop_name" placeholder="Shop Name" required><br>
  <p><strong>Location</strong></p>
  <button type="button" id="captureBtn">Get Live Location</button>
  <p class="status" id="locStatus">Click to capture</p>
  <div id="map"></div>
  <input type="hidden" name="lat" id="latField">
  <input type="hidden" name="lng" id="lngField">
  <button type="submit" id="submitBtn" disabled>Create Account</button>
</form>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
let map, marker;
document.getElementById('captureBtn').onclick = () => {
  const status = document.getElementById('locStatus');
  status.textContent = 'Requesting...';
  if (!navigator.geolocation) return status.textContent = 'Not supported';

  navigator.geolocation.getCurrentPosition(pos => {
    const lat = pos.coords.latitude, lng = pos.coords.longitude;
    status.textContent = \`Captured: \${lat.toFixed(6)}, \${lng.toFixed(6)}\`;
    document.getElementById('latField').value = lat;
    document.getElementById('lngField').value = lng;
    document.getElementById('submitBtn').disabled = false;

    if (!map) {
      map = L.map('map').setView([lat, lng], 17);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
    }
    if (marker) marker.setLatLng([lat, lng]);
    else marker = L.marker([lat, lng]).addTo(map);
  }, () => status.textContent = 'Failed');
};

document.getElementById('signupForm').onsubmit = async e => {
  e.preventDefault();
  const form = new FormData(e.target);
  const resp = await fetch('/signup', { method: 'POST', body: new URLSearchParams(form) });
  if (resp.ok) location.href = '/';
  else alert('Signup failed: ' + (await resp.text()));
};
</script>
</body></html>
  `);
});

app.post('/signup', async (req, res) => {
  const { email, password, shop_name, lat, lng } = req.body;
  const hash = await bcrypt.hash(password, 10);
  try {
    const result = await db.run(
      `INSERT INTO users (email, password, shop_name, lat, lng) VALUES (?,?,?,?,?)`,
      [email, hash, shop_name, lat, lng]
    );
    const user = { id: result.lastID, email, shop_name, lat, lng };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '24h' });
    res.cookie('jwt', token, { httpOnly: true, secure: false, maxAge: 24 * 60 * 60 * 1000 });
    res.json({ success: true });
  } catch (e) {
    res.status(500).send(`Error: ${e.message}`);
  }
});

app.get('/login', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login – LocalHub</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f4f4f4;padding:2rem;}
  .card{background:#fff;padding:2rem;border-radius:1rem;box-shadow:0 4px 12px rgba(0,0,0,.1);max-width:500px;margin:auto;}
  input,button{margin:0.5rem 0;padding:0.75rem;width:100%;border-radius:0.5rem;border:1px solid #ccc;}
  button{background:#2563eb;color:#fff;cursor:pointer;}
</style>
</head><body>
<div class="card">
<h2>Login</h2>
<form id="loginForm">
  <input type="email" name="email" placeholder="Email" required><br>
  <input type="password" name="password" placeholder="Password" required><br>
  <button type="submit">Login</button>
</form>
<p><a href="/signup">Create account</a></p>
</div>
<script>
document.getElementById('loginForm').onsubmit = async e => {
  e.preventDefault();
  const form = new FormData(e.target);
  const resp = await fetch('/login', { method: 'POST', body: new URLSearchParams(form) });
  if (resp.ok) location.href = '/';
  else alert('Login failed');
};
</script>
</body></html>
  `);
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await db.get('SELECT * FROM users WHERE email = ?', email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });
  const tokenUser = { id: user.id, email: user.email, shop_name: user.shop_name, lat: user.lat, lng: user.lng };
  const token = jwt.sign(tokenUser, JWT_SECRET, { expiresIn: '24h' });
  res.cookie('jwt', token, { httpOnly: true, secure: false, maxAge: 24 * 60 * 60 * 1000 });
  res.json({ success: true });
});

app.get('/logout', (req, res) => {
  res.clearCookie('jwt');
  res.redirect('/login');
});

// === API ===
app.get('/api/shop', ensureAuthAPI, (req, res) => {
  res.json({
    shop_name: req.user.shop_name,
    lat: req.user.lat,
    lng: req.user.lng
  });
});

app.get('/api/inventory', ensureAuthAPI, async (req, res) => {
  const items = await db.all(
    'SELECT * FROM inventory WHERE user_id = ? ORDER BY created_at DESC',
    req.user.id
  );
  res.json(items);
});

app.post('/api/inventory', ensureAuthAPI, async (req, res) => {
  const { product_name, price } = req.body;
  await db.run(
    'INSERT INTO inventory (user_id, product_name, price, stock) VALUES (?,?,?,?)',
    [req.user.id, product_name, price || null, 'In Stock']
  );
  res.json({ ok: true });
});

app.put('/api/inventory/:id', ensureAuthAPI, async (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  const set = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  await db.run(
    `UPDATE inventory SET ${set} WHERE id = ? AND user_id = ?`,
    [...Object.values(updates), id, req.user.id]
  );
  res.json({ ok: true });
});

app.delete('/api/inventory/:id', ensureAuthAPI, async (req, res) => {
  await db.run('DELETE FROM inventory WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

app.get('/api/inventory/export', ensureAuthAPI, async (req, res) => {
  const items = await db.all(
    'SELECT product_name, price, stock, created_at FROM inventory WHERE user_id = ?',
    req.user.id
  );
  const csv = [
    ['Product', 'Price', 'Stock', 'Added'].join(','),
    ...items.map(i => `"${i.product_name}","${i.price||''}","${i.stock||''}","${i.created_at}"`)
  ].join('\n');
  res.type('text/csv').send(csv);
});

// === ANALYZE (IMAGE OR VIDEO) – FAST COLLAGE FOR VIDEOS, DIRECT FOR IMAGES ===
app.post('/analyze', ensureAuthAPI, (req, res) => {
    upload(req, res, async err => {
      if (err) return res.status(400).send(err.message);
  
      const file = req.file;               // uploaded file (image or video)
      const mode = req.body.mode || 'append';
  
      let base64ForGemini = '';
      let mimeForGemini = '';
  
      let tempDirToDelete = null;          // for video cleanup
  
      try {
        // ---------- 1. IMAGE: direct to Gemini (no collage) ----------
        if (file.mimetype.startsWith('image/')) {
          base64ForGemini = fs.readFileSync(file.path, 'base64');
          mimeForGemini = file.mimetype;
        }
  
        // ---------- 2. VIDEO: collage approach ----------
        else if (file.mimetype.startsWith('video/')) {
          const { frames, frameDir } = await extractFrames(file.path);
          if (!frames.length) throw new Error('No frames extracted');
  
          const collageBuffer = await collageFrames(frames);
          base64ForGemini = collageBuffer.toString('base64');
          mimeForGemini = 'image/jpeg';
  
          // clean frames immediately
          frames.forEach(f => fs.unlinkSync(f));
          fs.rmdirSync(frameDir);
        } else {
          throw new Error('Unsupported file type (must be image or video)');
        }
  
        // ---------- 3. Gemini – ONE CALL (for either type) ----------
        const prompt = `You are a product-recognition assistant. 
  Look at the image (or collage of video frames) and list **every distinct product name** you see, one per line.
  Do NOT add explanations, numbers, or any extra text.`;
  
        const result = await model.generateContent([
          prompt,
          { inlineData: { data: base64ForGemini, mimeType: mimeForGemini } }
        ]);
  
        const products = (await result.response)
          .text()
          .trim()
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean);
  
        // ---------- 4. DB handling ----------
        if (mode === 'replace') {
          await db.run('DELETE FROM inventory WHERE user_id = ?', req.user.id);
        }
  
        const stmt = await db.prepare(
          'INSERT INTO inventory (user_id, product_name, stock) VALUES (?,?,?)'
        );
        for (const name of products) {
          await stmt.run(req.user.id, name, 'In Stock');
        }
        await stmt.finalize();
  
        res.json({ ok: true, added: products.length, products });
      } catch (e) {
        console.error('Analyze error:', e);
        res.status(500).send(e.message);
      } finally {
        // ---------- 5. Cleanup uploaded file ----------
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      }
    });
  });
// === PROFILE ===
app.get('/profile.html', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

app.put('/api/shop', ensureAuthAPI, async (req, res) => {
  const { shop_name, email, password, lat, lng } = req.body;
  const updates = [];
  const values = [];

  if (shop_name) { updates.push('shop_name = ?'); values.push(shop_name); }
  if (email) { updates.push('email = ?'); values.push(email); }
  if (password) { updates.push('password = ?'); values.push(await bcrypt.hash(password, 10)); }
  if (lat !== undefined && lng !== undefined) {
    updates.push('lat = ?', 'lng = ?');
    values.push(lat, lng);
  }

  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  values.push(req.user.id);
  await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);

  const updated = await db.get('SELECT id, email, shop_name, lat, lng FROM users WHERE id = ?', req.user.id);
  const token = jwt.sign(updated, JWT_SECRET, { expiresIn: '24h' });
  res.cookie('jwt', token, { httpOnly: true, secure: false, maxAge: 24 * 60 * 60 * 1000 });
  res.json({ ok: true });
});
// === PUBLIC SEARCH API ===
app.get('/api/search', async (req, res) => {
    const { product, lat, lng } = req.query;
    if (!product) return res.status(400).json({ error: 'product query required' });
  
    try {
      // Build a CASE-insensitive LIKE search
      const rows = await db.all(`
        SELECT 
          u.shop_name,
          u.lat,
          u.lng,
          i.product_name,
          i.stock,
          i.price,
          CASE 
            WHEN ? IS NOT NULL AND ? IS NOT NULL THEN
              (6371 * acos(
                cos(radians(?)) * cos(radians(u.lat)) * 
                cos(radians(u.lng) - radians(?)) + 
                sin(radians(?)) * sin(radians(u.lat))
              ))
            ELSE NULL
          END AS distance_km
        FROM inventory i
        JOIN users u ON i.user_id = u.id
        WHERE LOWER(i.product_name) LIKE LOWER(?)
        ORDER BY distance_km ASC
        LIMIT 50
      `, [lat, lng, lat, lng, lat, `%${product}%`]);
  
      // If no location supplied, just return the rows (distance_km = NULL)
      res.json(rows.map(r => ({
        shop_name: r.shop_name,
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lng),
        product_name: r.product_name,
        stock: r.stock || 'In Stock',
        price: r.price,
        distance: r.distance_km ? parseFloat(r.distance_km.toFixed(2)) : null
      })));
    } catch (e) {
      console.error('Search error:', e);
      res.status(500).json({ error: e.message });
    }
  });
// === START ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`http://localhost:${PORT}`));