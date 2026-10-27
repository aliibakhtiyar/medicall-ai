
require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Groq = require("groq-sdk");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 5000;

// Development CORS: allow localhost and private-LAN Vite origins so a phone
// on the same Wi-Fi can use the app. In production, set CLIENT_URL explicitly.
const configuredOrigins = (process.env.CLIENT_URL || "http://localhost:5173")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function isPrivateDevHost(hostname) {
  if (["localhost", "127.0.0.1", "::1"].includes(hostname)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  const match = hostname.match(/^172\.(\d{1,2})\.\d{1,3}\.\d{1,3}$/);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true); // curl/Postman/server requests
    if (configuredOrigins.includes(origin)) return callback(null, true);
    try {
      const url = new URL(origin);
      if (process.env.NODE_ENV !== "production" && isPrivateDevHost(url.hostname)) {
        return callback(null, true);
      }
    } catch {}
    return callback(new Error("Origin is not allowed by CORS"));
  },
}));
app.use(express.json({ limit: "1mb" }));

const { Schema } = mongoose;

// ==================== GROQ AI CHAT ====================

const groq = process.env.GROQ_API_KEY
  ? new Groq({
      apiKey: process.env.GROQ_API_KEY,
      timeout: 20000,
      maxRetries: 1,
    })
  : null;


// Conversation-scoped booking state. For a multi-instance production deployment,
// move this map to Redis or persist it in MongoDB.
const bookingSessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;
function getBookingSession(id) {
  const entry = bookingSessions.get(id);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > SESSION_TTL_MS) {
    bookingSessions.delete(id);
    return null;
  }
  entry.updatedAt = Date.now();
  return entry;
}
function normalizePhone(value) { return String(value || '').replace(/[^\d+]/g, ''); }
function parseDateTime(text) {
  const value = String(text || '').trim();
  let date = '';
  let time = '';
  let m = value.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (m) date = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  if (!date && (m = value.match(/\b(\d{1,2})[\/.](\d{1,2})[\/.](20\d{2})\b/))) date = `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  if (!date && /\btomorrow\b/i.test(value)) { const d = new Date(); d.setDate(d.getDate()+1); date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  if (!date && /\btoday\b/i.test(value)) { const d = new Date(); date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  m = value.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) || value.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) {
    let h = Number(m[1]); const min = Number(m[2] || 0); const ap = String(m[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) time = `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
  }
  return { date, time };
}
function matchDoctor(text, doctors) {
  const lower = String(text || '').toLowerCase();
  return doctors.find(d => lower.includes(String(d.name || '').toLowerCase())) || null;
}

const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (file.mimetype.startsWith("audio/") || file.mimetype === "video/webm") {
      return callback(null, true);
    }
    return callback(new Error("Please upload a supported audio recording."));
  },
});

// Sarvam Saaras v3: return Roman-script Hindi/Hinglish for speech input.
app.post("/api/transcribe", uploadAudio.single("audio"), async (req, res) => {
  try {
    const apiKey = process.env.SARVAM_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ message: "SARVAM_API_KEY is missing from server/.env" });
    }
    if (!req.file) return res.status(400).json({ message: "Audio recording is required." });

    const form = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || "audio/webm" });
    form.append("file", blob, req.file.originalname || "recording.webm");
    form.append("model", "saaras:v3");
    form.append("mode", "translit");
    form.append("language_code", "unknown");

    const response = await fetch("https://api.sarvam.ai/speech-to-text", {
      method: "POST",
      headers: { "api-subscription-key": apiKey },
      body: form,
      signal: AbortSignal.timeout(45000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Sarvam STT error:", response.status, payload);
      return res.status(response.status === 429 ? 429 : 502).json({
        message: payload?.error?.message || payload?.message || "Sarvam speech recognition failed. Check SARVAM_API_KEY and try again.",
      });
    }
    const text = typeof payload.transcript === "string" ? payload.transcript.trim() : "";
    if (!text) return res.status(422).json({ message: "No speech was detected. Please speak again." });
    return res.json({ text, languageCode: payload.language_code || "unknown" });
  } catch (error) {
    console.error("Sarvam transcription error:", error.message || error);
    return res.status(502).json({ message: "Speech recognition failed. Check the network and Sarvam API key." });
  }
});

