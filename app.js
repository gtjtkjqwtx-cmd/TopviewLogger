/* ============================================================
   TOPVIEW LOGGER — Combined App JavaScript
   ============================================================ */

window.onerror = function(msg, url, lineNo, columnNo, error) {
  alert('Error: ' + msg + '\nLine: ' + lineNo + '\nURL: ' + url);
  return false;
};

import DispatchEngine from './dispatch_engine.js';
import SamsaraEngine from './samsara_engine.js';

console.log("App.js loading (ESM Mode)...");

// FORCIBLY UNREGISTER ANY STALE SERVICE WORKERS to fix "broken UI" issues
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(function(registrations) {
    if (registrations.length > 0) {
      for (let registration of registrations) {
        registration.unregister();
      }
      console.log("Stale Service Worker Unregistered. Reloading...");
      setTimeout(() => window.location.reload(true), 500);
    }
  });
}

// ===== STATE =====
const State = {
  currentUser: null,
  activeModule: null, // 'sw' or 'fl'
  // Stopwatch state
  sw: {
    session: { inspector:'', supervisor:'', stopNum:'', startTime:null, endTime:null, violations:[], notes:[] },
    editingViolationIndex: null,
    editingSavedReportIndex: null,
    savedReports: []
  },
  // Full Loop state
  fl: {
    session: { inspector:'', busNumber:'', driverName:'', route:'', stopBoarded:'', startTime:null, endTime:null, violations:[], notes:[] },
    editingViolationIndex: null,
    editingSavedReportIndex: null,
    savedReports: [],
    drivers: [] // {driverName, lastReportDate}
  },
  // Liberty Cruise state
  lc: {
    session: null,
    savedReports: []
  },
  timePickerCallback: null
};

// ===== STORAGE KEYS =====
const KEYS = {
  USER: 'tv_user',
  SW_SESSION: 'tv_sw_session',
  SW_REPORTS: 'tv_sw_reports',
  FL_SESSION: 'tv_fl_session',
  FL_REPORTS: 'tv_fl_reports',
  FL_DRIVERS: 'tv_fl_drivers',
  LC_SESSION: 'tv_lc_session',
  LC_REPORTS: 'tv_lc_reports'
};

// ===== HELPERS =====
const formatTime = (d = new Date()) => d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', hour12:true });
const timeToMinutes = (s) => {
  if (!s) return 0;
  const p = s.trim().split(' ');
  if (p.length < 2) return 0;
  let [h, m] = p[0].split(':').map(Number);
  if (p[1] === 'PM' && h < 12) h += 12;
  if (p[1] === 'AM' && h === 12) h = 0;
  return h * 60 + m;
};

window.copyToClipboard = function(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (btn) {
      btn.classList.add('copy-glow-green');
      setTimeout(() => btn.classList.remove('copy-glow-green'), 1000);
    }
  });
};
const stripAmPm = (s) => s ? s.replace(/\s*(AM|PM)/gi, '') : '';
const stripLeadingZero = (s) => s ? s.replace(/\b0(\d:)/g, '$1') : '';
const formatReportTime = (s) => stripLeadingZero(stripAmPm(s));
const formatDisplayTime = (date) => {
  if (!date) return 'No Entry';
  const d = new Date(date);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
};
const daysBetween = (d1, d2) => Math.floor(Math.abs(d2-d1) / (1000*60*60*24));

async function copyToClipboard(text, btnElement) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy');
    document.body.removeChild(ta);
  }
  if (btnElement) {
    btnElement.classList.add('copy-glow-green');
    setTimeout(() => btnElement.classList.remove('copy-glow-green'), 800);
  }
}

// ===== VIEW NAVIGATION =====
const views = {};
document.querySelectorAll('.view').forEach(v => { views[v.id.replace('-view','')] = v; });

let viewHistory = ['login']; // track navigation stack

function showView(targetId) {
  const currentView = document.querySelector('.view.active');
  const targetView = views[targetId];

  if (!targetView || currentView === targetView) return;

  const isBack = viewHistory.length > 1 && viewHistory[viewHistory.length - 2] === targetId;

  if (isBack) {
    // Going backward (pop)
    viewHistory.pop();
    targetView.classList.remove('next');
    void targetView.offsetWidth; // Force layout
    targetView.classList.add('active');

    if (currentView) {
      currentView.classList.remove('active');
      currentView.classList.add('next'); // Push current to right
    }
  } else {
    // Going forward (push)
    if (viewHistory[viewHistory.length - 1] !== targetId) {
      viewHistory.push(targetId);
    }
    targetView.classList.add('next'); // Start target on right
    void targetView.offsetWidth; // Force layout
    targetView.classList.remove('next');
    targetView.classList.add('active'); // Slide target in

    if (currentView) {
      currentView.classList.remove('active');
      currentView.classList.remove('next'); // Push current to left/back
    }
  }
  
  if (targetId === 'sw-dashboard') checkSwResume();
  if (targetId === 'fl-dashboard') checkFlResume();
}

// Back buttons
document.querySelectorAll('.btn-back').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.target));
});

// ===== TIME PICKER (Scroll Dial — Fixed) =====
const pickerHourCol = document.getElementById('picker-hour-col');
const pickerMinCol = document.getElementById('picker-minute-col');
const pickerAmpmCol = document.getElementById('picker-ampm-col');
const pickerModal = document.getElementById('time-picker-modal');

function initTimePicker() {
  // Build hour options 1-12
  for (let h = 1; h <= 12; h++) {
    const d = document.createElement('div');
    d.className = 'time-option'; d.dataset.val = h.toString(); d.textContent = h;
    d.addEventListener('click', () => snapToOption(pickerHourCol, d));
    pickerHourCol.appendChild(d);
  }
  // Build minute options 00-59
  for (let m = 0; m < 60; m++) {
    const d = document.createElement('div');
    d.className = 'time-option';
    const ms = m.toString().padStart(2, '0');
    d.dataset.val = ms; d.textContent = ms;
    d.addEventListener('click', () => snapToOption(pickerMinCol, d));
    pickerMinCol.appendChild(d);
  }
  // AM/PM click
  pickerAmpmCol.querySelectorAll('.time-option').forEach(opt => {
    opt.addEventListener('click', () => snapToOption(pickerAmpmCol, opt));
  });

  // Scroll-based selection with RAF debounce
  [pickerHourCol, pickerMinCol, pickerAmpmCol].forEach(col => {
    let rafId = null;
    col.addEventListener('scroll', () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => highlightCenter(col));
    }, { passive: true });
  });
}

function highlightCenter(col) {
  const center = col.scrollTop + col.clientHeight / 2;
  let closest = null, minDist = Infinity;
  col.querySelectorAll('.time-option').forEach(opt => {
    const optCenter = opt.offsetTop + opt.offsetHeight / 2;
    const dist = Math.abs(optCenter - center);
    if (dist < minDist) { minDist = dist; closest = opt; }
  });
  if (closest) {
    col.querySelectorAll('.time-option').forEach(o => o.classList.remove('selected'));
    closest.classList.add('selected');
  }
}

function snapToOption(col, opt) {
  col.querySelectorAll('.time-option').forEach(o => o.classList.remove('selected'));
  opt.classList.add('selected');
  const scrollTarget = opt.offsetTop - col.clientHeight / 2 + opt.offsetHeight / 2;
  col.scrollTo({ top: scrollTarget, behavior: 'smooth' });
}

function scrollToVal(col, val) {
  const opt = Array.from(col.querySelectorAll('.time-option')).find(o => o.dataset.val == val);
  if (opt) {
    // Clear old selection
    col.querySelectorAll('.time-option').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    // Instant snap on open (no smooth — instant positioning)
    const scrollTarget = opt.offsetTop - col.clientHeight / 2 + opt.offsetHeight / 2;
    setTimeout(() => col.scrollTo({ top: scrollTarget, behavior: 'instant' }), 30);
  }
}

function openTimePicker(currentVal, callback) {
  State.timePickerCallback = callback;
  pickerModal.classList.add('active');
  const parsed = (currentVal || formatTime()).match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (parsed) {
    setTimeout(() => {
      scrollToVal(pickerHourCol, parseInt(parsed[1]).toString());
      scrollToVal(pickerMinCol, parsed[2]);
      scrollToVal(pickerAmpmCol, parsed[3].toUpperCase());
    }, 60);
  }
}

function saveTimePicker() {
  const h = pickerHourCol.querySelector('.selected')?.dataset.val || '12';
  const m = pickerMinCol.querySelector('.selected')?.dataset.val || '00';
  const p = pickerAmpmCol.querySelector('.selected')?.dataset.val || 'AM';
  const result = `${h.toString().padStart(2,'0')}:${m} ${p}`;
  if (State.timePickerCallback) State.timePickerCallback(result);
  pickerModal.classList.remove('active');
}

document.getElementById('btn-cancel-picker').addEventListener('click', () => pickerModal.classList.remove('active'));
document.getElementById('btn-save-picker').addEventListener('click', saveTimePicker);

// ===== OFFLINE STORAGE COUNT =====
function updateStorageCount() {
  const sw = State.sw.savedReports.length;
  const fl = State.fl.savedReports.length;
  const lc = (State.lc && State.lc.savedReports) ? State.lc.savedReports.length : 0;
  const total = sw + fl + lc;
  const el = document.getElementById('menu-storage-count');
  if (el) el.textContent = `${total} report${total !== 1 ? 's' : ''} saved locally`;
}

// ===== LOGIN =====
function doLogin() {
  console.log("[doLogin] Attempting login...");
  const input = document.getElementById('username');
  if (!input) {
    console.error("[doLogin] Error: 'username' input not found in DOM!");
    return;
  }
  const name = input.value.trim();
  if (!name) { 
    console.warn("[doLogin] No name entered, highlighting input.");
    input.style.borderColor = 'red'; 
    setTimeout(() => input.style.borderColor = '', 1000); 
    return; 
  }
  console.log("[doLogin] Success: Logging in as", name);
  State.currentUser = name;
  localStorage.setItem(KEYS.USER, name);
  
  const welcomeEl = document.getElementById('menu-welcome');
  if (welcomeEl) welcomeEl.textContent = `Hello, ${name}`;
  
  loadAllData();
  showView('menu');
  
  console.log("[doLogin] Navigation to menu triggered.");
  
  console.log("[Login] Triggering background CountIf link...");
  setTimeout(() => {
     const connectBtn = document.getElementById('btn-countif-connect');
     if (connectBtn) connectBtn.click();
  }, 300);
}

// Ensure Enter key works on the login input specifically
document.getElementById('username').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    doLogin();
  }
});

window.doLogin = doLogin;
window.showView = showView;
window.State = State;

// Attach click listener
const loginBtn = document.getElementById('btn-login-confirm');
if (loginBtn) {
  loginBtn.addEventListener('click', doLogin);
  console.log("[Init] Login button listener attached.");
}

// Auto-login
(function checkAutoLogin() {
  const saved = localStorage.getItem(KEYS.USER);
  if (saved) {
    State.currentUser = saved;
    document.getElementById('menu-welcome').textContent = `Hello, ${saved}`;
    loadAllData();
    showView('menu');

    // PRE-FETCH: Start scanning dispatch data immediately so it's ready for the tracker
    if (localStorage.getItem('portal_session_cookie')) {
      console.log('[AutoLogin] Pre-fetching dispatch data for instant DR...');
      setTimeout(() => fetchDispatchData(), 1000);
    }
    
    // AUTO-CONNECT: Background CountIf link
    console.log("[AutoLogin] Triggering background CountIf link...");
    setTimeout(() => {
       const connectBtn = document.getElementById('btn-countif-connect');
       if (connectBtn) connectBtn.click();
    }, 500);
  }
})();

// ===== MENU =====
document.getElementById('btn-goto-stopwatch').addEventListener('click', () => { State.activeModule = 'sw'; checkSwResume(); swRenderHistory(); showView('sw-dashboard'); });
document.getElementById('btn-goto-fullloop').addEventListener('click', () => { State.activeModule = 'fl'; checkFlResume(); flRenderHistory(); showView('fl-dashboard'); });
document.getElementById('btn-goto-liberty').addEventListener('click', () => { State.activeModule = 'lc'; checkLcResume(); lcRenderHistory(); showView('lc-dashboard'); });

// ===== TRACKER MODULE =====
const DEFAULTS = {
  SAMSARA_API: 'samsara_api_GhW9yDVbDjH8nA2uBD6F5ccMaNs9rH'
};

let trackerMap = null;
let trackerMarkers = [];

// UI Reactive logic for Default API checkbox (Removed to match minimal UI)
document.getElementById('btn-goto-tracker').addEventListener('click', () => { 
  State.activeModule = 'tracker'; 
  showView('tracker'); 

  // Initialize Map if not already done
  if (!trackerMap) {
    trackerMap = L.map('tracker-map-display', {
       zoomControl: false,
       attributionControl: false
    }).setView([40.7128, -74.0060], 12);
    
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png').addTo(trackerMap);
    
    // Load and Render Route Stops (Glowing Green Nodes)
    loadRouteStops();
  }
  
  // Necessary for Leaflet to recalculate its dimensions after being unhidden
  setTimeout(() => {
    trackerMap.invalidateSize();
    // AUTO-START SCAN: Pre-emptively load fleet positions
    console.log("[Tracker] Auto-initiating fleet discovery...");
    runFleetScan(); 
  }, 50);
});

async function runFleetScan() {
  const btn = document.getElementById('btn-show-all-buses');
  if (!btn) return;
  const orgText = btn.innerHTML;
  const apiKey = DEFAULTS.SAMSARA_API;
  
  if (!apiKey) return;
  const statusBadge = document.getElementById('tracker-api-status');
  
  btn.innerHTML = '<span>Scanning Fleet...</span>';
  statusBadge.style.background = 'rgba(241, 196, 15, 0.2)';
  statusBadge.style.color = '#f1c40f';
  statusBadge.innerHTML = '<div class="status-dot" style="background:#f1c40f;"></div><span>Connecting...</span>';
  
  trackerMarkers.forEach(m => trackerMap.removeLayer(m));
  trackerMarkers = [];
  
  try {
     document.getElementById('tracker-results-container').style.display = 'block';
     // Pull all buses globally using large limit fallback
     const rawBuses = await SamsaraEngine.findBusesNearStop(0, 0, apiKey, 500);
     
     // ENRICHMENT: Link every bus with driver data from portalData
     const closestBuses = rawBuses.map(bus => {
        // CRITICAL: Must use bus.name (e.g. '4205') for matching, not internal bus.id
        return DispatchEngine.getEnrichedStatus(bus, bus.name, portalData);
     });
     
     statusBadge.style.background = 'rgba(46, 204, 113, 0.2)';
     statusBadge.style.color = '#2ecc71';
     statusBadge.innerHTML = `<div class="status-dot" style="background:#2ecc71;"></div><span>Fleet Scan Active</span>`;
     
     document.getElementById('tracker-last-stop').parentElement.querySelector('.stat-label').textContent = 'TOTAL SCANNED';
     document.getElementById('tracker-next-stop').parentElement.querySelector('.stat-label').textContent = 'ACTIVE BUSES';
     document.getElementById('tracker-last-stop').textContent = closestBuses.length;
     document.getElementById('tracker-next-stop').textContent = "Map Updated";
     
     const timeEl = document.getElementById('tracker-active-time');
     timeEl.textContent = `Live`;
     timeEl.style.color = '#2ecc71';
     document.getElementById('tracker-street-addr').textContent = `Showing all ${closestBuses.length} active buses`;
     
     closestBuses.forEach(bus => {
       const pos = [bus.latitude, bus.longitude];
       const driverLabel = bus.operator !== "Unknown Driver" ? ` | ${bus.operator}` : "";
       
       const customIcon = L.divIcon({
          html: `
            <div class="bus-marker-wrapper">
              <div class="bus-number-label">${bus.name}${driverLabel}</div>
              <div class="bus-beacon">
                <div class="bus-dot-core"></div>
                <div class="bus-pulse-ring"></div>
              </div>
            </div>
          `,
          className: 'bus-custom-marker',
          iconSize: [40, 40],
          iconAnchor: [20, 36] 
       });
       const marker = L.marker(pos, { icon: customIcon }).addTo(trackerMap);
       trackerMarkers.push(marker);
     });
     
     trackerMap.setView([40.759433036950966, -73.98454271585518], 14, { animate: true });
     setTimeout(() => trackerMap.invalidateSize(), 100);
     
     btn.innerHTML = `
       <svg class="icon-sm" style="margin-right:8px;"><use href="#icon-bus"/></svg>
       <span>All Buses Displayed</span>
     `;
     setTimeout(() => btn.innerHTML = orgText, 2500);
     
  } catch(e) {
     statusBadge.style.background = 'rgba(231, 76, 60, 0.2)';
     statusBadge.style.color = '#e74c3c';
     statusBadge.innerHTML = `<div class="status-dot" style="background:#e74c3c;"></div><span>${e.message}</span>`;
     btn.innerHTML = orgText;
  }
}

