import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

if (!process.env.OPENAI_API_KEY) {
  console.error("\n  ✖  OPENAI_API_KEY not set. Copy .env.example → .env and add your key.\n");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ dest: "/tmp/voice-uploads/", limits: { fileSize: 25 * 1024 * 1024 } });

// ─── Conversation Store (in-memory per session) ──────────────
const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000; // 30 min

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      messages: [{ role: "system", content: SYSTEM_PROMPT }],
      mode: "practice",
      scenario: null,
      created: Date.now()
    });
  }
  return sessions.get(id);
}

// Cleanup old sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.created > SESSION_TTL) sessions.delete(id);
  }
}, 5 * 60 * 1000);

// ─── System Prompt ───────────────────────────────────────────
const SYSTEM_PROMPT = `You are a warm, supportive, and insightful AI dating coach with deep expertise in communication, emotional intelligence, and building romantic connections. Your name is "Coach."

Your personality:
- Encouraging but honest — you celebrate wins and gently point out areas to improve
- Casual and fun — you talk like a cool, wise friend, not a therapist
- Perceptive — you pick up on tone, word choice, and confidence levels
- Non-judgmental — you never shame anyone for their experience level or mistakes

You have TWO modes:

### 1. PRACTICE MODE (role-play)
When the user wants to practice, you role-play as a date. You:
- Stay in character as the person they're practicing with
- Match the scenario they chose (first date, asking someone out, texting, etc.)
- Respond naturally and realistically — sometimes flirty, sometimes testing, sometimes challenging
- After each exchange, briefly break character with [COACH TIP: ...] to give one actionable insight
- Keep responses conversational — 1-3 sentences in character, then a short tip

### 2. ADVICE MODE
When the user asks for advice, profile review, or general help, you:
- Give specific, actionable advice (not generic platitudes)
- Use examples and even suggest exact phrases they could say
- Break down what works and why
- Reference psychology and communication principles when relevant
- Keep it concise — max 3-4 key points per response

### Guidelines:
- Ask clarifying questions when needed to give better advice
- Be inclusive of all orientations and relationship styles
- Never encourage manipulation, dishonesty, or disrespecting boundaries
- If someone seems distressed, be empathetic and suggest professional support
- Keep responses SHORT and conversational since this is voice — max 3-4 sentences unless they ask for detail
- Use natural speech patterns since your responses will be read aloud via TTS`;

// ─── Scenarios ───────────────────────────────────────────────
const SCENARIOS = {
  first_date: {
    name: "First Date Conversation",
    description: "Practice making great first-date conversation",
    setup: "You are now role-playing as someone on a first date with the user at a cozy coffee shop. Be friendly, a little nervous at first, and genuinely curious about them. Start with a warm greeting."
  },
  asking_out: {
    name: "Asking Someone Out",
    description: "Practice confidently asking someone on a date",
    setup: "You are now role-playing as someone the user has been chatting with and wants to ask out. Be friendly but not making it easy — they need to show confidence and genuine interest. Wait for them to make the move."
  },
  deep_convo: {
    name: "Getting Deeper",
    description: "Practice moving past small talk to meaningful connection",
    setup: "You are on a second date with the user. Small talk is done. Role-play as someone who wants to connect deeper but needs the user to lead the conversation to more meaningful topics. Be open but don't carry the conversation."
  },
  after_conflict: {
    name: "After a Disagreement",
    description: "Practice resolving tension and reconnecting",
    setup: "You are role-playing as the user's partner after a minor disagreement about plans this weekend. You're a bit distant but not hostile. The user needs to practice reconnecting, acknowledging feelings, and finding a resolution."
  },
  texting: {
    name: "Texting Game",
    description: "Practice flirty, engaging text conversations",
    setup: "You are role-playing as someone the user matched with on a dating app. Respond in a texting style — short messages, casual. Be interested but test if they can keep the conversation fun and engaging. Start with their opening message."
  }
};

// ─── Routes ──────────────────────────────────────────────────

// GET /api/scenarios
app.get("/api/scenarios", (req, res) => {
  const list = Object.entries(SCENARIOS).map(([key, s]) => ({ key, name: s.name, description: s.description }));
  res.json({ scenarios: list });
});