// Sarvam Bulbul TTS: return playable audio without exposing the API key to React.
app.post("/api/tts", async (req, res) => {
  try {
    const apiKey = process.env.SARVAM_API_KEY;
    if (!apiKey) return res.status(500).json({ message: "SARVAM_API_KEY is missing from server/.env" });
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ message: "Text is required for speech." });
    if (text.length > 2500) return res.status(400).json({ message: "Please shorten the reply before generating speech." });

    // Roman Hinglish is spoken best with Hindi voice; English replies use Indian English.
    const languageCode = req.body?.languageCode === "en-IN" ? "en-IN" : "hi-IN";
    const response = await fetch("https://api.sarvam.ai/text-to-speech", {
      method: "POST",
      headers: { "api-subscription-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model: process.env.SARVAM_TTS_MODEL || "bulbul:v3",
        language_code: languageCode,
        speaker: process.env.SARVAM_TTS_SPEAKER || "shubh",
        pace: 1.0,
        output_audio_codec: "mp3",
      }),
      signal: AbortSignal.timeout(45000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Sarvam TTS error:", response.status, payload);
      return res.status(response.status === 429 ? 429 : 502).json({
        message: payload?.error?.message || payload?.message || "Voice generation failed. Check the Sarvam API configuration.",
      });
    }
    const audioBase64 = payload.audios?.[0];
    if (!audioBase64) return res.status(502).json({ message: "Voice provider returned empty audio." });
    return res.json({ audio: audioBase64, mimeType: "audio/mpeg" });
  } catch (error) {
    console.error("Sarvam TTS error:", error.message || error);
    return res.status(502).json({ message: "Voice generation failed. Check the network and Sarvam API key." });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) return res.status(400).json({ message: "Please enter a message." });
    if (message.length > 4000) return res.status(400).json({ message: "Message is too long." });
    if (!groq) return res.status(500).json({ message: "GROQ_API_KEY is missing from server/.env" });

    const requestedClinicId = req.body?.clinicId;
    if (!requestedClinicId || !mongoose.isValidObjectId(requestedClinicId)) {
      return res.status(400).json({ message: "Clinic context is missing. Refresh the page and try again." });
    }
    const clinic = await Clinic.findById(requestedClinicId).select("clinicName");
    if (!clinic) return res.status(404).json({ message: "Clinic not found." });
    const doctors = await Doctor.find({ clinicId: clinic._id }).select("name specialization fee").sort({ name: 1 });
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-16) : [];
    const conversation = history
      .filter((item) => ["user", "assistant"].includes(item?.role) && typeof item?.text === "string")
      .map((item) => ({ role: item.role, content: item.text.slice(0, 1500) }));
    conversation.push({ role: "user", content: message });

    const conversationId = String(req.body?.conversationId || '').trim();
    if (!conversationId || conversationId.length > 120) {
      return res.status(400).json({ message: "Conversation ID is missing. Refresh the page and try again." });
    }
    const lowerMessage = message.toLowerCase();
    const priorAssistant = [...history].reverse().find(item => item?.role === 'assistant')?.text || '';
    let session = getBookingSession(conversationId);
    const explicitBookingIntent = /\b(book|booking|schedule|make an appointment|appointment book|appointment with)\b/i.test(message) && !/\b(status|already booked|is my appointment done|check my appointment)\b/i.test(message);
    const yesConfirmation = /^(yes|yeah|yep|confirm|confirmed|book it|do it|haan|han|ji|yes confirm|please confirm)[.!\s]*$/i.test(message);
    const assistantOfferedBooking = /would you like to book|shall i book|want to book|like to book/i.test(priorAssistant);

    // Start a deterministic booking flow when booking is requested (including a clear yes
    // after the assistant explicitly offered to book). The LLM is not trusted to remember fields.
    if (!session && (explicitBookingIntent || (yesConfirmation && assistantOfferedBooking))) {
      session = { clinicId: String(clinic._id), patientName: '', phone: '', doctorId: '', doctorName: '', date: '', time: '', reason: '', step: 'name', updatedAt: Date.now(), createdAt: Date.now() };
      const doctorInMessage = matchDoctor(message, doctors);
      const doctorInHistory = matchDoctor(history.map(x => x.text || '').join(' '), doctors);
      const doctor = doctorInMessage || doctorInHistory;
      if (doctor) { session.doctorId = String(doctor._id); session.doctorName = doctor.name; }
      // Reuse any details already shared earlier in this same conversation.
      for (const item of history.filter(x => x.role === 'user')) {
        const t = String(item.text || '').trim();
        const phoneMatch = t.match(/(?:\+?\d[\d\s().-]{8,}\d)/);
        if (phoneMatch) session.phone = normalizePhone(phoneMatch[0]);
        const foundDoctor = matchDoctor(t, doctors);
        if (foundDoctor) { session.doctorId = String(foundDoctor._id); session.doctorName = foundDoctor.name; }
        const dt = parseDateTime(t); if (dt.date) session.date = dt.date; if (dt.time) session.time = dt.time;
        if (/\b(my name is|name is|i am|i'm)\b/i.test(t)) session.patientName = t.replace(/^.*?\b(?:my name is|name is|i am|i'm)\b\s*/i, '').replace(/[.!]+$/, '').trim();
      }
      bookingSessions.set(conversationId, session);
    }

    if (session && session.clinicId === String(clinic._id)) {
      // If the current message contains a real doctor name, retain it.
      const foundDoctor = matchDoctor(message, doctors);
      if (foundDoctor) { session.doctorId = String(foundDoctor._id); session.doctorName = foundDoctor.name; }
      const dt = parseDateTime(message); if (dt.date) session.date = dt.date; if (dt.time) session.time = dt.time;
      const phoneMatch = message.match(/(?:\+?\d[\d\s().-]{8,}\d)/);
      if (phoneMatch) session.phone = normalizePhone(phoneMatch[0]);

      const isYes = yesConfirmation;
      const isNo = /^(no|nope|cancel|stop|nah)[.!\s]*$/i.test(message);
      if (isNo && session.step === 'confirm') {
        bookingSessions.delete(conversationId);
        return res.json({ reply: "No problem. I haven't booked anything. Tell me whenever you'd like to start again.", bookingCreated: false, bookingState: null });
      }

      if (session.step === 'name') {
        if (!session.patientName) {
          const nameMatch = message.match(/(?:my name is|name is|i am|i'm)\s+(.+)/i);
          const looksLikeBookingRequest = /\b(book|booking|appointment|doctor|schedule|want|need)\b/i.test(message);
          const candidate = (nameMatch ? nameMatch[1] : message).trim().replace(/[.!]+$/, '');
          if (candidate.length >= 2 && candidate.length <= 100 && (Boolean(nameMatch) || !looksLikeBookingRequest) && !/^(yes|yeah|yep|no|hi|hello|book|appointment)$/i.test(candidate)) session.patientName = candidate;
        }
        if (!session.patientName) return res.json({ reply: "Sure. What is your full name?", bookingCreated: false, bookingState: session.step });
        session.step = 'phone';
        bookingSessions.set(conversationId, session);
        return res.json({ reply: `Thanks, ${session.patientName}. What phone number should the clinic use?`, bookingCreated: false, bookingState: session.step });
      }
      if (session.step === 'phone') {
        if (session.phone && session.phone.replace(/\D/g,'').length >= 10 && session.phone.replace(/\D/g,'').length <= 15) {
          session.step = session.doctorId ? 'date' : 'doctor';
        } else {
          bookingSessions.set(conversationId, session);
          return res.json({ reply: "Please enter a valid phone number with 10 to 15 digits.", bookingCreated: false, bookingState: session.step });
        }
      }
      if (session.step === 'doctor') {
        if (!session.doctorId) {
          bookingSessions.set(conversationId, session);
          return res.json({ reply: `Which doctor would you like? Available doctors: ${doctors.map(d => d.name).join(', ') || 'please contact the clinic'}.`, bookingCreated: false, bookingState: session.step });
        }
        session.step = 'date';
      }
      if (session.step === 'date') {
        if (!session.date) {
          bookingSessions.set(conversationId, session);
          return res.json({ reply: "What date would you prefer? Please say a date like 2026-11-05 or say tomorrow.", bookingCreated: false, bookingState: session.step });
        }
        session.step = 'time';
      }
      if (session.step === 'time') {
        if (!session.time) {
          bookingSessions.set(conversationId, session);
          return res.json({ reply: "What time would you prefer? Clinic hours are 09:00 to 17:00; for example, 10:30 AM.", bookingCreated: false, bookingState: session.step });
        }
        session.step = 'confirm';
      }
      if (session.step === 'confirm') {
        if (!isYes) {
          bookingSessions.set(conversationId, session);
          const doctor = doctors.find(d => String(d._id) === session.doctorId);
          return res.json({ reply: `Please confirm these details: ${session.patientName}, phone ${session.phone}, ${doctor?.name || session.doctorName}, ${session.date} at ${session.time}. Say “yes, confirm” to book, or “no” to cancel.`, bookingCreated: false, bookingState: 'confirm', booking: { ...session } });
        }
        const doctor = doctors.find(d => String(d._id) === session.doctorId);
        if (!doctor || !session.patientName || !session.phone || !session.date || !session.time) {
          session.step = !session.patientName ? 'name' : !session.phone ? 'phone' : !session.doctorId ? 'doctor' : !session.date ? 'date' : 'time';
          bookingSessions.set(conversationId, session);
          return res.json({ reply: "I still need a few details before I can confirm. " + ({name:'What is your full name?',phone:'What phone number should the clinic use?',doctor:'Which doctor would you like?',date:'What date would you prefer?',time:'What time would you prefer?'}[session.step]), bookingCreated: false, bookingState: session.step });
        }
        const [year, month, day] = session.date.split('-').map(Number); const [hour, minute] = session.time.split(':').map(Number);
        const apptDate = new Date(year, month - 1, day, hour, minute);
        if (apptDate.getTime() <= Date.now() || apptDate.getFullYear() !== year || apptDate.getMonth() !== month-1 || apptDate.getDate() !== day || hour < 9 || hour >= 17 || minute > 59) {
          session.step = apptDate.getTime() <= Date.now() ? 'date' : 'time'; bookingSessions.set(conversationId, session);
          return res.json({ reply: session.step === 'date' ? "That date must be in the future. What future date would you prefer?" : "That time is outside clinic hours (09:00–17:00). What time would you prefer?", bookingCreated: false, bookingState: session.step });
        }
        try {
          const appointment = await Appointment.create({ clinicId: clinic._id, doctorId: doctor._id, patientName: session.patientName, phone: session.phone, date: session.date, time: session.time, reason: session.reason || '' });
          bookingSessions.delete(conversationId);
          return res.status(201).json({ reply: `Your appointment is confirmed! ${session.patientName} with ${doctor.name} on ${session.date} at ${session.time}. Booking ID: ${appointment._id}.`, bookingCreated: true, appointment: { id: appointment._id, patientName: session.patientName, phone: session.phone, doctorName: doctor.name, date: session.date, time: session.time, status: appointment.status } });
        } catch (err) {
          if (err.code === 11000) return res.status(409).json({ message: "That time slot is already booked. Please choose another time.", bookingCreated: false });
          throw err;
        }
      }
      bookingSessions.set(conversationId, session);
    }

    const systemPrompt = `You are MediCall AI, a clinic receptionist for ${clinic.clinicName}.
Reply in the user's current language/script. Roman Hinglish must stay Roman Hinglish (Latin letters); English stays English; never switch to Arabic or Urdu script unless explicitly requested. Be friendly, concise, ask only ONE question at a time.
Verified doctors (use only these; never invent): ${JSON.stringify(doctors.map(d => ({name:d.name, specialization:d.specialization, fee:d.fee, doctorId:String(d._id)})))}
Clinic hours: 09:00-17:00.
Your job includes actually booking appointments. Use the entire conversation to extract booking details. If the user wants a booking, gather full name, phone number, exact future date (YYYY-MM-DD), time (HH:MM), doctor name, and reason (reason can be empty). Ask for any missing field one at a time. Do not ask for name/phone again if already supplied in conversation. If doctor name is ambiguous or unavailable, ask/offer a real doctor from the list.
Once all required fields are known, summarize all details and ask the user to confirm. Do NOT book until the latest user message clearly confirms (yes, confirm, book it, etc.) after you asked for confirmation. If confirmed, set confirmed=true and return the exact structured fields. If a user asks about status, do not claim to check by name/phone unless you have actually queried records; tell them you can book or staff can verify status.
Return ONLY valid JSON matching: {"reply":"text to show user","bookingIntent":true|false,"confirmationRequested":true|false,"confirmed":true|false,"booking":{"patientName":"","phone":"","doctorName":"","date":"YYYY-MM-DD","time":"HH:MM","reason":""}}. Always include all keys. If not booking, bookingIntent=false and confirmed=false. If fields are incomplete, put known fields in booking and blank unknown fields. Do not output markdown or extra keys.`;

    let parsed;
    const model = process.env.GROQ_CHAT_MODEL || "openai/gpt-oss-120b";
    try {
      const completion = await groq.chat.completions.create({
        model,
        messages: [{ role: "system", content: systemPrompt }, ...conversation],
        max_completion_tokens: 500,
        temperature: 0.2,
        response_format: { type: "json_object" },
      });
      const raw = completion.choices?.[0]?.message?.content?.trim();
      if (!raw) throw new Error("Groq returned an empty response");
      parsed = JSON.parse(raw);
    } catch (modelError) {
      console.error("Groq structured chat error:", modelError.status || "", modelError.message || modelError);
      return res.status(502).json({ message: "AI reply failed. Please try again; your message was not booked." });
    }

    const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
    if (!reply) return res.status(502).json({ message: "AI returned an empty response. Please try again." });

    if (parsed.bookingIntent && parsed.confirmed === true) {
      const b = parsed.booking || {};
      const patientName = String(b.patientName || "").trim();
      const phone = String(b.phone || "").trim();
      const date = String(b.date || "").trim();
      const time = String(b.time || "").trim();
      const doctorName = String(b.doctorName || "").trim();
      const reason = String(b.reason || "").trim();
      const doctor = doctors.find(d => d.name.toLowerCase() === doctorName.toLowerCase()) ||
        doctors.find(d => doctorName && d.name.toLowerCase().includes(doctorName.toLowerCase()));
      if (!patientName || !phone || !date || !time || !doctor) {
        return res.json({ reply: "I still need the patient's full name, phone number, a valid doctor, date and time before I can book. Please share the missing details.", bookingCreated: false });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
        return res.json({ reply: "Please provide the appointment date as YYYY-MM-DD and time as HH:MM, then confirm again.", bookingCreated: false });
      }
      const [year, month, day] = date.split("-").map(Number);
      const [hour, minute] = time.split(":").map(Number);
      const appointmentDate = new Date(year, month - 1, day, hour, minute);
      if (appointmentDate.getFullYear() !== year || appointmentDate.getMonth() !== month - 1 || appointmentDate.getDate() !== day || appointmentDate.getHours() !== hour || appointmentDate.getMinutes() !== minute || appointmentDate.getTime() <= Date.now()) {
        return res.json({ reply: "That date or time is not a valid future appointment. Please provide a future date and time, then confirm again.", bookingCreated: false });
      }
      if (hour < 9 || hour >= 17) return res.json({ reply: "Clinic appointments are available from 09:00 to 17:00. Please choose a time within clinic hours.", bookingCreated: false });
      try {
        const appointment = await Appointment.create({ clinicId: clinic._id, doctorId: doctor._id, patientName, phone, date, time, reason });
        return res.status(201).json({
          reply: `Appointment successfully booked! Patient: ${patientName}. Doctor: ${doctor.name}. Date: ${date}. Time: ${time}. Booking ID: ${appointment._id}.`,
          bookingCreated: true,
          appointment: { id: appointment._id, patientName, phone, doctorName: doctor.name, date, time, reason, status: appointment.status },
        });
      } catch (bookingError) {
        if (bookingError.code === 11000) return res.status(409).json({ message: "This doctor and time slot are already booked. Please choose another time." });
        throw bookingError;
      }
    }
    return res.json({ reply, bookingCreated: false });
  } catch (error) {
    console.error("Chat API error:", error.status || "", error.message || error);
    if (error.status === 429) return res.status(429).json({ message: "AI rate limit reached. Please try again in a moment." });
    return res.status(502).json({ message: "AI assistant is temporarily unavailable. Please try again." });
  }
});