// ============================================================
// COUNTIF CONNECT MODULE
// ============================================================

function openDispatchOverlayModal() {
  const modal = document.getElementById('dispatch-overlay-modal');
  const body = document.getElementById('dispatch-overlay-body');
  const setupEl = document.getElementById('countif-setup');
  const portalEl = document.getElementById('countif-portal');
  
  if (setupEl && portalEl && body) {
    body.appendChild(setupEl);
    body.appendChild(portalEl);
  }
  
  if (portalSessionCookie) {
    if (setupEl) setupEl.style.display = 'none';
    if (portalEl) portalEl.style.display = 'block';
    fetchDispatchData();
  } else {
    if (setupEl) setupEl.style.display = 'block';
    if (portalEl) portalEl.style.display = 'none';
  }
  
  if (modal) modal.classList.add('active');
}

function closeDispatchOverlayModal() {
  const modal = document.getElementById('dispatch-overlay-modal');
  if (modal) modal.classList.remove('active');
  
  const countifContainer = document.querySelector('#countif-view .container');
  const setupEl = document.getElementById('countif-setup');
  const portalEl = document.getElementById('countif-portal');
  if (countifContainer && setupEl && portalEl) {
    countifContainer.appendChild(setupEl);
    countifContainer.appendChild(portalEl);
  }
}

const closeOverlayBtn = document.getElementById('btn-close-dispatch-overlay');
if (closeOverlayBtn) {
  closeOverlayBtn.addEventListener('click', closeDispatchOverlayModal);
}

const dispatchModalEl = document.getElementById('dispatch-overlay-modal');
if (dispatchModalEl) {
  dispatchModalEl.addEventListener('click', (e) => {
    if (e.target === dispatchModalEl) {
      closeDispatchOverlayModal();
    }
  });
}

document.getElementById('btn-experiment').addEventListener('click', () => {
  openDispatchOverlayModal();
});

document.getElementById('btn-mini-dispatch').addEventListener('click', () => {
  openDispatchOverlayModal();
});

const COUNTIF_PROXY_URL = 'https://topviewloggerr.onrender.com';

/**
 * Robust XHR helper to bypass fetch-only security blocks on mobile
 */
function xhrProxyRequest(url, method, body = null) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch(e) { resolve({success:true}); }
      } else {
        const err = new Error(`HTTP ${xhr.status}`);
        try { err.data = JSON.parse(xhr.responseText); } catch(e) {}
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error('Network/CORS block'));
    xhr.timeout = 30000;
    xhr.ontimeout = () => reject(new Error('Connection timed out (Waking up server?)'));
    xhr.send(body ? JSON.stringify(body) : null);
  });
}

function countifResetDashboard() {
  const steps = document.querySelectorAll('.countif-step');
  steps.forEach(s => {
    s.classList.remove('active', 'complete', 'error');
  });
  document.getElementById('countif-result').style.display = 'none';
  const badge = document.getElementById('countif-status-badge');
  badge.style.background = 'rgba(255,255,255,0.05)';
  badge.style.color = 'rgba(255,255,255,0.4)';
  badge.innerHTML = '<div class="status-dot"></div><span>Idle</span>';
  
  const btn = document.getElementById('btn-countif-connect');
  btn.innerHTML = `
    <svg class="icon-sm" style="margin-right:8px;"><use href="#icon-navigation"/></svg>
    <span>Connect to Dispatch</span>
    <div class="gloss-sheen"></div>
  `;
  btn.disabled = false;

  // Reset View State
  document.getElementById('countif-setup').style.display = 'block';
  document.getElementById('countif-portal').style.display = 'none';
  
  // Clear data
  portalData = [];
  portalSessionCookie = null;
  document.getElementById('portal-results-list').innerHTML = '';
  document.getElementById('portal-results-area').style.display = 'none';
}

document.getElementById('btn-countif-reconnect').addEventListener('click', () => {
  countifResetDashboard();
});

function countifSetStep(stepName, state) {
  const stepEl = document.querySelector(`.countif-step[data-step="${stepName}"]`);
  if (!stepEl) return;
  stepEl.classList.remove('active', 'complete', 'error');
  stepEl.classList.add(state);
}

function countifSetBadge(text, color) {
  const badge = document.getElementById('countif-status-badge');
  const trackerBadge = document.getElementById('tracker-dispatch-status');
  
  const colorMap = {
    yellow: { bg: 'rgba(241, 196, 15, 0.2)', fg: '#f1c40f' },
    green: { bg: 'rgba(46, 204, 113, 0.2)', fg: '#2ecc71' },
    red: { bg: 'rgba(231, 76, 60, 0.2)', fg: '#e74c3c' }
  };
  const c = colorMap[color] || colorMap.yellow;
  
  // Update main badge
  if (badge) {
    badge.style.background = c.bg;
    badge.style.color = c.fg;
    badge.innerHTML = `<div class="status-dot" style="background:${c.fg};"></div><span>${text}</span>`;
  }
  
  // Update Tracker badge
  if (trackerBadge) {
    trackerBadge.style.background = c.bg;
    trackerBadge.style.color = c.fg;
    trackerBadge.innerHTML = `<div class="status-dot" style="width:6px; height:6px; background:${c.fg};"></div><span>${text}</span>`;
  }
}

let portalSessionCookie = localStorage.getItem('portal_session_cookie');
let portalData = [];
let portalLastSync = 0; // Timestamp of last successful dispatch sync

async function fetchDispatchData(contextLabel = 'Data') {
  if (!portalSessionCookie) return;
  
  const refreshBtn = document.getElementById('btn-portal-refresh');
  const syncIndicator = document.getElementById('portal-sync-indicator');
  const syncMessage = document.getElementById('portal-sync-message');
  const syncProgress = document.getElementById('portal-sync-progress');
  
  const originalText = refreshBtn.querySelector('span').textContent;
  refreshBtn.disabled = true;
  refreshBtn.querySelector('span').textContent = 'Syncing...';
  refreshBtn.style.opacity = '0.7';

  // Show status indicator
  syncIndicator.style.display = 'block';
  syncMessage.textContent = `Syncing ${contextLabel}...`;
  syncProgress.classList.add('sync-anim');

  try {
    const searchQuery = contextLabel === 'Data' ? '' : contextLabel;
    const queryParam = searchQuery ? `&query=${encodeURIComponent(searchQuery)}` : '';
    const limitParam = '&limit=500';
    const result = await xhrProxyRequest(`${COUNTIF_PROXY_URL}/api/countif/dispatch?cookie=${encodeURIComponent(portalSessionCookie)}${queryParam}${limitParam}`, 'GET');

    if (result.success) {
      const now = new Date();
      portalData = (result.data || []).reverse().filter(record => {
        if (!record.date) return false;
        const recordDate = new Date(record.date);
        const diffHrs = (now - recordDate) / (1000 * 60 * 60);
        return diffHrs <= 24;
      });
      portalLastSync = Date.now();
      console.log(`[Portal] Synced ${portalData.length} records (24h filter) for "${contextLabel}"`);
      
      if (portalData.length === 0) {
        console.warn(`[Portal] WARNING: No dispatch records found for query "${contextLabel}"`);
      }
        renderPortalResults(portalData.slice(0, 5));
        document.getElementById('portal-results-count').textContent = `${portalData.length}`;
        document.getElementById('portal-filter-tag').textContent = 'Live Feed';
    } else {
      if (result.message === 'Session expired.') {
        alert('CountIf Session Expired. Please reconnect.');
        countifResetDashboard();
      }
    }
  } catch (err) {
    console.error('[Portal] Sync error:', err);
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.querySelector('span').textContent = originalText;
    refreshBtn.style.opacity = '1';
    
    // Hide indicator after a small delay for visual weight
    setTimeout(() => {
      syncIndicator.style.display = 'none';
      syncProgress.classList.remove('sync-anim');
    }, 800);
  }
}

