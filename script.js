// health-app.js - full file (AI suggestion fixes + safe rendering + integration)

// IndexedDB constants
const DB_NAME = "health-db";
const DB_VERSION = 1;
const STORE_PROFILE = "profile";
const STORE_RECORDS = "records";
const STORE_HOSPITALS = "hospitals";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_PROFILE)) db.createObjectStore(STORE_PROFILE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_RECORDS)) db.createObjectStore(STORE_RECORDS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(STORE_HOSPITALS)) db.createObjectStore(STORE_HOSPITALS, { keyPath: "Name" });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbPut(store, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const s = tx.objectStore(store);
    const r = s.put(value);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function dbGetAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const s = tx.objectStore(store);
    const r = s.getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function dbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const s = tx.objectStore(store);
    const r = s.get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function dbClear(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const s = tx.objectStore(store);
    const r = s.clear();
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

// App state
let hospitals = [];
let userLat = null;
let userLon = null;
let Nearest = [];
let chartInstance = null;

const state = {
  userProfile: null,
  healthRecords: [],
  activeAlert: null,
  medicalConditions: [],
  medications: [],
  allergies: [],
  emergencyOnly: false,
  selectedSpecialty: "all",
  aiSuggestion: null, // latest suggestion object
};

const commonSymptoms = [
  "Headache",
  "Dizziness",
  "Fatigue",
  "Nausea",
  "Chest pain",
  "Shortness of breath",
  "Cough",
  "Fever",
];

function escapeForJs(str = "") {
  return String(str).replace(/'/g, "\\'").replace(/\n/g, " ");
}

function escapeHtmlForDisplay(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatDistance(km) {
  if (!isFinite(km)) return "Unknown";
  return km < 1 ? Math.round(km * 1000) + " meters" : km.toFixed(2) + " km";
}

function getDistance(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v == null || isNaN(v))) return Infinity;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getNumberValue(id, fallback = null) {
  const el = document.getElementById(id);
  if (!el) return fallback;
  const v = el.value;
  if (v === "" || v == null) return fallback;
  const n = parseFloat(v);
  return isNaN(n) ? fallback : n;
}

function getTextValue(id, fallback = "") {
  const el = document.getElementById(id);
  return el ? (el.value || "") : fallback;
}

function feverSeverityFromRecord(record) {
  if (!record) return 0;
  const raw = record.temperature;
  if (raw == null || raw === "") {
    if (record.symptoms && record.symptoms.some(s => s.toLowerCase() === "fever")) return 5;
    return 0;
  }
  const n = Number(raw);
  if (!isFinite(n)) return 0;
  const tempF = (n <= 45) ? (n * 9 / 5 + 32) : n;
  if (tempF < 98) return 0;
  if (tempF < 99.5) return 2;
  if (tempF < 100.4) return 4;
  if (tempF < 102) return 7;
  return 9;
}

function painSeverityFromRecord(record) {
  let score = 0;
  if (record.symptoms && record.symptoms.length) {
    const sLower = record.symptoms.map(s => s.toLowerCase());
    if (sLower.includes("chest pain")) score += 6;
    if (sLower.includes("headache")) score += 3;
    if (sLower.includes("fatigue")) score += 1;
    if (score > 9) score = 9;
  }
  return score;
}

function detectDiseaseType(tags) {
  const name = (tags.name || "").toLowerCase();
  const desc = (tags.description || "").toLowerCase();
  const full = `${name} ${desc}`;
  const types = {
    heart: ["heart", "cardio", "cardiac"],
    bone: ["bone", "ortho", "orthopaedic", "orthopedic"],
    cancer: ["cancer", "oncology", "tumor", "tumour"],
    neuro: ["neuro", "brain", "nervous"],
    dental: ["dental", "dentist", "teeth"],
    eye: ["eye", "vision", "ophthalm"],
    skin: ["skin", "derma", "dermatology"],
    child: ["child", "pediatric", "paediatric"],
    women: ["women", "gyne", "obg", "obgyn"],
    general: [],
  };
  for (let type in types) {
    for (let key of types[type]) {
      if (full.includes(key)) return type;
    }
  }
  return "general";
}

function buildOverpassUrl(lat, lon, radius = 5000) {
  const q = `[out:json];node["amenity"="hospital"](around:${radius},${lat},${lon});out;`;
  return "https://overpass-api.de/api/interpreter?data=" + encodeURIComponent(q);
}

async function fetchHospitals(lat, lon) {
  if (lat == null || lon == null) return;
  const url = buildOverpassUrl(lat, lon);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Network error fetching hospitals");
    const data = await res.json();
    hospitals = (data.elements || []).map((h) => {
      const tags = h.tags || {};
      const detected = detectDiseaseType(tags);
      const specialties = [];
      if (tags.specialty) specialties.push(tags.specialty);
      if (tags.specialties) specialties.push(...tags.specialties.split(",").map((s) => s.trim()));
      return {
        Name: tags.name || "Unnamed Hospital",
        lat: h.lat,
        lng: h.lon,
        Contact: tags.phone || tags.contact || "N/A",
        Category: [detected],
        specialties: specialties.length ? specialties : ["General"],
        emergencyAvailable: tags.emergency === "yes" || false,
        distanceKm: null,
        Distance: null,
      };
    });

    hospitals.forEach((h) => {
      h.distanceKm = getDistance(userLat, userLon, h.lat, h.lng);
      h.Distance = formatDistance(h.distanceKm);
    });
    hospitals.sort((a, b) => (a.distanceKm || Infinity) - (b.distanceKm || Infinity));

    await dbClear(STORE_HOSPITALS);
    await Promise.all(hospitals.map((h) => dbPut(STORE_HOSPITALS, h)));

    const out = document.getElementById("output");
    if (out) out.textContent = `Fetched ${hospitals.length} hospitals. Enter disease type to search.`;
    renderHospitals();
  } catch (err) {
    console.error("fetchHospitals error:", err);
    const out = document.getElementById("output");
    if (out) out.textContent = "Failed to fetch hospitals: " + err.message;
  }
}

async function loadPersistedData() {
  try {
    const savedProfile = await dbGetAll(STORE_PROFILE);
    if (savedProfile && savedProfile.length) {
      state.userProfile = savedProfile[0];
    }

    const savedRecords = await dbGetAll(STORE_RECORDS);
    if (savedRecords && savedRecords.length) {
      state.healthRecords = savedRecords
        .map((r) => ({ ...r, date: new Date(r.date) }))
        .sort((a, b) => new Date(b.date) - new Date(a.date));
    } else {
      state.healthRecords = [];
    }

    const savedHosp = await dbGetAll(STORE_HOSPITALS);
    if (savedHosp && savedHosp.length) {
      hospitals = savedHosp.map((h) => ({ ...h, distanceKm: h.distanceKm || null }));
      if (userLat != null && userLon != null) {
        hospitals.forEach((h) => {
          h.distanceKm = getDistance(userLat, userLon, h.lat, h.lng);
          h.Distance = formatDistance(h.distanceKm);
        });
        hospitals.sort((a, b) => (a.distanceKm || Infinity) - (b.distanceKm || Infinity));
      }
    }

    // Pre-generate AI suggestion for the latest record (if exists)
    if (state.healthRecords && state.healthRecords.length) {
      state.aiSuggestion = generateAISuggestion(state.healthRecords[0], state.healthRecords.slice(1));
    }
  } catch (err) {
    console.error("loadPersistedData err:", err);
  }
}

function nearest(type) {
  if (!type) return null;
  const q = type.toLowerCase().trim();
  const filtered = hospitals.filter((h) => {
    const inCategory = Array.isArray(h.Category) && h.Category.some((c) => c.toLowerCase() === q);
    const inSpecialty = Array.isArray(h.specialties) && h.specialties.some((s) => s.toLowerCase().includes(q));
    const inName = h.Name && h.Name.toLowerCase().includes(q);
    return inCategory || inSpecialty || inName;
  });
  if (filtered.length === 0) return null;
  filtered.forEach((h) => {
    if (h.distanceKm == null || !isFinite(h.distanceKm)) {
      h.distanceKm = getDistance(userLat, userLon, h.lat, h.lng);
      h.Distance = formatDistance(h.distanceKm);
    }
  });
  filtered.sort((a, b) => (a.distanceKm || Infinity) - (b.distanceKm || Infinity));
  return filtered.slice(0, 3);
}

function searchHospitals() {
  const input = document.getElementById("search");
  if (!input) return;
  const type = input.value.toLowerCase().trim();
  const out = document.getElementById("output");
  if (!type) {
    if (out) out.textContent = "Enter a disease type.";
    return;
  }
  const result = nearest(type);
  if (!result || !result.length) {
    if (out) out.textContent = "No hospitals found for: " + type;
    return;
  }
  Nearest = [];
  let text = `Nearest hospitals for "${type}":\n\n`;
  result.forEach((h, i) => {
    Nearest.push({ Name: h.Name, Distance: h.Distance, Category: h.Category, Contact: h.Contact });
    text += `${i + 1}. ${h.Name} — ${h.Distance} — ${h.Contact}\nSpecialties: ${h.specialties.join(", ")}\n\n`;
  });
  if (out) out.textContent = text;
  renderHospitals();
}

function renderSidebar() {
  const sidebarContent = document.querySelector(".sidebar-content");
  if (!sidebarContent) return;

  if (!state.userProfile) {
    sidebarContent.innerHTML = `
      <div class="profile-empty">
        <i class="fas fa-user"></i>
        <h3>No Profile Set</h3>
        <p>Create your profile to enable personalized health monitoring</p>
        <button class="btn btn-primary btn-full" onclick="openProfileModal()">
          <i class="fas fa-user"></i> Create Profile
        </button>
      </div>
    `;
    return;
  }

  const profile = state.userProfile;
  const initials = (profile.name || "U").split(" ").map((n) => n[0] || "").join("").toUpperCase().slice(0, 2);

  let html = `
    <div class="profile-header">
      <div class="avatar">${initials}</div>
      <h2>${profile.name}</h2>
      <p>${profile.age} years • ${profile.gender}</p>
      <button class="btn btn-outline btn-sm" onclick="openProfileModal()" style="margin-top:0.75rem;">
        <i class="fas fa-edit"></i> Edit Profile
      </button>
    </div>

    <div class="profile-card">
      <h4>Basic Information</h4>
      <div class="profile-info"><span>Blood Type:</span><span>${profile.bloodType}</span></div>
      <div class="profile-info"><span>Height:</span><span>${(profile.height>250)?"Invalid":profile.height+" cm"}</span></div>
      <div class="profile-info"><span>Weight:</span><span>${(profile.weight>180)?"Invalid":profile.weight+" kg"}</span></div>
    </div>

    <div class="profile-card">
      <h4>Contact Information</h4>
      <div class="profile-contact"><i class="fas fa-envelope"></i><span>${profile.email}</span></div>
      <div class="profile-contact"><i class="fas fa-phone"></i><span>${profile.phone}</span></div>
    </div>

    <div class="profile-card emergency">
      <h4><i class="fas fa-exclamation-triangle"></i> Emergency Contact</h4>
      <div class="profile-info"><span>Name</span><span>${profile.emergencyContact}</span></div>
      <div class="profile-info"><span>Phone</span><span>${profile.emergencyPhone}</span></div>
    </div>
  `;
  if (profile.medicalConditions && profile.medicalConditions.length > 0) {
    html += `<div class="profile-card"><h4>Medical Conditions</h4><div class="tags">${profile.medicalConditions.map((c)=>`<span class="tag">${c}</span>`).join("")}</div></div>`;
  }
  if (profile.medications && profile.medications.length > 0) {
    html += `<div class="profile-card"><h4>Current Medications</h4><div class="medications-list">${profile.medications.map((m)=>`<div><span>•</span><span>${m}</span></div>`).join("")}</div></div>`;
  }
  if (profile.allergies && profile.allergies.length > 0) {
    html += `<div class="profile-card warning"><h4><i class="fas fa-exclamation-circle"></i> Allergies</h4><div class="tags">${profile.allergies.map((a)=>`<span class="tag danger">${a}</span>`).join("")}</div></div>`;
  }

  sidebarContent.innerHTML = html;
}

function renderDashboard() {
  const latestRecord = state.healthRecords[0];
  const vitalsGrid = document.getElementById("vitalsGrid");
  if (!vitalsGrid) return;

  if (!latestRecord) {
    const symptomsCard = document.getElementById("symptomsCard"); if (symptomsCard) symptomsCard.style.display = "none";
    vitalsGrid.innerHTML = "<p>No health data available.</p>";
    return;
  }

  document.getElementById("currentDate").textContent = new Date(latestRecord.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  let temp = "—";
  if (latestRecord.temperature != null && latestRecord.temperature !== "" && latestRecord.temperature >= 50 && latestRecord.temperature <= 120) {
    const n = Number(latestRecord.temperature);
    if (isFinite(n)) {
      if (n <= 45) {
        const f = (n * 9/5 + 32);
        temp = `${n} °C (${f.toFixed(1)} °F — used for analysis)`;
      } else {
        temp = `${n} °F`;
      }
    } else {
      temp = String(latestRecord.temperature>120?"Invalid":latestRecord.temperature);
    }
  }
  const urine = latestRecord.urine ? latestRecord.urine : "—";
  const notes = latestRecord.notes ? latestRecord.notes : "";

  // Ensure AI suggestion corresponds to the latest record
  if (!state.aiSuggestion || state.aiSuggestion.recordId !== latestRecord.id) {
    state.aiSuggestion = generateAISuggestion(latestRecord, state.healthRecords.slice(1));
  }

  const suggestion = state.aiSuggestion;
  let suggestionHtml = `<p>No suggestion available.</p>`;
  if (suggestion) {
    suggestionHtml = `
      <ul class="suggestion-list">${(suggestion.suggestions || []).map(s => `<li>${escapeHtmlForDisplay(s)}</li>`).join("")}</ul>`;
  }

  vitalsGrid.innerHTML = `
    <div class="vital-card"><div class="vital-card"><h4>Temperature</h4><p>${temp}</p></div><div class="vital-card"><h4>Urine</h4><p>${urine}</p></div></div>
    <div class="vital-card"><h4>Notes</h4><p>${escapeHtmlForDisplay(notes) || "—"}</p></div>

    <div class="vital-card" id="SuggestionCard">
      <h4>Suggestion</h4>
      <div class="card-header">${suggestionHtml}</div>
    </div>
  `;

  const symptomsCard = document.getElementById("symptomsCard");
  if (symptomsCard) {
    if (latestRecord.symptoms && latestRecord.symptoms.length > 0) {
      symptomsCard.style.display = "block";
      symptomsCard.innerHTML = `<div class="symptoms-card"><h4>Reported Symptoms</h4><div class="symptoms-list">${latestRecord.symptoms.map((s)=>`<span class="symptom-badge">${escapeHtmlForDisplay(s)}</span>`).join("")}</div></div>`;
    } else {
      symptomsCard.style.display = "none";
    }
  }
}

function renderAlert() {
  const alertBanner = document.getElementById("alertBanner");
  if (!alertBanner) return;

  if (!state.activeAlert) {
    alertBanner.style.display = "none";
    return;
  }

  const alert = state.activeAlert;
  const titles = { emergency: "EMERGENCY ALERT", urgent: "Urgent Attention Required", warning: "Health Warning", normal: "All Good" };
  const icons = { emergency: "fa-triangle-exclamation", urgent: "fa-circle-exclamation", warning: "fa-circle-info", normal: "fa-circle-check" };

  alertBanner.className = `alert-banner ${alert.level}`;
  alertBanner.style.display = "block";
  alertBanner.innerHTML = `
    <div class="alert-content">
      <div class="alert-icon"><i class="fas ${icons[alert.level]}"></i></div>
      <div class="alert-body">
        <div class="alert-header">
          <div>
            <h3>${titles[alert.level]}</h3>
            <p class="alert-message">${escapeHtmlForDisplay(alert.message)}</p>
          </div>
          ${alert.level !== "emergency" ? '<button class="alert-close" onclick="dismissAlert()">&times;</button>' : ""}
        </div>
        <div class="alert-recommendations">
          <p>Recommendations:</p>
          <ul>${(alert.recommendations || []).map((r)=>`<li><span>•</span><span>${escapeHtmlForDisplay(r)}</span></li>`).join("")}</ul>
        </div>
        ${alert.level === "emergency" ? `<div class="alert-actions"><button class="btn btn-danger" onclick="callEmergency()"><i class="fas fa-phone"></i> Call Emergency</button><button class="btn btn-outline" onclick="alertDoctor()"><i class="fas fa-phone"></i> Alert My Doctor</button></div>` : alert.level === "urgent" ? `<div class="alert-actions"><button class="btn btn-outline" onclick="alertDoctor()"><i class="fas fa-phone"></i> Contact Doctor</button></div>` : ""}
      </div>
    </div>
  `;
}

function renderSymptomCheckboxes() {
  const symptomsGrid = document.getElementById("symptomsGrid");
  if (!symptomsGrid) return;
  symptomsGrid.innerHTML = commonSymptoms.map(symptom => {
    const id = "symptom-" + symptom.replace(/\s+/g, "-");
    return `<div class="symptom-checkbox"><input type="checkbox" id="${id}" name="symptoms" value="${escapeHtmlForDisplay(symptom)}"><label for="${id}">${escapeHtmlForDisplay(symptom)}</label></div>`;
  }).join("");
}

async function ensureChartJsLoaded() {
  if (window.Chart) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/chart.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Chart.js"));
    document.head.appendChild(s);
  });
}

function describeChange(prev, curr, label) {
  if (prev == null) return "";
  if (curr > prev) return `More ${label} than previous`;
  if (curr < prev) return `Less ${label} than previous`;
  return `${label} similar to previous`;
}

async function renderTrends() {
  const trendsContent = document.getElementById("trendsContent");
  if (!trendsContent) return;

  if (!state.healthRecords || state.healthRecords.length === 0) {
    trendsContent.innerHTML = `<div class="card"><div class="card-content"><p style="text-align:center;color:#6b7280">No health data available yet. Complete check-ins to see trends.</p></div></div>`;
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    return;
  }

  const lastRecords = state.healthRecords.slice(0, 20).slice().reverse();
  const labels = lastRecords.map(r => new Date(r.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }));
  const feverData = lastRecords.map(r => feverSeverityFromRecord(r));
  const painData = lastRecords.map(r => painSeverityFromRecord(r));

  const historyHtml = state.healthRecords.slice(0, 8).map((record, idx, arr) => {
    const prev = arr[idx + 1];
    let feverNote = "";
    let painNote = "";
    if (prev) {
      const prevF = feverSeverityFromRecord(prev);
      const currF = feverSeverityFromRecord(record);
      const prevP = painSeverityFromRecord(prev);
      const currP = painSeverityFromRecord(record);
      feverNote = describeChange(prevF, currF, "fever");
      painNote = describeChange(prevP, currP, "pain");
    }
    const dateStr = new Date(record.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const symptomsText = record.symptoms && record.symptoms.length ? `Symptoms: ${record.symptoms.map(s=>escapeHtmlForDisplay(s)).join(", ")}` : "";
    const notesText = record.notes ? `Notes: ${escapeHtmlForDisplay(record.notes)}` : "";
    const changeNotes = [feverNote, painNote].filter(Boolean).join(" • ");
    return `
      <div class="history-item">
        <div>
          <div class="history-date">${dateStr}</div>
          ${symptomsText ? `<div class="history-details">${symptomsText}</div>` : ""}
          ${notesText ? `<div class="history-details">${notesText}</div>` : ""}
          ${changeNotes ? `<div class="history-details" style="font-style:italic;color:#6b7280">${changeNotes}</div>` : ""}
        </div>
        <div class="history-vitals"><div>Fever: ${feverSeverityFromRecord(record)}</div><div>Pain: ${painSeverityFromRecord(record)}</div></div>
      </div>
    `;
  }).join("");

  trendsContent.innerHTML = `
    <div class="chart-card" style="height:360px;">
      <h3>Health Condition Trends (Fever & Pain)</h3>
      <canvas id="trendsChart"></canvas>
    </div>
    <div class="card">
      <div class="card-header"><h3>Recent History</h3></div>
      <div class="card-content">${historyHtml}</div>
    </div>
  `;

  try {
    await ensureChartJsLoaded();
  } catch (err) {
    console.warn("Chart.js load failed:", err);
    return;
  }

  const ctx = document.getElementById("trendsChart").getContext("2d");

  if (chartInstance) chartInstance.destroy();
  chartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Fever Severity (0-10)",
          data: feverData,
          tension: 0.25,
          borderWidth: 2,
          pointRadius: 3,
          fill: true,
          // colors left to Chart defaults
        },
        {
          label: "Pain Severity (0-10)",
          data: painData,
          tension: 0.25,
          borderWidth: 2,
          pointRadius: 3,
          fill: true,
        }
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: true, position: 'top' }, tooltip: { mode: 'index', intersect: false } },
      scales: {
        x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
        y: { beginAtZero: true, max: 10, ticks: { stepSize: 1 } }
      },
      layout: { padding: { top: 6, right: 8, bottom: 6, left: 6 } }
    },
  });
}