// POST /api/start — start a new session with optional scenario
app.post("/api/start", async (req, res) => {
  try {
    const { sessionId, scenario, mode } = req.body;
    const session = getSession(sessionId);
    session.mode = mode || "advice";
    session.messages = [{ role: "system", content: SYSTEM_PROMPT }];

    if (scenario && SCENARIOS[scenario]) {
      session.scenario = scenario;
      session.messages.push({ role: "system", content: SCENARIOS[scenario].setup });
      // Get opening line from the AI
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: session.messages,
        max_tokens: 200,
        temperature: 0.9
      });
      const reply = completion.choices[0].message.content;
      session.messages.push({ role: "assistant", content: reply });

      // Generate TTS
      const audioBase64 = await textToSpeech(reply);

      res.json({ reply, audio: audioBase64, scenario: SCENARIOS[scenario].name });
    } else {
      const greeting = "Hey! I'm your dating coach. You can ask me anything about dating — conversation tips, profile help, how to handle tricky situations — or we can jump into a practice scenario where I'll role-play with you. What sounds good?";
      session.messages.push({ role: "assistant", content: greeting });
      const audioBase64 = await textToSpeech(greeting);
      res.json({ reply: greeting, audio: audioBase64 });
    }
  } catch (err) {
    console.error("[start] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/chat — text message
app.post("/api/chat", async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    const session = getSession(sessionId);
    session.messages.push({ role: "user", content: message });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: session.messages,
      max_tokens: 300,
      temperature: 0.9
    });

    const reply = completion.choices[0].message.content;
    session.messages.push({ role: "assistant", content: reply });

    const audioBase64 = await textToSpeech(reply);

    res.json({ reply, audio: audioBase64 });
  } catch (err) {
    console.error("[chat] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voice — voice message (audio file)
app.post("/api/voice", upload.single("audio"), async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = getSession(sessionId);

    if (!req.file) return res.status(400).json({ error: "No audio file" });

    // Transcribe with Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: "whisper-1",
      response_format: "text"
    });

    // Cleanup temp file
    try { fs.unlinkSync(req.file.path); } catch(e) {}

    const userMessage = (typeof transcription === 'string' ? transcription : transcription.text || '').trim();
    if (!userMessage) return res.json({ transcript: "", reply: "I didn't catch that. Could you try again?", audio: null });

    session.messages.push({ role: "user", content: userMessage });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: session.messages,
      max_tokens: 300,
      temperature: 0.9
    });

    const reply = completion.choices[0].message.content;
    session.messages.push({ role: "assistant", content: reply });

    const audioBase64 = await textToSpeech(reply);

    res.json({ transcript: userMessage, reply, audio: audioBase64 });
  } catch (err) {
    console.error("[voice] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/feedback — get a detailed coaching summary of the session
app.post("/api/feedback", async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = getSession(sessionId);

    if (session.messages.length < 4) {
      return res.json({ feedback: "We need a bit more conversation before I can give meaningful feedback. Keep going!" });
    }

    const feedbackMessages = [
      ...session.messages,
      {
        role: "user",
        content: "Please break character and give me a detailed coaching summary of how I did in this conversation. Score me 1-10 on: Confidence, Engagement, Emotional Intelligence, and Humor. Give specific examples from what I said and concrete tips for improvement. Be encouraging but honest."
      }
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: feedbackMessages,
      max_tokens: 600,
      temperature: 0.7
    });

    const feedback = completion.choices[0].message.content;
    const audioBase64 = await textToSpeech(feedback);

    res.json({ feedback, audio: audioBase64 });
  } catch (err) {
    console.error("[feedback] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── TTS Helper ──────────────────────────────────────────────
async function textToSpeech(text) {
  try {
    // Strip coach tips brackets for cleaner audio
    const cleanText = text.replace(/\[COACH TIP:.*?\]/gs, '').trim();
    if (!cleanText) return null;

    const response = await openai.audio.speech.create({
      model: "tts-1",
      voice: "nova", // warm, friendly voice
      input: cleanText.substring(0, 4096),
      response_format: "mp3"
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.toString("base64");
  } catch (err) {
    console.error("[tts] error:", err.message);
    return null;
  }
}

// ─── Start ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────────────────┐
  │                                                 │
  │   💬  Voice AI Dating Coach                     │
  │   Running at http://localhost:${PORT}              │
  │                                                 │
  │   Modes: Practice (role-play) + Advice          │
  │   Voice: OpenAI Whisper + TTS                   │
  │                                                 │
  └─────────────────────────────────────────────────┘
  `);
});