function renderPortalResults(records, filterLabel = '', options = {}) {
  const list = document.getElementById('portal-results-list');
  const area = document.getElementById('portal-results-area');
  const tag = document.getElementById('portal-filter-tag');
  
  const snapshotArea = document.getElementById('portal-snapshot-area');
  const driverRow = document.getElementById('portal-snapshot-driver');
  const superRow = document.getElementById('portal-snapshot-supervisor');
  const drVal = document.getElementById('snapshot-driver-val');
  const supVal = document.getElementById('snapshot-supervisor-val');

  if (filterLabel) {
    tag.textContent = filterLabel;
  }

  // Handle Snapshot Logic
  snapshotArea.style.display = 'none';
  driverRow.style.display = 'none';
  superRow.style.display = 'none';

  // Blacklisted supervisors (partial match)
  const superBlacklist = ['Stevenson', 'Michael Leshaj'];
  // Supervisory role suffixes — only users with these in their name count as supervisors
  const supervisorRoles = ['Supervisor', 'Coordinator', 'FieldCoordinator'];

  function isBlacklisted(userName) {
    return superBlacklist.some(bl => userName.includes(bl));
  }
  function isSupervisor(userName) {
    return supervisorRoles.some(role => userName.includes(role));
  }

  if (records && records.length > 0) {
    const isBus = filterLabel.toLowerCase().includes('bus');
    const isStop = filterLabel.toLowerCase().includes('stop');

    if (isBus || isStop) {
      snapshotArea.style.display = 'block';
      if (isBus) {
        driverRow.style.display = 'flex';
        driverRow.style.alignItems = 'center';
        driverRow.style.justifyContent = 'space-between';
        
        const driverName = records[0].operator;
        const timeStr = formatDisplayTime(records[0].date);
        drVal.innerHTML = `${driverName} <span style="opacity:0.6; font-weight:400; margin-left:4px;">(${timeStr})</span>`;
        
        // Add or update copy button
        let copyBtn = driverRow.querySelector('.btn-copy-driver');
        if (!copyBtn) {
          copyBtn = document.createElement('button');
          copyBtn.className = 'icon-btn-sm btn-copy-driver';
          copyBtn.style.cssText = 'margin: 0; background: rgba(255,255,255,0.05); border-radius: 6px; padding: 4px;';
          copyBtn.innerHTML = '<svg class="icon-xs" style="fill: var(--green);"><use href="#icon-clipboard"/></svg>';
          driverRow.appendChild(copyBtn);
        }
        copyBtn.onclick = () => copyToClipboard(driverName, copyBtn);
      }
      if (isStop) {
        superRow.style.display = 'flex';
        
        // Search ALL records for this stop (not just the 5 displayed)
        const allMatches = options.allMatches || records;
        // Find the most recent user who HAS a supervisor/coordinator role AND is NOT blacklisted
        const validRec = allMatches.find(r => isSupervisor(r.user) && !isBlacklisted(r.user)) || allMatches[0];
        
        // Extract H:MM
        let timeStr = '---';
        const parts = validRec.date.split(' ');
        if (parts.length >= 2) {
          const timeParts = parts[1].split(':'); // "8:00:43"
          if (timeParts.length >= 2) {
             const ampm = parts[2] || '';
             timeStr = `${timeParts[0]}:${timeParts[1]} ${ampm}`.trim();
          }
        }
        
        supVal.textContent = `${validRec.user} | ${timeStr}`;
        
        // Setup copy button
        const copyBtn = document.getElementById('btn-copy-snapshot-super');
        copyBtn.onclick = () => {
           navigator.clipboard.writeText(validRec.user).then(() => {
              const originalColor = copyBtn.style.background;
              copyBtn.style.background = 'var(--green)';
              setTimeout(() => copyBtn.style.background = originalColor, 500);
           });
        };
      }
    }
  }

  if (!records || records.length === 0) {
    list.innerHTML = `<div style="text-align:center; padding: 2rem; opacity:0.5; font-size:0.8rem;">No matching entries found.</div>`;
    area.style.display = 'block';
    return;
  }

  area.style.display = 'block';
  list.innerHTML = records.map(record => {
    // Auto-detect if we should hide date (if label includes "Bus" or "Stop")
    const isFiltered = filterLabel.toLowerCase().includes('bus') || 
                       filterLabel.toLowerCase().includes('stop') || 
                       options.timeOnly;
    
    let timestamp = record.date;
    if (isFiltered) {
      // Extract time from: "4/20/2026 1:18:41 PM"
      const parts = record.date.split(' ');
      if (parts.length >= 2) {
        timestamp = parts.slice(1).join(' '); // "1:18:41 PM"
      }
    }

    return `
      <div class="result-card" style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); border-radius: 8px; padding: 0.8rem; margin-bottom: 0.5rem;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.4rem;">
          <span style="color: var(--green); font-weight: 700; font-size: 0.95rem;">Bus ${record.bus}</span>
          <span style="font-size: 0.85rem; font-weight: 600; opacity: 0.8; color: white;">${timestamp}</span>
        </div>
        ${options.hideStop ? '' : `<div style="font-size: 0.8rem; color: white; margin-bottom: 0.3rem; opacity: 0.9;">${record.stop}</div>`}
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.95rem; opacity: 0.8; font-weight: 500;">
          <span>${record.operator} • ${record.route}</span>
          <button class="violation-btn-sm" style="width: 28px; height: 28px; padding: 0; display: flex; align-items: center; justify-content: center; background: rgba(46, 204, 113, 0.1); border: 1px solid rgba(46, 204, 113, 0.2);" 
                  onclick="copyToClipboard('${record.operator.replace(/'/g, "\\'")}', this)" title="Copy Driver Name">
            <svg style="width: 14px; height: 14px; fill: var(--green);"><use href="#icon-folder"/></svg>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function filterPortalData(type) {
  // Always verify we have a session
  if (!portalSessionCookie) return;
  
  if (type === 'bus') {
    const busNum = window.prompt('Enter Bus #:');
    if (busNum === null) return;
    if (!busNum.trim()) return alert('Please enter a Bus #');
    
    // Refresh data FIRST
    await fetchDispatchData(`Bus #${busNum.trim()}`);
    
    const matches = portalData.filter(r => r.bus === busNum.trim());
    renderPortalResults(matches.slice(0, 5), `Bus ${busNum}`, { timeOnly: true });
  } else if (type === 'stop') {
    const stopNum = window.prompt('Enter Stop #:');
    if (stopNum === null) return;
    if (!stopNum.trim()) return alert('Please enter a Stop #');
    
    // Refresh data FIRST
    await fetchDispatchData(`Stop #${stopNum.trim()}`);
    
    // Use exact stop number matching: "STOP 1 " won't match "STOP 10", "STOP 13", etc.
    const target = `STOP ${stopNum.trim()} `;
    const matches = portalData.filter(r => r.stop && r.stop.includes(target));
    // Pass ALL matches for supervisor lookup, but only display 5
    renderPortalResults(matches.slice(0, 5), `Stop ${stopNum}`, { hideStop: true, allMatches: matches });
  }
}

document.getElementById('btn-portal-bus').addEventListener('click', () => filterPortalData('bus'));
document.getElementById('btn-portal-stop').addEventListener('click', () => filterPortalData('stop'));
document.getElementById('btn-portal-refresh').addEventListener('click', () => fetchDispatchData());

document.getElementById('btn-countif-connect').addEventListener('click', async () => {
  const btn = document.getElementById('btn-countif-connect');
  const maxRetries = 3;
  let attempt = 1;
  
  btn.disabled = true;
  btn.innerHTML = '<span>Connecting...</span>';
  
  // Reset all steps to fresh
  countifResetDashboard();
  btn.disabled = true;

  const stageOrder = ['init', 'page_loaded', 'tokens_harvested', 'authenticated'];
  
  async function attemptConnection() {
    countifSetBadge(`Connecting (Try ${attempt}/${maxRetries})...`, 'yellow');
    countifSetStep('init', 'active');

    try {
      const data = await xhrProxyRequest(`${COUNTIF_PROXY_URL}/api/countif/login`, 'POST', {
        username: 'fvazquez',
        password: 'Topview12345'
      });

      if (data.stages && data.stages.length > 0) {
        for (let i = 0; i < data.stages.length; i++) {
          const stage = data.stages[i];
          const stageIdx = stageOrder.indexOf(stage.stage);
          for (let j = 0; j < stageIdx; j++) countifSetStep(stageOrder[j], 'complete');
          
          if (stage.stage === 'auth_failed' || stage.stage === 'error') {
            const lastIdx = Math.min(stageIdx >= 0 ? stageIdx : stageOrder.length - 1, stageOrder.length - 1);
            countifSetStep(stageOrder[lastIdx], 'error');
          } else {
            countifSetStep(stage.stage, 'complete');
          }
        }
      }

      if (data.success) {
        stageOrder.forEach(s => countifSetStep(s, 'complete'));
        countifSetBadge('Dispatch Active', 'green');
        portalSessionCookie = data.result?.sessionCookie;
        localStorage.setItem('portal_session_cookie', portalSessionCookie);

        document.getElementById('countif-setup').style.display = 'none';
        document.getElementById('countif-portal').style.display = 'block';
        fetchDispatchData();
        return true;
      }
      return false;
    } catch (err) {
      console.warn(`[CountIf] Attempt ${attempt} failed:`, err.message);
      return false;
    }
  }

  while (attempt <= maxRetries) {
    const success = await attemptConnection();
    if (success) return;
    
    if (attempt < maxRetries) {
      countifSetBadge(`Retrying (${attempt}/${maxRetries})...`, 'yellow');
      // Wait 1.5s before retry to give server a breath
      await new Promise(r => setTimeout(r, 1500));
      attempt++;
    } else {
      // Final Failure
      countifSetStep('init', 'error');
      countifSetBadge('Offline', 'red');
      
      const resultEl = document.getElementById('countif-result');
      resultEl.style.display = 'block';
      resultEl.style.background = 'rgba(231, 76, 60, 0.1)';
      resultEl.style.border = '1px solid rgba(231, 76, 60, 0.3)';
      document.getElementById('countif-result-icon').textContent = '⚠';
      document.getElementById('countif-result-icon').style.color = '#e74c3c';
      document.getElementById('countif-result-title').textContent = 'Connection Error';
      document.getElementById('countif-result-msg').textContent = `Backend proxy unreachable after ${maxRetries} attempts.`;
      
      btn.innerHTML = `<span>Retry Connection</span>`;
      btn.disabled = false;
      break;
    }
  }
});


async function loadRouteStops() {
  if (!trackerMap) return;
  try {
    const response = await fetch('stops_data.json');
    const stops = await response.json();
    
    stops.forEach(stop => {
      const stopNum = stop.name.replace('Stop ', '');
      const stopIcon = L.divIcon({
        html: `
          <div class="stop-marker-wrapper">
            <div class="stop-tip">${stop.name}</div>
            <div class="stop-dot">${stopNum}</div>
          </div>
        `,
        className: 'stop-custom-marker',
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });
      
      L.marker([stop.lat, stop.lng], { icon: stopIcon, zIndexOffset: -100 }).addTo(trackerMap);
    });
    console.log(`[Stops] ${stops.length} nodes rendered on Noir map.`);
  } catch (err) {
    console.error("Error loading route stops:", err);
  }
}

document.getElementById('btn-run-tracker').addEventListener('click', async () => {
  const apiKey = DEFAULTS.SAMSARA_API;
  const busId = document.getElementById('tracker-bus-number').value.trim();
  const stopIdString = document.getElementById('tracker-route-input').value.trim();
  const stopId = parseInt(stopIdString, 10);
  
  if (!apiKey) { alert('Samsara API configuration missing.'); return; }
  if (!busId && !stopIdString) { alert('Please enter a Bus Number or Stop Number'); return; }
  
  const btn = document.getElementById('btn-run-tracker');
  const orgText = btn.innerHTML;
  const statusBadge = document.getElementById('tracker-api-status');
  
  // UI Reset: Prevent dragging old data while the fresh signal is being resolved
  document.getElementById('tracker-last-stop').textContent = '...';
  document.getElementById('tracker-next-stop').textContent = '...';
  document.getElementById('tracker-street-addr').textContent = 'Syncing Fresh Satellite Position...';
  document.getElementById('tracker-active-time').textContent = '--';
  
  btn.innerHTML = '<span>Pinging Satellite...</span>';
  statusBadge.style.background = 'rgba(241, 196, 15, 0.2)';
  statusBadge.style.color = '#f1c40f';
  statusBadge.innerHTML = '<div class="status-dot" style="background:#f1c40f;"></div><span>Connecting...</span>';
  
  // Clear existing tracking markers
  trackerMarkers.forEach(m => trackerMap.removeLayer(m));
  trackerMarkers = [];

  try {
     document.getElementById('tracker-results-container').style.display = 'block';

     if (busId) {
       // --- BUS TRACKING BRANCH ---
       const busGps = await SamsaraEngine.fetchBusLocation(busId, apiKey);
       
       // ENRICHMENT: Link with CountIf data
       let enriched = DispatchEngine.getEnrichedStatus(busGps, busId, portalData);
       
       // Deep Search disabled — use refresh button to manually sync dispatch data
       
       statusBadge.style.background = 'rgba(46, 204, 113, 0.2)';
       statusBadge.style.color = '#2ecc71';
       
       const reportTimeStr = enriched.dispatchTime ? formatDisplayTime(enriched.dispatchTime) : 'No Entry';
       const timeDisplay = ` (${reportTimeStr})`;
       
       statusBadge.innerHTML = `
         <div class="status-dot" style="background:#2ecc71;"></div>
         <span>Connected: ${enriched.operator}${timeDisplay}</span>
         <button class="icon-btn-sm btn-copy-tracker-driver" style="margin-left: 8px; background: rgba(255,255,255,0.1); border-radius: 6px; padding: 4px; vertical-align: middle;">
           <svg class="icon-xs" style="fill: var(--green);"><use href="#icon-clipboard"/></svg>
         </button>
       `;
       
       const copyBtn = statusBadge.querySelector('.btn-copy-tracker-driver');
       if (copyBtn) {
         copyBtn.onclick = (e) => {
           e.stopPropagation();
           copyToClipboard(enriched.operator, copyBtn);
         };
       }
       
       const context = SamsaraEngine.resolveRouteContext(enriched, SamsaraEngine.CONFIG.STOPS);
       document.getElementById('tracker-last-stop').parentElement.querySelector('.stat-label').textContent = 'LAST STOP';
       document.getElementById('tracker-next-stop').parentElement.querySelector('.stat-label').textContent = 'UPCOMING';
       document.getElementById('tracker-last-stop').textContent = context.lastVisited ? context.lastVisited.name : 'Unknown';
       document.getElementById('tracker-next-stop').textContent = context.upcoming ? context.upcoming.name : 'Unknown';

       // Update Freshness & Address
       const gpsTimeStr = busGps.time || new Date().toISOString();
       const gpsTime = new Date(gpsTimeStr);
       const now = Date.now();
       
       // Handle potential clock drift (if satellite is slightly ahead or behind)
       const diffMs = Math.abs(now - gpsTime.getTime());
       const diffMins = Math.floor(diffMs / 60000);
       
       // User requirement: Sync from 1 minute ago at most
       const timeStr = diffMins <= 1 ? "Live" : `${diffMins}m ago`;
       
       const timeEl = document.getElementById('tracker-active-time');
       timeEl.textContent = `Active: ${timeStr}`;
       
       // Red alert if data is older than 5 minutes
       timeEl.style.color = (diffMins > 5 && timeStr !== "Live") ? '#e74c3c' : '#2ecc71'; 
       
       document.getElementById('tracker-street-addr').textContent = busGps.address;

       // Interactive Map Update: Custom Bus Marker (Samsara-Style Green Dot + Label)
       const pos = [busGps.latitude, busGps.longitude];
       const busIdDisplay = busId || "Bus";
       
       const customIcon = L.divIcon({
         html: `
           <div class="bus-marker-wrapper">
             <div class="bus-number-label">${busIdDisplay}</div>
             <div class="bus-beacon">
               <div class="bus-dot-core"></div>
               <div class="bus-pulse-ring"></div>
             </div>
           </div>
         `,
         className: 'bus-custom-marker',
         iconSize: [40, 40],
         iconAnchor: [20, 36] 
       });

       const marker = L.marker(pos, { icon: customIcon }).addTo(trackerMap);
       trackerMarkers.push(marker);

       trackerMap.setView(pos, 16, { animate: true });
       
     } else {
       // --- STOP RADIUS BRANCH ---
       const stopObj = SamsaraEngine.CONFIG.STOPS.find(s => s.id === stopId);
       if (!stopObj) throw new Error("Invalid Stop #");

       const closestBuses = await SamsaraEngine.findBusesNearStop(stopObj.lat, stopObj.lng, apiKey, 5);
       
       statusBadge.style.background = 'rgba(46, 204, 113, 0.2)';
       statusBadge.style.color = '#2ecc71';
       statusBadge.innerHTML = `<div class="status-dot" style="background:#2ecc71;"></div><span>Radius Scan Active</span>`;
       
       document.getElementById('tracker-last-stop').parentElement.querySelector('.stat-label').textContent = 'SCANNED STOP';
       document.getElementById('tracker-next-stop').parentElement.querySelector('.stat-label').textContent = 'CLOSEST BUSES';
       document.getElementById('tracker-last-stop').textContent = stopObj.name;
       
       const busNames = closestBuses.map(b => b.name).join(' & ');
       document.getElementById('tracker-next-stop').textContent = closestBuses.length > 0 ? busNames : "None nearby";

       const timeEl = document.getElementById('tracker-active-time');
       timeEl.textContent = `Radius Scan`;
       timeEl.style.color = '#2ecc71';
       document.getElementById('tracker-street-addr').textContent = `Showing closest buses to ${stopObj.name}`;

       let bounds = [];
       bounds.push([stopObj.lat, stopObj.lng]); // Include the stop itself in the bounds

       closestBuses.forEach(bus => {
         const pos = [bus.latitude, bus.longitude];
         bounds.push(pos);
         
         const customIcon = L.divIcon({
           html: `
             <div class="bus-marker-wrapper">
               <div class="bus-number-label">${bus.name}</div>
               <div class="bus-beacon">
                 <div class="bus-dot-core"></div>
                 <div class="bus-pulse-ring"></div>
               </div>
             </div>
           `,
           className: 'bus-custom-marker',
           iconSize: [40, 40],
           iconAnchor: [20, 36] 
         });
    
         const marker = L.marker(pos, { icon: customIcon }).addTo(trackerMap);
         trackerMarkers.push(marker);
       });

       // Always focus directly on the queried Stop location instead of zooming out to fit buses
       trackerMap.setView([stopObj.lat, stopObj.lng], 16, { animate: true });
     }
     
     // Ensure map is correctly rendered
     setTimeout(() => trackerMap.invalidateSize(), 100);
     
     btn.innerHTML = `
       <svg class="icon-sm" style="margin-right:8px;"><use href="#icon-navigation"/></svg>
       <span>Pinged</span>
     `;
     setTimeout(() => btn.innerHTML = orgText, 2500);
     
  } catch(e) {
     statusBadge.style.background = 'rgba(231, 76, 60, 0.2)';
     statusBadge.style.color = '#e74c3c';
     statusBadge.innerHTML = `<div class="status-dot" style="background:#e74c3c;"></div><span>${e.message}</span>`;
     btn.innerHTML = orgText;
  }
});

document.getElementById('btn-show-all-buses').addEventListener('click', runFleetScan);

document.getElementById('btn-menu-logout').addEventListener('click', () => {
  State.currentUser = null;
  localStorage.removeItem(KEYS.USER);
  document.getElementById('username').value = '';
  showView('login');
});

// ===== LOAD ALL DATA =====
function loadAllData() {
  // SW
  const swReports = localStorage.getItem(KEYS.SW_REPORTS);
  if (swReports) State.sw.savedReports = JSON.parse(swReports);
  // FL
  const flReports = localStorage.getItem(KEYS.FL_REPORTS);
  if (flReports) State.fl.savedReports = JSON.parse(flReports);
  const flDrivers = localStorage.getItem(KEYS.FL_DRIVERS);
  if (flDrivers) State.fl.drivers = JSON.parse(flDrivers);
  // LC
  const lcReports = localStorage.getItem(KEYS.LC_REPORTS);
  if (lcReports && State.lc) State.lc.savedReports = JSON.parse(lcReports);
  updateStorageCount();
}

// ===== REPORT VIEWER =====
let currentReportText = '';

function openReportViewer(content, title, onUpdateCallback) {
  currentReportText = content;
  document.getElementById('report-viewer-title').textContent = title || 'Report';
  const body = document.getElementById('report-viewer-body');
  body.innerHTML = '';
  let inNotesSection = false;
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (!line && idx === lines.length - 1) return; // skip trailing empty
    
    if (line.trim() === 'NOTES:') {
      inNotesSection = true;
    } else if (line.trim() === 'COPYABLES:' || (line.match(/^[A-Z ]+:$/) && line.trim() !== 'NOTES:')) {
      inNotesSection = false;
    }

    const row = document.createElement('div');
    row.className = 'report-line';
    const text = document.createElement('span');
    text.className = 'report-line-text';
    if (line.match(/^[A-Z ]+:$/)) text.classList.add('header-line');
    if (line.match(/^[-=]+$/)) text.classList.add('separator-line');
    text.textContent = line || ' ';
    
    if (!line.match(/^[-=]+$/) && line.trim() !== '') {
      text.contentEditable = true;
      text.style.borderBottom = "1px dashed rgba(255, 255, 255, 0.25)";
      text.style.padding = "2px 4px";
      text.style.borderRadius = "4px";
      text.style.outline = "none";
      text.title = "Click to edit line";
      text.addEventListener('input', () => {
        lines[idx] = text.textContent;
        currentReportText = lines.join('\n');
        if (typeof onUpdateCallback === 'function') {
          onUpdateCallback(currentReportText);
        }
      });
    }

    const btnContainer = document.createElement('div');
    btnContainer.style.display = 'flex';
    btnContainer.style.gap = '0.5rem';

    if (line.includes(' || ') || line.startsWith('Uniform violation')) {
      const btnV = document.createElement('button');
      btnV.className = 'btn-copy-line';
      btnV.innerHTML = '<span style="font-weight:bold;font-size:0.8rem;line-height:1;">V</span>';
      btnV.title = "Copy Violation Times/Notes Only";
      btnV.addEventListener('click', () => {
        let vText = lines[idx];
        if (vText.includes(' || ')) {
          vText = vText.split(' || ')[0].trim();
        }
        const ta = document.createElement('textarea');
        ta.value = vText; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy');
        document.body.removeChild(ta);
        btnV.classList.add('copied');
        setTimeout(() => btnV.classList.remove('copied'), 1200);
      });
      btnContainer.appendChild(btnV);
    }

    const btn = document.createElement('button');
    btn.className = 'btn-copy-line';
    btn.innerHTML = '<svg class="icon-xs"><use href="#icon-clipboard"/></svg>';
    btn.addEventListener('click', () => {
      // FORCE textarea fallback exclusively to bypass iOS URL encoding bugs on line copy
      const ta = document.createElement('textarea');
      ta.value = lines[idx]; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy');
      document.body.removeChild(ta);
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1200);
    });
    btnContainer.appendChild(btn);

    if (line.startsWith('VIOLATIONS LOG (')) {
      const btnAll = document.createElement('button');
      btnAll.className = 'btn-copy-line';
      btnAll.innerHTML = '<span style="font-weight:bold;font-size:0.8rem;line-height:1;">A</span>';
      btnAll.title = "Copy Entire Violations Log";
      btnAll.addEventListener('click', () => {
        const match = currentReportText.match(/VIOLATIONS LOG \(\d+\)\n-+\n([\s\S]*?)(?:\n\nNOTES:|\n\nCOPYABLES:|$)/);
        let logContent = match ? match[1].trim() : '';
        logContent = logContent.split('\n').map(l => l.trim()).filter(Boolean).join('\n\n');
        const ta = document.createElement('textarea');
        ta.value = logContent; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy');
        document.body.removeChild(ta);
        btnAll.classList.add('copied');
        setTimeout(() => btnAll.classList.remove('copied'), 1200);
      });
      btnContainer.appendChild(btnAll);
    }

    row.appendChild(text);
    if (line.trim()) row.appendChild(btnContainer);
    body.appendChild(row);
  });

  const formBtn = document.getElementById('dynamic-form-btn');
  if (formBtn) {
    if ((title && title.includes('Stopwatch')) || content.includes('STOPWATCH')) {
      formBtn.textContent = 'Stopwatch Form';
      formBtn.dataset.url = 'https://docs.google.com/forms/d/e/1FAIpQLSdlcMExtKCdKrDjad4B4Rq1y4phVHG5nSJhY_seBxKgbQBSYw/viewform';
    } else if ((title && title.includes('Bus ')) || content.includes('FULL LOOP')) {
      formBtn.textContent = 'Full Loop Form';
      formBtn.dataset.url = 'https://docs.google.com/forms/d/e/1FAIpQLSfc97vaKGcC6Ijdjer5fyQ2M3qN93scHiBGDRWtD_gYhU1ROw/viewform';
    } else {
      formBtn.textContent = 'Cruise Form';
      formBtn.dataset.url = 'https://docs.google.com/forms/d/e/1FAIpQLSd0zU3h4U-FJwYhm5WCInVypOJ38dHn_0CTJDlzO7acnXhNAQ/viewform';
    }
  }

  document.getElementById('report-viewer-modal').classList.add('active');
}