function renderHospitals() {
  const specialtyFilter = document.getElementById("specialtyFilter");
  const hospitalsList = document.getElementById("hospitalsList");
  if (!hospitalsList) return;

  const allSpecialties = [...new Set(hospitals.flatMap(h => h.specialties || []))].sort();
  if (specialtyFilter) {
    const cur = specialtyFilter.value || "all";
    specialtyFilter.innerHTML = '<option value="all">All Specialties</option>' + allSpecialties.map(s => `<option value="${escapeHtmlForDisplay(s)}">${escapeHtmlForDisplay(s)}</option>`).join("");
    specialtyFilter.value = cur;
  }

  const filtered = hospitals.filter(h => {
    if (state.emergencyOnly && !h.emergencyAvailable) return false;
    if (state.selectedSpecialty && state.selectedSpecialty !== "all" && !h.specialties.includes(state.selectedSpecialty)) return false;
    return true;
  }).sort((a,b) => (a.distanceKm||Infinity) - (b.distanceKm||Infinity));

  if (filtered.length === 0) {
    hospitalsList.innerHTML = `<div class="card"><div class="card-content"><p style="text-align:center;color:#6b7280">No hospitals found matching your criteria</p></div></div>`;
    return;
  }

  hospitalsList.innerHTML = filtered.map(h => {
    const distanceText = h.Distance || formatDistance(h.distanceKm);
    const specialtiesHtml = (h.specialties || []).map(s => `<span class="specialty-badge">${escapeHtmlForDisplay(s)}</span>`).join(" ");
    return `
      <div class="hospital-card">
        <div class="hospital-header">
          <h3>${escapeHtmlForDisplay(h.Name)}</h3>
          <div class="hospital-meta"><div class="distance"><i class="fas fa-location-arrow"></i> <span>${escapeHtmlForDisplay(distanceText)} away</span></div></div>
        </div>
        <div class="specialties">${specialtiesHtml}</div>
        <div class="hospital-actions">
          <button class="btn btn-primary btn-sm" onclick="getDirections(${h.lat}, ${h.lng}, '${escapeForJs(h.Name)}')"><i class="fas fa-location-arrow"></i> Get Directions</button>
          <button class="btn btn-outline btn-sm" onclick="callHospital('${escapeForJs(h.Name)}', '${escapeForJs(h.Contact)}')"><i class="fas fa-phone"></i> ${escapeHtmlForDisplay(h.Contact)}</button>
        </div>
      </div>
    `;
  }).join("");
}

