
import { useEffect, useRef, useState } from "react";
import axios from "axios";

const API =
  import.meta.env.VITE_API_URL ||
  `${window.location.protocol}//${window.location.hostname}:5000/api`;

const api = axios.create({ baseURL: API });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("medicall_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

function Icon({ name, size = 18, className = "" }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", className, "aria-hidden": true };
  const paths = {
    plus: <><path d="M12 5v14"/><path d="M5 12h14"/></>,
    spark: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-2-5.8L4 11l6-2.2L12 3Z"/><path d="m19 14 1 2.5 2 1-2 1-1 2.5-1-2.5-2-1 2-1 1-2.5Z"/></>,
    mic: <><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11.5a7 7 0 0 0 14 0"/><path d="M12 18.5v3"/><path d="M8.5 21.5h7"/></>,
    send: <><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></>,
    volume: <><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15 9a5 5 0 0 1 0 6"/><path d="M18 5a10 10 0 0 1 0 14"/></>,
    close: <><path d="m18 6-12 12"/><path d="m6 6 12 12"/></>,
    message: <><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-4-.9L3 21l1.9-4.1a8.5 8.5 0 1 1 16.1-5.4Z"/><path d="M8 11h8M8 14h5"/></>,
    arrow: <><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
  };
  return <svg {...common}>{paths[name] || paths.spark}</svg>;
}

const emptyBooking = {
  patientName: "",
  phone: "",
  doctorId: "",
  date: "",
  time: "",
  reason: "",
};

export default function App() {
  const [page, setPage] = useState("home");
  const [clinic, setClinic] = useState(null);
  const [doctors, setDoctors] = useState([]);
  const [booking, setBooking] = useState(emptyBooking);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const conversationIdRef = useRef(
    localStorage.getItem("medicall_conversation_id") ||
      (() => { const id = `medicall-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; localStorage.setItem("medicall_conversation_id", id); return id; })()
  );
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatMessages, setChatMessages] = useState([
    {
      role: "assistant",
      text: "Hi! I'm MediCall AI. Ask me about our doctors or appointments.",
    },
  ]);

  const [listening, setListening] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const voiceModeRef = useRef(false);
  const processingVoiceRef = useRef(false);
  const silenceIntervalRef = useRef(null);
  const audioContextRef = useRef(null);
  const lastVoiceAtRef = useRef(0);
  const heardSpeechRef = useRef(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const mediaStreamRef = useRef(null);
  const chatEndRef = useRef(null);
  const audioRef = useRef(null);

  const [token, setToken] = useState(
    () => localStorage.getItem("medicall_token") || ""
  );
  const [authMode, setAuthMode] = useState("clinic-login");
  const [patientToken, setPatientToken] = useState(() => localStorage.getItem("medicall_patient_token") || "");
  const [patient, setPatient] = useState(null);
  const [patientAuth, setPatientAuth] = useState({ fullName: "", email: "", phone: "", password: "" });
  const [auth, setAuth] = useState({
    clinicName: "",
    adminName: "",
    email: "",
    password: "",
  });

  const [adminClinic, setAdminClinic] = useState(null);
  const [stats, setStats] = useState({});
  const [appointments, setAppointments] = useState([]);
  const [adminDoctors, setAdminDoctors] = useState([]);
  const [doctorForm, setDoctorForm] = useState({
    name: "",
    specialization: "",
    fee: "500",
  });

  const today = new Date().toLocaleDateString("en-CA");

  useEffect(() => {
    loadClinic();
    return () => {
      try {
        if (mediaRecorderRef.current?.state === "recording") {
          mediaRecorderRef.current.stop();
        }
      } catch {}
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (silenceIntervalRef.current) clearInterval(silenceIntervalRef.current);
      audioContextRef.current?.close?.();
      window.speechSynthesis?.cancel();
      audioRef.current?.pause?.();
    };
  }, []);

  useEffect(() => {
    if (token) loadDashboard();
  }, [token]);

  useEffect(() => {
    if (!patientToken) return;
    axios.get(`${API}/patient-auth/me`, { headers: { Authorization: `Bearer ${patientToken}` } })
      .then(({ data }) => { setPatient(data.patient); setBooking((old) => ({ ...old, patientName: old.patientName || data.patient.fullName, phone: old.phone || data.patient.phone })); })
      .catch(() => { localStorage.removeItem("medicall_patient_token"); setPatientToken(""); setPatient(null); });
  }, [patientToken]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  useEffect(() => {
    if (!token || page !== "dashboard") return;

    const timer = setInterval(loadDashboard, 10000);
    return () => clearInterval(timer);
  }, [token, page]);

  async function loadClinic() {
    try {
      const { data } = await axios.get(`${API}/public/clinic`);

      setClinic(data.clinic);
      setDoctors(data.doctors || []);

      setBooking((previous) => ({
        ...previous,
        doctorId: previous.doctorId || data.doctors?.[0]?._id || "",
      }));
    } catch (err) {
      console.error("Clinic loading failed:", err.message);
    }
  }

  async function loadDashboard() {
    try {
      const [me, stat, appt, doc] = await Promise.all([
        api.get("/auth/me"),
        api.get("/dashboard/stats"),
        api.get("/appointments"),
        api.get("/doctors"),
      ]);

      setAdminClinic(me.data.clinic);
      setStats(stat.data);
      setAppointments(appt.data);
      setAdminDoctors(doc.data);
    } catch (err) {
      if (err.response?.status === 401) {
        localStorage.removeItem("medicall_token");
        setToken("");
        setPage("auth");
      }

      setError(
        err.response?.data?.message || "Dashboard could not be loaded."
      );
    }
  }

  async function registerOrLogin(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");

    try {
      const isPatient = authMode.startsWith("patient-");
      const isRegister = authMode.endsWith("register");
      const endpoint = isPatient
        ? `/patient-auth/${isRegister ? "register" : "login"}`
        : `/auth/${isRegister ? "register" : "login"}`;
      const payload = isPatient ? patientAuth : auth;
      const { data } = await axios.post(`${API}${endpoint}`, payload);

      if (isPatient) {
        localStorage.setItem("medicall_patient_token", data.token);
        setPatientToken(data.token);
        setPatient(data.patient);
        setPage("patient-dashboard");
        setNotice(isRegister ? "Patient account created successfully." : "Patient login successful.");
      } else {
        localStorage.setItem("medicall_token", data.token);
        setToken(data.token);
        setAdminClinic(data.clinic);
        setPage("dashboard");
        setNotice(isRegister ? "Clinic account created successfully." : "Clinic login successful.");
        await loadClinic();
      }
    } catch (err) {
      setError(err.response?.data?.message || "Authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  async function bookAppointment(e, details = booking) {
    e?.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");

    try {
      if (!clinic?.id) {
        throw new Error("Clinic is unavailable. Please try again later.");
      }

      const { data } = await axios.post(`${API}/public/appointments`, {
        clinicId: clinic.id,
        ...details,
      });

      const message =
        `Appointment confirmed for ${data.appointment.patientName} ` +
        `with ${data.appointment.doctorName} on ` +
        `${data.appointment.date} at ${data.appointment.time}.`;

      setNotice(message);
      setBooking(emptyBooking);

      setChatMessages((previous) => [
        ...previous,
        { role: "assistant", text: message },
      ]);

      if (token) await loadDashboard();

      return { success: true, message };
    } catch (err) {
      const message =
        err.response?.data?.message || err.message || "Booking failed.";

      setError(message);
      return { success: false, message };
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage(message, readReplyAloud = false) {
    const cleanMessage = String(message || "").trim();
    if (!cleanMessage || chatLoading) return;

    setChatInput("");
    setError("");
    setChatMessages((previous) => [...previous, { role: "user", text: cleanMessage }]);
    setChatLoading(true);

    try {
      const history = chatMessages.slice(-16).map(({ role, text }) => ({ role, text }));
      const { data } = await axios.post(`${API}/chat`, {
        message: cleanMessage,
        clinicId: clinic?.id,
        conversationId: conversationIdRef.current,
        history,
      }, { timeout: 60000 });
      const reply = data.reply || "Sorry, please try again.";
      setChatMessages((previous) => [...previous, { role: "assistant", text: reply }]);
      if (data.bookingCreated && token) await loadDashboard();
      if (readReplyAloud) await speak(reply, true);
    } catch (err) {
      console.error("Chat error:", err.response?.data || err.message);
      setChatMessages((previous) => [...previous, {
        role: "assistant",
        text: err.response?.data?.message || "Sorry, I couldn't connect. Please try again.",
      }]);
    } finally {
      setChatLoading(false);
    }
  }

  async function sendChat(e) {
    e?.preventDefault();
    await sendMessage(chatInput, false);
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state === "recording") {
      recorder.stop();
      setNotice("I heard you. Preparing a reply…");
    }
  }

  function stopVoiceConversation() {
    voiceModeRef.current = false;
    setVoiceMode(false);
    if (silenceIntervalRef.current) clearInterval(silenceIntervalRef.current);
    silenceIntervalRef.current = null;
    window.speechSynthesis?.cancel();
    const recorder = mediaRecorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    audioRef.current?.pause?.();
    audioRef.current = null;
    setListening(false);
    setNotice("Voice conversation stopped.");
  }

  async function startVoice(automaticRestart = false) {
    setError("");
    setChatOpen(true);
    if (!automaticRestart) {
      if (voiceModeRef.current) {
        stopVoiceConversation();
        return;
      }
      voiceModeRef.current = true;
      setVoiceMode(true);
    }
    if (!voiceModeRef.current || processingVoiceRef.current) return;

    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      voiceModeRef.current = false;
      setVoiceMode(false);
      setError("Voice recording is not supported in this browser. Use an up-to-date browser and HTTPS.");
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!voiceModeRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];
      heardSpeechRef.current = false;
      lastVoiceAtRef.current = Date.now();

      const mimeCandidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
      const mimeType = mimeCandidates.find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      // Detect a pause after speech and automatically submit the recording.
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        const audioContext = new AudioContextClass();
        audioContextRef.current = audioContext;
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        audioContext.createMediaStreamSource(stream).connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        silenceIntervalRef.current = setInterval(() => {
          if (recorder.state !== "recording") return;
          analyser.getByteTimeDomainData(samples);
          let energy = 0;
          for (let i = 0; i < samples.length; i++) {
            const value = (samples[i] - 128) / 128;
            energy += value * value;
          }
          const volume = Math.sqrt(energy / samples.length);
          if (volume > 0.025) {
            heardSpeechRef.current = true;
            lastVoiceAtRef.current = Date.now();
          }
          if (heardSpeechRef.current && Date.now() - lastVoiceAtRef.current > 1300) {
            if (silenceIntervalRef.current) clearInterval(silenceIntervalRef.current);
            silenceIntervalRef.current = null;
            recorder.stop();
          }
        }, 180);
      }

      recorder.ondataavailable = (event) => {
        if (event.data?.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onerror = (event) => {
        console.error("Recorder error:", event.error || event);
        setListening(false);
        setError("Recording failed. Check microphone permission and try again.");
      };

      recorder.onstop = async () => {
        if (silenceIntervalRef.current) clearInterval(silenceIntervalRef.current);
        silenceIntervalRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        try { await audioContextRef.current?.close?.(); } catch {}
        audioContextRef.current = null;
        setListening(false);

        const actualType = recorder.mimeType || audioChunksRef.current[0]?.type || "audio/webm";
        const audioBlob = new Blob(audioChunksRef.current, { type: actualType });
        audioChunksRef.current = [];
        if (!voiceModeRef.current) return;
        if (!audioBlob.size || !heardSpeechRef.current) {
          // Keep listening if the user didn't speak clearly yet.
          setNotice("Listening… speak in Hindi or English.");
          setTimeout(() => { if (voiceModeRef.current && !processingVoiceRef.current) startVoice(true); }, 250);
          return;
        }

        const extension = actualType.includes("mp4") ? "m4a" : actualType.includes("ogg") ? "ogg" : "webm";
        const formData = new FormData();
        formData.append("audio", audioBlob, `recording.${extension}`);
        processingVoiceRef.current = true;
        setChatLoading(true);
        setNotice("Understanding your speech…");
        try {
          const { data } = await axios.post(`${API}/transcribe`, formData, { timeout: 60000 });
          const transcript = data.text?.trim();
          if (!transcript) {
            setNotice("I couldn't hear that clearly. Listening again…");
          } else {
            setNotice(`Heard: “${transcript}”`);
            await sendTranscribedMessage(transcript);
          }
        } catch (err) {
          console.error("Transcription error:", err.response?.data || err.message);
          setError(err.response?.data?.message || "Voice transcription failed. Check the Sarvam API key.");
        } finally {
          processingVoiceRef.current = false;
          setChatLoading(false);
          if (voiceModeRef.current) setTimeout(() => startVoice(true), 350);
        }
      };

      recorder.start(250);
      setListening(true);
      setNotice("Live voice is on. Speak naturally; pause when you're done.");
    } catch (err) {
      stream?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
      setListening(false);
      voiceModeRef.current = false;
      setVoiceMode(false);
      console.error("Microphone access error:", err);
      setError(err.name === "NotAllowedError"
        ? "Microphone permission denied. Allow microphone access in browser settings."
        : err.name === "NotFoundError"
          ? "No microphone was found on this device."
          : "Could not start the microphone. Use localhost or HTTPS and check browser permissions.");
    }
  }

  async function sendTranscribedMessage(transcript) {
    setChatInput("");
    setError("");
    setChatMessages((previous) => [...previous, { role: "user", text: transcript }]);
    try {
      const history = chatMessages.slice(-16).map(({ role, text }) => ({ role, text }));
      const { data } = await axios.post(`${API}/chat`, {
        message: transcript,
        clinicId: clinic?.id,
        conversationId: conversationIdRef.current,
        history,
      }, { timeout: 60000 });
      const reply = data.reply || "Sorry, please try again.";
      setChatMessages((previous) => [...previous, { role: "assistant", text: reply }]);
      if (data.bookingCreated && token) await loadDashboard();
      if (voiceModeRef.current) await speak(reply, true);
    } catch (err) {
      console.error("Chat after transcription failed:", err.response?.data || err.message);
      const message = err.response?.data?.message || "I heard you, but couldn't reach the assistant. Please try again.";
      setChatMessages((previous) => [...previous, { role: "assistant", text: message }]);
      if (voiceModeRef.current) await speak(message, true);
    }
  }

  async function speak(text, waitForEnd = false) {
    try {
      const englishOnly = /^[\x00-\x7F]*$/.test(text) && /\b(the|and|your|please|how|what|would|appointment|doctor|hello|thank)\b/i.test(text);
      const { data } = await axios.post(`${API}/tts`, {
        text: String(text || "").slice(0, 2500),
        languageCode: englishOnly ? "en-IN" : "hi-IN",
      }, { timeout: 50000 });
      if (!data.audio) throw new Error("TTS returned no audio.");
      const audio = new Audio(`data:${data.mimeType || "audio/mpeg"};base64,${data.audio}`);
      audioRef.current = audio;
      if (waitForEnd) {
        await new Promise((resolve) => {
          audio.onended = resolve;
          audio.onerror = resolve;
          audio.play().catch((error) => {
            console.error("TTS playback error:", error);
            resolve();
          });
        });
      } else {
        await audio.play();
      }
    } catch (error) {
      console.error("Sarvam voice playback failed:", error.response?.data || error.message);
      setError(error.response?.data?.message || "Natural voice playback failed. Check SARVAM_API_KEY.");
    }
  }

  async function addDoctor(e) {
    e.preventDefault();
    setError("");
    setNotice("");

    try {
      await api.post("/doctors", {
        ...doctorForm,
        fee: Number(doctorForm.fee),
      });

      setDoctorForm({
        name: "",
        specialization: "",
        fee: "500",
      });

      setNotice("Doctor added successfully.");
      await Promise.all([loadDashboard(), loadClinic()]);
    } catch (err) {
      setError(err.response?.data?.message || "Could not add doctor.");
    }
  }

  async function updateAppointment(id, status) {
    try {
      await api.patch(`/appointments/${id}/status`, { status });
      setNotice(`Appointment marked ${status.toLowerCase()}.`);
      await loadDashboard();
    } catch (err) {
      setError(err.response?.data?.message || "Could not update appointment.");
    }
  }

  function logout() {
    localStorage.removeItem("medicall_token");
    setToken("");
    setAdminClinic(null);
    setPage("home");
    setNotice("Clinic admin logged out.");
  }

  function patientLogout() {
    localStorage.removeItem("medicall_patient_token");
    setPatientToken("");
    setPatient(null);
    setPage("home");
    setNotice("Patient logged out successfully.");
  }

  const field =
    "w-full border border-slate-200 px-3 py-3 text-sm text-slate-800 outline-none transition focus:border-teal-600 focus:ring-4 focus:ring-teal-50";

  const button =
    "rounded-xl bg-teal-700 px-5 py-3.5 text-sm font-bold text-white shadow-sm transition hover:bg-teal-800 focus:outline-none focus:ring-4 focus:ring-teal-100 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#f8fafc] text-slate-800">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200/70 bg-white/95 px-4 py-3 backdrop-blur-xl sm:px-6 lg:px-12">
        <button
          onClick={() => setPage("home")}
          className="flex items-center text-lg font-extrabold tracking-tight sm:text-xl"
        >
          <span className="mr-2 grid h-9 w-9 place-items-center rounded-xl bg-teal-600 text-white">
            <Icon name="plus" size={20} />
          </span>
          MediCall <span className="text-teal-600">AI</span>
        </button>

        <nav className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
          <button onClick={() => setPage("home")} className="rounded-xl px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100">Patient website</button>
          {token ? <>
            <button className="rounded-xl bg-teal-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-teal-800" onClick={() => setPage("dashboard")}>Clinic dashboard</button>
            <button onClick={logout} className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-semibold hover:bg-slate-50">Log out</button>
          </> : patientToken ? <>
            <button className="rounded-xl bg-teal-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-teal-800" onClick={() => setPage("patient-dashboard")}>My account</button>
            <button onClick={patientLogout} className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-semibold hover:bg-slate-50">Log out</button>
          </> : <>
            <button onClick={() => { setAuthMode("patient-login"); setPage("auth"); }} className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">Patient login</button>
            <button onClick={() => { setAuthMode("clinic-login"); setPage("auth"); }} className="rounded-xl bg-teal-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-teal-800">Clinic login</button>
          </>}
        </nav>
      </header>

      <div className="mx-auto max-w-6xl px-4 pt-4">
        {notice && (
          <div className="mb-3 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700">
            {notice}
          </div>
        )}

        {error && (
          <div className="mb-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>

      {page === "home" && (
        <main className="mx-auto max-w-[1400px] px-4 py-10 sm:px-6 md:py-16 lg:px-10">
          <section className="relative grid items-center gap-10 overflow-hidden rounded-[1.5rem] border border-slate-200/80 bg-white p-6 shadow-sm sm:p-9 md:grid-cols-2 md:p-12 lg:p-16">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-teal-100 bg-teal-50 px-4 py-2 text-xs font-extrabold uppercase tracking-[0.18em] text-teal-800">
                <span className="h-2 w-2 rounded-full bg-emerald-500" /> Your clinic, made simpler
              </p>

              <h1 className="mt-6 max-w-2xl text-4xl font-black leading-[1.08] tracking-tight text-slate-950 sm:text-5xl md:text-6xl lg:text-7xl">
                Healthcare starts with a{" "}
                <span className="text-teal-600">conversation.</span>
              </h1>

              <p className="mt-6 max-w-xl text-base leading-8 text-slate-600 sm:text-lg">
                Ask about doctors, consultation fees and clinic timings.
                Book appointments with help from MediCall AI.
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <button
                  className={button}
                  onClick={() =>
                    document
                      .getElementById("booking")
                      ?.scrollIntoView({ behavior: "smooth" })
                  }
                >
                  Book appointment
                </button>

                <button
                  className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white"
                  onClick={() => setChatOpen(true)}
                >
                  Talk to AI
                </button>
              </div>
            </div>

            <div className="relative rounded-[1.5rem] bg-gradient-to-br from-teal-700 to-teal-600 p-5 text-white shadow-lg shadow-teal-900/10 sm:p-7 md:p-9">
              <div className="absolute -right-12 -top-12 h-48 w-48 rounded-full border border-white/15" />
              <div className="absolute -bottom-16 -left-12 h-48 w-48 rounded-full border border-white/15" />
              <div className="relative rounded-2xl border border-white/20 bg-white/10 p-7 text-center shadow-sm backdrop-blur sm:p-9">
                <div className="mx-auto grid h-20 w-20 place-items-center rounded-2xl border border-white/20 bg-white text-teal-700 shadow-lg">
                  <Icon name="spark" size={34} />
                </div>
                <p className="mt-6 text-xs font-bold uppercase tracking-[0.2em] text-teal-100">MEDICALL AI ASSISTANT</p>
                <h2 className="mt-3 text-2xl font-black sm:text-3xl">
                  How can we help today?
                </h2>
                <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-teal-50">
                  Ask about doctors, consultation fees or appointments. Chat in Hindi or English.
                </p>
                <button
                  className="mt-6 w-full rounded-xl bg-white px-5 py-4 text-sm font-extrabold text-teal-800 shadow-lg transition hover:bg-teal-50"
                  onClick={() => setChatOpen(true)}
                >
                  Talk to MediCall AI <span className="ml-1">→</span>
                </button>
                <div className="mt-5 flex justify-center gap-2 text-xs text-teal-50"><span>✓ Hindi & English</span><span>·</span><span>✓ Voice input</span></div>
              </div>
            </div>
          </section>

          <section id="booking" className="mt-24 scroll-mt-24 md:mt-28">
            <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="text-xs font-extrabold uppercase tracking-[0.22em] text-teal-700">PERSONALIZED CARE</p>
                <h2 className="mt-3 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl md:text-5xl">
                  {clinic?.clinicName || "Book your appointment"}
                </h2>
                <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">Meet the right specialist and choose a time that works for you. Our team is here to make your visit simple.</p>
              </div>
              <div className="inline-flex w-fit items-center gap-2 rounded-full border border-teal-100 bg-white px-4 py-2.5 text-sm font-semibold text-teal-800 shadow-sm">
                <span className="h-2 w-2 rounded-full bg-emerald-500" /> Easy online booking
              </div>
            </div>

            <div className="grid items-stretch gap-7 xl:grid-cols-[0.95fr_1.05fr]">
              <section className="overflow-hidden rounded-[1.5rem] border border-slate-200/80 bg-white shadow-sm">
                <div className="bg-gradient-to-br from-slate-950 via-teal-950 to-teal-800 p-7 text-white sm:p-9">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-bold uppercase tracking-[0.2em] text-teal-200">OUR MEDICAL TEAM</p>
                      <h3 className="mt-3 text-2xl font-black sm:text-3xl">Care you can trust.</h3>
                      <p className="mt-2 max-w-sm text-sm leading-6 text-teal-50/85">Explore specialists and their consultation fees before you book.</p>
                    </div>
                    <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl border border-white/15 bg-white/10"><Icon name="plus" size={28} /></span>
                  </div>
                  <div className="mt-6 flex flex-wrap gap-3 text-sm">
                    <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5">{doctors.length} specialist{doctors.length === 1 ? "" : "s"}</span>
                    <span className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5">Transparent fees</span>
                  </div>
                </div>
                <div className="space-y-3 p-5 sm:p-7">
                  {doctors.map((doctor) => (
                    <button
                      key={doctor._id}
                      type="button"
                      onClick={() => setBooking((previous) => ({ ...previous, doctorId: doctor._id }))}
                      className={`group flex w-full items-center gap-4 rounded-2xl border p-4 text-left transition duration-200 sm:p-5 ${booking.doctorId === doctor._id ? "border-teal-400 bg-teal-50 ring-4 ring-teal-50" : "border-slate-100 bg-slate-50/70 hover:border-teal-200 hover:bg-white hover:shadow-md"}`}
                    >
                      <span className={`grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-xl font-black ${booking.doctorId === doctor._id ? "bg-teal-600 text-white" : "bg-white text-teal-700 shadow-sm"}`}>{doctor.name?.trim()?.charAt(0)?.toUpperCase() || "D"}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-base font-extrabold text-slate-900 sm:text-lg">{doctor.name}</span>
                        <span className="mt-1 block text-sm text-slate-500">{doctor.specialization}</span>
                        <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-teal-700"><span>✓</span> Select specialist</span>
                      </span>
                      <span className="text-right">
                        <span className="block text-lg font-black text-slate-950">₹{doctor.fee}</span>
                        <span className="mt-1 block text-xs text-slate-500">per visit</span>
                      </span>
                    </button>
                  ))}
                  {!doctors.length && (
                    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
                      <span className="text-3xl">🩺</span>
                      <p className="mt-3 font-bold text-slate-800">Doctor profiles coming soon</p>
                      <p className="mt-1 text-sm text-slate-500">Please contact the clinic for assistance.</p>
                    </div>
                  )}
                </div>
              </section>

              <form onSubmit={bookAppointment} className="rounded-[1.5rem] border border-slate-200/80 bg-white p-6 shadow-sm sm:p-8 lg:p-10">
                <div className="mb-7 flex items-start gap-4">
                  <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-teal-50 text-2xl text-teal-700">▣</span>
                  <div>
                    <p className="text-xs font-extrabold uppercase tracking-[0.18em] text-teal-700">APPOINTMENT REQUEST</p>
                    <h3 className="mt-2 text-2xl font-black text-slate-950 sm:text-3xl">Let's book your visit</h3>
                    <p className="mt-2 text-sm leading-6 text-slate-500">Fill in the details below. Fields marked * are required.</p>
                  </div>
                </div>

                <div className="grid gap-5 sm:grid-cols-2">
                  <label className="block sm:col-span-1">
                    <span className="mb-2 block text-sm font-bold text-slate-700">Full name *</span>
                    <input className={`${field} min-h-12 rounded-xl bg-slate-50/70 px-4`} placeholder="e.g. Ali Khan" required value={booking.patientName} onChange={(e) => setBooking({ ...booking, patientName: e.target.value })} />
                  </label>
                  <label className="block sm:col-span-1">
                    <span className="mb-2 block text-sm font-bold text-slate-700">Phone number *</span>
                    <input className={`${field} min-h-12 rounded-xl bg-slate-50/70 px-4`} placeholder="Your contact number" type="tel" inputMode="tel" required value={booking.phone} onChange={(e) => setBooking({ ...booking, phone: e.target.value })} />
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="mb-2 block text-sm font-bold text-slate-700">Choose a doctor *</span>
                    <select className={`${field} min-h-12 rounded-xl bg-slate-50/70 px-4`} required value={booking.doctorId} onChange={(e) => setBooking({ ...booking, doctorId: e.target.value })}>
                      <option value="">Select a specialist</option>
                      {doctors.map((doctor) => <option key={doctor._id} value={doctor._id}>{doctor.name} — {doctor.specialization} (₹{doctor.fee})</option>)}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-2 block text-sm font-bold text-slate-700">Preferred date *</span>
                    <input className={`${field} min-h-12 rounded-xl bg-slate-50/70 px-4`} type="date" min={today} required value={booking.date} onChange={(e) => setBooking({ ...booking, date: e.target.value })} />
                  </label>
                  <label className="block">
                    <span className="mb-2 block text-sm font-bold text-slate-700">Preferred time *</span>
                    <select className={`${field} min-h-12 rounded-xl bg-slate-50/70 px-4`} required value={booking.time} onChange={(e) => setBooking({ ...booking, time: e.target.value })}>
                      <option value="">Choose a time</option>
                      {Array.from({ length: 16 }, (_, i) => {
                        const hour = 9 + Math.floor(i / 2);
                        const minute = i % 2 ? "30" : "00";
                        const time = `${String(hour).padStart(2, "0")}:${minute}`;
                        return <option key={time} value={time}>{time}</option>;
                      })}
                    </select>
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="mb-2 block text-sm font-bold text-slate-700">Reason for visit <span className="font-normal text-slate-400">(optional)</span></span>
                    <textarea className={`${field} rounded-xl bg-slate-50/70 px-4`} rows={4} placeholder="Tell us briefly what you need help with" value={booking.reason} onChange={(e) => setBooking({ ...booking, reason: e.target.value })} />
                  </label>
                </div>

                <button className={`${button} mt-6 flex min-h-14 w-full items-center justify-center gap-2 rounded-xl text-base shadow-lg shadow-teal-700/20`} disabled={busy || !clinic || !doctors.length}>
                  {busy ? "Submitting your request…" : "Confirm appointment request →"}
                </button>
                <p className="mt-4 flex items-start justify-center gap-2 text-center text-xs leading-5 text-slate-500"><span className="text-teal-700">✓</span> Your details are sent securely to the clinic for processing.</p>
              </form>
            </div>
          </section>
        </main>
      )}

      {page === "auth" && (
        <main className="relative mx-auto grid min-h-[78vh] max-w-6xl items-center gap-10 px-4 py-10 md:grid-cols-2 md:px-8">
          <section className="hidden overflow-hidden rounded-[2rem] bg-gradient-to-br from-slate-950 via-teal-950 to-teal-700 p-10 text-white shadow-xl md:block">
            <div className="grid h-14 w-14 place-items-center rounded-2xl border border-white/20 bg-white/10 text-2xl">✚</div>
            <p className="mt-10 text-xs font-bold uppercase tracking-[0.25em] text-teal-200">MEDICALL AI</p>
            <h1 className="mt-4 text-4xl font-black leading-tight">Better care starts with a simpler experience.</h1>
            <p className="mt-4 max-w-md leading-7 text-teal-50/80">Secure access for clinic teams and patients, all in one place.</p>
            <div className="mt-10 grid gap-3 text-sm text-teal-50/90"><p>✓ Manage appointments with ease</p><p>✓ Explore doctors and book visits</p><p>✓ Keep your account details in one place</p></div>
          </section>
          <form onSubmit={registerOrLogin} className="mx-auto w-full max-w-md space-y-5 rounded-[2rem] border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50 sm:p-9">
            <div className="mb-2 flex rounded-2xl bg-slate-100 p-1.5">
              <button type="button" onClick={() => setAuthMode(authMode.startsWith("patient-") ? "patient-login" : "clinic-login")} className={`flex-1 rounded-xl px-3 py-2.5 text-sm font-bold ${authMode.startsWith("patient-") ? "text-slate-500" : "bg-white text-teal-800 shadow-sm"}`}>Clinic</button>
              <button type="button" onClick={() => setAuthMode("patient-login")} className={`flex-1 rounded-xl px-3 py-2.5 text-sm font-bold ${authMode.startsWith("patient-") ? "bg-white text-teal-800 shadow-sm" : "text-slate-500"}`}>Patient</button>
            </div>
            <div><p className="text-xs font-extrabold uppercase tracking-[0.2em] text-teal-700">Welcome to MediCall</p><h2 className="mt-2 text-3xl font-black tracking-tight text-slate-950">{authMode.endsWith("register") ? "Create your account" : "Welcome back"}</h2><p className="mt-2 text-sm leading-6 text-slate-500">{authMode.startsWith("patient-") ? "Sign in to your patient account or create one to get started." : "Sign in to manage your clinic workspace."}</p></div>
            {authMode.startsWith("patient-") ? <>
              {authMode.endsWith("register") && <>
                <label className="block"><span className="mb-2 block text-sm font-semibold text-slate-700">Full name</span><input className={`${field} rounded-xl bg-slate-50`} placeholder="Your full name" required value={patientAuth.fullName} onChange={(e) => setPatientAuth({ ...patientAuth, fullName: e.target.value })} /></label>
                <label className="block"><span className="mb-2 block text-sm font-semibold text-slate-700">Phone number</span><input className={`${field} rounded-xl bg-slate-50`} type="tel" placeholder="Your phone number" required value={patientAuth.phone} onChange={(e) => setPatientAuth({ ...patientAuth, phone: e.target.value })} /></label>
              </>}
              <label className="block"><span className="mb-2 block text-sm font-semibold text-slate-700">Email address</span><input className={`${field} rounded-xl bg-slate-50`} type="email" placeholder="you@example.com" required value={patientAuth.email} onChange={(e) => setPatientAuth({ ...patientAuth, email: e.target.value })} /></label>
              <label className="block"><span className="mb-2 block text-sm font-semibold text-slate-700">Password</span><input className={`${field} rounded-xl bg-slate-50`} type="password" minLength={8} placeholder="At least 8 characters" required value={patientAuth.password} onChange={(e) => setPatientAuth({ ...patientAuth, password: e.target.value })} /></label>
            </> : <>
              {authMode.endsWith("register") && <>
                <label className="block"><span className="mb-2 block text-sm font-semibold text-slate-700">Clinic name</span><input className={`${field} rounded-xl bg-slate-50`} placeholder="Clinic name" required value={auth.clinicName} onChange={(e) => setAuth({ ...auth, clinicName: e.target.value })} /></label>
                <label className="block"><span className="mb-2 block text-sm font-semibold text-slate-700">Admin name</span><input className={`${field} rounded-xl bg-slate-50`} placeholder="Admin name" required value={auth.adminName} onChange={(e) => setAuth({ ...auth, adminName: e.target.value })} /></label>
              </>}
              <label className="block"><span className="mb-2 block text-sm font-semibold text-slate-700">Email address</span><input className={`${field} rounded-xl bg-slate-50`} type="email" placeholder="clinic@example.com" required value={auth.email} onChange={(e) => setAuth({ ...auth, email: e.target.value })} /></label>
              <label className="block"><span className="mb-2 block text-sm font-semibold text-slate-700">Password</span><input className={`${field} rounded-xl bg-slate-50`} type="password" minLength={8} placeholder="At least 8 characters" required value={auth.password} onChange={(e) => setAuth({ ...auth, password: e.target.value })} /></label>
            </>}
            <button className={`${button} w-full rounded-xl py-4`} disabled={busy}>{busy ? "Please wait…" : authMode.endsWith("register") ? "Create account" : "Sign in securely"}</button>
            <p className="text-center text-sm text-slate-500">{authMode.endsWith("register") ? "Already have an account?" : "New to MediCall?"} <button type="button" className="font-bold text-teal-700 hover:text-teal-900" onClick={() => setAuthMode(authMode.endsWith("register") ? authMode.replace("register", "login") : authMode.replace("login", "register"))}>{authMode.endsWith("register") ? "Sign in" : "Create account"}</button></p>
            <button type="button" onClick={() => setPage("home")} className="w-full text-sm font-semibold text-slate-400 hover:text-slate-700">← Back to patient website</button>
          </form>
        </main>
      )}

      {page === "patient-dashboard" && (
        <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
          <section className="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm">
            <div className="bg-gradient-to-r from-teal-800 to-teal-600 p-8 text-white sm:p-10"><p className="text-xs font-bold uppercase tracking-[0.22em] text-teal-100">PATIENT PORTAL</p><h1 className="mt-3 text-3xl font-black sm:text-4xl">Hello, {patient?.fullName || "there"}!</h1><p className="mt-3 max-w-xl text-sm leading-6 text-teal-50">Your MediCall patient account is ready. You can return to the clinic website to book a visit.</p></div>
            <div className="grid gap-5 p-6 sm:grid-cols-2 sm:p-8">
              <div className="rounded-2xl border border-slate-200 p-5"><p className="text-sm font-semibold text-slate-500">Full name</p><p className="mt-2 text-lg font-bold text-slate-900">{patient?.fullName || "—"}</p></div>
              <div className="rounded-2xl border border-slate-200 p-5"><p className="text-sm font-semibold text-slate-500">Email address</p><p className="mt-2 break-all text-lg font-bold text-slate-900">{patient?.email || "—"}</p></div>
              <div className="rounded-2xl border border-slate-200 p-5"><p className="text-sm font-semibold text-slate-500">Phone number</p><p className="mt-2 text-lg font-bold text-slate-900">{patient?.phone || "—"}</p></div>
              <div className="flex flex-col justify-center gap-3 rounded-2xl bg-teal-50 p-5"><p className="font-bold text-teal-950">Ready to see a doctor?</p><p className="text-sm leading-5 text-teal-800">Choose a specialist and submit an appointment request.</p><button className={`${button} w-full`} onClick={() => setPage("home")}>Book an appointment →</button></div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-6 py-5 sm:px-8"><p className="text-sm text-slate-500">You are signed in as a patient.</p><button onClick={patientLogout} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50">Log out of patient account</button></div>
          </section>
        </main>
      )}

      {page === "dashboard" && (
        <main className="mx-auto max-w-[1440px] px-4 py-7 sm:px-6 lg:px-10">
          <section className="relative mb-7 overflow-hidden rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-teal-50" />
            <div className="pointer-events-none absolute right-24 top-16 h-24 w-24 rounded-full border border-teal-100" />
            <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-emerald-100 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" /> Clinic workspace
                </div>
                <h1 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
                  Good to see you, {adminClinic?.adminName || "Admin"}
                </h1>
                <p className="mt-2 text-sm text-slate-500">{adminClinic?.clinicName || "Your clinic"} · Manage appointments, doctors and patient visits.</p>
              </div>
              <button className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition hover:border-teal-300 hover:bg-teal-50" onClick={loadDashboard}>
                <Icon name="arrow" size={16} /> Refresh data
              </button>
            </div>
          </section>

          <section className="mb-7 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: "Today's appointments", value: stats.today || 0, note: "Scheduled for today", icon: "message", tint: "bg-blue-50 text-blue-700" },
              { label: "Upcoming visits", value: stats.upcoming || 0, note: "Confirmed appointments", icon: "arrow", tint: "bg-teal-50 text-teal-700" },
              { label: "Unique patients", value: stats.patients || 0, note: "Patients in your records", icon: "user", tint: "bg-violet-50 text-violet-700" },
              { label: "Doctors", value: stats.doctors || 0, note: "Available specialists", icon: "plus", tint: "bg-amber-50 text-amber-700" },
            ].map((item) => (
              <article key={item.label} className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_2px_10px_rgba(15,23,42,0.025)] transition hover:-translate-y-0.5 hover:shadow-md">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-slate-500">{item.label}</p>
                    <p className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">{item.value}</p>
                  </div>
                  <span className={`grid h-11 w-11 place-items-center rounded-xl ${item.tint}`}><Icon name={item.icon} size={20} /></span>
                </div>
                <p className="mt-3 text-xs text-slate-400">{item.note}</p>
              </article>
            ))}
          </section>

          <section className="mb-7 overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
            <div className="flex flex-col gap-2 border-b border-slate-100 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div>
                <h2 className="text-lg font-semibold tracking-tight text-slate-950">Appointments</h2>
                <p className="mt-1 text-sm text-slate-500">Review bookings and update their status.</p>
              </div>
              <span className="w-fit rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600">{appointments.length} total</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="bg-slate-50/80 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-6 py-4">Patient</th><th className="px-6 py-4">Specialist</th><th className="px-6 py-4">Appointment</th><th className="px-6 py-4">Status</th><th className="px-6 py-4">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {appointments.map((appointment) => (
                    <tr key={appointment._id} className="transition hover:bg-slate-50/70">
                      <td className="px-6 py-4">
                        <div className="font-semibold text-slate-800">{appointment.patientName}</div>
                        <div className="mt-1 text-xs text-slate-500">{appointment.phone}</div>
                      </td>
                      <td className="px-6 py-4"><div className="font-medium text-slate-700">{appointment.doctorId?.name || "Doctor"}</div></td>
                      <td className="px-6 py-4"><div className="font-medium text-slate-700">{appointment.date}</div><div className="mt-1 text-xs text-slate-500">{appointment.time}</div></td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${appointment.status === "Confirmed" ? "bg-emerald-50 text-emerald-700" : appointment.status === "Cancelled" ? "bg-rose-50 text-rose-700" : appointment.status === "Completed" ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-700"}`}>{appointment.status}</span>
                      </td>
                      <td className="px-6 py-4">
                        {appointment.status === "Confirmed" ? <div className="flex items-center gap-3">
                          <button className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:border-teal-300 hover:text-teal-700" onClick={() => updateAppointment(appointment._id, "Completed")}>Mark complete</button>
                          <button className="px-2 py-2 text-xs font-semibold text-rose-600 hover:text-rose-700" onClick={() => updateAppointment(appointment._id, "Cancelled")}>Cancel</button>
                        </div> : <span className="text-xs text-slate-400">No actions</span>}
                      </td>
                    </tr>
                  ))}
                  {!appointments.length && <tr><td colSpan="5" className="px-6 py-14 text-center">
                    <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400"><Icon name="message" size={22} /></span>
                    <p className="mt-3 font-semibold text-slate-700">No appointments yet</p><p className="mt-1 text-sm text-slate-500">New patient bookings will appear here.</p>
                  </td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section className="grid gap-6 xl:grid-cols-[0.85fr_1.15fr]">
            <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6">
              <div className="mb-5">
                <h2 className="text-lg font-semibold tracking-tight text-slate-950">Add a doctor</h2>
                <p className="mt-1 text-sm text-slate-500">Add a specialist to your clinic directory.</p>
              </div>
              <form onSubmit={addDoctor} className="space-y-4">
                <label className="block"><span className="mb-1.5 block text-xs font-semibold text-slate-600">Doctor name</span><input className={`${field} rounded-xl bg-slate-50/70`} placeholder="e.g. Dr. Aditi Sharma" required value={doctorForm.name} onChange={(e) => setDoctorForm({ ...doctorForm, name: e.target.value })} /></label>
                <label className="block"><span className="mb-1.5 block text-xs font-semibold text-slate-600">Specialization</span><input className={`${field} rounded-xl bg-slate-50/70`} placeholder="e.g. Orthopaedics" required value={doctorForm.specialization} onChange={(e) => setDoctorForm({ ...doctorForm, specialization: e.target.value })} /></label>
                <label className="block"><span className="mb-1.5 block text-xs font-semibold text-slate-600">Consultation fee (₹)</span><input className={`${field} rounded-xl bg-slate-50/70`} type="number" min="0" placeholder="500" value={doctorForm.fee} onChange={(e) => setDoctorForm({ ...doctorForm, fee: e.target.value })} /></label>
                <button className={`${button} flex w-full items-center justify-center gap-2 rounded-xl`}><Icon name="plus" size={16} /> Add doctor</button>
              </form>
            </div>
            <div className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6">
              <div className="mb-5 flex items-start justify-between gap-3">
                <div><h2 className="text-lg font-semibold tracking-tight text-slate-950">Clinic team</h2><p className="mt-1 text-sm text-slate-500">Doctors currently listed for your clinic.</p></div>
                <span className="rounded-full bg-teal-50 px-3 py-1.5 text-xs font-semibold text-teal-700">{adminDoctors.length} doctors</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {adminDoctors.map((doctor) => (
                  <article key={doctor._id} className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50/60 p-4">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white text-sm font-bold text-teal-700 shadow-sm">{(doctor.name || "D").replace(/^dr\.?\s*/i, "").slice(0, 1).toUpperCase()}</span>
                    <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-800">{doctor.name}</p><p className="mt-1 truncate text-xs text-slate-500">{doctor.specialization}</p><p className="mt-2 text-xs font-semibold text-teal-700">₹{doctor.fee} <span className="font-normal text-slate-400">/ visit</span></p></div>
                  </article>
                ))}
                {!adminDoctors.length && <div className="col-span-full rounded-xl border border-dashed border-slate-200 px-4 py-10 text-center"><p className="font-semibold text-slate-700">No doctors added yet</p><p className="mt-1 text-sm text-slate-500">Add your clinic’s first doctor using the form.</p></div>}
              </div>
            </div>
          </section>
        </main>
      )}
      <footer className="border-t bg-white px-5 py-6 text-center text-xs text-slate-500">
        © {new Date().getFullYear()} MediCall AI · Clinic-managed appointments
      </footer>

      {chatOpen && (
        <section className="fixed bottom-20 right-3 z-50 flex h-[min(720px,82dvh)] w-[min(440px,calc(100vw-24px))] flex-col overflow-hidden rounded-[1.5rem] border border-slate-200 bg-white shadow-[0_24px_80px_-28px_rgba(15,23,42,0.35)] sm:bottom-24 sm:right-5">
          <header className="flex items-center justify-between border-b border-slate-100 bg-white p-4 text-slate-900">
            <div>
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-teal-50 text-teal-700"><Icon name="spark" size={21} /></span>
                <div><h2 className="font-semibold tracking-tight">MediCall AI</h2>
                <p className="mt-0.5 text-xs text-slate-500">Clinic assistant · Hindi & English</p></div>
              </div>
            </div>
            <button
              onClick={() => setChatOpen(false)}
              aria-label="Close chat"
              className="grid h-9 w-9 place-items-center rounded-xl text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            >
              <Icon name="close" />
            </button>
          </header>

          <div className="flex-1 space-y-3 overflow-y-auto bg-[#f8fafc] p-4">
            {chatMessages.map((message, index) => (
              <div
                key={index}
                className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm ${
                  message.role === "user"
                    ? "ml-auto rounded-br-md bg-teal-700 text-white"
                    : "rounded-bl-md border border-slate-200/80 bg-white text-slate-800"
                }`}
              >
                {message.text}

                {message.role === "assistant" && (
                  <button
                    className="ml-2 text-xs text-teal-700"
                    title="Read aloud"
                    onClick={() => speak(message.text)}
                  >
                    <Icon name="volume" size={15} />
                  </button>
                )}
              </div>
            ))}

            {chatLoading && (
              <p className="text-sm text-slate-500">MediCall is typing...</p>
            )}

            <div ref={chatEndRef} />
          </div>

          {(notice || error) && <div className={`px-3 py-2 text-xs ${error ? "bg-red-50 text-red-700" : "bg-teal-50 text-teal-800"}`}>{error || notice}</div>}

          <form onSubmit={sendChat} className="flex items-center gap-2 border-t border-slate-100 bg-white p-3">
            <input
              className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none transition placeholder:text-slate-400 focus:border-teal-500 focus:bg-white focus:ring-4 focus:ring-teal-50"
              placeholder="Type your message..."
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              disabled={chatLoading}
            />

            <button
              type="button"
              className={`rounded-xl px-4 py-3 text-sm font-bold transition ${voiceMode ? "animate-pulse bg-red-600 text-white" : "bg-teal-50 text-teal-800 hover:bg-teal-100"}`}
              title={voiceMode ? "Stop live voice conversation" : "Start live voice conversation"}
              onClick={() => startVoice(false)}
              disabled={chatLoading && !voiceMode}
              aria-label={voiceMode ? "Stop live voice conversation" : "Start live voice conversation"}
            >
              <span className="inline-flex items-center gap-2">{voiceMode ? <Icon name="close" size={16} /> : <Icon name="mic" size={16} />}{voiceMode ? "End voice" : "Live voice"}</span>
            </button>

            <button className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-teal-700 text-white transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-40" disabled={chatLoading || !chatInput.trim()} aria-label="Send message" title="Send message">
              <Icon name="send" size={17} />
            </button>
          </form>

          <div className="border-t border-slate-100 px-3 py-2 text-center text-[10px] text-slate-400">
            Live voice: speak naturally and pause; replies play aloud and listening resumes automatically. Hindi accuracy depends on audio quality and model support.
          </div>
        </section>
      )}

      {!chatOpen && (
        <button
          className="fixed bottom-5 right-5 z-40 grid h-16 w-16 place-items-center rounded-2xl bg-teal-700 text-2xl text-white shadow-xl shadow-teal-900/25 transition hover:-translate-y-1 hover:bg-teal-800"
          onClick={() => setChatOpen(true)}
          aria-label="Open MediCall AI"
        >
          <Icon name="message" size={26} />
        </button>
      )}
    </div>
  );
}