document.getElementById('btn-close-report-viewer').addEventListener('click', () => {
  document.getElementById('report-viewer-modal').classList.remove('active');
});

document.getElementById('btn-close-report-viewer-top').addEventListener('click', () => {
  document.getElementById('report-viewer-modal').classList.remove('active');
});
document.getElementById('btn-share-report').addEventListener('click', () => {
  if (navigator.share) {
    navigator.share({
      title: document.getElementById('report-viewer-title').textContent,
      text: currentReportText
    }).then(() => {
      document.getElementById('report-viewer-modal').classList.remove('active');
    }).catch(() => {});
  } else {
    alert("Export not supported on this device/browser.");
  }
});

document.getElementById('btn-download-txt-report').addEventListener('click', () => {
  const title = document.getElementById('report-viewer-title').textContent.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const file = new File([currentReportText], `${title}_report.txt`, { type: 'text/plain' });
  
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({
      files: [file],
      title: `${title} Report`,
    }).then(() => {
      document.getElementById('report-viewer-modal').classList.remove('active');
    }).catch(err => console.log('Share canceled', err));
  } else {
    // Fallback if File sharing is disabled
    const blob = new Blob([currentReportText], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${title}_report.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    document.getElementById('report-viewer-modal').classList.remove('active');
  }
});

// Quick Form Links in Report Viewer
document.querySelectorAll('.hud-shortcut').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.url && btn.dataset.url.includes('countif.net')) {
      openDispatchOverlayModal();
      return;
    }
    window.open(btn.dataset.url, '_blank');
  });
});

// Floating Pill Drag Logic
const dispatchPill = document.getElementById('floating-dispatch-pill');
if (dispatchPill) {
  let pillDragging = false;
  let startX, startY, initialLeft, initialTop, hasMoved = false;

  const onStart = (e) => {
    pillDragging = true;
    hasMoved = false;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    startX = clientX;
    startY = clientY;
    const rect = dispatchPill.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;
    dispatchPill.style.bottom = 'auto';
    dispatchPill.style.right = 'auto';
    dispatchPill.style.left = initialLeft + 'px';
    dispatchPill.style.top = initialTop + 'px';
  };

  const onMove = (e) => {
    if (!pillDragging) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - startX;
    const dy = clientY - startY;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      hasMoved = true;
    }
    dispatchPill.style.left = (initialLeft + dx) + 'px';
    dispatchPill.style.top = (initialTop + dy) + 'px';
  };

  const onEnd = (e) => {
    if (!pillDragging) return;
    pillDragging = false;
    if (!hasMoved) {
      openDispatchOverlayModal();
    }
  };

  dispatchPill.addEventListener('mousedown', onStart);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onEnd);

  dispatchPill.addEventListener('touchstart', onStart, { passive: true });
  window.addEventListener('touchmove', onMove, { passive: true });
  window.addEventListener('touchend', onEnd);
}

document.getElementById('btn-copy-all-report').addEventListener('click', () => {
  const btn = document.getElementById('btn-copy-all-report');
  // FORCE textarea fallback exclusively to bypass iOS URL encoding bugs on block copy
  let clipboardText = currentReportText.replace(/\n{3,}/g, '\n\n');
  const ta = document.createElement('textarea');
  ta.value = clipboardText; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select(); document.execCommand('copy');
  document.body.removeChild(ta);
  btn.querySelector('span').textContent = 'Copied!';
  setTimeout(() => btn.querySelector('span').textContent = 'Copy All', 1500);
});

// ============================================================
// STOPWATCH MODULE
// ============================================================

function swSaveSession() { localStorage.setItem(KEYS.SW_SESSION, JSON.stringify(State.sw.session)); }
function swClearSession() { localStorage.removeItem(KEYS.SW_SESSION); }

function checkSwResume() {
  const saved = localStorage.getItem(KEYS.SW_SESSION);
  const btn = document.getElementById('sw-btn-resume');
  if (saved) {
    const s = JSON.parse(saved);
    if (s.inspector === State.currentUser && (s.supervisor || s.violations.length > 0)) {
      State.sw.session = s;
      btn.classList.remove('hidden');
      return;
    }
  }
  btn.classList.add('hidden');
}

document.getElementById('sw-btn-start-new').addEventListener('click', () => {
  const startNew = () => {
    swClearSession();
    document.getElementById('sw-btn-resume').classList.add('hidden');
    document.getElementById('sw-supervisor-name').value = '';
    document.getElementById('sw-stop-num').value = '';
    document.getElementById('sw-time-started').value = formatTime();
    showView('sw-new');
  };

  if (!document.getElementById('sw-btn-resume').classList.contains('hidden')) {
    openConfirmModal("You already have an active report, Proceed", startNew);
  } else {
    startNew();
  }
});

document.getElementById('sw-btn-resume').addEventListener('click', () => { swUpdateDisplay(); swRenderLog(); swRenderNotes(); showView('sw-session'); });
document.getElementById('sw-btn-view-all').addEventListener('click', () => { swRenderHistory(); showView('sw-history'); });

// Time input click
document.getElementById('sw-time-started').addEventListener('click', () => {
  openTimePicker(document.getElementById('sw-time-started').value, v => document.getElementById('sw-time-started').value = v);
});

// Start session
document.getElementById('sw-btn-confirm-start').addEventListener('click', () => {
  const sup = document.getElementById('sw-supervisor-name').value.trim();
  const stop = document.getElementById('sw-stop-num').value.trim();
  const time = document.getElementById('sw-time-started').value.trim();
  if (!sup || !stop) { alert('Please fill in all fields'); return; }
  State.sw.editingSavedReportIndex = null;
  const combinedGlobal = typeof getCombinedGlobalNotes === 'function' ? getCombinedGlobalNotes() : [];
  State.sw.session = { inspector: State.currentUser, supervisor: sup, stopNum: stop, startTime: time, endTime: null, violations: [], notes: combinedGlobal };
  swUpdateDisplay(); swRenderLog(); swRenderNotes(); swSaveSession();
  showView('sw-session');
});

function swUpdateDisplay() {
  document.getElementById('sw-session-sup').textContent = State.sw.session.supervisor;
  document.getElementById('sw-session-stop').textContent = State.sw.session.stopNum;
  document.getElementById('sw-session-start').textContent = State.sw.session.startTime;
}

// Violation buttons
document.querySelectorAll('#sw-violation-grid .violation-btn-sm:not(.custom-btn):not(.note-btn)').forEach(btn => {
  btn.addEventListener('click', () => openViolationDetail('sw', btn.dataset.type));
});
document.getElementById('sw-btn-custom-violation').addEventListener('click', () => openCustomModal('sw'));
document.getElementById('sw-btn-add-note').addEventListener('click', () => openNoteModal('sw'));

// Edit session
document.getElementById('sw-btn-edit-session').addEventListener('click', () => {
  openEditSessionModal('sw');
});

// End session
document.getElementById('sw-btn-finish').addEventListener('click', () => {
  openTimePicker(formatTime(), endTime => {
    State.sw.session.endTime = endTime;
    const report = swGenerateReport(State.sw.session);
    swSaveReport(State.sw.session);
    swClearSession();
    if (typeof clearGlobalNotes === 'function') clearGlobalNotes();
    checkSwResume();
    showView('sw-dashboard');
    setTimeout(() => openReportViewer(report, `${State.sw.session.supervisor} — Stop #${State.sw.session.stopNum}`), 400);
  });
});

function swRenderLog() {
  const list = document.getElementById('sw-violation-list');
  const badge = document.getElementById('sw-violation-count');
  const violations = State.sw.session.violations;
  badge.textContent = `${violations.length} logged`;
  list.innerHTML = '';
  if (violations.length === 0) {
    list.innerHTML = `<div style="text-align:center;padding:3rem 1rem;opacity:.3;"><svg class="icon" style="width:32px;height:32px;margin-bottom:.5rem;"><use href="#icon-folder"/></svg><p style="font-size:.75rem;">No violations logged yet</p></div>`;
    return;
  }
  [...violations].sort((a,b) => b.sortMinutes - a.sortMinutes).forEach(v => {
    const idx = violations.indexOf(v);
    const li = document.createElement('li');
    li.className = 'log-item';
    let label = v.type;
    if (v.type === 'Bus Dispatch') { label += v.isLate ? ' (Late)' : v.noInput ? ' (No Input)' : ' (On Time)'; }
    li.innerHTML = `<div class="log-content"><span class="type">${label}</span>${v.notes ? `<span class="log-notes">${v.type==='Bus Dispatch'?'Bus #':''}${v.notes}</span>` : ''}</div><div class="log-meta"><span class="time">${(v.isMultipleMinutes && v.endTime) ? `${v.timestamp}-${v.endTime}` : v.timestamp}</span><button class="icon-btn-sm sw-edit-log" data-idx="${idx}"><svg class="icon-sm"><use href="#icon-pencil"/></svg></button><button class="icon-btn-sm sw-del-log" data-idx="${idx}"><svg class="icon-sm"><use href="#icon-x"/></svg></button></div>`;
    li.querySelector('.sw-edit-log').onclick = () => openViolationDetail('sw', v.type, idx);
    li.querySelector('.sw-del-log').onclick = () => {
      State.sw.session.violations.splice(idx, 1);
      swRenderLog();
      swSaveSession();
    };
    list.appendChild(li);
  });
}

function swRenderNotes() {
  const list = document.getElementById('sw-notes-list');
  const badge = document.getElementById('sw-notes-count');
  const notes = State.sw.session.notes || [];
  badge.textContent = `${notes.length} note${notes.length !== 1 ? 's' : ''}`;
  list.innerHTML = '';
  if (notes.length === 0) {
    list.innerHTML = `<div style="text-align:center;padding:2rem 1rem;opacity:.3;"><p style="font-size:.75rem;">No notes added</p></div>`;
    return;
  }
  notes.forEach((note, idx) => {
    const li = document.createElement('li');
    li.className = 'log-item';
    li.innerHTML = `<div class="log-content"><span class="type" style="color:var(--accent);">📝 Note</span><span class="log-notes">${note}</span></div><div class="log-meta"><button class="icon-btn-sm sw-edit-note" data-idx="${idx}"><svg class="icon-sm"><use href="#icon-pencil"/></svg></button><button class="icon-btn-sm sw-del-note" data-idx="${idx}"><svg class="icon-sm"><use href="#icon-x"/></svg></button></div>`;
    li.querySelector('.sw-edit-note').onclick = () => openNoteModal('sw', idx);
    li.querySelector('.sw-del-note').onclick = () => {
      State.sw.session.notes.splice(idx, 1);
      swRenderNotes(); swSaveSession();
    };
    list.appendChild(li);
  });
}

function swGenerateReport(s) {
  let r = `SESSION DETAILS:\n`;
  r += `----------------\n`;
  r += `Date: ${s.date || new Date().toLocaleDateString()}\n`;
  r += `Supervisor: ${s.supervisor}\n`;
  r += `Stop #: ${s.stopNum}\n`;
  r += `Time Started: ${formatReportTime(s.startTime)}\n`;
  r += `Time Ended: ${formatReportTime(s.endTime)}\n\n\n`;
  r += `VIOLATIONS LOG (${s.violations.length}):\n`;
  r += `---------------\n`;
  if (s.violations.length === 0) { r += 'No violations recorded.\n'; }
  else {
    const sorted = [...s.violations].sort((a,b) => a.sortMinutes - b.sortMinutes);
    const groups = {};
    sorted.forEach(v => { if (!groups[v.type]) groups[v.type] = []; groups[v.type].push(v); });
    const violationLines = [];
    Object.keys(groups).forEach(type => {
      if (type === 'Bus Dispatch') {
        const formatViolationTime = (v) => (v.isMultipleMinutes && v.endTime) ? `${formatReportTime(v.timestamp)}-${formatReportTime(v.endTime)}` : formatReportTime(v.timestamp);
        const accurate = groups[type].filter(v => !v.isLate && !v.noInput);
        const inaccurate = groups[type].filter(v => v.isLate || v.noInput);
        if (accurate.length > 0) violationLines.push(`Accurate updates to dispatch: ${accurate.map(v => `${v.notes}`).join(', ')}`);
        if (inaccurate.length > 0) {
          violationLines.push(`Inaccurate updates to dispatch: ${inaccurate.map(v => {
            const tags = []; if (v.isLate) tags.push('Late'); if (v.noInput) tags.push("Didnt Input");
            return `${v.notes}(${formatViolationTime(v)},${tags.join('/')})`;
          }).join(', ')}`);
        }
      } else if (type === 'Uniform') {
        const notes = groups[type].map(v => v.notes).filter(n => n && n.length > 0).join(', ');
        if (notes) violationLines.push(notes);
      } else {
        const formatViolationTime = (v) => (v.isMultipleMinutes && v.endTime) ? `${formatReportTime(v.timestamp)}-${formatReportTime(v.endTime)}` : formatReportTime(v.timestamp);
        const times = groups[type].map(v => { const n = v.notes ? ` (${v.notes})` : ''; return `${formatViolationTime(v)}${n}`; });
        violationLines.push(`[${times.join(', ')}] || ${type}`);
      }
    });
    r += violationLines.join('\n\n') + '\n';
  }
  // Notes section
  const notes = s.notes || [];
  r += `\n\nNOTES:\n`;
  r += `------\n`;
  if (notes.length > 0) {
    notes.forEach(n => { r += `${n}\n`; });
  } else {
    r += `None\n`;
  }
  return r;
}

function swSaveReport(session) {
  const report = { ...session, inspector: State.currentUser, id: session.id || Date.now(), date: session.date || new Date().toLocaleDateString() };
  if (State.sw.editingSavedReportIndex === null) {
    State.sw.savedReports.unshift(report);
  } else {
    State.sw.savedReports[State.sw.editingSavedReportIndex] = report;
    State.sw.editingSavedReportIndex = null;
  }
  localStorage.setItem(KEYS.SW_REPORTS, JSON.stringify(State.sw.savedReports));
  updateStorageCount();
}

function swRenderHistory() {
  const list = document.getElementById('sw-saved-list');
  list.innerHTML = '';
  const mine = State.sw.savedReports.filter(r => r.inspector === State.currentUser);
  if (mine.length === 0) { list.innerHTML = `<li class="subtitle" style="text-align:center;padding:2rem;">No reports found.</li>`; return; }
  mine.forEach(r => {
    const globalIdx = State.sw.savedReports.indexOf(r);
    const li = document.createElement('li');
    li.className = 'log-item';
    li.style.cursor = 'pointer';
    li.innerHTML = `<div class="log-content"><span class="type">${r.supervisor}</span><span class="log-notes">Stop #${r.stopNum} • ${r.date}</span></div><div class="log-meta"><button class="icon-btn-sm sw-view-btn" title="View Report"><svg class="icon-sm"><use href="#icon-clipboard"/></svg></button><button class="icon-btn-sm sw-edit-btn" title="Edit"><svg class="icon-sm"><use href="#icon-pencil"/></svg></button><button class="icon-btn-sm sw-del-report-btn" title="Delete"><svg class="icon-sm"><use href="#icon-trash"/></svg></button></div>`;
    const openViewer = () => openReportViewer(swGenerateReport(r), `${r.supervisor} — Stop #${r.stopNum}`);
    li.querySelector('.sw-view-btn').onclick = (e) => { e.stopPropagation(); openViewer(); };
    li.querySelector('.log-content').onclick = openViewer;
    li.querySelector('.sw-edit-btn').onclick = (e) => {
      e.stopPropagation();
      State.sw.session = JSON.parse(JSON.stringify(r));
      State.sw.editingSavedReportIndex = globalIdx;
      swUpdateDisplay(); swRenderLog(); showView('sw-session');
    };
    li.querySelector('.sw-del-report-btn').onclick = (e) => {
      e.stopPropagation();
      if (confirm('Delete this report?')) {
        State.sw.savedReports.splice(globalIdx, 1);
        localStorage.setItem(KEYS.SW_REPORTS, JSON.stringify(State.sw.savedReports));
        updateStorageCount();
        swRenderHistory();
      }
    };
    list.appendChild(li);
  });
}