function dismissAlert() { state.activeAlert = null; renderAlert(); }
function callEmergency() {
  const phone = state.userProfile && state.userProfile.emergencyPhone ? state.userProfile.emergencyPhone : null;
  if (phone) {
    window.location.href = `tel:${phone}`;
  } else {
    const confirmed = confirm("No emergency number saved in profile. Call local emergency services?");
    if (confirmed) window.location.href = `tel:108`;
  }
}
function alertDoctor() {
  const docPhone = state.userProfile && state.userProfile.doctorPhone ? state.userProfile.doctorPhone : null;
  if (docPhone) {
    window.location.href = `tel:${docPhone}`;
  } else {
    alert("Doctor phone not available in profile.");
  }
}
function getDirections(lat, lng, name) {
  if (lat == null || lng == null) { alert("Coordinates not available."); return; }
  const gm = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
  window.open(gm, "_blank");
}
function callHospital(hospitalName, phone) {
  const cleaned = String(phone || "").replace(/[^\d+]/g, "");
  if (cleaned && cleaned !== "N") {
    window.location.href = `tel:${cleaned}`;
  } else {
    alert(`No phone available for ${hospitalName}`);
  }
}

function analyzeHealthData(current, history) {
  const issues = [];
  const recommendations = [];
  let level = "normal";

  function isNum(v){ return v != null && v !== "" && isFinite(Number(v)); }

  const rawTemp = current.temperature;
  let tempF = null;
  if (isNum(rawTemp)) {
    const n = Number(rawTemp);
    tempF = (n <= 45) ? (n * 9 / 5 + 32) : n;
  }

  if (tempF != null && (tempF > 100.4 || tempF < 95)) {
    issues.push("abnormal temperature");
    if (tempF > 103 ) {
      level = level === "emergency" ? "emergency" : "urgent";
      recommendations.push("High fever or hypothermia - seek medical care");
    }else if(tempF > 120){
      level = level === "invalid" ? "invalid" : "emergency";
      recommendations.push("very high temperature - fault in thermometer");
    } else if(tempF < 92){
      level = level === "emergency" ? "emergency" : "urgent";
      recommendations.push("low body temperature - seek medical care");
    } else if(tempF < 50){
      level = level === "invalid" ? "invalid" : "emergency";
      recommendations.push("very low temperature - fault in thermometer");
    }
    else {
      level = level === "normal" ? "warning" : level;
      recommendations.push("Monitor temperature and stay hydrated");
    }
  }

  let message = "";
  if (level === "normal") {
    message = "All vitals are within normal range. Keep up the good work!";
    recommendations.push("Continue monitoring daily", "Maintain healthy diet and exercise");
  } else if (level === "warning") message = `Some vitals need attention: ${issues.join(", ")}`;
  else if (level === "urgent") message = `Urgent attention needed: ${issues.join(", ")}`;
  else message = `EMERGENCY: Critical health indicators detected - ${issues.join(", ")}`;

  return { level, message, recommendations };
}

