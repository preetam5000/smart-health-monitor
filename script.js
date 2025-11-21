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
let chartInstance = null; // Chart.js instance

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