// ==================== DATABASE MODELS ====================

const clinicSchema = new Schema(
  {
    clinicName: {
      type: String,
      required: true,
      trim: true,
    },
    adminName: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

const doctorSchema = new Schema(
  {
    clinicId: {
      type: Schema.Types.ObjectId,
      ref: "Clinic",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    specialization: {
      type: String,
      required: true,
      trim: true,
    },
    fee: {
      type: Number,
      default: 500,
      min: 0,
    },
  },
  { timestamps: true }
);

const appointmentSchema = new Schema(
  {
    clinicId: {
      type: Schema.Types.ObjectId,
      ref: "Clinic",
      required: true,
    },
    doctorId: {
      type: Schema.Types.ObjectId,
      ref: "Doctor",
      required: true,
    },
    patientName: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    date: {
      type: String,
      required: true,
    },
    time: {
      type: String,
      required: true,
    },
    reason: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["Confirmed", "Cancelled", "Completed"],
      default: "Confirmed",
    },
  },
  { timestamps: true }
);

appointmentSchema.index(
  {
    clinicId: 1,
    doctorId: 1,
    date: 1,
    time: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      status: "Confirmed",
    },
  }
);

const patientSchema = new Schema({
  fullName: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, required: true, trim: true },
  password: { type: String, required: true },
}, { timestamps: true });