/**
 * Replacement generateAISuggestion - robust, deterministic, safe
 * Input: current (record), history (array of previous records)
 * Output: { recordId, summary, reasons, suggestions, generatedAt }
 */
function generateAISuggestion(current, history) {
  if (!current) return null;

  const toNumber = (v) => {
    if (v == null || v === "") return null;
    const n = Number(String(v).trim());
    return isFinite(n) ? n : null;
  };

  const suggestions = [];
  const reasons = [];

  // Temperature handling:
  // Input may be Celsius (typical human < 45) or Fahrenheit (>45). We'll convert to F if <=45 (assume Celsius).
  const tempRaw = toNumber(current.temperature);
  let tempF = null;
  if (tempRaw != null) {
    tempF = (tempRaw <= 45) ? (tempRaw * 9 / 5 + 32) : tempRaw;
    tempF = Math.round(tempF * 10) / 10;
  }

  // Symptoms array lowercased
  const symptoms = (current.symptoms || []).map(s => String(s || "").toLowerCase().trim());

  // Emergency priority checks (top-priority)
  if (symptoms.includes("chest pain") || symptoms.includes("shortness of breath") || symptoms.includes("breathlessness")) {
    return {
      recordId: current.id,
      summary: "URGENT: Chest pain / breathlessness — seek emergency care now.",
      reasons: ["Chest pain / breathlessness reported"],
      suggestions: [
        "Call emergency services or go to the nearest emergency department immediately.",
        "If available, take someone with you and inform them of the symptoms."
      ],
      generatedAt: new Date().toISOString()
    };
  }


  // Temperature-based suggestions (non-emergent)
  if (tempF != null) {
    if (tempF >= 104) {
      suggestions.push("High fever (>=104°F) — seek urgent medical care.");
      reasons.push(`High temperature ${tempF}°F`);
    } else if (tempF >= 100.4) {
      suggestions.push("Fever detected — rest, hydrate, take antipyretic like paracetamol per dosing instructions, recheck in 2–4 hours.");
      reasons.push(`Fever ${tempF}°F`);
    } else if (tempF >= 99.5) {
      suggestions.push("Low-grade fever — monitor, rest, hydrate. Contact clinician if it rises or other concerning symptoms appear.");
      reasons.push(`Low-grade fever ${tempF}°F`);
    } else if (tempF < 95) {
      suggestions.push("Measured temperature unusually low — verify thermometer and re-measure; seek care if symptomatic.");
      reasons.push(`Low measured temp ${tempF}°F`);
    }
  } else if (symptoms.includes("fever")) {
    suggestions.push("Reported fever symptom — measure temperature, hydrate, consider antipyretic if needed.");
    reasons.push("Reported symptom: fever");
  }

  // Pain handling
  const painScore = painSeverityFromRecord(current);
  if (painScore >= 8) {
    suggestions.push("Severe pain — consider urgent clinical assessment.");
    reasons.push(`Severe pain score ${painScore}/10`);
  } else if (painScore >= 4) {
    suggestions.push("Moderate pain — rest, consider an analgesic per usual guidance, and contact clinician if pain persists or worsens.");
    reasons.push(`Moderate pain ${painScore}/10`);
  }

  // Trend-based checks
  if (history && history.length) {
    const prev = history[0];
    const prevF = feverSeverityFromRecord(prev);
    const currF = feverSeverityFromRecord(current);
    if (currF > prevF && currF >= 4) {
      suggestions.push("Fever trending up compared to previous check — contact clinician if it continues to rise.");
      reasons.push("Upward fever trend");
    }

    const prevP = painSeverityFromRecord(prev);
    const currP = painSeverityFromRecord(current);
    if (currP > prevP && currP >= 4) {
      suggestions.push("Pain worsening vs previous check — consider contacting your doctor.");
      reasons.push("Worsening pain trend");
    }
  }

  // Profile-aware (only if data exists)
  if (state.userProfile) {
    if (Array.isArray(state.userProfile.medications) && state.userProfile.medications.length) {
      suggestions.push(`Continue prescribed medications: ${state.userProfile.medications.join(", ")} unless instructed otherwise.`);
      reasons.push("On regular medications");
    }
    if (Array.isArray(state.userProfile.allergies) && state.userProfile.allergies.length) {
      suggestions.push(`Allergies recorded: ${state.userProfile.allergies.join(", ")} — inform any treating clinician.`);
      reasons.push("Known allergies");
    }
  }

  // Baseline fallback
  if (suggestions.length === 0) {
    suggestions.push("No urgent issues detected. Monitor daily, rest, hydrate, and seek care if symptoms worsen.");
    reasons.push("Routine monitoring");
  }

  // Dedupe while preserving order
  const seen = new Set();
  const deduped = suggestions.filter(s => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });

  const summary = deduped[0] || "No specific suggestion.";

  return {
    recordId: current.id,
    summary,
    reasons,
    suggestions: deduped,
    generatedAt: new Date().toISOString()
  };
}

