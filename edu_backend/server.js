import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { fileURLToPath } from 'url';
import path from 'path';

const backendDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(backendDir, 'api.env') });

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, configured: Boolean(process.env.GEMINI_API_KEY) });
});

function extractTextFromResponse(response) {
  if (!response) return '';

  if (typeof response.text === 'string' && response.text.trim()) {
    return response.text.trim();
  }

  const candidateText = response?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('\n') || '';
  if (candidateText.trim()) return candidateText.trim();

  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  return '';
}

function buildLocalChatFallback(prompt) {
  return `Here is a concise academic response for your teaching context:\n\n${prompt}\n\n- Start with the core concept in one sentence.\n- Explain the key principles using real-world examples relevant to CSE Semester 5.\n- Mention the practical application, advantages, limitations, and likely classroom discussion points.\n- Conclude with a short recap suitable for teaching or revision.`;
}

function buildLocalPaperMarkup({ college, subject, dept, syllabus, marks, date }, variant) {
  const variantLabel = variant === 'A' ? 'Standard Concept Exam' : 'Application-Based Exam';
  const safeSyllabus = String(syllabus || 'Cloud Computing and related units').replace(/\n/g, '<br>');

  return `
    <div style="font-family: Arial, sans-serif; max-width: 820px; margin: 0 auto; color: #111827; line-height: 1.6;">
      <div style="border: 2px solid #0f172a; padding: 24px; background: #ffffff;">
        <div style="text-align: center; border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 18px;">
          <div style="font-size: 13px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase;">${college}</div>
          <div style="font-size: 22px; font-weight: 700; margin-top: 8px;">${subject}</div>
          <div style="font-size: 12px; margin-top: 4px;">${dept} | Date: ${date} | Max Marks: ${marks}</div>
        </div>

        <div style="display: flex; justify-content: space-between; gap: 12px; font-size: 12px; font-weight: 600; margin-bottom: 18px;">
          <span>Exam Style: ${variantLabel}</span>
          <span>Department: ${dept}</span>
        </div>

        <div style="font-size: 12px; margin-bottom: 18px;"><strong>Syllabus Coverage:</strong><br>${safeSyllabus}</div>

        <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; text-decoration: underline; margin-bottom: 12px;">Part A (5 × 2 = 10 Marks)</div>
        <ol style="padding-left: 18px; margin: 0 0 18px; font-size: 12px;">
          <li>Define the main concept from the prescribed syllabus and state its importance.</li>
          <li>Differentiate between the core technologies or models discussed in the unit.</li>
          <li>Explain one practical example of the concept in a real-world system.</li>
          <li>List the key advantages, challenges, or limitations of the topic.</li>
          <li>Describe one real-life use case or scenario where this concept is applied.</li>
        </ol>

        <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; text-decoration: underline; margin-bottom: 12px;">Part B (4 × 10 = 40 Marks)</div>
        <ol style="padding-left: 18px; margin: 0; font-size: 12px;">
          <li>Explain the architecture, working process, and significance of the core topic in detail with examples.</li>
          <li>Compare the covered systems, concepts, or deployment models and discuss performance, scalability, and security trade-offs.</li>
          <li>Analyze a scenario-based problem and justify the most suitable design approach for the given setting.</li>
          <li>Discuss implementation considerations, challenges, and best practices for a real-world solution.</li>
        </ol>
      </div>
    </div>
  `;
}

// Initialize Google Gen AI SDK
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const GEMINI_MODEL = 'gemini-2.5-flash';
const PAPER_MODEL = 'gemini-2.5-flash';

async function generateAI(contents, model = GEMINI_MODEL) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  const models = model === GEMINI_MODEL ? [GEMINI_MODEL, PAPER_MODEL] : [model];
  let lastError;

  for (const currentModel of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await ai.models.generateContent({ model: currentModel, contents });
      } catch (error) {
        lastError = error;
        const status = error.status || error.code;
        if (![429, 503].includes(status)) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError;
}

// Endpoint for TeachMate Chatbot
app.post('/api/chat', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'A chat message is required.' });
    }

    const generated = await generateAI(prompt.trim());
    const responseText = extractTextFromResponse(generated) || buildLocalChatFallback(prompt.trim());
    res.json({ text: responseText, fallback: false });
  } catch (error) {
    console.error('Gemini Error:', error);
    const fallbackText = buildLocalChatFallback(req.body?.prompt || 'Academic assistance');
    const status = error.status === 429 || error.status === 503 ? 503 : 200;
    res.status(status).json({
      text: fallbackText,
      fallback: true,
      error: status === 503
        ? 'Gemini is temporarily busy. Please try again in a moment.'
        : 'Gemini is unavailable, so a local teaching fallback was used.'
    });
  }
});

// Endpoint for PaperGen Question Papers
app.post('/api/generate-paper', async (req, res) => {
  try {
    const { college, subject, dept, syllabus, marks, date } = req.body;
    if (![college, subject, dept, syllabus, marks, date].every(value => value !== undefined && String(value).trim())) {
      return res.status(400).json({ error: 'Complete question paper details are required.' });
    }

    const promptA = `Generate a formal college examination question paper for:
College: ${college} | Subject: ${subject} | Department: ${dept} | Date: ${date} | Max Marks: ${marks}
Syllabus: ${syllabus}
Format strictly as HTML inside a container: Header, Part A (5 short questions, 2 marks), Part B (4 long questions with choice, 10 marks). Focus on theory. Return clean HTML code only.`;

    const promptB = `Generate an alternative application-based question paper for:
College: ${college} | Subject: ${subject} | Department: ${dept} | Date: ${date} | Max Marks: ${marks}
Syllabus: ${syllabus}
Format strictly as HTML inside a container: Header, Part A (5 short questions, 2 marks), Part B (4 scenario-based problem questions, 10 marks). Return clean HTML code only.`;

    const resA = await generateAI(promptA, PAPER_MODEL);
    const resB = await generateAI(promptB, PAPER_MODEL);

    const variantA = extractTextFromResponse(resA) || buildLocalPaperMarkup({ college, subject, dept, syllabus, marks, date }, 'A');
    const variantB = extractTextFromResponse(resB) || buildLocalPaperMarkup({ college, subject, dept, syllabus, marks, date }, 'B');

    const cleanVariantA = variantA.replace(/```html\s*/gi, '').replace(/```/g, '').trim();
    const cleanVariantB = variantB.replace(/```html\s*/gi, '').replace(/```/g, '').trim();

    res.json({
      variantA: cleanVariantA,
      variantB: cleanVariantB,
      fallback: false
    });
  } catch (error) {
    console.error('Gemini Error:', error);
    const fallbackPaper = {
      variantA: buildLocalPaperMarkup(req.body, 'A'),
      variantB: buildLocalPaperMarkup(req.body, 'B'),
      fallback: true
    };

    const status = error.status === 429 || error.status === 503 ? 503 : 200;
    res.status(status).json({
      ...fallbackPaper,
      error: status === 503
        ? 'Gemini is temporarily busy. Please try generating the papers again in a moment.'
        : 'Gemini is unavailable, so a local exam paper template was used.'
    });
  }
});

app.listen(5000, () => {
  console.log("EduFlow Backend Server running on http://localhost:5000");
});