const Clinic = mongoose.model("Clinic", clinicSchema);
const Patient = mongoose.model("Patient", patientSchema);
const Doctor = mongoose.model("Doctor", doctorSchema);
const Appointment = mongoose.model(
  "Appointment",
  appointmentSchema
);

// ==================== AUTH HELPERS ====================

function makeToken(clinic) {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is missing.");
  }

  return jwt.sign(
    { clinicId: clinic._id.toString() },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function makePatientToken(patient) {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is missing.");
  return jwt.sign({ patientId: patient._id.toString(), role: "patient" }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

function protectPatient(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ message: "Please log in first." });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== "patient" || !decoded.patientId) return res.status(401).json({ message: "Invalid patient session." });
    req.patientId = decoded.patientId;
    return next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token." });
  }
}

function protect(req, res, next) {
  const header = req.headers.authorization || "";

  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : "";

  if (!token) {
    return res.status(401).json({
      message: "Please log in first.",
    });
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    if (!decoded.clinicId || decoded.role === "patient") {
      return res.status(403).json({ message: "Clinic admin access required." });
    }
    req.clinicId = decoded.clinicId;
    return next();
  } catch {
    return res.status(401).json({
      message: "Invalid or expired token.",
    });
  }
}

// ==================== HEALTH CHECK ====================

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "MediCall AI",
  });
});