function openProfileModal() {
  const modal = document.getElementById("profileModal");
  const form = document.getElementById("profileForm");
  if (!modal || !form) return;
  if (state.userProfile) {
    document.getElementById("modalTitle").textContent = "Edit Profile";
    document.getElementById("profileName").value = state.userProfile.name || "";
    document.getElementById("profileAge").value = state.userProfile.age || "";
    document.getElementById("profileGender").value = state.userProfile.gender || "";
    document.getElementById("profileBloodType").value = state.userProfile.bloodType || "";
    document.getElementById("profileWeight").value = state.userProfile.weight || "";
    document.getElementById("profileHeight").value = state.userProfile.height || "";
    document.getElementById("profileEmail").value = state.userProfile.email || "";
    document.getElementById("profilePhone").value = state.userProfile.phone || "";
    document.getElementById("emergencyContact").value = state.userProfile.emergencyContact || "";
    document.getElementById("emergencyPhone").value = state.userProfile.emergencyPhone || "";
    document.getElementById("doctorName").value = state.userProfile.doctorName || "";
    document.getElementById("doctorPhone").value = state.userProfile.doctorPhone || "";
    state.medicalConditions = [...(state.userProfile.medicalConditions || [])];
    state.medications = [...(state.userProfile.medications || [])];
    state.allergies = [...(state.userProfile.allergies || [])];
  } else {
    document.getElementById("modalTitle").textContent = "Create Your Profile";
    form.reset();
    state.medicalConditions = []; state.medications = []; state.allergies = [];
  }
  renderTags();
  modal.classList.add("active");
}
function closeProfileModal() { const modal = document.getElementById("profileModal"); if (!modal) return; modal.classList.remove("active"); }
function renderTags() {
  const conditionsList = document.getElementById("conditionsList");
  const medicationsList = document.getElementById("medicationsList");
  const allergiesList = document.getElementById("allergiesList");
  if (conditionsList) conditionsList.innerHTML = state.medicalConditions.map((c,i)=>`<div class="tag-item">${escapeHtmlForDisplay(c)}<button type="button" class="tag-remove" onclick="removeCondition(${i})">&times;</button></div>`).join("");
  if (medicationsList) medicationsList.innerHTML = state.medications.map((m,i)=>`<div class="tag-item">${escapeHtmlForDisplay(m)}<button type="button" class="tag-remove" onclick="removeMedication(${i})">&times;</button></div>`).join("");
  if (allergiesList) allergiesList.innerHTML = state.allergies.map((a,i)=>`<div class="tag-item allergy">${escapeHtmlForDisplay(a)}<button type="button" class="tag-remove" onclick="removeAllergy(${i})">&times;</button></div>`).join("");
}
function addCondition(){const input=document.getElementById("conditionInput"); if(input && input.value.trim()){state.medicalConditions.push(input.value.trim()); input.value=""; renderTags();}}
function removeCondition(i){state.medicalConditions.splice(i,1); renderTags();}
function addMedication(){const input=document.getElementById("medicationInput"); if(input && input.value.trim()){state.medications.push(input.value.trim()); input.value=""; renderTags();}}
function removeMedication(i){state.medications.splice(i,1); renderTags();}
function addAllergy(){const input=document.getElementById("allergyInput"); if(input && input.value.trim()){state.allergies.push(input.value.trim()); input.value=""; renderTags();}}
function removeAllergy(i){state.allergies.splice(i,1); renderTags();}