// ============================================================
// FULL LOOP MODULE
// ============================================================

function flSaveSession() { localStorage.setItem(KEYS.FL_SESSION, JSON.stringify(State.fl.session)); }
function flClearSession() { localStorage.removeItem(KEYS.FL_SESSION); }

function checkFlResume() {
  const saved = localStorage.getItem(KEYS.FL_SESSION);
  const btn = document.getElementById('fl-btn-resume');
  if (saved) {
    const s = JSON.parse(saved);
    if (s.inspector === State.currentUser && (s.busNumber || s.violations.length > 0)) {
      State.fl.session = s;
      btn.classList.remove('hidden');
      return;
    }
  }
  btn.classList.add('hidden');
}

document.getElementById('fl-btn-start-new').addEventListener('click', () => {
  const startNew = () => {
    flClearSession();
    document.getElementById('fl-btn-resume').classList.add('hidden');
    document.getElementById('fl-bus-number').value = '';
    document.getElementById('fl-driver-name').value = '';
    document.getElementById('fl-route').value = '';
    document.getElementById('fl-stop-boarded').value = '';
    document.getElementById('fl-time-started').value = formatTime();
    showView('fl-new');
  };

  if (!document.getElementById('fl-btn-resume').classList.contains('hidden')) {
    openConfirmModal("You already have an active report, Proceed", startNew);
  } else {
    startNew();
  }
});
document.getElementById('fl-btn-resume').addEventListener('click', () => { flUpdateDisplay(); flRenderLog(); flRenderNotes(); showView('fl-session'); });
document.getElementById('fl-btn-view-all').addEventListener('click', () => { flRenderHistory(); showView('fl-history'); });

document.getElementById('fl-time-started').addEventListener('click', () => {
  openTimePicker(document.getElementById('fl-time-started').value, v => document.getElementById('fl-time-started').value = v);
});

document.getElementById('fl-btn-confirm-start').addEventListener('click', () => {
  const bus = document.getElementById('fl-bus-number').value.trim();
  const driver = document.getElementById('fl-driver-name').value.trim();
  const route = document.getElementById('fl-route').value.trim();
  const stop = document.getElementById('fl-stop-boarded').value.trim();
  const time = document.getElementById('fl-time-started').value.trim();
  if (!bus || !driver) { alert('Please fill in Bus Number and Driver Name'); return; }
  State.fl.editingSavedReportIndex = null;
  const combinedGlobal = typeof getCombinedGlobalNotes === 'function' ? getCombinedGlobalNotes() : [];
  State.fl.session = { inspector: State.currentUser, busNumber: bus, driverName: driver, route: route || '', stopBoarded: stop || '', startTime: time, endTime: null, violations: [], notes: combinedGlobal };
  flUpsertDriver(driver);
  flUpdateDisplay(); flRenderLog(); flRenderNotes(); flSaveSession();
  showView('fl-session');
});

function flUpdateDisplay() {
  document.getElementById('fl-session-bus').textContent = State.fl.session.busNumber;
  document.getElementById('fl-session-driver').textContent = State.fl.session.driverName;
  document.getElementById('fl-session-route').textContent = State.fl.session.route || '-';
  document.getElementById('fl-session-start').textContent = State.fl.session.startTime;
}

// Violation buttons
document.querySelectorAll('#fl-violation-grid .violation-btn-sm:not(.custom-btn):not(.note-btn)').forEach(btn => {
  btn.addEventListener('click', () => openViolationDetail('fl', btn.dataset.type));
});
document.getElementById('fl-btn-custom-violation').addEventListener('click', () => openCustomModal('fl'));
document.getElementById('fl-btn-add-note').addEventListener('click', () => openNoteModal('fl'));

// Edit session
document.getElementById('fl-btn-edit-session').addEventListener('click', () => openEditSessionModal('fl'));

// Driver change
document.getElementById('fl-btn-driver-change').addEventListener('click', () => {
  document.getElementById('new-driver-input').value = State.fl.session.driverName;
  document.getElementById('driver-change-modal').classList.add('active');
});
document.getElementById('btn-cancel-driver-change').addEventListener('click', () => document.getElementById('driver-change-modal').classList.remove('active'));
document.getElementById('btn-save-driver-change').addEventListener('click', () => {
  const name = document.getElementById('new-driver-input').value.trim();
  if (!name) return;
  State.fl.session.driverName = name;
  flUpsertDriver(name);
  flUpdateDisplay(); flSaveSession();
  document.getElementById('driver-change-modal').classList.remove('active');
});

// End session
document.getElementById('fl-btn-finish').addEventListener('click', () => {
  openTimePicker(formatTime(), endTime => {
    State.fl.session.endTime = endTime;
    const report = flGenerateReport(State.fl.session);
    flSaveReport(State.fl.session);
    flClearSession();
    if (typeof clearGlobalNotes === 'function') clearGlobalNotes();
    checkFlResume();
    showView('fl-dashboard');
    setTimeout(() => openReportViewer(report, `Bus ${State.fl.session.busNumber} — ${State.fl.session.driverName}`), 400);
  });
});

function flRenderLog() {
  const list = document.getElementById('fl-violation-list');
  const badge = document.getElementById('fl-violation-count');
  const violations = State.fl.session.violations;
  badge.textContent = `${violations.length} logged`;
  list.innerHTML = '';
  if (violations.length === 0) {
    list.innerHTML = `<div style="text-align:center;padding:3rem 1rem;opacity:.3;"><svg class="icon" style="width:32px;height:32px;margin-bottom:.5rem;"><use href="#icon-folder"/></svg><p style="font-size:.75rem;">No violations logged yet</p></div>`;
    return;
  }
  [...violations].sort((a,b) => b.sortMinutes - a.sortMinutes).forEach(v => {
    const idx = violations.indexOf(v);
    const li = document.createElement('li');
    li.className = 'log-item';
    let label = v.type;
    let parts = [];
    if (v.stopNumber) parts.push(v.stopNumber);
    if (v.notes) parts.push(v.notes);
    if (isStandingType(v.type)) {
      if (v.standingAction === 'taken') {
        parts.push(v.actionDescription ? v.actionDescription : "Action Taken");
      } else if (v.standingAction === 'none') {
        parts.push("No Action Taken");
      }
    }
    let notesHtml = parts.length > 0 ? `<span class="log-notes">(${parts.join(', ')})</span>` : '';
    li.innerHTML = `<div class="log-content"><span class="type">${label}</span>${notesHtml}</div><div class="log-meta"><span class="time">${(v.isMultipleMinutes && v.endTime) ? `${v.timestamp}-${v.endTime}` : v.timestamp}</span><button class="icon-btn-sm fl-edit-log" data-idx="${idx}"><svg class="icon-sm"><use href="#icon-pencil"/></svg></button><button class="icon-btn-sm fl-del-log" data-idx="${idx}"><svg class="icon-sm"><use href="#icon-x"/></svg></button></div>`;
    li.querySelector('.fl-edit-log').onclick = () => openViolationDetail('fl', v.type, idx);
    li.querySelector('.fl-del-log').onclick = () => {
      State.fl.session.violations.splice(idx, 1);
      flRenderLog(); flSaveSession();
    };
    list.appendChild(li);
  });
}

function flRenderNotes() {
  const list = document.getElementById('fl-notes-list');
  const badge = document.getElementById('fl-notes-count');
  const notes = State.fl.session.notes || [];
  badge.textContent = `${notes.length} note${notes.length !== 1 ? 's' : ''}`;
  list.innerHTML = '';
  if (notes.length === 0) {
    list.innerHTML = `<div style="text-align:center;padding:2rem 1rem;opacity:.3;"><p style="font-size:.75rem;">No notes added</p></div>`;
    return;
  }
  notes.forEach((note, idx) => {
    const li = document.createElement('li');
    li.className = 'log-item';
    li.innerHTML = `<div class="log-content"><span class="type" style="color:var(--accent);">📝 Note</span><span class="log-notes">${note}</span></div><div class="log-meta"><button class="icon-btn-sm fl-edit-note" data-idx="${idx}"><svg class="icon-sm"><use href="#icon-pencil"/></svg></button><button class="icon-btn-sm fl-del-note" data-idx="${idx}"><svg class="icon-sm"><use href="#icon-x"/></svg></button></div>`;
    li.querySelector('.fl-edit-note').onclick = () => openNoteModal('fl', idx);
    li.querySelector('.fl-del-note').onclick = () => {
      State.fl.session.notes.splice(idx, 1);
      flRenderNotes(); flSaveSession();
    };
    list.appendChild(li);
  });
}

function flGenerateReport(s) {
  let r = `SESSION REPORT\n`;
  r += `================================\n`;
  r += `Bus Number: ${s.busNumber}\n`;
  r += `Bus Driver: ${s.driverName}\n`;
  r += `Route: ${s.route}\n`;
  r += `Stop Boarded: ${s.stopBoarded}\n`;
  r += `Time Boarded: ${formatReportTime(s.startTime)}\n`;
  r += `Time Off: ${s.endTime ? formatReportTime(s.endTime) : 'N/A'}\n\n`;
  r += `VIOLATIONS LOG (${s.violations.length})\n`;
  r += `--------------------------------\n`;
  if (s.violations.length === 0) { r += 'No violations recorded.\n'; }
  else {
    const sorted = [...s.violations].sort((a,b) => a.sortMinutes - b.sortMinutes);
    const groups = {};
    sorted.forEach(v => { if (!groups[v.type]) groups[v.type] = []; groups[v.type].push(v); });
    const sortedKeys = Object.keys(groups).sort((a,b) => groups[a][0].sortMinutes - groups[b][0].sortMinutes);
    const violationLines = [];
    sortedKeys.forEach(type => {
      if (type.toLowerCase() === 'uniform') {
        const notes = groups[type].map(v => v.notes).filter(n => n && n.length > 0).join(', ');
        if (notes) violationLines.push(notes); else violationLines.push(`Uniform violation (${groups[type].length})`);
      } else if (type === 'Skipped Stop') {
        const formatViolationTime = (v) => (v.isMultipleMinutes && v.endTime) ? `${formatReportTime(v.timestamp)}-${formatReportTime(v.endTime)}` : formatReportTime(v.timestamp);
        const entries = groups[type].map(v => {
          let parts = [];
          if (v.stopNumber) parts.push(v.stopNumber);
          if (v.notes) parts.push(v.notes);
          let extra = parts.length > 0 ? `(${parts.join(', ')})` : '';
          return `${formatViolationTime(v)}${extra}`;
        });
        violationLines.push(`${entries.join(', ')} || Skipped Stop`);
      } else {
        const isStanding = type.toLowerCase().includes('standing');
        const formatViolationTime = (v) => (v.isMultipleMinutes && v.endTime) ? `${formatReportTime(v.timestamp)}-${formatReportTime(v.endTime)}` : formatReportTime(v.timestamp);
        const times = groups[type].map(v => {
          let parts = [];
          if (v.notes) parts.push(v.notes);
          if (isStanding) {
            if (v.standingAction === 'taken') {
              parts.push(v.actionDescription ? v.actionDescription : "Action Taken");
            } else if (v.standingAction === 'none') {
              parts.push("No Action Taken");
            }
          }
          let extra = parts.length > 0 ? ` (${parts.join(', ')})` : '';
          return `${formatViolationTime(v)}${extra}`;
        });
        violationLines.push(`[${times.join(', ')}] || ${type}`);
      }
    });
    r += violationLines.join('\n\n') + '\n';
  }
  // Notes section
  const notes = s.notes || [];
  r += `\n\nNOTES:\n`;
  r += `------\n`;
  if (notes.length > 0) {
    notes.forEach(n => { r += `${n}\n`; });
  } else {
    r += `None\n`;
  }

  // Copyables section for video violations
  const videoViolations = s.violations.filter(v => v.hasVideo);
  if (videoViolations.length > 0) {
    r += `\n\nCOPYABLES:\n`;
    r += `----------\n`;
    const vGroups = {};
    [...videoViolations].sort((a,b) => a.sortMinutes - b.sortMinutes).forEach(v => {
      if (!vGroups[v.type]) vGroups[v.type] = [];
      vGroups[v.type].push(v);
    });
    Object.keys(vGroups).forEach(type => {
      const formatViolationTime = (v) => (v.isMultipleMinutes && v.endTime) ? `${formatReportTime(v.timestamp)}-${formatReportTime(v.endTime)}` : formatReportTime(v.timestamp);
      const isStanding = isStandingType(type);
      const times = vGroups[type].map(v => {
        let parts = [];
        if (v.notes) parts.push(v.notes);
        if (isStanding) {
          if (v.standingAction === 'taken') {
            parts.push(v.actionDescription ? v.actionDescription : "Action Taken");
          } else if (v.standingAction === 'none') {
            parts.push("No Action Taken");
          }
        }
        let extra = parts.length > 0 ? ` (${parts.join(', ')})` : '';
        return `${formatViolationTime(v)}${extra}`;
      });
      r += `[${times.join(', ')}] || ${type} // Bus: ${s.busNumber}, Bus Driver: ${s.driverName}\n`;
    });
  }

  return r;
}

function flSaveReport(session) {
  const report = { ...session, inspector: State.currentUser, id: session.id || Date.now(), date: session.date || new Date().toLocaleDateString() };
  if (State.fl.editingSavedReportIndex === null) {
    State.fl.savedReports.unshift(report);
  } else {
    State.fl.savedReports[State.fl.editingSavedReportIndex] = report;
    State.fl.editingSavedReportIndex = null;
  }
  localStorage.setItem(KEYS.FL_REPORTS, JSON.stringify(State.fl.savedReports));
  updateStorageCount();
}

function flRenderHistory() {
  const list = document.getElementById('fl-saved-list');
  list.innerHTML = '';
  const mine = State.fl.savedReports.filter(r => r.inspector === State.currentUser);
  if (mine.length === 0) { list.innerHTML = `<li class="subtitle" style="text-align:center;padding:2rem;">No reports found.</li>`; return; }
  mine.forEach(r => {
    const globalIdx = State.fl.savedReports.indexOf(r);
    const li = document.createElement('li');
    li.className = 'log-item';
    li.style.cursor = 'pointer';
    li.innerHTML = `<div class="log-content"><span class="type">Bus ${r.busNumber} - ${r.route || 'No route'}</span><span class="log-notes">${r.driverName} • ${r.date}</span></div><div class="log-meta"><button class="icon-btn-sm fl-view-btn" title="View Report"><svg class="icon-sm"><use href="#icon-clipboard"/></svg></button><button class="icon-btn-sm fl-edit-btn" title="Edit"><svg class="icon-sm"><use href="#icon-pencil"/></svg></button><button class="icon-btn-sm fl-del-report-btn" title="Delete"><svg class="icon-sm"><use href="#icon-trash"/></svg></button></div>`;
    const openViewer = () => openReportViewer(flGenerateReport(r), `Bus ${r.busNumber} — ${r.driverName}`);
    li.querySelector('.fl-view-btn').onclick = (e) => { e.stopPropagation(); openViewer(); };
    li.querySelector('.log-content').onclick = openViewer;
    li.querySelector('.fl-edit-btn').onclick = (e) => {
      e.stopPropagation();
      State.fl.session = JSON.parse(JSON.stringify(r));
      State.fl.editingSavedReportIndex = globalIdx;
      flUpdateDisplay(); flRenderLog(); showView('fl-session');
    };
    li.querySelector('.fl-del-report-btn').onclick = (e) => {
      e.stopPropagation();
      if (confirm('Delete this report?')) {
        State.fl.savedReports.splice(globalIdx, 1);
        localStorage.setItem(KEYS.FL_REPORTS, JSON.stringify(State.fl.savedReports));
        updateStorageCount();
        flRenderHistory();
      }
    };
    list.appendChild(li);
  });
}