// ==================== REGISTER ====================

app.post("/api/auth/register", async (req, res) => {
  try {
    const {
      clinicName,
      adminName,
      email,
      password,
    } = req.body || {};

    if (
      !clinicName?.trim() ||
      !adminName?.trim() ||
      !email?.trim() ||
      !password
    ) {
      return res.status(400).json({
        message: "All fields are required.",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        message: "Password must be at least 8 characters.",
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existingClinic = await Clinic.findOne({
      email: normalizedEmail,
    });

    if (existingClinic) {
      return res.status(409).json({
        message: "Email already registered.",
      });
    }

    const clinic = await Clinic.create({
      clinicName: clinicName.trim(),
      adminName: adminName.trim(),
      email: normalizedEmail,
      password: await bcrypt.hash(password, 12),
    });

    return res.status(201).json({
      token: makeToken(clinic),
      clinic: {
        id: clinic._id,
        clinicName: clinic.clinicName,
        adminName: clinic.adminName,
        email: clinic.email,
      },
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        message: "Email already registered.",
      });
    }

    console.error("Register error:", error);

    return res.status(500).json({
      message: "Could not register clinic.",
    });
  }
});

// ==================== LOGIN ====================

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(
      req.body?.email || ""
    ).toLowerCase().trim();

    const password = req.body?.password || "";

    const clinic = await Clinic.findOne({ email });

    if (
      !clinic ||
      !(await bcrypt.compare(password, clinic.password))
    ) {
      return res.status(401).json({
        message: "Invalid email or password.",
      });
    }

    return res.json({
      token: makeToken(clinic),
      clinic: {
        id: clinic._id,
        clinicName: clinic.clinicName,
        adminName: clinic.adminName,
        email: clinic.email,
      },
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      message: "Could not log in.",
    });
  }
});