(function() {
  const createErrorOverlay = () => {
    let el = document.getElementById('__app_error_overlay__');
    if (!el) {
      el = document.createElement('div');
      el.id = '__app_error_overlay__';
      el.style.position = 'fixed';
      el.style.left = '12px';
      el.style.right = '12px';
      el.style.bottom = '12px';
      el.style.zIndex = '99999';
      el.style.maxHeight = '40vh';
      el.style.overflow = 'auto';
      el.style.background = 'rgba(255,255,255,0.95)';
      el.style.border = '1px solid #d33';
      el.style.padding = '8px';
      el.style.fontFamily = 'monospace';
      el.style.fontSize = '12px';
      el.style.color = '#111';
      el.style.boxShadow = '0 6px 24px rgba(0,0,0,0.2)';
      document.body.appendChild(el);
    }
    return el;
  };

  const showError = (msg) => {
    console.error(msg);
    const el = createErrorOverlay();
    const row = document.createElement('div');
    row.style.marginBottom = '6px';
    row.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    el.prepend(row);
  };

  window.addEventListener('error', (ev) => {
    try { showError(`ERROR: ${ev.message} at ${ev.filename}:${ev.lineno}:${ev.colno}`); } catch(e){}
  });
  window.addEventListener('unhandledrejection', (ev) => {
    try { showError(`Promise rejection: ${ev.reason && ev.reason.message ? ev.reason.message : JSON.stringify(ev.reason)}`); } catch(e){}
  });

  async function safeInit() {
    try {
      if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition((pos) => {
          try {
            userLat = pos.coords.latitude; userLon = pos.coords.longitude;
            const out = document.getElementById("output");
            if (out) out.textContent = "Location: " + userLat.toFixed(5) + ", " + userLon.toFixed(5);
            loadPersistedData().then(() => {
              if (!hospitals.length) fetchHospitals(userLat, userLon);
              renderAll();
            }).catch(err => {
              showError(`loadPersistedData failed: ${err && err.message ? err.message : err}`);
              if (!hospitals.length) fetchHospitals(userLat, userLon);
              renderAll();
            });
          } catch (e) { showError("geolocation onSuccess error: " + (e.message || e)); }
        }, (err) => {
          try {
            showError("Geolocation error: " + (err && err.message ? err.message : JSON.stringify(err)));
            loadPersistedData().then(renderAll).catch((e)=>{ showError("loadPersistedData failed (no geo): " + (e.message||e)); renderAll(); });
            const out = document.getElementById("output"); if (out) out.textContent = "Enable location to fetch real hospitals (or allow location).";
          } catch(e) { showError("geolocation onError handler failed: " + (e.message||e)); }
        }, { timeout: 8000 });
      } else {
        await loadPersistedData();
        renderAll();
      }

      renderAll();

      try {
        document.querySelectorAll(".tab-trigger").forEach(trigger => {
          trigger.addEventListener("click", function() {
            const tabName = this.dataset.tab;
            document.querySelectorAll(".tab-trigger").forEach(t => t.classList.remove("active"));
            document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
            this.classList.add("active");
            const el = document.getElementById(tabName); if (el) el.classList.add("active");
            if (tabName === "trends") renderTrends();
          });
        });
      } catch (e) { showError("Tab wiring failed: " + (e.message||e)); }

      try {
        const hospitalsCard = document.querySelector("#hospitals .card-content");
        if (hospitalsCard && !document.getElementById("search")) {
          const wrapper = document.createElement("div");
          wrapper.style.display = "flex"; wrapper.style.gap = "0.5rem"; wrapper.style.marginBottom = "1rem";
          wrapper.innerHTML = `<input id="search" placeholder="Enter disease type (ex: heart, cancer, dental)" class="text-input" /><button id="searchBtn" class="btn btn-primary">Search</button>`;
          hospitalsCard.prepend(wrapper);
          document.getElementById("searchBtn").addEventListener("click", searchHospitals);
        }
      } catch (e) { showError("Search UI injection failed: " + (e.message||e)); }

      try {
        const specialtyFilter = document.getElementById("specialtyFilter");
        if (specialtyFilter) {
          specialtyFilter.addEventListener("change", function() { state.selectedSpecialty = this.value; renderHospitals(); });
        }
      } catch (e) { showError("Specialty filter wiring failed: " + (e.message||e)); }

      try {
        const emergencyToggle = document.getElementById("emergencyToggle");
        if (emergencyToggle) {
          emergencyToggle.addEventListener("click", function() { state.emergencyOnly = !state.emergencyOnly; this.classList.toggle("active"); renderHospitals(); });
        }
      } catch (e) { showError("Emergency toggle wiring failed: " + (e.message||e)); }

      try {
        const healthForm = document.getElementById("healthForm");
        if (healthForm) {
          const onSubmit = async (e) => {
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            try {
              const newRecord = {
                id: Date.now().toString(),
                date: new Date().toISOString(),
                heartRate: getNumberValue("heartRate", null),
                bloodPressureSystolic: getNumberValue("bpSystolic", null),
                bloodPressureDiastolic: getNumberValue("bpDiastolic", null),
                temperature: getNumberValue("temperature", null),
                oxygenLevel: getNumberValue("oxygenLevel", null),
                glucoseLevel: getNumberValue("glucoseLevel", null),
                urine: getTextValue("Urine", ""),
                symptoms: Array.from(document.querySelectorAll('input[name="symptoms"]:checked')).map(cb=>cb.value),
                notes: getTextValue("notes", "")
              };

              state.healthRecords.unshift({ ...newRecord, date: new Date(newRecord.date) });
              try { await dbPut(STORE_RECORDS, { ...newRecord }); } catch (err) { showError("Failed to save record: " + (err.message||err)); }

              const analysis = analyzeHealthData(state.healthRecords[0], state.healthRecords.slice(1));
              state.activeAlert = (analysis.level !== "normal") ? analysis : null;

              // generate AI suggestion based on new record + history
              state.aiSuggestion = generateAISuggestion(state.healthRecords[0], state.healthRecords.slice(1));

              // ensure full UI refresh so suggestion and other components sync
              renderAll();

              healthForm.reset();
              document.querySelectorAll('input[name="symptoms"]').forEach(cb => cb.checked = false);

              const submitBtn = healthForm.querySelector('button[type="submit"]');
              if (submitBtn) {
                const prev = submitBtn.textContent;
                submitBtn.textContent = "Submitted ✔";
                setTimeout(()=> submitBtn.textContent = prev, 1000);
              }
            } catch (inner) {
              showError("Submit handler error: " + (inner && inner.message ? inner.message : inner));
            }
          };

          healthForm.addEventListener("submit", onSubmit);

          const submitButtons = healthForm.querySelectorAll('button[type="submit"], input[type="submit"]');
          submitButtons.forEach(btn => {
            btn.addEventListener('click', (ev) => {
              setTimeout(()=>{}, 0);
            });
          });

        } else {
          showError("healthForm not found in DOM. Make sure your HTML includes <form id=\"healthForm\">");
        }
      } catch (e) { showError("Health form wiring failed: " + (e.message||e)); }

      try {
        const profileForm = document.getElementById("profileForm");
        if (profileForm) {
          profileForm.addEventListener("submit", async function(e) {
            e.preventDefault();
            try {
              const profile = {
                id: "me",
                name: document.getElementById("profileName").value,
                age: parseInt(document.getElementById("profileAge").value),
                gender: document.getElementById("profileGender").value,
                bloodType: document.getElementById("profileBloodType").value,
                weight: parseFloat(document.getElementById("profileWeight").value),
                height: parseFloat(document.getElementById("profileHeight").value),
                email: document.getElementById("profileEmail").value,
                phone: document.getElementById("profilePhone").value,
                emergencyContact: document.getElementById("emergencyContact").value,
                emergencyPhone: document.getElementById("emergencyPhone").value,
                doctorName: document.getElementById("doctorName").value,
                doctorPhone: document.getElementById("doctorPhone").value,
                medicalConditions: [...state.medicalConditions],
                medications: [...state.medications],
                allergies: [...state.allergies],
              };
              state.userProfile = profile;
              try { await dbPut(STORE_PROFILE, profile); } catch (err) { showError("save profile failed: " + (err.message||err)); }
              renderSidebar(); closeProfileModal();

              // re-evaluate AI suggestion on profile change (if there's a latest record)
              if (state.healthRecords && state.healthRecords.length) {
                state.aiSuggestion = generateAISuggestion(state.healthRecords[0], state.healthRecords.slice(1));
                renderAll();
              }
            } catch (inner) { showError("Profile submit handler error: " + (inner.message||inner)); }
          });
        } else {
          showError("profileForm not found in DOM.");
        }
      } catch (e) { showError("Profile wiring failed: " + (e.message||e)); }

      try {
        document.getElementById("closeModal")?.addEventListener("click", closeProfileModal);
        document.getElementById("cancelProfile")?.addEventListener("click", closeProfileModal);
        document.getElementById("profileModal")?.addEventListener("click", function(e){ if (e.target === this) closeProfileModal(); });

        document.getElementById("addCondition")?.addEventListener("click", addCondition);
        document.getElementById("addMedication")?.addEventListener("click", addMedication);
        document.getElementById("addAllergy")?.addEventListener("click", addAllergy);

        document.getElementById("conditionInput")?.addEventListener("keypress", (e)=>{ if (e.key==="Enter"){ e.preventDefault(); addCondition(); }});
        document.getElementById("medicationInput")?.addEventListener("keypress", (e)=>{ if (e.key==="Enter"){ e.preventDefault(); addMedication(); }});
        document.getElementById("allergyInput")?.addEventListener("keypress", (e)=>{ if (e.key==="Enter"){ e.preventDefault(); addAllergy(); }});
      } catch (e) { showError("Modal/tag wiring failed: " + (e.message||e)); }

    } catch (err) {
      showError("Initialization failed: " + (err && err.message ? err.message : err));
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", safeInit);
  } else {
    setTimeout(safeInit, 0);
  }
})();

function renderAll() {
  renderSidebar();
  renderDashboard();
  renderSymptomCheckboxes();
  renderTrends();
  renderHospitals();
}
