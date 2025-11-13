import 'dotenv/config';
import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import multer from 'multer';
import path from 'path';
import { promises as fs } from 'fs';
import fsSync from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { createCanvas, loadImage } from 'canvas';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// ES Module equivalents for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Set ffmpeg path if using ffmpeg-static
try {
  const ffmpegStatic = await import('ffmpeg-static');
  ffmpeg.setFfmpegPath(ffmpegStatic.default);
} catch (err) {
  console.log('ffmpeg-static not found, using system ffmpeg');
}

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from public directory
app.use(express.static('public'));
app.use(express.json());

// ---------- Gemini ----------
if (!process.env.GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY not found in environment variables');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// ---------- Multer (store original video) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'video/mp4', 'video/mpeg', 'video/quicktime', 
      'video/x-msvideo', 'video/webm',
      'image/jpeg', 'image/jpg', 'image/png', 'image/webp'
    ];
    if (allowedMimes.includes(file.mimetype) || 
        file.mimetype.startsWith('video/') || 
        file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video and image files are allowed'));
    }
  }
});

// Create directories synchronously at startup

// ---------- Helper: extract 1 frame per second ----------
async function extractFrames(videoPath) {
  return new Promise((resolve, reject) => {
    const frameDir = path.join('/tmp', `frames_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);
    
    try {
      fsSync.mkdirSync(frameDir, { recursive: true });
    } catch (err) {
      return reject(new Error(`Failed to create frame directory: ${err.message}`));
    }

    ffmpeg(videoPath)
      .outputOptions('-vf', 'fps=1') // 1 fps
      .output(path.join(frameDir, 'frame_%04d.png'))
      .on('end', () => {
        try {
          const files = fsSync.readdirSync(frameDir);
          const frames = files
            .filter(f => f.endsWith('.png'))
            .sort()
            .map(f => path.join(frameDir, f));
          
          if (frames.length === 0) {
            reject(new Error('No frames extracted from video'));
          } else {
            resolve({ frames, frameDir });
          }
        } catch (err) {
          reject(new Error(`Failed to read frames: ${err.message}`));
        }
      })
      .on('error', err => reject(new Error(`FFmpeg error: ${err.message}`)))
      .run();
  });
}

// ---------- Helper: process image file ----------
async function processImage(imagePath) {
  const frameDir = path.join('/tmp', `image_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);
  fsSync.mkdirSync(frameDir, { recursive: true });
  
  // Copy image to temp directory
  const destPath = path.join(frameDir, 'frame_0001.png');
  await fs.copyFile(imagePath, destPath);
  
  return { frames: [destPath], frameDir };
}

// ---------- Helper: stitch frames side-by-side ----------
async function collageFrames(frames, maxFrames = 20) {
  if (frames.length === 0) throw new Error('No frames to collage');

  // Limit frames to avoid memory issues
  const selectedFrames = frames.length > maxFrames
    ? frames.filter((_, i) => i % Math.ceil(frames.length / maxFrames) === 0).slice(0, maxFrames)
    : frames;

  const SAMPLE_SIZE = 320; // resize each frame to this width
  const images = await Promise.all(
    selectedFrames.map(async p => {
      try {
        return await loadImage(p);
      } catch (err) {
        console.error(`Failed to load image ${p}:`, err);
        return null;
      }
    })
  );

  // Filter out failed images
  const validImages = images.filter(img => img !== null);
  if (validImages.length === 0) throw new Error('Failed to load any images');

  const heights = validImages.map(img => Math.round((SAMPLE_SIZE / img.width) * img.height));
  const maxHeight = Math.max(...heights, 200);
  const totalWidth = SAMPLE_SIZE * validImages.length;

  const canvas = createCanvas(totalWidth, maxHeight);
  const ctx = canvas.getContext('2d');

  // Fill background with white
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, totalWidth, maxHeight);

  let x = 0;
  for (let i = 0; i < validImages.length; i++) {
    const img = validImages[i];
    const h = heights[i];
    ctx.drawImage(img, x, (maxHeight - h) / 2, SAMPLE_SIZE, h);
    x += SAMPLE_SIZE;
  }

  return canvas.toBuffer('image/jpeg', { quality: 0.85 });
}

// ---------- Cleanup helper ----------
async function cleanupFiles(filePaths, directories) {
  for (const filePath of filePaths) {
    try {
      if (fsSync.existsSync(filePath)) {
        await fs.unlink(filePath);
      }
    } catch (err) {
      console.error(`Failed to delete file ${filePath}:`, err);
    }
  }

  for (const dir of directories) {
    try {
      if (fsSync.existsSync(dir)) {
        const files = await fs.readdir(dir);
        await Promise.all(files.map(f => fs.unlink(path.join(dir, f))));
        await fs.rmdir(dir);
      }
    } catch (err) {
      console.error(`Failed to cleanup directory ${dir}:`, err);
    }
  }
}

// ---------- Routes ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
import { randomUUID } from 'crypto';

app.post('/analyze', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  const tmpPath = `/tmp/${randomUUID()}`;
  await fs.writeFile(tmpPath, req.file.buffer);
  const filePath = tmpPath;
    const mode = req.body.mode || 'scan'; // 'scan' or 'add'
  let tempDirToDelete = null;

  try {
    console.log(`Processing ${req.file.mimetype}: ${req.file.originalname}`);

    let frames, frameDir;
    
    // Check if it's an image or video
    if (req.file.mimetype.startsWith('image/')) {
      ({ frames, frameDir } = await processImage(filePath));
      console.log(`Processed image`);
    } else {
      ({ frames, frameDir } = await extractFrames(filePath));
      console.log(`Extracted ${frames.length} frames from video`);
    }
    
    tempDirToDelete = frameDir;

    // Build collage
    const collageBuffer = await collageFrames(frames);
    const mimeType = 'image/jpeg';
    const base64 = collageBuffer.toString('base64');
    console.log('Collage created successfully');

    // ---------- AI CALL (Gemini → Groq fallback) ----------
    let description = '';
    let usedModel = 'gemini';

    try {
      // ----- GEMINI -----
      const prompt = `You are a product-recognition assistant. 
Look at this collage of video/image frames and list EVERY DISTINCT product, brand, or item you can identify.

Rules:
- List one product per line
- Include brand names when visible
- Be specific (e.g., "iPhone 15" not just "phone")
- Only list products you can clearly see
- No explanations or extra text

Products:`;

      const imagePart = {
        inlineData: { data: base64, mimeType },
      };

      const result = await model.generateContent([prompt, imagePart]);
      const response = await result.response;
      description = response.text().trim();
      console.log('Gemini analysis complete');
    } catch (geminiErr) {
      console.warn('Gemini failed, falling back to Groq Llama-Vision:', geminiErr.message);
      usedModel = 'groq-llama-vision';

      // ----- GROQ FALLBACK -----
      if (!process.env.GROQ_API_KEY) {
        throw new Error('Gemini failed and GROQ_API_KEY is missing');
      }

      const { Groq } = await import('groq-sdk');
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

      const chatCompletion = await groq.chat.completions.create({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',   // <-- latest vision model (as of Nov 2025)
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: `You are a product-recognition assistant. 
List EVERY DISTINCT product/brand/item you see in the attached collage.
- One per line
- Be specific (e.g., "Coca-Cola Zero 330ml")
- No extra text` },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64}`
                }
              }
            ]
          }
        ],
        temperature: 0.2,
        max_tokens: 1024
      });

      description = chatCompletion.choices[0]?.message?.content?.trim() ?? '';
      console.log('Groq Llama-Vision analysis complete');
    }


    // Parse products
    const productList = description.split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => line.trim().replace(/^[-•*]\s*/, ''))
      .filter(line => line.length > 0);

    // Format products for inventory
    const products = productList.map(name => ({
      name: name,
      price: null,
      stock: 1,
      added: new Date().toISOString()
    }));

    res.json({
      success: true,
      products: products,
      collageBase64: base64,
      mode: mode
    });

  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  } finally {
    // Cleanup
    await cleanupFiles(
      [filePath],
      tempDirToDelete ? [tempDirToDelete] : []
    );
  }
});


// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({
    success: false,
    error: err.message
  });
});

// ✅ Export the Express app for Vercel (DO NOT listen)
export default app;

// ✅ Optional: still allow local development
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`✅ Local server running at http://localhost:${PORT}`);
    console.log(`📁 Make sure index.html is in the 'public' folder`);
  });
}