// ==================== CURRENT CLINIC ====================

app.get("/api/auth/me", protect, async (req, res) => {
  try {
    const clinic = await Clinic.findById(
      req.clinicId
    ).select("clinicName adminName email");

    if (!clinic) {
      return res.status(404).json({
        message: "Clinic not found.",
      });
    }

    return res.json({
      clinic: {
        id: clinic._id,
        clinicName: clinic.clinicName,
        adminName: clinic.adminName,
        email: clinic.email,
      },
    });
  } catch (error) {
    console.error("Profile error:", error);

    return res.status(500).json({
      message: "Could not load clinic profile.",
    });
  }
});

// ==================== PATIENT AUTHENTICATION ====================
app.post("/api/patient-auth/register", async (req, res) => {
  try {
    const fullName = String(req.body?.fullName || "").trim();
    const email = String(req.body?.email || "").toLowerCase().trim();
    const phone = String(req.body?.phone || "").trim();
    const password = String(req.body?.password || "");
    if (!fullName || !email || !phone || !password) return res.status(400).json({ message: "Please fill in all fields." });
    if (password.length < 8) return res.status(400).json({ message: "Password must be at least 8 characters." });
    if (await Patient.findOne({ email })) return res.status(409).json({ message: "An account with this email already exists." });
    const patient = await Patient.create({ fullName, email, phone, password: await bcrypt.hash(password, 12) });
    return res.status(201).json({ token: makePatientToken(patient), patient: { id: patient._id, fullName: patient.fullName, email: patient.email, phone: patient.phone } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: "An account with this email already exists." });
    console.error("Patient registration error:", error);
    return res.status(500).json({ message: "Could not create patient account." });
  }
});

app.post("/api/patient-auth/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").toLowerCase().trim();
    const password = String(req.body?.password || "");
    const patient = await Patient.findOne({ email });
    if (!patient || !(await bcrypt.compare(password, patient.password))) return res.status(401).json({ message: "Invalid email or password." });
    return res.json({ token: makePatientToken(patient), patient: { id: patient._id, fullName: patient.fullName, email: patient.email, phone: patient.phone } });
  } catch (error) {
    console.error("Patient login error:", error);
    return res.status(500).json({ message: "Could not log in." });
  }
});

app.get("/api/patient-auth/me", protectPatient, async (req, res) => {
  try {
    const patient = await Patient.findById(req.patientId).select("fullName email phone");
    if (!patient) return res.status(404).json({ message: "Patient account not found." });
    return res.json({ patient: { id: patient._id, fullName: patient.fullName, email: patient.email, phone: patient.phone } });
  } catch (error) {
    console.error("Patient profile error:", error);
    return res.status(500).json({ message: "Could not load patient profile." });
  }
});

