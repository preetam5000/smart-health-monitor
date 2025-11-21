
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

function formatDistance(km) {
  if (!isFinite(km)) return "Unknown";
  return km < 1 ? Math.round(km * 1000) + " meters" : km.toFixed(2) + " km";
}

function getDistance(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v == null || isNaN(v))) return Infinity;
  const R = 6371; // km
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
  if (record.temperature != null && !isNaN(record.temperature)) {
    const t = Number(record.temperature);
    if (t < 98) return 0;
    if (t < 99.5) return 2;
    if (t < 100.4) return 4;
    if (t < 102) return 7;
    return 9;
  }
  if (record.symptoms && record.symptoms.some(s => s.toLowerCase() === "fever")) return 5;
  return 0;
}

function painSeverityFromRecord(record) {
  let score = 0;
  if (record.symptoms && record.symptoms.length) {
    const sLower = record.symptoms.map(s => s.toLowerCase());
    if (sLower.includes("chest pain")) score += 6;
    if (sLower.includes("headache")) score += 3;
    if (sLower.includes("fatigue")) score += 1;
    // cap
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
      <div class="profile-info"><span>Height:</span><span>${profile.height} cm</span></div>
      <div class="profile-info"><span>Weight:</span><span>${profile.weight} kg</span></div>
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

  const temp = (latestRecord.temperature != null) ? `${latestRecord.temperature} °F` : "—";
  const urine = latestRecord.urine ? latestRecord.urine : "—";
  const notes = latestRecord.notes ? latestRecord.notes : "";

  vitalsGrid.innerHTML = `
    <div class="vital-card"><h4>Temperature</h4><p>${temp}</p></div>
    <div class="vital-card"><h4>Urine</h4><p>${urine}</p></div>
    <div class="vital-card"><h4>Notes</h4><p>${notes || "—"}</p></div>
  `;

  const symptomsCard = document.getElementById("symptomsCard");
  if (symptomsCard) {
    if (latestRecord.symptoms && latestRecord.symptoms.length > 0) {
      symptomsCard.style.display = "block";
      symptomsCard.innerHTML = `<div class="symptoms-card"><h4>Reported Symptoms</h4><div class="symptoms-list">${latestRecord.symptoms.map((s)=>`<span class="symptom-badge">${s}</span>`).join("")}</div></div>`;
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
            <p class="alert-message">${alert.message}</p>
          </div>
          ${alert.level !== "emergency" ? '<button class="alert-close" onclick="dismissAlert()">&times;</button>' : ""}
        </div>
        <div class="alert-recommendations">
          <p>Recommendations:</p>
          <ul>${alert.recommendations.map((r)=>`<li><span>•</span><span>${r}</span></li>`).join("")}</ul>
        </div>
        ${alert.level === "emergency" ? `<div class="alert-actions"><button class="btn btn-danger" onclick="callEmergency()"><i class="fas fa-phone"></i> Call 911</button><button class="btn btn-outline" onclick="alertDoctor()"><i class="fas fa-phone"></i> Alert My Doctor</button></div>` : alert.level === "urgent" ? `<div class="alert-actions"><button class="btn btn-outline" onclick="alertDoctor()"><i class="fas fa-phone"></i> Contact Doctor</button></div>` : ""}
      </div>
    </div>
  `;
}

function renderSymptomCheckboxes() {
  const symptomsGrid = document.getElementById("symptomsGrid");
  if (!symptomsGrid) return;
  symptomsGrid.innerHTML = commonSymptoms.map(symptom => {
    const id = "symptom-" + symptom.replace(/\s+/g, "-");
    return `<div class="symptom-checkbox"><input type="checkbox" id="${id}" name="symptoms" value="${symptom}"><label for="${id}">${symptom}</label></div>`;
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
    const symptomsText = record.symptoms && record.symptoms.length ? `Symptoms: ${record.symptoms.join(", ")}` : "";
    const notesText = record.notes ? `Notes: ${record.notes}` : "";
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
          backgroundColor: "rgba(255, 99, 132, 0.08)",
          borderColor: "rgb(255,99,132)"
        },
        {
          label: "Pain Severity (0-10)",
          data: painData,
          tension: 0.25,
          borderWidth: 2,
          pointRadius: 3,
          fill: true,
          backgroundColor: "rgba(54, 162, 235, 0.08)",
          borderColor: "rgb(54,162,235)"
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