// ===== DRIVERS =====
function flUpsertDriver(name) {
  if (!name || !name.trim()) return;
  const now = new Date().toISOString();
  const idx = State.fl.drivers.findIndex(d => d.driverName === name);
  if (idx === -1) State.fl.drivers.push({ driverName: name, lastReportDate: now });
  else State.fl.drivers[idx].lastReportDate = now;
  localStorage.setItem(KEYS.FL_DRIVERS, JSON.stringify(State.fl.drivers));
}



// ============================================================
// SHARED MODALS
// ============================================================

// --- Custom Violation ---
let customViolationModule = null;
function openCustomModal(mod) {
  customViolationModule = mod;
  document.getElementById('custom-violation-input').value = '';
  document.getElementById('custom-violation-modal').classList.add('active');
  setTimeout(() => document.getElementById('custom-violation-input').focus(), 100);
}
document.getElementById('btn-cancel-custom').addEventListener('click', () => document.getElementById('custom-violation-modal').classList.remove('active'));
document.getElementById('btn-save-custom').addEventListener('click', () => {
  const val = document.getElementById('custom-violation-input').value.trim();
  if (!val) return;
  document.getElementById('custom-violation-modal').classList.remove('active');
  openViolationDetail(customViolationModule, val);
});

// --- Note Modal ---
let noteModule = null;
function openConfirmModal(message, onYes) {
  const modal = document.getElementById('confirm-modal');
  document.getElementById('confirm-modal-message').textContent = message;
  modal.classList.add('active');
  
  const btnYes = document.getElementById('btn-confirm-yes');
  const btnNo = document.getElementById('btn-confirm-no');
  
  // Clone to remove old listeners
  const newBtnYes = btnYes.cloneNode(true);
  const newBtnNo = btnNo.cloneNode(true);
  btnYes.parentNode.replaceChild(newBtnYes, btnYes);
  btnNo.parentNode.replaceChild(newBtnNo, btnNo);
  
  newBtnYes.onclick = () => {
    modal.classList.remove('active');
    if (onYes) onYes();
  };
  newBtnNo.onclick = () => {
    modal.classList.remove('active');
  };
}

let editingNoteIndex = null;
function openNoteModal(mod, editIdx = null) {
  noteModule = mod;
  editingNoteIndex = editIdx;
  const state = State[noteModule];
  if (editIdx !== null && state && state.session && state.session.notes && state.session.notes[editIdx] !== undefined) {
    document.getElementById('note-input').value = state.session.notes[editIdx];
  } else {
    document.getElementById('note-input').value = '';
  }
  document.getElementById('note-modal').classList.add('active');
  setTimeout(() => document.getElementById('note-input').focus(), 100);
}
document.getElementById('btn-cancel-note').addEventListener('click', () => {
  editingNoteIndex = null;
  document.getElementById('note-modal').classList.remove('active');
});
document.getElementById('btn-save-note').addEventListener('click', () => {
  const val = document.getElementById('note-input').value.trim();
  document.getElementById('note-modal').classList.remove('active');
  const state = State[noteModule];
  if (!state.session.notes) state.session.notes = [];
  
  if (editingNoteIndex !== null) {
    if (!val) {
      state.session.notes.splice(editingNoteIndex, 1);
    } else {
      state.session.notes[editingNoteIndex] = val;
    }
    editingNoteIndex = null;
  } else {
    if (!val) return;
    state.session.notes.push(val);
  }
  if (noteModule === 'sw') { swRenderNotes(); swSaveSession(); }
  else if (noteModule === 'fl') { flRenderNotes(); flSaveSession(); }
  else if (noteModule === 'lc') { lcRenderNotes(); lcSaveSessionToStorage(); }
});

// --- Violation Detail ---
let detailModule = null;
const detailModal = document.getElementById('violation-detail-modal');
const detailTime = document.getElementById('detail-time-input');
const detailNotes = document.getElementById('detail-notes-input');
const detailTitle = document.getElementById('detail-modal-title');
const detailNotesLabel = document.getElementById('detail-notes-label');
const busDispatchOpts = document.getElementById('bus-dispatch-options');
const checkLate = document.getElementById('check-late');
const checkNoInput = document.getElementById('check-no-input');
const standingActionOpts = document.getElementById('standing-action-options');
const radioNoAction = document.getElementById('radio-no-action');
const radioActionTaken = document.getElementById('radio-action-taken');
const actionDescInput = document.getElementById('action-description-input');
const actionDescGroup = document.getElementById('action-desc-group');
const checkHasVideo = document.getElementById('check-has-video');

// Radio mutual exclusivity + show/hide text input
if (radioNoAction && radioActionTaken) {
  radioNoAction.addEventListener('change', () => {
    if (radioNoAction.checked) { radioActionTaken.checked = false; actionDescGroup.style.display = 'none'; }
  });
  radioActionTaken.addEventListener('change', () => {
    if (radioActionTaken.checked) { radioNoAction.checked = false; actionDescGroup.style.display = 'block'; setTimeout(() => actionDescInput.focus(), 100); }
  });
}

function isStandingType(type) {
  const t = type.toLowerCase();
  return t.includes('standing');
}

function formatStopPrefix(val) {
  if (!val) return '';
  val = val.trim();
  if (/^stop\b/i.test(val)) {
    return val.replace(/^stop\s*/i, 'Stop ');
  }
  return `Stop ${val}`;
}

function openViolationDetail(mod, type, editIdx = null) {
  detailModule = mod;
  const state = State[mod];
  state.editingViolationIndex = editIdx;
  const isEdit = editIdx !== null;
  const existing = isEdit ? state.session.violations[editIdx] : null;
  detailTitle.textContent = isEdit ? 'Edit Violation' : type;
  detailTime.value = isEdit ? existing.timestamp : formatTime();
  detailNotes.value = (isEdit && existing.notes) || '';
  if (type === 'Bus Dispatch') {
    busDispatchOpts.style.display = 'flex';
    detailNotesLabel.textContent = 'Bus #';
    checkLate.checked = isEdit && existing.isLate || false;
    checkNoInput.checked = isEdit && existing.noInput || false;
  } else {
    busDispatchOpts.style.display = 'none';
    detailNotesLabel.textContent = 'Notes (Optional)';
    checkLate.checked = false; checkNoInput.checked = false;
  }
  // Standing action options (Full Loop only)
  if (isStandingType(type) && mod === 'fl') {
    standingActionOpts.style.display = 'block';
    radioNoAction.checked = isEdit && existing.standingAction === 'none' || false;
    radioActionTaken.checked = isEdit && existing.standingAction === 'taken' || false;
    actionDescInput.value = (isEdit && existing.actionDescription) || '';
    actionDescGroup.style.display = radioActionTaken.checked ? 'block' : 'none';
    if (checkHasVideo) checkHasVideo.checked = (isEdit && existing.hasVideo) || false;
  } else {
    standingActionOpts.style.display = 'none';
    radioNoAction.checked = false; radioActionTaken.checked = false;
    actionDescInput.value = '';
    actionDescGroup.style.display = 'none';
    if (checkHasVideo) checkHasVideo.checked = false;
  }
  
  // Multiple Minutes Logic
  if (type === 'Customer standing while bus in motion' || type === 'Took off while customers standing' || type === 'Skipped Stop') {
    document.getElementById('multiple-minutes-options').style.display = 'block';
    const isChecked = isEdit && existing.isMultipleMinutes || false;
    document.getElementById('check-multiple-minutes').checked = isChecked;
    document.getElementById('end-time-group').style.display = isChecked ? 'block' : 'none';
    document.getElementById('detail-end-time-input').value = (isEdit && existing.endTime) ? existing.endTime : '';
    document.querySelector('label[for="detail-time-input"]').textContent = isChecked ? 'Start Time' : 'Time';
  } else {
    document.getElementById('multiple-minutes-options').style.display = 'none';
    document.getElementById('check-multiple-minutes').checked = false;
    document.getElementById('end-time-group').style.display = 'none';
    document.getElementById('detail-end-time-input').value = '';
    document.querySelector('label[for="detail-time-input"]').textContent = 'Time';
  }

  if (type === 'Skipped Stop') {
    document.getElementById('skipped-stop-options').style.display = 'block';
    document.getElementById('detail-stop-num-input').value = (isEdit && existing.rawStopInput !== undefined) ? existing.rawStopInput : ((isEdit && existing.stopNumber) ? existing.stopNumber.replace(/^Stop\s*/i, '') : '');
  } else {
    document.getElementById('skipped-stop-options').style.display = 'none';
    document.getElementById('detail-stop-num-input').value = '';
  }

  detailModal.classList.add('active');
  detailModal.dataset.currentType = type;
  setTimeout(() => detailNotes.focus(), 100);
}

detailTime.addEventListener('click', () => openTimePicker(detailTime.value, v => detailTime.value = v));

document.getElementById('check-multiple-minutes').addEventListener('change', (e) => {
  document.getElementById('end-time-group').style.display = e.target.checked ? 'block' : 'none';
  document.querySelector('label[for="detail-time-input"]').textContent = e.target.checked ? 'Start Time' : 'Time';
  if (e.target.checked && !document.getElementById('detail-end-time-input').value) {
    document.getElementById('detail-end-time-input').value = formatTime();
  }
});
document.getElementById('detail-end-time-input').addEventListener('click', () => {
  openTimePicker(document.getElementById('detail-end-time-input').value || formatTime(), v => document.getElementById('detail-end-time-input').value = v);
});

document.getElementById('btn-cancel-detail').addEventListener('click', () => { detailModal.classList.remove('active'); checkLate.checked = false; checkNoInput.checked = false; radioNoAction.checked = false; radioActionTaken.checked = false; if (checkHasVideo) checkHasVideo.checked = false; document.getElementById('check-multiple-minutes').checked = false; });
document.getElementById('btn-save-detail').addEventListener('click', () => {
  const state = State[detailModule];
  const idx = state.editingViolationIndex;
  const time = detailTime.value.trim();
  const notes = detailNotes.value.trim();
  const type = idx === null ? detailModal.dataset.currentType : state.session.violations[idx].type;
  
  if (document.getElementById('check-multiple-minutes').checked) {
    const et = document.getElementById('detail-end-time-input').value.trim();
    if (!et) { alert('Please select an End Time, or uncheck "Multiple Minutes?".'); return; }
  }

  const violation = {
    type: type,
    timestamp: time, notes: notes, sortMinutes: timeToMinutes(time),
    isLate: checkLate.checked, noInput: checkNoInput.checked
  };
  
  if (type === 'Skipped Stop') {
    const rawStop = document.getElementById('detail-stop-num-input').value.trim();
    violation.rawStopInput = rawStop;
    violation.stopNumber = rawStop ? formatStopPrefix(rawStop) : '';
  }
  
  if (document.getElementById('check-multiple-minutes').checked) {
    violation.isMultipleMinutes = true;
    violation.endTime = document.getElementById('detail-end-time-input').value.trim();
  }

  // Standing action fields
  if (isStandingType(type) && detailModule === 'fl') {
    if (radioActionTaken.checked) {
      violation.standingAction = 'taken';
      violation.actionDescription = actionDescInput.value.trim();
    } else if (radioNoAction.checked) {
      violation.standingAction = 'none';
      violation.actionDescription = '';
    } else {
      violation.standingAction = '';
      violation.actionDescription = '';
    }
    violation.hasVideo = checkHasVideo ? checkHasVideo.checked : false;
  }
  if (idx === null) state.session.violations.push(violation);
  else state.session.violations[idx] = violation;
  checkLate.checked = false; checkNoInput.checked = false;
  radioNoAction.checked = false; radioActionTaken.checked = false;
  if (checkHasVideo) checkHasVideo.checked = false;
  detailModal.classList.remove('active');
  state.editingViolationIndex = null;
  if (detailModule === 'sw') { swRenderLog(); swSaveSession(); }
  else { flRenderLog(); flSaveSession(); }
});

// --- Edit Session Modal ---
let editModule = null;
const editModal = document.getElementById('edit-session-modal');
const editFields = document.getElementById('edit-session-fields');

function openEditSessionModal(mod) {
  editModule = mod;
  editFields.innerHTML = '';
  const s = State[mod].session;
  if (mod === 'sw') {
    editFields.innerHTML = `
      <div class="input-group"><label>Supervisor Name:</label><input type="text" id="edit-f-sup" value="${s.supervisor}" /></div>
      <div class="input-group"><label>Stop #:</label><input type="text" id="edit-f-stop" value="${s.stopNum}" /></div>
      <div class="input-group"><label>Time Started:</label><input type="text" id="edit-f-time" value="${s.startTime}" readonly class="clickable-input" /></div>`;
    setTimeout(() => document.getElementById('edit-f-time').addEventListener('click', () => openTimePicker(document.getElementById('edit-f-time').value, v => document.getElementById('edit-f-time').value = v)), 50);
  } else {
    editFields.innerHTML = `
      <div class="input-group"><label>Bus Number:</label><input type="text" id="edit-f-bus" value="${s.busNumber}" /></div>
      <div class="input-group"><label>Driver Name:</label><input type="text" id="edit-f-driver" value="${s.driverName}" /></div>
      <div class="input-group"><label>Route:</label><input type="text" id="edit-f-route" value="${s.route}" /></div>
      <div class="input-group"><label>Stop Boarded:</label><input type="text" id="edit-f-stop" value="${s.stopBoarded}" /></div>
      <div class="input-group"><label>Time On:</label><input type="text" id="edit-f-time" value="${s.startTime}" readonly class="clickable-input" /></div>`;
    setTimeout(() => document.getElementById('edit-f-time').addEventListener('click', () => openTimePicker(document.getElementById('edit-f-time').value, v => document.getElementById('edit-f-time').value = v)), 50);
  }
  editModal.classList.add('active');
}

document.getElementById('btn-cancel-edit-session').addEventListener('click', () => editModal.classList.remove('active'));
document.getElementById('btn-save-edit-session').addEventListener('click', () => {
  const s = State[editModule].session;
  if (editModule === 'sw') {
    s.supervisor = document.getElementById('edit-f-sup').value.trim();
    s.stopNum = document.getElementById('edit-f-stop').value.trim();
    s.startTime = document.getElementById('edit-f-time').value.trim();
    swUpdateDisplay(); swSaveSession();
  } else {
    s.busNumber = document.getElementById('edit-f-bus').value.trim();
    s.driverName = document.getElementById('edit-f-driver').value.trim();
    s.route = document.getElementById('edit-f-route').value.trim();
    s.stopBoarded = document.getElementById('edit-f-stop').value.trim();
    s.startTime = document.getElementById('edit-f-time').value.trim();
    flUpdateDisplay(); flSaveSession();
  }
  editModal.classList.remove('active');
});

// ============================================================
// GLOBAL NOTES LOGIC
// ============================================================
let globalNotesData = { blocks: [] };

function loadGlobalNotes() {
  const saved = localStorage.getItem('topview_global_notes');
  if (saved) globalNotesData = JSON.parse(saved);
  if (!globalNotesData.blocks) globalNotesData.blocks = [];
}

function saveGlobalNotes() { localStorage.setItem('topview_global_notes', JSON.stringify(globalNotesData)); }