// ==================== PUBLIC CLINIC INFO ====================

app.get("/api/public/clinic", async (req, res) => {
  try {
    const clinic = await Clinic.findOne()
      .sort({ createdAt: 1 })
      .select("clinicName");

    if (!clinic) {
      return res.status(404).json({
        message: "No clinic registered yet.",
      });
    }

    const doctors = await Doctor.find({
      clinicId: clinic._id,
    }).sort({ name: 1 });

    return res.json({
      clinic: {
        id: clinic._id,
        clinicName: clinic.clinicName,
      },
      doctors,
    });
  } catch (error) {
    console.error("Public clinic error:", error);

    return res.status(500).json({
      message: "Could not load clinic information.",
    });
  }
});

// ==================== PUBLIC APPOINTMENT BOOKING ====================

app.post("/api/public/appointments", async (req, res) => {
  try {
    const {
      clinicId,
      doctorId,
      patientName,
      phone,
      date,
      time,
      reason,
    } = req.body || {};

    if (
      !clinicId ||
      !doctorId ||
      !patientName?.trim() ||
      !phone?.trim() ||
      !date ||
      !time
    ) {
      return res.status(400).json({
        message: "Please provide all required booking details.",
      });
    }

    if (
      !mongoose.isValidObjectId(clinicId) ||
      !mongoose.isValidObjectId(doctorId)
    ) {
      return res.status(400).json({
        message: "Invalid clinic or doctor.",
      });
    }

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !/^\d{2}:\d{2}$/.test(time)
    ) {
      return res.status(400).json({
        message: "Invalid date or time format.",
      });
    }

    const [year, month, day] = date.split("-").map(Number);
    const [hour, minute] = time.split(":").map(Number);

    const appointmentDate = new Date(
      year,
      month - 1,
      day,
      hour,
      minute
    );

    if (
      appointmentDate.getFullYear() !== year ||
      appointmentDate.getMonth() !== month - 1 ||
      appointmentDate.getDate() !== day ||
      appointmentDate.getHours() !== hour ||
      appointmentDate.getMinutes() !== minute ||
      appointmentDate.getTime() <= Date.now()
    ) {
      return res.status(400).json({
        message: "Choose a valid future appointment time.",
      });
    }

    if (hour < 9 || hour >= 17) {
      return res.status(400).json({
        message: "Clinic hours are 09:00 to 17:00.",
      });
    }

    const clinic = await Clinic.findById(clinicId);

    const doctor = await Doctor.findOne({
      _id: doctorId,
      clinicId,
    });

    if (!clinic || !doctor) {
      return res.status(404).json({
        message: "Clinic or doctor not found.",
      });
    }

    const appointment = await Appointment.create({
      clinicId,
      doctorId,
      patientName: patientName.trim(),
      phone: phone.trim(),
      date,
      time,
      reason:
        typeof reason === "string"
          ? reason.trim()
          : "",
    });

    return res.status(201).json({
      message: "Appointment confirmed.",
      appointment: {
        id: appointment._id,
        patientName: appointment.patientName,
        doctorName: doctor.name,
        date: appointment.date,
        time: appointment.time,
        status: appointment.status,
      },
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        message: "This time slot is already booked.",
      });
    }

    console.error("Booking error:", error);

    return res.status(500).json({
      message: "Could not book appointment.",
    });
  }
});

// ==================== GET DOCTORS ====================

app.get("/api/doctors", protect, async (req, res) => {
  try {
    let doctors = await Doctor.find({
      clinicId: req.clinicId,
    }).sort({ name: 1 });

    // Seed demo doctors only for a clinic whose doctor list is empty.
    // These are sample records; clinics can edit/remove them later if those actions are added.
    if (doctors.length === 0 && process.env.SEED_DEMO_DOCTORS !== "false") {
      const demoDoctors = [
        { name: "Dr. Rajendra Sharma", specialization: "Orthopaedics", fee: 2000 },
        { name: "Dr. Aditi Verma", specialization: "General Physician", fee: 700 },
        { name: "Dr. Arjun Mehta", specialization: "Cardiology", fee: 1200 },
        { name: "Dr. Neha Kapoor", specialization: "Dermatology", fee: 900 },
        { name: "Dr. Imran Khan", specialization: "Paediatrics", fee: 800 },
        { name: "Dr. Priya Singh", specialization: "Gynaecology", fee: 1000 },
      ];
      await Doctor.insertMany(demoDoctors.map((doctor) => ({ ...doctor, clinicId: req.clinicId })));
      doctors = await Doctor.find({ clinicId: req.clinicId }).sort({ name: 1 });
    }

    return res.json(doctors);
  } catch (error) {
    console.error("Get doctors error:", error);

    return res.status(500).json({
      message: "Could not load doctors.",
    });
  }
});

// ==================== ADD DOCTOR ====================

app.post("/api/doctors", protect, async (req, res) => {
  try {
    const { name, specialization, fee } = req.body || {};

    if (!name?.trim() || !specialization?.trim()) {
      return res.status(400).json({
        message: "Name and specialization are required.",
      });
    }

    const parsedFee =
      fee === undefined || fee === ""
        ? 500
        : Number(fee);

    if (
      !Number.isFinite(parsedFee) ||
      parsedFee < 0
    ) {
      return res.status(400).json({
        message: "Fee must be a valid non-negative number.",
      });
    }

    const doctor = await Doctor.create({
      clinicId: req.clinicId,
      name: name.trim(),
      specialization: specialization.trim(),
      fee: parsedFee,
    });

    return res.status(201).json(doctor);
  } catch (error) {
    console.error("Add doctor error:", error);

    return res.status(500).json({
      message: "Could not add doctor.",
    });
  }
});

// ==================== GET APPOINTMENTS ====================

app.get("/api/appointments", protect, async (req, res) => {
  try {
    const appointments = await Appointment.find({
      clinicId: req.clinicId,
    })
      .populate("doctorId", "name specialization fee")
      .sort({ date: 1, time: 1 });

    return res.json(appointments);
  } catch (error) {
    console.error("Get appointments error:", error);

    return res.status(500).json({
      message: "Could not load appointments.",
    });
  }
});

// ==================== UPDATE APPOINTMENT STATUS ====================

app.patch(
  "/api/appointments/:id/status",
  protect,
  async (req, res) => {
    try {
      const { status } = req.body || {};

      if (!["Cancelled", "Completed"].includes(status)) {
        return res.status(400).json({
          message: "Invalid status.",
        });
      }

      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({
          message: "Invalid appointment ID.",
        });
      }

      const appointment =
        await Appointment.findOneAndUpdate(
          {
            _id: req.params.id,
            clinicId: req.clinicId,
            status: "Confirmed",
          },
          { status },
          { new: true }
        );

      if (!appointment) {
        return res.status(404).json({
          message: "Appointment not found or already updated.",
        });
      }

      return res.json({
        message: "Appointment updated.",
        appointment,
      });
    } catch (error) {
      console.error("Update appointment error:", error);

      return res.status(500).json({
        message: "Could not update appointment.",
      });
    }
  }
);

// ==================== DASHBOARD STATS ====================

app.get("/api/dashboard/stats", protect, async (req, res) => {
  try {
    const now = new Date();

    const today =
      `${now.getFullYear()}-` +
      `${String(now.getMonth() + 1).padStart(2, "0")}-` +
      `${String(now.getDate()).padStart(2, "0")}`;

    const [
      doctors,
      total,
      upcoming,
      phones,
      todayCount,
    ] = await Promise.all([
      Doctor.countDocuments({
        clinicId: req.clinicId,
      }),

      Appointment.countDocuments({
        clinicId: req.clinicId,
      }),

      Appointment.countDocuments({
        clinicId: req.clinicId,
        status: "Confirmed",
        date: { $gte: today },
      }),

      Appointment.distinct("phone", {
        clinicId: req.clinicId,
      }),

      Appointment.countDocuments({
        clinicId: req.clinicId,
        date: today,
        status: "Confirmed",
      }),
    ]);

    return res.json({
      doctors,
      appointments: total,
      upcoming,
      patients: phones.length,
      today: todayCount,
    });
  } catch (error) {
    console.error("Dashboard stats error:", error);

    return res.status(500).json({
      message: "Could not load dashboard statistics.",
    });
  }
});

// Friendly upload/JSON errors (including unsupported audio type and oversized files).
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
      message: error.code === "LIMIT_FILE_SIZE"
        ? "Audio recording is too large. Please record a shorter message."
        : "Could not process the audio upload.",
    });
  }
  if (error.message === "Please upload a supported audio recording.") {
    return res.status(400).json({ message: error.message });
  }
  if (error.message === "Origin is not allowed by CORS") {
    return res.status(403).json({ message: error.message });
  }
  return next(error);
});

// ==================== START SERVER ====================

async function start() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is missing from server/.env");
  }

  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is missing from server/.env");
  }

  await mongoose.connect(process.env.MONGODB_URI);

  console.log("MongoDB connected");

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`MediCall API running on port ${PORT}`);
    console.log("Local testing: http://localhost:" + PORT + "/api/health");
    console.log("Phone testing: use your laptop LAN IP with port " + PORT);
  });
}

start().catch((error) => {
  console.error("Server startup failed:", error.message);
  process.exit(1);
});