function renderGlobalNotesUI() {
  const blockList = document.getElementById('global-block-list');
  blockList.innerHTML = '';
  
  if (!globalNotesData.blocks || globalNotesData.blocks.length === 0) {
    blockList.innerHTML = `<div style="text-align:center;padding:1.5rem;opacity:.4;font-size:0.8rem;">No global notes</div>`;
    return;
  }
  
  globalNotesData.blocks.forEach((blk, idx) => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="log-content"><span class="log-notes">${blk}</span></div>
                    <div class="log-meta"><button class="icon-btn-sm gl-del-log" data-idx="${idx}"><svg class="icon-sm"><use href="#icon-x"/></svg></button></div>`;
    li.querySelector('.gl-del-log').onclick = () => { globalNotesData.blocks.splice(idx, 1); saveGlobalNotes(); renderGlobalNotesUI(); };
    blockList.appendChild(li);
  });
}

document.getElementById('btn-open-global-block-input').addEventListener('click', () => {
  document.getElementById('global-block-input-container').style.display = 'block';
  document.getElementById('global-block-input').focus();
  document.getElementById('btn-open-global-block-input').style.display = 'none';
});

document.getElementById('btn-cancel-global-block').addEventListener('click', () => {
  document.getElementById('global-block-input-container').style.display = 'none';
  document.getElementById('global-block-input').value = '';
  document.getElementById('btn-open-global-block-input').style.display = 'inline-block';
});

document.getElementById('btn-add-global-block').addEventListener('click', () => {
  const input = document.getElementById('global-block-input');
  const val = input.value.trim();
  if (val) {
    if (!globalNotesData.blocks) globalNotesData.blocks = [];
    globalNotesData.blocks.push(val); 
    input.value = ''; 
    saveGlobalNotes(); 
    renderGlobalNotesUI(); 
    document.getElementById('global-block-input-container').style.display = 'none';
    document.getElementById('btn-open-global-block-input').style.display = 'inline-block';
  }
});

function getCombinedGlobalNotes() {
  return globalNotesData.blocks ? [...globalNotesData.blocks] : [];
}

function clearGlobalNotes() {
  globalNotesData = { blocks: [] };
  saveGlobalNotes(); renderGlobalNotesUI();
}

function openGlobalNotesModal() { 
  loadGlobalNotes(); 
  document.getElementById('global-block-input-container').style.display = 'none';
  document.getElementById('btn-open-global-block-input').style.display = 'inline-block';
  document.getElementById('global-block-input').value = '';
  renderGlobalNotesUI(); 
  document.getElementById('global-notes-modal').classList.add('active'); 
}
document.getElementById('btn-close-global-notes').addEventListener('click', () => document.getElementById('global-notes-modal').classList.remove('active'));
document.getElementById('btn-goto-global-notes').addEventListener('click', openGlobalNotesModal);
document.getElementById('sw-btn-global-notes').addEventListener('click', openGlobalNotesModal);
document.getElementById('fl-btn-global-notes').addEventListener('click', openGlobalNotesModal);

loadGlobalNotes();

// ===== KEYBOARD SHORTCUTS =====
window.addEventListener('keydown', e => {
  const modal = document.querySelector('.modal-overlay.active');
  if (e.key === 'Escape') {
    if (modal) modal.classList.remove('active');
    return;
  }
  if (e.key === 'Enter') {
    if (modal) { 
      const btn = modal.querySelector('.btn-primary'); 
      if (btn) { btn.click(); return; }
    }
    // Fallback for login screen
    if (views['login'] && views['login'].classList.contains('active')) { 
      doLogin(); 
    }
  }
});

// ===== INIT =====
console.log("Topview Logger V10.0.0 initializing...");
initTimePicker();
updateStorageCount();

// AUTO-SYNC: If session exists, sync in background immediately
if (portalSessionCookie) {
  console.log("[Init] Found active CountIf session, syncing...");
  countifSetBadge('Synced', 'green');
  fetchDispatchData(); 
}
// ============================================================
// LIBERTY CRUISE MODULE
// ============================================================

const LC_CHECKLIST_ITEMS = [
  { id: 'statue_duration', label: 'Duration Spent At Statue', type: 'duration' },
  { id: 'wristbands', label: 'Gave Premium Wristbands', type: 'YN_NA' },
  { id: 'life_jacket', label: 'Supervisor behind fence wore Life Jacket', type: 'YN', extraOn: 'No', extraLabel: 'Their Name:' },
  { id: 'took_cash', label: 'Supervisor Took Cash on the Pier', type: 'YN', extraOn: 'Yes', extraLabel: 'Time & Name:' },
  { id: 'board_step', label: 'Announced Watch Step/Head While Boarding', type: 'ASN' },
  { id: 'board_greet', label: 'Crew Greeted Upon Boarding:', type: 'ASN' },
  { id: 'deboard_thank', label: 'Crew Thanked Upon DeBoarding:', type: 'ASN' },
  { id: 'crew_smile', label: 'Crew Smiled', type: 'ASN', extraOn: ['Some', 'None'], extraLabel: 'Their Name:' },
  { id: 'cap_welcome', label: 'Welcome Message by Captain:', type: 'YN' },
  { id: 'cap_safety', label: 'Safety Message by Captain:', type: 'YN' },
  { id: 'crew_interact', label: 'Crew interacted with customers:', type: 'ASN' },
  { id: 'uniforms', label: 'Uniforms', type: 'YN', extraOn: 'No', extraLabel: 'Their Name:' },
  { id: 'crew_breaks', label: 'Crew Breaks on schedule', type: 'YN', extraOn: 'No', extraLabel: 'Their Name:' },
  { id: 'crew_eating', label: 'Crew Eating outside of wheel house', type: 'ASN', invertColor: true, extraOn: ['All', 'Some'], extraLabel: 'Their Name:' },
  { id: 'phone_usage', label: 'Phone usage outside of wheel house', type: 'ASN', invertColor: true },
  { id: 'crew_tips', label: 'Crew asking customer for tips', type: 'YN', invertColor: true },
  { id: 'vip_section', label: 'VIP Section Correct', type: 'YN' },
  { id: 'restrooms_clean', label: 'Restrooms Clean', type: 'YN', extraOn: 'No', extraLabel: 'Their Name:' },
  { id: 'deck_clean', label: 'Deck/Floor Cleanliness', type: 'YN' },
  { id: 'windows_clean', label: 'Windows Cleanliness', type: 'YN' },
  { id: 'temp_drinks', label: 'Temp of Drinks', type: 'TEMP' },
  { id: 'liquor_id', label: 'Asking ID for Liquor', type: 'YN', extraOn: 'No', extraLabel: 'Their name:' },
  { id: 'menu_prices', label: 'Menu with prices at concession stand', type: 'YN' },
  { id: 'concession_uniforms', label: 'Concession Uniforms', type: 'YN' },
  { id: 'music_boarding', label: 'Music played when boarding', type: 'YN' },
  { id: 'music_deboarding', label: 'Music played when deboarding', type: 'YN' },
  { id: 'music_statue_pier', label: 'Music played from the statue to the pier', type: 'YN' },
  { id: 'tg_tour', label: 'Tour guide giving tour entire time', type: 'YN' },
  { id: 'tg_phone', label: 'Tour guide phone use', type: 'YN', invertColor: true },
  { id: 'tg_uniform', label: 'Tour guide uniform', type: 'YN' }
];

let lcActiveDropdownId = null;

function lcSaveSessionToStorage() {
  if (State.lc && State.lc.session) {
    localStorage.setItem(KEYS.LC_SESSION, JSON.stringify(State.lc.session));
  }
}

function checkLcResume() {
  const saved = localStorage.getItem(KEYS.LC_SESSION);
  const btn = document.getElementById('lc-btn-resume');
  if (!btn) return;
  if (saved) {
    btn.classList.remove('hidden');
  } else {
    btn.classList.add('hidden');
  }
}

function lcCalculateDuration(startStr, endStr) {
  if (!startStr || !endStr) return null;
  const parseTime = (str) => {
    const m = str.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!m) return null;
    let h = parseInt(m[1]);
    const min = parseInt(m[2]);
    const p = m[3].toUpperCase();
    if (p === 'PM' && h !== 12) h += 12;
    if (p === 'AM' && h === 12) h = 0;
    return h * 60 + min;
  };
  const sMin = parseTime(startStr);
  const eMin = parseTime(endStr);
  if (sMin === null || eMin === null) return null;
  let diff = eMin - sMin;
  if (diff < 0) diff += 24 * 60;
  return diff;
}

function lcIsPositiveAnswer(item, answer) {
  if (!answer || answer === '---') return false;
  if (answer === 'Not Applicable') return 'neutral';
  if (item.type === 'duration') return true;
  if (item.invertColor) {
    if (item.type === 'YN' || item.type === 'YN_NA') return answer === 'No';
    if (item.type === 'ASN') return answer === 'None';
  } else {
    if (item.type === 'YN' || item.type === 'YN_NA') return answer === 'Yes';
    if (item.type === 'ASN') return answer === 'All';
    if (item.type === 'TEMP') return answer === 'Cold' || answer === 'Cold With Ice';
  }
  return false;
}

window.lcUpdatePreField = function(field, val) {
  if (!State.lc.session) return;
  State.lc.session[field] = val;
  lcSaveSessionToStorage();
};

window.lcManualSavePreInfo = function(btn) {
  if (!State.lc.session) return;
  const card = btn.closest('div').parentElement;
  if (card) {
    const inputs = card.querySelectorAll('input');
    if (inputs.length >= 4) {
      State.lc.session.boat = inputs[0].value.trim();
      State.lc.session.depart = inputs[1].value.trim();
      State.lc.session.ticket = inputs[2].value.trim();
      State.lc.session.supervisor = inputs[3].value.trim();
    }
  }
  lcSaveSessionToStorage();
  
  if (State.lc.editingSavedReportIndex !== null && State.lc.editingSavedReportIndex !== undefined && State.lc.editingSavedReportIndex >= 0) {
    const saved = State.lc.savedReports[State.lc.editingSavedReportIndex];
    if (saved) {
      saved.boat = State.lc.session.boat;
      saved.depart = State.lc.session.depart;
      saved.ticket = State.lc.session.ticket;
      saved.supervisor = State.lc.session.supervisor;
      saved.items = State.lc.session.items || {};
      saved.title = `Liberty Cruise - ${saved.boat || 'Boat'} - ${saved.depart || ''}`;
      saved.auditText = lcGenerateAuditText(State.lc.session);
      localStorage.setItem(KEYS.LC_REPORTS, JSON.stringify(State.lc.savedReports));
    }
  }

  const originalHtml = btn.innerHTML;
  btn.style.background = '#2ecc71';
  btn.style.color = 'white';
  btn.innerHTML = '<svg class="icon-xs"><use href="#icon-check"/></svg>Saved!';
  setTimeout(() => {
    btn.style.background = '';
    btn.style.color = '';
    btn.innerHTML = originalHtml;
  }, 1200);
};

window.lcOpenDepartPicker = function() {
  if (!State.lc.session) return;
  const currentVal = State.lc.session.depart || formatTime();
  openTimePicker(currentVal, (val) => {
    if (!State.lc.session) return;
    State.lc.session.depart = val;
    lcSaveSessionToStorage();
    const departInput = document.getElementById('lc-pre-depart');
    if (departInput) departInput.value = val;
  });
};

function lcRenderChecklist() {
  const container = document.getElementById('lc-checklist-area');
  if (!container) return;
  if (!State.lc || !State.lc.session) { container.innerHTML = ''; return; }
  
  if (!State.lc.session.items) State.lc.session.items = {};
  const itemsMap = State.lc.session.items;

  let html = `
    <div style="background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; padding: 1rem; margin-bottom: 1.5rem;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.8rem;">
        <span style="font-size: 0.75rem; font-weight: 800; color: var(--green); text-transform: uppercase; letter-spacing: 1px;">Cruise Pre-Logging Info</span>
        <button type="button" class="btn-primary" style="padding: 4px 12px; font-size: 0.7rem; font-weight: 800; border-radius: 6px; height: 26px; display: flex; align-items: center; gap: 4px;" onclick="lcManualSavePreInfo(this)"><svg class="icon-xs"><use href="#icon-check"/></svg>Save Info</button>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.8rem; font-size: 0.85rem;">
        <div>
          <label style="color: rgba(255,255,255,0.5); display:block; font-size:0.7rem; margin-bottom:3px;">Boat Name</label>
          <input type="text" value="${State.lc.session.boat || ''}" placeholder="Boat Name" style="width: 100%; padding: 8px 10px; border-radius: 8px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 0.85rem; font-weight: 700;" oninput="lcUpdatePreField('boat', this.value)" />
        </div>
        <div>
          <label style="color: rgba(255,255,255,0.5); display:block; font-size:0.7rem; margin-bottom:3px;">Departure Time</label>
          <input type="text" id="lc-pre-depart" readonly value="${State.lc.session.depart || ''}" placeholder="Tap to pick" class="clickable-input" style="width: 100%; padding: 8px 10px; border-radius: 8px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 0.85rem; font-weight: 700; cursor: pointer; text-align: center;" onclick="lcOpenDepartPicker()" />
        </div>
        <div>
          <label style="color: rgba(255,255,255,0.5); display:block; font-size:0.7rem; margin-bottom:3px;">Ticket Number</label>
          <input type="text" value="${State.lc.session.ticket || ''}" placeholder="Ticket Number" style="width: 100%; padding: 8px 10px; border-radius: 8px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 0.85rem; font-weight: 700;" oninput="lcUpdatePreField('ticket', this.value)" />
        </div>
        <div>
          <label style="color: rgba(255,255,255,0.5); display:block; font-size:0.7rem; margin-bottom:3px;">Supervisor Scanned</label>
          <input type="text" value="${State.lc.session.supervisor || ''}" placeholder="Supervisor Name" style="width: 100%; padding: 8px 10px; border-radius: 8px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 0.85rem; font-weight: 700;" oninput="lcUpdatePreField('supervisor', this.value)" />
        </div>
      </div>
    </div>
  `;

  LC_CHECKLIST_ITEMS.forEach(item => {
    const itemData = itemsMap[item.id] || {};
    const answer = itemData.answer || '---';
    const isExpanded = lcActiveDropdownId === item.id;
    const isAnswered = answer && answer !== '---';
    const isPositive = lcIsPositiveAnswer(item, answer);

    let badgeColor = 'rgba(255,255,255,0.15)';
    let badgeText = 'Tap to select';
    let badgeBorder = 'rgba(255,255,255,0.3)';
    let textColor = 'white';

    if (isAnswered) {
      badgeText = answer;
      if (item.type === 'duration') {
        badgeColor = 'rgba(46, 204, 113, 0.2)';
        badgeBorder = '#2ecc71';
        textColor = '#2ecc71';
      } else if (isPositive === 'neutral') {
        badgeColor = 'rgba(255, 255, 255, 0.1)';
        badgeBorder = 'rgba(255, 255, 255, 0.4)';
        textColor = 'rgba(255, 255, 255, 0.7)';
      } else if (isPositive) {
        badgeColor = 'rgba(46, 204, 113, 0.2)';
        badgeBorder = '#2ecc71';
        textColor = '#2ecc71';
      } else {
        badgeColor = 'rgba(231, 76, 60, 0.25)';
        badgeBorder = '#e74c3c';
        textColor = '#e74c3c';
      }
    }

    html += `
    <div class="lc-item-card" data-id="${item.id}" style="background: ${isExpanded ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.02)'}; border: 1px solid ${isExpanded ? 'var(--green)' : 'rgba(255,255,255,0.08)'}; border-radius: 12px; padding: 1rem; margin-bottom: 0.8rem; cursor: pointer; transition: all 0.2s ease; box-shadow: ${isExpanded ? '0 4px 20px rgba(0,0,0,0.4)' : 'none'};">
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 1rem;">
        <span style="font-size: 0.85rem; font-weight: 600; color: white;">${item.label}</span>
        <div style="background: ${badgeColor}; border: 1px solid ${badgeBorder}; color: ${textColor}; padding: 4px 12px; border-radius: 20px; font-size: 0.75rem; font-weight: 700; white-space: nowrap; display: flex; align-items: center; gap: 6px;">
          <span>${badgeText}</span>
          <svg class="icon-xs" style="fill: ${textColor}; transform: ${isExpanded ? 'rotate(180deg)' : 'rotate(0deg)'}; transition: transform 0.2s;"><use href="#icon-chevron-down"/></svg>
        </div>
      </div>
    `;

    if (isExpanded) {
      if (item.type === 'duration') {
        html += `
        <div style="margin-top: 1rem; padding-top: 0.8rem; border-top: 1px solid rgba(255,255,255,0.1); display: flex; flex-direction: column; gap: 0.8rem;" onclick="event.stopPropagation();">
          <div style="display: flex; gap: 0.8rem;">
            <div style="flex: 1;">
              <label style="font-size: 0.65rem; color: rgba(255,255,255,0.5); display: block; margin-bottom: 4px;">Start Time:</label>
              <input type="text" readonly value="${itemData.startTime || ''}" placeholder="Tap to pick" class="clickable-input" style="width: 100%; padding: 8px 10px; border-radius: 8px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 0.8rem; text-align: center; cursor: pointer;" onclick="lcOpenDurationPicker('${item.id}', 'startTime')" />
            </div>
            <div style="flex: 1;">
              <label style="font-size: 0.65rem; color: rgba(255,255,255,0.5); display: block; margin-bottom: 4px;">End Time:</label>
              <input type="text" readonly value="${itemData.endTime || ''}" placeholder="Tap to pick" class="clickable-input" style="width: 100%; padding: 8px 10px; border-radius: 8px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.2); color: white; font-size: 0.8rem; text-align: center; cursor: pointer;" onclick="lcOpenDurationPicker('${item.id}', 'endTime')" />
            </div>
          </div>
        </div>
        `;
      } else {
        let options = [];
        if (item.type === 'YN') options = ['Yes', 'No'];
        if (item.type === 'YN_NA') options = ['Yes', 'No', 'Not Applicable'];
        if (item.type === 'ASN') options = ['All', 'Some', 'None'];
        if (item.type === 'TEMP') options = ['Cold', 'Cold With Ice', 'Not cold'];

        html += `
        <div style="margin-top: 1rem; padding-top: 0.8rem; border-top: 1px solid rgba(255,255,255,0.1); display: flex; gap: 0.6rem; flex-wrap: wrap;" onclick="event.stopPropagation();">
          ${options.map(opt => {
            const isSel = answer === opt;
            return `<button class="btn-primary" style="flex: 1; min-width: 80px; height: 40px; border-radius: 8px; font-size: 0.75rem; background: ${isSel ? 'var(--green)' : 'rgba(255,255,255,0.08)'}; color: ${isSel ? 'black' : 'white'}; border: 1px solid ${isSel ? 'var(--green)' : 'rgba(255,255,255,0.15)'}; font-weight: ${isSel ? '800' : '600'}; cursor: pointer;" onclick="lcSelectOption('${item.id}', '${opt}')">${opt}</button>`;
          }).join('')}
        </div>
        `;
      }
    }

    const extraOnMatch = item.extraOn && (Array.isArray(item.extraOn) ? item.extraOn.includes(answer) : answer === item.extraOn);
    if (extraOnMatch) {
      html += `
      <div style="margin-top: 0.8rem; padding-top: 0.6rem; border-top: 1px dashed rgba(255,255,255,0.15); display: flex; flex-direction: column; gap: 4px;" onclick="event.stopPropagation();">
        <label style="font-size: 0.7rem; color: #f39c12; font-weight: 700;">${item.extraLabel}</label>
        <input type="text" value="${itemData.extra || ''}" placeholder="Enter details..." style="width: 100%; padding: 8px 12px; border-radius: 8px; background: rgba(0,0,0,0.3); border: 1px solid #f39c12; color: white; font-size: 0.8rem;" oninput="lcUpdateExtra('${item.id}', this.value)" />
      </div>
      `;
    }

    html += `</div>`;
  });

  container.innerHTML = html;

  container.querySelectorAll('.lc-item-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-id');
      lcActiveDropdownId = (lcActiveDropdownId === id) ? null : id;
      lcRenderChecklist();
      // Re-apply filter after re-render
      const searchInput = document.getElementById('lc-checklist-search');
      if (searchInput && searchInput.value.trim()) {
        lcFilterChecklist(searchInput.value);
      }
    });
  });
}

window.lcFilterChecklist = function(query) {
  const container = document.getElementById('lc-checklist-area');
  if (!container) return;
  const cards = container.querySelectorAll('.lc-item-card');
  const q = query.toLowerCase().trim();
  cards.forEach(card => {
    const id = card.getAttribute('data-id');
    const item = LC_CHECKLIST_ITEMS.find(i => i.id === id);
    if (!item) return;
    if (!q || item.label.toLowerCase().includes(q)) {
      card.style.display = '';
    } else {
      card.style.display = 'none';
    }
  });
};

window.lcSelectOption = function(itemId, opt) {
  if (!State.lc.session) return;
  if (!State.lc.session.items[itemId]) State.lc.session.items[itemId] = {};
  State.lc.session.items[itemId].answer = opt;
  lcSaveSessionToStorage();
  lcRenderChecklist();
};

window.lcOpenDurationPicker = function(itemId, field) {
  if (!State.lc.session) return;
  if (!State.lc.session.items[itemId]) State.lc.session.items[itemId] = {};
  const currentVal = State.lc.session.items[itemId][field] || formatTime();
  openTimePicker(currentVal, (val) => {
    if (!State.lc.session) return;
    if (!State.lc.session.items[itemId]) State.lc.session.items[itemId] = {};
    State.lc.session.items[itemId][field] = val;
    const sTime = State.lc.session.items[itemId].startTime;
    const eTime = State.lc.session.items[itemId].endTime;
    if (sTime && eTime) {
      const mins = lcCalculateDuration(sTime, eTime);
      State.lc.session.items[itemId].answer = (mins !== null) ? `${mins} mins (${sTime} - ${eTime})` : `(${sTime} - ${eTime})`;
    } else if (sTime || eTime) {
      State.lc.session.items[itemId].answer = `Start: ${sTime || '---'} | End: ${eTime || '---'}`;
    }
    lcSaveSessionToStorage();
    lcRenderChecklist();
  });
};

window.lcUpdateExtra = function(itemId, val) {
  if (!State.lc.session) return;
  if (!State.lc.session.items[itemId]) State.lc.session.items[itemId] = {};
  State.lc.session.items[itemId].extra = val;
  lcSaveSessionToStorage();
};

function lcRenderNotes() {
  const list = document.getElementById('lc-notes-list');
  const badge = document.getElementById('lc-notes-count');
  if (!list || !badge) return;
  if (!State.lc || !State.lc.session) {
    list.innerHTML = '';
    badge.textContent = '0 notes';
    return;
  }
  const notes = State.lc.session.notes || [];
  badge.textContent = `${notes.length} note${notes.length !== 1 ? 's' : ''}`;
  list.innerHTML = '';
  if (notes.length === 0) {
    list.innerHTML = `<div style="text-align:center;padding:2rem 1rem;opacity:.3;"><p style="font-size:.75rem;">No notes added</p></div>`;
    return;
  }
  notes.forEach((note, idx) => {
    const li = document.createElement('li');
    li.className = 'log-item';
    li.innerHTML = `<div class="log-content"><span class="type" style="color:var(--accent);">📝 Note</span><span class="log-notes">${note}</span></div><div class="log-meta"><button class="icon-btn-sm lc-edit-note" data-idx="${idx}"><svg class="icon-sm"><use href="#icon-pencil"/></svg></button><button class="icon-btn-sm lc-del-note" data-idx="${idx}"><svg class="icon-sm"><use href="#icon-x"/></svg></button></div>`;
    li.querySelector('.lc-edit-note').onclick = () => openNoteModal('lc', idx);
    li.querySelector('.lc-del-note').onclick = () => {
      State.lc.session.notes.splice(idx, 1);
      lcRenderNotes(); lcSaveSessionToStorage();
    };
    list.appendChild(li);
  });
}

function lcGenerateAuditText(session) {
  let text = `=========================================
LIBERTY CRUISE INSPECTION REPORT
=========================================
Departure Time: ${session.depart || '-'}
Return Time: ${session.returnTime || '-'}
Ticket Number: ${session.ticket || '-'}
Boat Name: ${session.boat || '-'}
Supervisor That Scanned Ticket: ${session.supervisor || '-'}

-----------------------------------------
CHECKLIST
-----------------------------------------
`;

  const itemsMap = session.items || {};

  LC_CHECKLIST_ITEMS.forEach(item => {
    const itemData = itemsMap[item.id] || {};
    const ans = itemData.answer || '---';
    let extraStr = '';
    const extraMatch = item.extraOn && (Array.isArray(item.extraOn) ? item.extraOn.includes(ans) : ans === item.extraOn);
    if (extraMatch && itemData.extra) {
      extraStr = ` ^ ${item.extraLabel} ${itemData.extra}`;
    }
    text += `${item.label} || ${ans}${extraStr}\n`;
  });

  if (session.notes && session.notes.length > 0) {
    text += `\n\nNOTES:\n`;
    text += `-----------------------------------------\n`;
    session.notes.forEach((note, i) => {
      text += `${i + 1}. ${note}\n`;
    });
  }

  return text;
}

function lcRenderHistory() {
  const list = document.getElementById('lc-saved-list');
  if (!list) return;
  list.innerHTML = '';
  const reports = State.lc.savedReports || [];
  if (reports.length === 0) {
    list.innerHTML = `<li class="subtitle" style="text-align:center;padding:2rem;">No saved cruise reports found.</li>`;
    return;
  }
  reports.forEach((r, idx) => {
    const li = document.createElement('li');
    li.className = 'log-item';
    li.style.cursor = 'pointer';
    li.innerHTML = `
      <div class="log-content">
        <span class="type">${r.boat || 'Liberty Cruise'}</span>
        <span class="log-notes">Ticket #${r.ticket || '-'} • Depart: ${r.depart || '-'}</span>
      </div>
      <div class="log-meta">
        <button class="icon-btn-sm lc-view-btn" title="View Report"><svg class="icon-sm"><use href="#icon-clipboard"/></svg></button>
        <button class="icon-btn-sm lc-edit-btn" title="Edit Report & Checklist"><svg class="icon-sm"><use href="#icon-pencil"/></svg></button>
        <button class="icon-btn-sm lc-del-btn" title="Delete"><svg class="icon-sm"><use href="#icon-trash"/></svg></button>
      </div>
    `;
    const openViewer = () => openReportViewer(r.auditText, r.title || `Liberty Cruise — ${r.boat}`, (updatedText) => {
      r.auditText = updatedText;
      localStorage.setItem(KEYS.LC_REPORTS, JSON.stringify(State.lc.savedReports));
    });
    li.querySelector('.lc-view-btn').onclick = (e) => { e.stopPropagation(); openViewer(); };
    li.querySelector('.log-content').onclick = openViewer;
    li.querySelector('.lc-edit-btn').onclick = (e) => {
      e.stopPropagation();
      State.lc.session = {
        id: r.id || Date.now().toString(),
        depart: r.depart || '',
        ticket: r.ticket || '',
        boat: r.boat || '',
        supervisor: r.supervisor || '',
        items: r.items ? JSON.parse(JSON.stringify(r.items)) : {},
        notes: r.notes ? JSON.parse(JSON.stringify(r.notes)) : []
      };
      State.lc.editingSavedReportIndex = idx;
      lcRenderChecklist();
      lcRenderNotes();
      showView('lc-session');
    };
    li.querySelector('.lc-del-btn').onclick = (e) => {
      e.stopPropagation();
      if (confirm('Delete this cruise report?')) {
        State.lc.savedReports.splice(idx, 1);
        localStorage.setItem(KEYS.LC_REPORTS, JSON.stringify(State.lc.savedReports));
        updateStorageCount();
        lcRenderHistory();
      }
    };
    list.appendChild(li);
  });
}

document.getElementById('lc-btn-resume')?.addEventListener('click', () => {
  const saved = localStorage.getItem(KEYS.LC_SESSION);
  if (saved) {
    State.lc.session = JSON.parse(saved);
    if (!State.lc.session.notes) State.lc.session.notes = [];
    lcRenderChecklist();
    lcRenderNotes();
    showView('lc-session');
  }
});

document.getElementById('lc-btn-start-new')?.addEventListener('click', () => {
  const startNewLc = () => {
    State.lc.session = null;
    localStorage.removeItem(KEYS.LC_SESSION);
    document.getElementById('lc-btn-resume').classList.add('hidden');
    document.getElementById('lc-departure-time').value = formatTime();
    document.getElementById('lc-ticket-number').value = '';
    document.getElementById('lc-boat-name').value = '';
    document.getElementById('lc-supervisor-scanned').value = '';
    showView('lc-new');
  };

  const saved = localStorage.getItem(KEYS.LC_SESSION);
  if (saved) {
    openConfirmModal("You already have an active cruise report, Proceed", startNewLc);
  } else {
    startNewLc();
  }
});

document.getElementById('lc-departure-time')?.addEventListener('click', () => {
  openTimePicker(document.getElementById('lc-departure-time').value, (val) => {
    document.getElementById('lc-departure-time').value = val;
  });
});

document.getElementById('lc-btn-view-all')?.addEventListener('click', () => {
  lcRenderHistory();
  showView('lc-history');
});

document.getElementById('lc-btn-add-note')?.addEventListener('click', () => {
  openNoteModal('lc');
});

document.getElementById('lc-btn-confirm-start')?.addEventListener('click', () => {
  const depart = document.getElementById('lc-departure-time').value.trim();
  const ticket = document.getElementById('lc-ticket-number').value.trim();
  const boat = document.getElementById('lc-boat-name').value.trim();
  const sup = document.getElementById('lc-supervisor-scanned').value.trim();

  if (!depart || !ticket || !boat || !sup) {
    alert('Please fill in all fields.');
    return;
  }

  State.lc.session = {
    id: Date.now().toString(),
    depart, ticket, boat, supervisor: sup,
    items: {},
    notes: []
  };
  lcSaveSessionToStorage();

  lcRenderChecklist();
  lcRenderNotes();
  showView('lc-session');
});

function openMissingFieldsConfirmation(onProceed) {
  const modal = document.getElementById('missing-fields-modal');
  const btnYes = document.getElementById('btn-missing-fields-yes');
  const btnNo = document.getElementById('btn-missing-fields-no');
  
  if (!modal || !btnYes || !btnNo) {
    if (confirm("Missing Fields, Proceed Anyway?")) onProceed();
    return;
  }

  modal.classList.add('active');
  
  const cleanUp = () => {
    modal.classList.remove('active');
  };
  
  const newYes = btnYes.cloneNode(true);
  const newNo = btnNo.cloneNode(true);
  btnYes.replaceWith(newYes);
  btnNo.replaceWith(newNo);
  
  newYes.addEventListener('click', () => {
    cleanUp();
    onProceed();
  });
  
  newNo.addEventListener('click', () => {
    cleanUp();
  });
}

function lcFinalizeAndSaveReport(returnTime) {
  if (!State.lc.session) return;
  State.lc.session.returnTime = returnTime || '';
  const auditText = lcGenerateAuditText(State.lc.session);
  const title = `Liberty Cruise - ${State.lc.session.boat || 'Boat'} - ${State.lc.session.depart || ''}`;
  
  const savedReportObj = {
    id: State.lc.session.id || Date.now().toString(),
    timestamp: new Date().toLocaleString(),
    depart: State.lc.session.depart,
    returnTime: State.lc.session.returnTime,
    ticket: State.lc.session.ticket,
    boat: State.lc.session.boat,
    supervisor: State.lc.session.supervisor,
    items: State.lc.session.items || {},
    notes: State.lc.session.notes || [],
    auditText: auditText,
    title: title
  };

  if (!State.lc.savedReports) State.lc.savedReports = [];
  
  if (State.lc.editingSavedReportIndex !== null && State.lc.editingSavedReportIndex !== undefined && State.lc.editingSavedReportIndex >= 0) {
    State.lc.savedReports[State.lc.editingSavedReportIndex] = savedReportObj;
    State.lc.editingSavedReportIndex = null;
  } else {
    State.lc.savedReports.unshift(savedReportObj);
  }

  localStorage.setItem(KEYS.LC_REPORTS, JSON.stringify(State.lc.savedReports));
  updateStorageCount();

  State.lc.session = null;
  localStorage.removeItem(KEYS.LC_SESSION);
  checkLcResume();

  document.getElementById('report-viewer-modal').classList.remove('active');
  lcRenderHistory();
  showView('lc-dashboard');
}

document.getElementById('lc-btn-complete')?.addEventListener('click', () => {
  if (!State.lc.session) return;
  
  const items = State.lc.session.items || {};
  let unansweredCount = 0;
  LC_CHECKLIST_ITEMS.forEach(item => {
    const ans = items[item.id] ? items[item.id].answer : null;
    if (!ans || ans === '---') unansweredCount++;
  });

  let missingExtra = false;
  LC_CHECKLIST_ITEMS.forEach(item => {
    if (item.extraOn && items[item.id] && items[item.id].answer) {
      const ans = items[item.id].answer;
      const matches = Array.isArray(item.extraOn) ? item.extraOn.includes(ans) : ans === item.extraOn;
      if (matches && (!items[item.id].extra || !items[item.id].extra.trim())) {
        missingExtra = true;
      }
    }
  });

  if (unansweredCount > 0 || missingExtra) {
    openMissingFieldsConfirmation(() => {
      openTimePicker(formatTime(), (returnTime) => {
        lcFinalizeAndSaveReport(returnTime);
      });
    });
  } else {
    openTimePicker(formatTime(), (returnTime) => {
      lcFinalizeAndSaveReport(returnTime);
    });
  }
});

console.log("Topview Logger V10.0.0 operational.");
