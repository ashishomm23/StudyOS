/* ============================================================
   StudyOS — Student Dashboard
   All app logic: state management, rendering, localStorage, 
   Google Drive API sync engine, and onboarding automation
   ============================================================ */

/* ===================== STATE ===================== */

let state = {
  userName: '',        // Personalized onboarding field
  subjects: [],        // { id, name, code, color, present, absent, attendanceGoal }
  semesters: [],       // { id, label, sgpa, credits }
  tasks: [],           // { id, title, subjectId, type, dueDate, completed }
  todos: [],           // { id, text, done }
  plannerByDate: {},   // { 'YYYY-MM-DD': [ { id, time, activity } ] }
  notes: [],           // { id, title, content, updatedAt }
  achievements: [],    // { id, title, category, date }
  studyDocs: [],       // { id, title, subjectId, content, updatedAt, type:'document' }
  studyUploads: [],    // { id, name, dataUrl, mimeType, size, uploadedAt, subjectId }
  globalAttendanceGoal: 75,
  streak: { count: 0, lastVisit: null }
};

const STORAGE_KEY = 'studyos_data_v1';

/* ===================== CLOUD SYNC CONFIGURATION ===================== */
const GOOGLE_CLIENT_ID = "574648378648-9fg7bqi4jj4giuk737b02ocif642kg3i.apps.googleusercontent.com"; 
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const BACKUP_FILE_NAME = "study_os_cloud_sync.json";
const SIGNED_IN_FLAG_KEY = "studyos_drive_connected"; 

let codeClient = null; // Switched to code engine client
let googleAccessToken = null;
let cloudSyncStatus = 'idle'; 
let debounceSaveTimeout = null;

function initGoogleDriveAuth() {
  if (typeof window.google === 'undefined' || typeof window.google.accounts === 'undefined') {
    setTimeout(initGoogleDriveAuth, 500);
    return;
  }
  
  try {
    // Using initCodeClient instead of initTokenClient for cross-device state persistence
    codeClient = window.google.accounts.oauth2.initCodeClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      ux_mode: 'popup',
      callback: async (authResponse) => {
        if (authResponse.code) {
          // The authorization code can be safely cached or used to coordinate 
          // direct verification tokens.
          console.log("Authorization code received successfully.");
          localStorage.setItem(SIGNED_IN_FLAG_KEY, 'true');
          
          // For frontend-only architectures, request runtime implicit flow tokens 
          // dynamically while setting long-lived cross-device flags.
          switchToImplicitTokenFetch();
        }
      },
    });

    bindAuthButton();
    autoRestoreCloudSession();
  } catch (err) {
    console.error("Failed to initialize Google Auth client:", err);
  }
}

function bindAuthButton() {
  const authBtn = document.getElementById('googleDriveAuthBtn');
  if (authBtn) {
    authBtn.replaceWith(authBtn.cloneNode(true)); 
    document.getElementById('googleDriveAuthBtn').addEventListener('click', () => {
      if (codeClient) {
        codeClient.requestCode();
      } else {
        switchToImplicitTokenFetch(true);
      }
    });
  }
}

function switchToImplicitTokenFetch(forceConsent = false) {
  window.google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    prompt: forceConsent ? 'consent' : '',
    callback: async (tokenResponse) => {
      if (tokenResponse.access_token) {
        googleAccessToken = tokenResponse.access_token;
        localStorage.setItem(SIGNED_IN_FLAG_KEY, 'true');
        updateCloudUI('saved');
        await pullFromDrive();
      }
    }
  }).requestAccessToken();
}

function autoRestoreCloudSession() {
  if (localStorage.getItem(SIGNED_IN_FLAG_KEY) === 'true') {
    console.log("Restoring long-lived persistent cloud session across window parameters...");
    updateCloudUI('syncing');
    // Quietly wake up tracking tokens without an intrusive modal prompt interruption
    setTimeout(() => {
      switchToImplicitTokenFetch(false);
    }, 1000);
  }
}

/* ===================== UTILITIES ===================== */

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Local save wrapped with active debouncer cloud push engine
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    scheduleCloudSync();
  } catch(e) {
    try {
      const lightState = { ...state, studyUploads: state.studyUploads.map(u => ({ ...u, dataUrl: u.dataUrl })) };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(lightState));
      scheduleCloudSync();
    } catch(e2) {
      showToast('⚠️ Storage full — some data may not be saved locally.');
    }
  }
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    state = Object.assign({}, state, parsed);
    if (!state.plannerByDate) state.plannerByDate = {};
    if (!state.streak) state.streak = { count: 0, lastVisit: null };
    if (!state.studyDocs) state.studyDocs = [];
    if (!state.studyUploads) state.studyUploads = [];
    if (!state.userName) state.userName = '';
    if (state.globalAttendanceGoal === undefined) state.globalAttendanceGoal = 75;
    state.subjects.forEach(s => { if (s.attendanceGoal === undefined) s.attendanceGoal = null; });
  } catch (e) {
    console.error('Failed to parse saved data', e);
  }
}

let toastTimeout;
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 2200);
}

function formatDateInput(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDisplayDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function daysUntil(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

/* ===================== CLOUD SYNC ENGINE (GOOGLE DRIVE REST API v3) ===================== */

function updateCloudUI(status, msg = '') {
  cloudSyncStatus = status;
  const statusPill = document.getElementById('cloudStatusPill');
  const dot = document.getElementById('cloudStatusDot');
  const text = document.getElementById('cloudStatusText');
  const authBtn = document.getElementById('googleDriveAuthBtn');

  if (!googleAccessToken) {
    statusPill.classList.add('hidden');
    authBtn.classList.remove('hidden');
    return;
  }

  authBtn.classList.add('hidden');
  statusPill.classList.remove('hidden');
  dot.className = "cloud-status-dot " + status;

  switch(status) {
    case 'syncing': text.textContent = "Syncing with Drive..."; break;
    case 'saved': text.textContent = "Cloud Saved"; break;
    case 'pending': text.textContent = "Changes pending..."; break;
    case 'error': text.textContent = msg || "Sync Connection Error"; break;
    default: text.textContent = "Cloud Active";
  }
}

function initGoogleDriveAuth() {
  if (typeof window.google === 'undefined' || typeof window.google.accounts === 'undefined') {
    setTimeout(initGoogleDriveAuth, 500);
    return;
  }
  
  try {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      // Change prompt to 'none' for seamless background token acquisition
      prompt: localStorage.getItem(SIGNED_IN_FLAG_KEY) === 'true' ? '' : 'consent',
      callback: async (tokenResponse) => {
        if (tokenResponse.access_token) {
          googleAccessToken = tokenResponse.access_token;
          
          // Set our flag so the app remembers we are connected[cite: 2]
          localStorage.setItem(SIGNED_IN_FLAG_KEY, 'true'); 
          
          updateCloudUI('saved');
          await pullFromDrive();
        }
      },
      error_callback: (err) => {
        // If background renewal fails, clear flag and let user click manually
        if (err.error === 'immediate_failed') {
          localStorage.removeItem(SIGNED_IN_FLAG_KEY);
          updateCloudUI('idle');
        }
      }
    });

    const authBtn = document.getElementById('googleDriveAuthBtn');
    if (authBtn) {
      authBtn.replaceWith(authBtn.cloneNode(true)); 
      
      document.getElementById('googleDriveAuthBtn').addEventListener('click', () => {
        if (tokenClient) {
          // Force prompt consent on a manual user click interaction
          tokenClient.requestAccessToken({ prompt: 'consent' });
        } else {
          showToast("Google client initialization error. Check Client ID.");
        }
      });
    }

    // AUTO-LOGIN TRIGGER: If they logged in previously, request a token silently right now![cite: 2]
    if (localStorage.getItem(SIGNED_IN_FLAG_KEY) === 'true') {
      console.log("Restoring previous cloud sync session...");
      updateCloudUI('syncing');
      tokenClient.requestAccessToken({ hint: 'skip_prompt' });
    }

  } catch (err) {
    console.error("Failed to initialize Google Auth client:", err);
  }
}


  document.getElementById('googleDriveAuthBtn').addEventListener('click', () => {
    if (tokenClient) {
      tokenClient.requestAccessToken({ prompt: 'consent' });
    } else {
      showToast("Google client initialization error. Check Client ID.");
    }
  });


function scheduleCloudSync() {
  if (!googleAccessToken) return;
  updateCloudUI('pending');
  clearTimeout(debounceSaveTimeout);
  debounceSaveTimeout = setTimeout(pushToDrive, 2500); // 2.5 second delay debounce
}

async function pushToDrive() {
  if (!googleAccessToken) return;
  updateCloudUI('syncing');

  try {
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=name='${BACKUP_FILE_NAME}'+and+'appDataFolder'+in+parents&spaces=appDataFolder`;
    const searchRes = await fetch(searchUrl, { headers: { Authorization: `Bearer ${googleAccessToken}` } });
    const { files } = await searchRes.json();

    const metadata = { name: BACKUP_FILE_NAME, parents: ['appDataFolder'] };
    const formData = new FormData();
    formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    formData.append('file', new Blob([JSON.stringify(state)], { type: 'application/json' }));

    let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    let method = 'POST';

    if (files && files.length > 0) {
      url = `https://www.googleapis.com/upload/drive/v3/files/${files[0].id}?uploadType=multipart`;
      method = 'PATCH';
    }

    const uploadResponse = await fetch(url, {
      method: method,
      headers: { Authorization: `Bearer ${googleAccessToken}` },
      body: formData
    });

    if (uploadResponse.ok) {
      updateCloudUI('saved');
    } else {
      throw new Error("HTTP upload status error");
    }
  } catch (err) {
    console.error("Cloud synchronization push failure:", err);
    updateCloudUI('error', 'Cloud save failed');
  }
}

async function pullFromDrive() {
  if (!googleAccessToken) return;
  try {
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=name='${BACKUP_FILE_NAME}'+and+'appDataFolder'+in+parents&spaces=appDataFolder`;
    const response = await fetch(searchUrl, { headers: { Authorization: `Bearer ${googleAccessToken}` } });
    const { files } = await response.json();

    if (files && files.length > 0) {
      if(confirm("Cloud backup instance found on Google Drive. Do you want to restore it? (This replaces your local runtime state)")) {
        const downloadUrl = `https://www.googleapis.com/drive/v3/files/${files[0].id}?alt=media`;
        const fileResponse = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${googleAccessToken}` } });
        const remoteState = await fileResponse.json();
        
        state = Object.assign({}, state, remoteState);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        renderAll();
        checkOnboardingRequirement();
        showToast("Data pulled from Drive successfully! 🔄");
      }
    } else {
      showToast("No existing cloud backup found. Initializing a clean slot.");
      await pushToDrive();
    }
    updateCloudUI('saved');
  } catch (err) {
    console.error("Cloud data fetch pull failure:", err);
    updateCloudUI('error', 'Cloud sync import failed');
  }
}

/* ===================== EXPLICIT UNLOAD GUARD LOCK ===================== */
window.addEventListener('beforeunload', (e) => {
  if (cloudSyncStatus === 'pending' || cloudSyncStatus === 'syncing') {
    e.preventDefault();
    e.returnValue = 'Your latest updates are still syncing with Google Drive. Are you sure you want to leave?';
  }
});

/* ===================== PERSONALIZED ONBOARDING FLOW ===================== */

function checkOnboardingRequirement() {
  const onboardingOverlay = document.getElementById('onboardingOverlay');
  if (!state.userName || state.userName.trim() === '') {
    onboardingOverlay.classList.remove('hidden');
  } else {
    onboardingOverlay.classList.add('hidden');
    updateGreetingDisplay();
  }
}

function updateGreetingDisplay() {
  const greetingEl = document.getElementById('welcomeGreeting');
  if (state.userName && state.userName.trim() !== '') {
    greetingEl.textContent = `Welcome back, ${state.userName}! 👋`;
  } else {
    greetingEl.textContent = 'Welcome back 👋';
  }
}

function initOnboardingFlow() {
  const submitBtn = document.getElementById('onboardingSubmitBtn');
  const nameInput = document.getElementById('onboardingNameInput');

  submitBtn.addEventListener('click', () => {
    const enteredName = nameInput.value.trim();
    if (!enteredName) {
      showToast("Please enter a valid name to proceed!");
      return;
    }
    state.userName = enteredName;
    saveState();
    document.getElementById('onboardingOverlay').classList.add('hidden');
    updateGreetingDisplay();
    showToast(`Welcome aboard, ${state.userName}! 🎉`);
  });

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitBtn.click();
  });
}

/* ===================== STREAK TRACKING ===================== */

function updateStreak() {
  const today = formatDateInput(new Date());
  if (!state.streak.lastVisit) {
    state.streak = { count: 1, lastVisit: today };
  } else if (state.streak.lastVisit === today) {
    // Stalls cycle logic out
  } else {
    const last = new Date(state.streak.lastVisit);
    const diffDays = Math.round((new Date(today) - last) / (1000 * 60 * 60 * 24));
    if (diffDays === 1) {
      state.streak.count += 1;
    } else {
      state.streak.count = 1;
    }
    state.streak.lastVisit = today;
  }
  saveState();
  document.getElementById('streakCount').textContent = state.streak.count;
}

/* ===================== SIDEBAR / NAVIGATION ===================== */

function initNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const pages = document.querySelectorAll('.page');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const target = item.dataset.section;

      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');

      pages.forEach(p => p.classList.remove('active'));
      document.getElementById(`page-${target}`).classList.add('active');

      document.getElementById('sidebar').classList.remove('mobile-open');
      document.getElementById('sidebarOverlay').classList.remove('show');
    });
  });

  document.getElementById('collapseBtn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
  });

  document.getElementById('mobileMenuBtn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('mobile-open');
    document.getElementById('sidebarOverlay').classList.add('show');
  });

  document.getElementById('sidebarOverlay').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('mobile-open');
    document.getElementById('sidebarOverlay').classList.remove('show');
  });
}

/* ===================== TOP BAR (date + search) ===================== */

function initTopbar() {
  const dateEl = document.getElementById('todayDate');
  dateEl.textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long'
  });

  const input = document.getElementById('globalSearch');
  const dropdown = document.getElementById('searchDropdown');
  const clearBtn = document.getElementById('searchClear');

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearBtn.classList.toggle('hidden', !q);
    if (!q) { closeSearchDropdown(); return; }
    renderSearchDropdown(q);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { clearSearch(); }
  });

  clearBtn.addEventListener('click', clearSearch);

  document.addEventListener('click', e => {
    if (!document.getElementById('searchWrap').contains(e.target)) {
      closeSearchDropdown();
    }
  });
}

function clearSearch() {
  document.getElementById('globalSearch').value = '';
  document.getElementById('searchClear').classList.add('hidden');
  closeSearchDropdown();
}

function closeSearchDropdown() {
  const dd = document.getElementById('searchDropdown');
  dd.classList.add('hidden');
  dd.innerHTML = '';
}

function buildSearchIndex() {
  const results = [];

  state.subjects.forEach(s => {
    results.push({
      label: s.name,
      sub: s.code || 'Subject',
      icon: '📚',
      section: 'subjects',
      id: s.id
    });
  });

  state.tasks.forEach(t => {
    const subj = state.subjects.find(s => s.id === t.subjectId);
    results.push({
      label: t.title,
      sub: `${t.type} · ${subj ? subj.name : 'No subject'} · due ${formatDisplayDate(t.dueDate)}`,
      icon: t.type === 'exam' ? '📝' : t.type === 'project' ? '🗂️' : '✏️',
      section: 'tasks',
      id: t.id
    });
  });

  state.notes.forEach(n => {
    results.push({
      label: n.title || 'Untitled note',
      sub: n.content ? n.content.replace(/<[^>]*>/g, '').slice(0, 60) : '',
      icon: '🗒️',
      section: 'notes',
      id: n.id
    });
  });

  state.studyDocs.forEach(d => {
    results.push({
      label: d.title || 'Untitled Document',
      sub: 'Study document · ' + new Date(d.updatedAt).toLocaleDateString(),
      icon: '📄',
      section: 'studymaterial',
      id: d.id
    });
  });

  state.studyUploads.forEach(u => {
    const subjU = state.subjects.find(s => s.id === u.subjectId);
    results.push({
      label: u.name,
      sub: 'Uploaded file · ' + formatBytes(u.size) + (subjU ? ' · ' + subjU.name : ''),
      icon: getFileIcon(u.mimeType),
      section: 'studymaterial',
      id: u.id,
      isUpload: true
    });
  });

  state.achievements.forEach(a => {
    results.push({
      label: a.title,
      sub: ACHIEVEMENT_LABELS[a.category] || 'Achievement',
      icon: ACHIEVEMENT_ICONS[a.category] || '⭐',
      section: 'achievements',
      id: a.id
    });
  });

  state.todos.forEach(t => {
    results.push({
      label: t.text,
      sub: t.done ? 'To-do · done' : 'To-do · pending',
      icon: t.done ? '✅' : '⬜',
      section: 'todo',
      id: t.id
    });
  });

  return results;
}

function renderSearchDropdown(query) {
  const q = query.toLowerCase();
  const dropdown = document.getElementById('searchDropdown');
  const index = buildSearchIndex();

  const matches = index.filter(item =>
    item.label.toLowerCase().includes(q) ||
    (item.sub && item.sub.toLowerCase().includes(q))
  ).slice(0, 8);

  dropdown.innerHTML = '';

  if (matches.length === 0) {
    dropdown.innerHTML = `<div class="search-no-results">No results for "<strong>${escapeHtml(query)}</strong>"</div>`;
    dropdown.classList.remove('hidden');
    return;
  }

  matches.forEach(item => {
    const el = document.createElement('button');
    el.className = 'search-result-item';

    const highlighted = item.label.replace(
      new RegExp(`(${escapeRegex(query)})`, 'gi'),
      '<mark>$1</mark>'
    );

    el.innerHTML = `
      <span class="sr-icon">${item.icon}</span>
      <span class="sr-body">
        <span class="sr-label">${highlighted}</span>
        <span class="sr-sub">${escapeHtml(item.sub)}</span>
      </span>
      <span class="sr-section">${sectionLabel(item.section)}</span>
    `;

    el.addEventListener('click', () => {
      navigateToSection(item.section);
      clearSearch();
      if (item.section === 'studymaterial') {
        setTimeout(() => {
          if (item.isUpload) openUpload(item.id);
          else openDoc(item.id);
        }, 80);
      }
    });

    dropdown.appendChild(el);
  });

  dropdown.classList.remove('hidden');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sectionLabel(section) {
  const map = {
    dashboard: 'Dashboard', subjects: 'Subjects', attendance: 'Attendance',
    cgpa: 'CGPA', tasks: 'Tasks', todo: 'To-Do', notes: 'Notes',
    achievements: 'Achievements', studymaterial: 'Study Material'
  };
  return map[section] || section;
}

function navigateToSection(section) {
  const navItem = document.querySelector(`.nav-item[data-section="${section}"]`);
  if (navItem) navItem.click();
}

/* ============================================================
   SUBJECT MANAGER
   ============================================================ */

function initSubjectManager() {
  const formCard = document.getElementById('subjectFormCard');
  const nameInput = document.getElementById('subjectName');
  const codeInput = document.getElementById('subjectCode');
  const colorInput = document.getElementById('subjectColor');
  const editingIdInput = document.getElementById('editingSubjectId');
  const formTitle = document.getElementById('subjectFormTitle');

  document.getElementById('addSubjectBtn').addEventListener('click', () => {
    editingIdInput.value = '';
    nameInput.value = '';
    codeInput.value = '';
    colorInput.value = '#6ee7b7';
    formTitle.textContent = 'New Subject';
    formCard.classList.remove('hidden');
    nameInput.focus();
  });

  document.getElementById('cancelSubjectBtn').addEventListener('click', () => {
    formCard.classList.add('hidden');
  });

  document.getElementById('saveSubjectBtn').addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) {
      showToast('Please enter a subject name');
      return;
    }

    const editingId = editingIdInput.value;

    if (editingId) {
      const subject = state.subjects.find(s => s.id === editingId);
      if (subject) {
        subject.name = name;
        subject.code = codeInput.value.trim();
        subject.color = colorInput.value;
      }
      showToast('Subject updated');
    } else {
      const newSubject = {
        id: genId(),
        name: name,
        code: codeInput.value.trim(),
        color: colorInput.value,
        present: 0,
        absent: 0,
        attendanceGoal: null   
      };
      state.subjects.push(newSubject);
      showToast('Subject added');
    }

    saveState();
    formCard.classList.add('hidden');
    renderAll();
  });
}

function editSubject(id) {
  const subject = state.subjects.find(s => s.id === id);
  if (!subject) return;

  document.getElementById('editingSubjectId').value = subject.id;
  document.getElementById('subjectName').value = subject.name;
  document.getElementById('subjectCode').value = subject.code || '';
  document.getElementById('subjectColor').value = subject.color || '#6ee7b7';
  document.getElementById('subjectFormTitle').textContent = 'Edit Subject';

  const formCard = document.getElementById('subjectFormCard');
  formCard.classList.remove('hidden');
  formCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function deleteSubject(id) {
  if (!confirm('Delete this subject? This will also remove its attendance data and linked tasks.')) return;
  state.subjects = state.subjects.filter(s => s.id !== id);
  state.tasks = state.tasks.filter(t => t.subjectId !== id);
  saveState();
  renderAll();
  showToast('Subject deleted');
}

function renderSubjects() {
  const grid = document.getElementById('subjectGrid');
  const emptyHint = document.getElementById('subjectsEmpty');
  grid.innerHTML = '';

  if (state.subjects.length === 0) {
    emptyHint.classList.remove('hidden');
    return;
  }
  emptyHint.classList.add('hidden');

  state.subjects.forEach(subject => {
    const total = subject.present + subject.absent;
    const pct = total > 0 ? Math.round((subject.present / total) * 100) : 0;

    const card = document.createElement('div');
    card.className = 'subject-card';
    card.style.setProperty('--card-color', subject.color || '#6ee7b7');
    card.dataset.search = `${subject.name} ${subject.code || ''}`.toLowerCase();

    card.innerHTML = `
      <div class="subject-card-head">
        <div>
          <div class="subject-card-title">${escapeHtml(subject.name)}</div>
          <div class="subject-card-code">${escapeHtml(subject.code || 'No code')}</div>
        </div>
        <div class="subject-card-actions">
          <button class="icon-btn" data-action="edit" title="Edit subject">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
          </button>
          <button class="icon-btn danger" data-action="delete" title="Delete subject">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>
          </button>
        </div>
      </div>
      <div class="subject-stats">
        <div class="subject-stat">
          <span class="num">${pct}%</span>
          <span class="lbl">Attendance</span>
        </div>
        <div class="subject-stat">
          <span class="num">${subject.present}</span>
          <span class="lbl">Present</span>
        </div>
        <div class="subject-stat">
          <span class="num">${subject.absent}</span>
          <span class="lbl">Absent</span>
        </div>
      </div>
    `;

    card.querySelector('[data-action="edit"]').addEventListener('click', () => editSubject(subject.id));
    card.querySelector('[data-action="delete"]').addEventListener('click', () => deleteSubject(subject.id));

    grid.appendChild(card);
  });
}

/* ============================================================
   ATTENDANCE TRACKER
   ============================================================ */

const lastAttendanceAction = {};

function getSubjectGoal(subject) {
  return (subject.attendanceGoal !== null && subject.attendanceGoal !== undefined)
    ? subject.attendanceGoal
    : state.globalAttendanceGoal;
}

function initAttendanceGoal() {
  const globalInput = document.getElementById('globalAttendanceGoal');
  globalInput.value = state.globalAttendanceGoal;
  globalInput.addEventListener('change', () => {
    const val = Math.min(100, Math.max(1, parseInt(globalInput.value) || 75));
    globalInput.value = val;
    state.globalAttendanceGoal = val;
    saveState();
    renderAttendance();
  });
}

function getAttendanceGoalInfo(present, total, targetPct) {
  const target = targetPct / 100;
  if (total === 0) return { type: 'none' };
  const currentPct = present / total;

  if (Math.abs(currentPct - target) < 1e-9) return { type: 'exact' };

  if (currentPct < target) {
    const x = Math.ceil((target * total - present) / (1 - target));
    return { type: 'need', count: Math.max(x, 1) };
  }

  const y = Math.floor(present / target - total);
  return { type: 'can-skip', count: Math.max(y, 0) };
}

function renderAttendanceGoalMessage(present, absent, targetPct) {
  const total = present + absent;
  const info = getAttendanceGoalInfo(present, total, targetPct);

  if (info.type === 'none') {
    return `<div class="attendance-goal-msg goal-neutral">📌 Mark your first class to see progress toward ${targetPct}%.</div>`;
  }
  if (info.type === 'exact') {
    return `<div class="attendance-goal-msg goal-ok">🎯 Exactly at ${targetPct}% — attend your next class to stay safe!</div>`;
  }
  if (info.type === 'need') {
    const w = info.count === 1 ? 'class' : 'classes';
    return `<div class="attendance-goal-msg goal-warning">⚠️ Attend the next <strong>${info.count}</strong> ${w} in a row to reach ${targetPct}%.</div>`;
  }
  if (info.count === 0) {
    return `<div class="attendance-goal-msg goal-ok">✅ Right at ${targetPct}% — one more absence and you're under!</div>`;
  }
  const w = info.count === 1 ? 'class' : 'classes';
  return `<div class="attendance-goal-msg goal-ok">✅ You can bunk <strong>${info.count}</strong> more ${w} and stay above ${targetPct}%.</div>`;
}

function renderAttendance() {
  const grid = document.getElementById('attendanceGrid');
  const emptyHint = document.getElementById('attendanceEmpty');
  grid.innerHTML = '';

  if (state.subjects.length === 0) {
    emptyHint.classList.remove('hidden');
    return;
  }
  emptyHint.classList.add('hidden');

  state.subjects.forEach(subject => {
    const total = subject.present + subject.absent;
    const pct = total > 0 ? Math.round((subject.present / total) * 100) : 0;
    const goal = getSubjectGoal(subject);

    const radius = 28;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (pct / 100) * circumference;

    let ringColor = '#6ee7b7'; 
    if (pct < goal && pct >= goal - 15) ringColor = '#fbbf24'; 
    if (pct < goal - 15) ringColor = '#fb7185'; 

    const card = document.createElement('div');
    card.className = 'attendance-card';
    card.dataset.search = `${subject.name} ${subject.code || ''}`.toLowerCase();

    card.innerHTML = `
      <div class="attendance-card-head">
        <div class="ring-wrap">
          <svg width="64" height="64" viewBox="0 0 64 64">
            <circle class="ring-bg" cx="32" cy="32" r="${radius}"></circle>
            <circle class="ring-progress" cx="32" cy="32" r="${radius}"
              stroke="${ringColor}"
              stroke-dasharray="${circumference}"
              stroke-dashoffset="${total > 0 ? offset : circumference}"></circle>
          </svg>
          <div class="ring-label">${pct}%</div>
        </div>
        <div>
          <div class="attendance-card-title">${escapeHtml(subject.name)}</div>
          <div class="attendance-card-sub">${escapeHtml(subject.code || 'No code')}</div>
        </div>
      </div>

      <div class="attendance-counts">
        <span>Present: <strong>${subject.present}</strong></span>
        <span>Absent: <strong>${subject.absent}</strong></span>
        <span>Total: <strong>${total}</strong></span>
      </div>

      <div class="attendance-goal-row">
        <label class="attendance-goal-label">Goal</label>
        <div class="attendance-goal-input-wrap">
          <input type="number" class="attendance-goal-input" min="1" max="100"
            value="${goal}" data-subjectid="${subject.id}" />
          <span>%</span>
        </div>
        ${subject.attendanceGoal !== null ? `<button class="attendance-goal-reset-btn" data-action="resetgoal" title="Reset to global default">↺ global</button>` : `<span class="attendance-goal-using-global">using global</span>`}
      </div>

      <div class="attendance-actions">
        <button class="btn btn-present" data-action="present">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
          Present
        </button>
        <button class="btn btn-absent" data-action="absent">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          Absent
        </button>
      </div>

      ${lastAttendanceAction[subject.id] ? `
      <button class="attendance-undo" data-action="undo">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>
        Undo last "${lastAttendanceAction[subject.id]}" entry
      </button>` : ''}

      <button class="attendance-reset" data-action="reset">Reset attendance for this subject</button>

      ${renderAttendanceGoalMessage(subject.present, subject.absent, goal)}
    `;

    const goalInput = card.querySelector('.attendance-goal-input');
    goalInput.addEventListener('change', () => {
      const val = Math.min(100, Math.max(1, parseInt(goalInput.value) || state.globalAttendanceGoal));
      goalInput.value = val;
      subject.attendanceGoal = val;
      saveState();
      renderAttendance();
    });

    const resetGoalBtn = card.querySelector('[data-action="resetgoal"]');
    if (resetGoalBtn) {
      resetGoalBtn.addEventListener('click', () => {
        subject.attendanceGoal = null;
        saveState();
        renderAttendance();
      });
    }

    card.querySelector('[data-action="present"]').addEventListener('click', () => markAttendance(subject.id, 'present'));
    card.querySelector('[data-action="absent"]').addEventListener('click', () => markAttendance(subject.id, 'absent'));
    card.querySelector('[data-action="reset"]').addEventListener('click', () => resetAttendance(subject.id));

    const undoBtn = card.querySelector('[data-action="undo"]');
    if (undoBtn) undoBtn.addEventListener('click', () => undoAttendance(subject.id));

    grid.appendChild(card);
  });
}

function markAttendance(subjectId, type) {
  const subject = state.subjects.find(s => s.id === subjectId);
  if (!subject) return;

  if (type === 'present') subject.present += 1;
  else subject.absent += 1;

  lastAttendanceAction[subjectId] = type;

  saveState();
  renderAttendance();
  renderDashboard(); 
  renderSubjects();  
}

function undoAttendance(subjectId) {
  const subject = state.subjects.find(s => s.id === subjectId);
  const lastType = lastAttendanceAction[subjectId];
  if (!subject || !lastType) return;

  if (lastType === 'present' && subject.present > 0) subject.present -= 1;
  else if (lastType === 'absent' && subject.absent > 0) subject.absent -= 1;

  delete lastAttendanceAction[subjectId];

  saveState();
  renderAttendance();
  renderDashboard();
  renderSubjects();
  showToast('Last entry undone');
}

function resetAttendance(subjectId) {
  if (!confirm('Reset attendance counts for this subject to zero?')) return;
  const subject = state.subjects.find(s => s.id === subjectId);
  if (!subject) return;

  subject.present = 0;
  subject.absent = 0;

  delete lastAttendanceAction[subjectId];

  saveState();
  renderAttendance();
  renderDashboard();
  renderSubjects();
  showToast('Attendance reset');
}

/* ============================================================
   CGPA CALCULATOR
   ============================================================ */

function initCgpaCalculator() {
  document.getElementById('addSemesterBtn').addEventListener('click', () => {
    const semNumber = state.semesters.length + 1;
    state.semesters.push({
      id: genId(),
      label: `Semester ${semNumber}`,
      sgpa: 0,
      credits: 0
    });
    saveState();
    renderCgpa();
    renderDashboard();
  });
}

function renderCgpa() {
  const tbody = document.getElementById('semesterTableBody');
  const emptyHint = document.getElementById('semestersEmpty');
  const countTag = document.getElementById('semesterCountTag');
  tbody.innerHTML = '';

  countTag.textContent = `${state.semesters.length} semester${state.semesters.length === 1 ? '' : 's'}`;

  if (state.semesters.length === 0) {
    emptyHint.classList.remove('hidden');
  } else {
    emptyHint.classList.add('hidden');
  }

  state.semesters.forEach(sem => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>
        <input type="text" value="${escapeHtml(sem.label)}" data-field="label" />
      </td>
      <td>
        <input type="number" min="0" max="10" step="0.01" value="${sem.sgpa}" data-field="sgpa" />
      </td>
      <td>
        <input type="number" min="0" step="1" value="${sem.credits}" data-field="credits" />
      </td>
      <td>
        <button class="icon-btn danger" title="Remove semester">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path></svg>
        </button>
      </td>
    `;

    row.querySelectorAll('input').forEach(input => {
      input.addEventListener('input', () => {
        const field = input.dataset.field;
        if (field === 'label') {
          sem.label = input.value;
        } else {
          sem.sgpa = field === 'sgpa' ? parseFloat(input.value) || 0 : sem.sgpa;
          sem.credits = field === 'credits' ? parseFloat(input.value) || 0 : sem.credits;
        }
        saveState();
        recalcCgpaOnly();
        renderDashboard();
      });
    });

    row.querySelector('.icon-btn.danger').addEventListener('click', () => {
      state.semesters = state.semesters.filter(s => s.id !== sem.id);
      saveState();
      renderCgpa();
      renderDashboard();
    });

    tbody.appendChild(row);
  });

  recalcCgpaOnly();
}

function recalcCgpaOnly() {
  let totalCredits = 0;
  let weightedSum = 0;

  state.semesters.forEach(sem => {
    totalCredits += sem.credits;
    weightedSum += sem.sgpa * sem.credits;
  });

  const cgpa = totalCredits > 0 ? (weightedSum / totalCredits) : 0;
  document.getElementById('cgpaResult').textContent = cgpa.toFixed(2);

  const pct = Math.min(100, (cgpa / 10) * 100);
  document.getElementById('cgpaBarFill').style.width = `${pct}%`;
}

/* ============================================================
   ASSIGNMENTS & EXAMS
   ============================================================ */

let currentTaskFilter = 'all';

function initTaskTracker() {
  const formCard = document.getElementById('taskFormCard');

  document.getElementById('addTaskBtn').addEventListener('click', () => {
    populateTaskSubjectSelect();
    document.getElementById('taskTitle').value = '';
    document.getElementById('taskDueDate').value = formatDateInput(new Date());
    document.getElementById('taskType').value = 'assignment';
    formCard.classList.remove('hidden');
    document.getElementById('taskTitle').focus();
  });

  document.getElementById('cancelTaskBtn').addEventListener('click', () => {
    formCard.classList.add('hidden');
  });

  document.getElementById('saveTaskBtn').addEventListener('click', () => {
    const title = document.getElementById('taskTitle').value.trim();
    const dueDate = document.getElementById('taskDueDate').value;

    if (!title || !dueDate) {
      showToast('Please enter a title and due date');
      return;
    }

    state.tasks.push({
      id: genId(),
      title: title,
      subjectId: document.getElementById('taskSubjectSelect').value || null,
      type: document.getElementById('taskType').value,
      dueDate: dueDate,
      completed: false
    });

    saveState();
    formCard.classList.add('hidden');
    renderTasks();
    renderDashboard();
    showToast('Item added');
  });

  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentTaskFilter = chip.dataset.filter;
      renderTasks();
    });
  });
}

function populateTaskSubjectSelect() {
  const select = document.getElementById('taskSubjectSelect');
  select.innerHTML = '<option value="">No subject</option>';
  state.subjects.forEach(subject => {
    const opt = document.createElement('option');
    opt.value = subject.id;
    opt.textContent = subject.name;
    select.appendChild(opt);
  });
}

function toggleTask(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  task.completed = !task.completed;
  saveState();
  renderTasks();
  renderDashboard();
}

function deleteTask(id) {
  state.tasks = state.tasks.filter(t => t.id !== id);
  saveState();
  renderTasks();
  renderDashboard();
}

function renderTasks() {
  const list = document.getElementById('taskList');
  const emptyHint = document.getElementById('tasksEmpty');
  list.innerHTML = '';

  let filtered = state.tasks.slice();

  if (currentTaskFilter === 'pending') filtered = filtered.filter(t => !t.completed);
  else if (currentTaskFilter === 'completed') filtered = filtered.filter(t => t.completed);
  else if (['assignment', 'exam', 'project'].includes(currentTaskFilter)) {
    filtered = filtered.filter(t => t.type === currentTaskFilter);
  }

  filtered.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  if (filtered.length === 0) {
    emptyHint.classList.remove('hidden');
    emptyHint.textContent = state.tasks.length === 0
      ? 'No assignments or exams added yet.'
      : 'Nothing matches this filter.';
  } else {
    emptyHint.classList.add('hidden');
  }

  filtered.forEach(task => {
    const subject = state.subjects.find(s => s.id === task.subjectId);
    const diff = daysUntil(task.dueDate);

    let dueClass = '';
    let dueLabel = formatDisplayDate(task.dueDate);
    if (!task.completed) {
      if (diff < 0) { dueClass = 'due-overdue'; dueLabel += ' (Overdue)'; }
      else if (diff === 0) { dueClass = 'due-soon'; dueLabel += ' (Today)'; }
      else if (diff <= 3) { dueClass = 'due-soon'; dueLabel += ` (${diff}d left)`; }
    }

    const item = document.createElement('div');
    item.className = `task-item${task.completed ? ' completed' : ''}`;
    item.dataset.search = `${task.title} ${subject ? subject.name : ''} ${task.type}`.toLowerCase();

    item.innerHTML = `
      <div class="task-checkbox${task.completed ? ' checked' : ''}" data-action="toggle">
        ${task.completed ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}
      </div>
      <div class="task-body">
        <div class="task-title">${escapeHtml(task.title)}</div>
        <div class="task-meta">
          <span class="task-type-tag type-${task.type}">${task.type}</span>
          ${subject ? `<span>${escapeHtml(subject.name)}</span>` : ''}
          <span class="${dueClass}">Due ${dueLabel}</span>
        </div>
      </div>
      <div class="task-actions">
        <button class="icon-btn danger" data-action="delete" title="Delete">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path></svg>
        </button>
      </div>
    `;

    item.querySelector('[data-action="toggle"]').addEventListener('click', () => toggleTask(task.id));
    item.querySelector('[data-action="delete"]').addEventListener('click', () => deleteTask(task.id));

    list.appendChild(item);
  });
}

/* ============================================================
   TO-DO LIST & DAILY PLANNER
   ============================================================ */

function initTodoAndPlanner() {
  document.getElementById('addTodoBtn').addEventListener('click', addTodo);
  document.getElementById('todoInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') addTodo();
  });

  document.getElementById('plannerDate').value = formatDateInput(new Date());
  document.getElementById('addPlannerBtn').addEventListener('click', addPlannerItem);
  document.getElementById('plannerActivity').addEventListener('keydown', e => {
    if (e.key === 'Enter') addPlannerItem();
  });
  document.getElementById('plannerDate').addEventListener('change', renderPlanner);
}

function addTodo() {
  const input = document.getElementById('todoInput');
  const text = input.value.trim();
  if (!text) return;

  state.todos.push({ id: genId(), text: text, done: false });
  saveState();
  input.value = '';
  renderTodos();
}

function toggleTodo(id) {
  const todo = state.todos.find(t => t.id === id);
  if (!todo) return;
  todo.done = !todo.done;
  saveState();
  renderTodos();
}

function deleteTodo(id) {
  state.todos = state.todos.filter(t => t.id !== id);
  saveState();
  renderTodos();
}

function renderTodos() {
  const list = document.getElementById('todoList');
  const emptyHint = document.getElementById('todoEmpty');
  const countTag = document.getElementById('todoCountTag');
  list.innerHTML = '';

  const pending = state.todos.filter(t => !t.done).length;
  countTag.textContent = `${pending} pending`;

  if (state.todos.length === 0) {
    emptyHint.classList.remove('hidden');
    return;
  }
  emptyHint.classList.add('hidden');

  state.todos.forEach(todo => {
    const li = document.createElement('li');
    li.className = `todo-item${todo.done ? ' done' : ''}`;
    li.innerHTML = `
      <div class="task-checkbox${todo.done ? ' checked' : ''}" data-action="toggle">
        ${todo.done ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}
      </div>
      <span class="todo-text">${escapeHtml(todo.text)}</span>
      <button class="icon-btn danger" data-action="delete" title="Delete">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    `;

    li.querySelector('[data-action="toggle"]').addEventListener('click', () => toggleTodo(todo.id));
    li.querySelector('[data-action="delete"]').addEventListener('click', () => deleteTodo(todo.id));

    list.appendChild(li);
  });
}

function addPlannerItem() {
  const dateInput = document.getElementById('plannerDate');
  const timeInput = document.getElementById('plannerTime');
  const activityInput = document.getElementById('plannerActivity');

  const date = dateInput.value || formatDateInput(new Date());
  const time = timeInput.value || '00:00';
  const activity = activityInput.value.trim();

  if (!activity) return;

  if (!state.plannerByDate[date]) state.plannerByDate[date] = [];
  state.plannerByDate[date].push({ id: genId(), time, activity });

  saveState();
  activityInput.value = '';
  renderPlanner();
  renderDashboard();
}

function deletePlannerItem(date, id) {
  state.plannerByDate[date] = (state.plannerByDate[date] || []).filter(p => p.id !== id);
  saveState();
  renderPlanner();
  renderDashboard();
}

function renderPlanner() {
  const date = document.getElementById('plannerDate').value || formatDateInput(new Date());
  const list = document.getElementById('plannerList');
  const emptyHint = document.getElementById('plannerEmpty');
  list.innerHTML = '';

  const items = (state.plannerByDate[date] || []).slice().sort((a, b) => a.time.localeCompare(b.time));

  if (items.length === 0) {
    emptyHint.classList.remove('hidden');
    return;
  }
  emptyHint.classList.add('hidden');

  items.forEach(item => {
    const li = document.createElement('li');
    li.className = 'planner-item';
    li.innerHTML = `
      <span class="planner-time">${item.time}</span>
      <span class="planner-text">${escapeHtml(item.activity)}</span>
      <button class="icon-btn danger" data-action="delete" title="Delete">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    `;
    li.querySelector('[data-action="delete"]').addEventListener('click', () => deletePlannerItem(date, item.id));
    list.appendChild(li);
  });
}

/* ============================================================
   NOTES
   ============================================================ */

function initNotes() {
  document.getElementById('addNoteBtn').addEventListener('click', () => {
    state.notes.unshift({
      id: genId(),
      title: 'Untitled note',
      content: '',
      updatedAt: Date.now()
    });
    saveState();
    renderNotes();
  });
}

function updateNote(id, field, value) {
  const note = state.notes.find(n => n.id === id);
  if (!note) return;
  note[field] = value;
  note.updatedAt = Date.now();
  saveState();
}

function deleteNote(id) {
  state.notes = state.notes.filter(n => n.id !== id);
  saveState();
  renderNotes();
}

function renderNotes() {
  const grid = document.getElementById('notesGrid');
  const emptyHint = document.getElementById('notesEmpty');
  grid.innerHTML = '';

  if (state.notes.length === 0) {
    emptyHint.classList.remove('hidden');
    return;
  }
  emptyHint.classList.add('hidden');

  state.notes.forEach(note => {
    const card = document.createElement('div');
    card.className = 'note-card';
    card.dataset.search = `${note.title} ${note.content}`.toLowerCase();

    card.innerHTML = `
      <input type="text" value="${escapeHtml(note.title)}" data-field="title" placeholder="Note title" />
      <textarea data-field="content" placeholder="Write your note here...">${escapeHtml(note.content)}</textarea>
      <div class="note-card-foot">
        <span>Updated ${new Date(note.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
        <button class="icon-btn danger" data-action="delete" title="Delete note">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path></svg>
        </button>
      </div>
    `;

    const titleInput = card.querySelector('[data-field="title"]');
    const contentInput = card.querySelector('[data-field="content"]');

    titleInput.addEventListener('input', () => {
      updateNote(note.id, 'title', titleInput.value);
      card.dataset.search = `${titleInput.value} ${contentInput.value}`.toLowerCase();
    });
    contentInput.addEventListener('input', () => {
      updateNote(note.id, 'content', contentInput.value);
      card.dataset.search = `${titleInput.value} ${contentInput.value}`.toLowerCase();
    });

    card.querySelector('[data-action="delete"]').addEventListener('click', () => deleteNote(note.id));

    grid.appendChild(card);
  });
}

/* ============================================================
   ACHIEVEMENTS
   ============================================================ */

const ACHIEVEMENT_ICONS = {
  'distinction': '🏅', 'first-class': '🥇', 'second-class': '🥈',
  'gold-medal': '🏆', 'scholarship': '🎓', 'other': '⭐'
};

const ACHIEVEMENT_LABELS = {
  'distinction': 'Distinction', 'first-class': 'First Class', 'second-class': 'Second Class',
  'gold-medal': 'Gold Medal', 'scholarship': 'Scholarship', 'other': 'Other'
};

function initAchievements() {
  const formCard = document.getElementById('achievementFormCard');

  document.getElementById('addAchievementBtn').addEventListener('click', () => {
    document.getElementById('achievementTitle').value = '';
    document.getElementById('achievementCategory').value = 'distinction';
    document.getElementById('achievementDate').value = formatDateInput(new Date());
    formCard.classList.remove('hidden');
    document.getElementById('achievementTitle').focus();
  });

  document.getElementById('cancelAchievementBtn').addEventListener('click', () => {
    formCard.classList.add('hidden');
  });

  document.getElementById('saveAchievementBtn').addEventListener('click', () => {
    const title = document.getElementById('achievementTitle').value.trim();
    if (!title) {
      showToast('Please enter a title');
      return;
    }

    state.achievements.unshift({
      id: genId(),
      title: title,
      category: document.getElementById('achievementCategory').value,
      date: document.getElementById('achievementDate').value || formatDateInput(new Date())
    });

    saveState();
    formCard.classList.add('hidden');
    renderAchievements();
    renderDashboard();
    showToast('Achievement added 🎉');
  });
}

function deleteAchievement(id) {
  state.achievements = state.achievements.filter(a => a.id !== id);
  saveState();
  renderAchievements();
  renderDashboard();
}

function renderAchievements() {
  const grid = document.getElementById('achievementGrid');
  const emptyHint = document.getElementById('achievementsEmpty');
  grid.innerHTML = '';

  if (state.achievements.length === 0) {
    emptyHint.classList.remove('hidden');
    return;
  }
  emptyHint.classList.add('hidden');

  state.achievements.forEach(ach => {
    const card = document.createElement('div');
    card.className = 'achievement-card';

    card.innerHTML = `
      <div class="achievement-icon cat-${ach.category}">${ACHIEVEMENT_ICONS[ach.category] || '⭐'}</div>
      <div class="achievement-body">
        <div class="achievement-title">${escapeHtml(ach.title)}</div>
        <div class="achievement-meta">
          <span class="achievement-tag cat-${ach.category}">${ACHIEVEMENT_LABELS[ach.category] || 'Other'}</span>
          <span>${formatDisplayDate(ach.date)}</span>
        </div>
      </div>
      <button class="icon-btn danger" data-action="delete" title="Delete">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path></svg>
      </button>
    `;

    card.querySelector('[data-action="delete"]').addEventListener('click', () => deleteAchievement(ach.id));

    grid.appendChild(card);
  });
}

/* ============================================================
   DASHBOARD / HOME
   ============================================================ */

function renderDashboard() {
  document.getElementById('statSubjects').textContent = state.subjects.length;

  const subjectsWithData = state.subjects.filter(s => (s.present + s.absent) > 0);
  let avgAttendance = 0;
  if (subjectsWithData.length > 0) {
    const total = subjectsWithData.reduce((sum, s) => sum + (s.present / (s.present + s.absent)) * 100, 0);
    avgAttendance = Math.round(total / subjectsWithData.length);
  }
  document.getElementById('statAvgAttendance').textContent = `${avgAttendance}%`;

  let totalCredits = 0, weightedSum = 0;
  state.semesters.forEach(sem => {
    totalCredits += sem.credits;
    weightedSum += sem.sgpa * sem.credits;
  });
  const cgpa = totalCredits > 0 ? (weightedSum / totalCredits) : 0;
  document.getElementById('statCGPA').textContent = cgpa.toFixed(2);

  const pendingTasks = state.tasks.filter(t => !t.completed).length;
  document.getElementById('statPendingTasks').textContent = pendingTasks;

  renderAttendanceChart();
  renderUpcomingDeadlines();
  renderTodayPlan();
  renderRecentAchievements();
  updateGreetingDisplay();
}

function renderAttendanceChart() {
  const chart = document.getElementById('attendanceChart');
  const emptyHint = document.getElementById('attendanceChartEmpty');
  chart.innerHTML = '';

  if (state.subjects.length === 0) {
    emptyHint.classList.remove('hidden');
    return;
  }
  emptyHint.classList.add('hidden');

  state.subjects.forEach(subject => {
    const total = subject.present + subject.absent;
    const pct = total > 0 ? Math.round((subject.present / total) * 100) : 0;

    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <span class="bar-name">${escapeHtml(subject.name)}</span>
      <div class="bar-track">
        <div class="bar-fill" style="width:${pct}%; background:${subject.color || '#6ee7b7'};"></div>
      </div>
      <span class="bar-pct">${pct}%</span>
    `;
    chart.appendChild(row);
  });
}

function renderUpcomingDeadlines() {
  const list = document.getElementById('upcomingDeadlines');
  list.innerHTML = '';

  const upcoming = state.tasks
    .filter(t => !t.completed && daysUntil(t.dueDate) >= 0 && daysUntil(t.dueDate) <= 7)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  if (upcoming.length === 0) {
    list.innerHTML = '<li class="empty-hint">No upcoming deadlines. You\'re all caught up!</li>';
    return;
  }

  upcoming.forEach(task => {
    const subject = state.subjects.find(s => s.id === task.subjectId);
    const diff = daysUntil(task.dueDate);
    const li = document.createElement('li');
    li.innerHTML = `
      <span>${escapeHtml(task.title)}${subject ? ` <span style="color:var(--text-muted)">· ${escapeHtml(subject.name)}</span>` : ''}</span>
      <span class="ml-tag type-${task.type}">${diff === 0 ? 'Today' : `${diff}d left`}</span>
    `;
    list.appendChild(li);
  });
}

function renderTodayPlan() {
  const list = document.getElementById('todayPlanList');
  const countTag = document.getElementById('todayPlanCount');
  list.innerHTML = '';

  const today = formatDateInput(new Date());
  const items = (state.plannerByDate[today] || []).slice().sort((a, b) => a.time.localeCompare(b.time));

  countTag.textContent = `${items.length} task${items.length === 1 ? '' : 's'}`;

  if (items.length === 0) {
    list.innerHTML = '<li class="empty-hint">Nothing planned for today yet.</li>';
    return;
  }

  items.forEach(item => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span>${escapeHtml(item.activity)}</span>
      <span class="ml-tag type-assignment">${item.time}</span>
    `;
    list.appendChild(li);
  });
}

function renderRecentAchievements() {
  const list = document.getElementById('recentAchievements');
  list.innerHTML = '';

  if (state.achievements.length === 0) {
    list.innerHTML = '<li class="empty-hint">No achievements added yet.</li>';
    return;
  }

  state.achievements.slice(0, 3).forEach(ach => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span>${ACHIEVEMENT_ICONS[ach.category] || '⭐'} ${escapeHtml(ach.title)}</span>
      <span class="ml-tag cat-${ach.category}">${ACHIEVEMENT_LABELS[ach.category] || 'Other'}</span>
    `;
    list.appendChild(li);
  });
}

/* ============================================================
   STUDY MATERIAL — Rich Text Editor + File Uploads
   ============================================================ */

let activeDocId = null;    
let activeUploadId = null; 
let smSaveTimeout = null;  
let smCurrentFilter = 'all';

function getFileIcon(mime) {
  if (!mime) return '📎';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime === 'application/pdf') return '📕';
  if (mime.includes('word') || mime.includes('document')) return '📘';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return '📙';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime === 'text/plain') return '📄';
  return '📎';
}

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function initStudyMaterial() {
  document.getElementById('smNewDocBtn').addEventListener('click', createNewDoc);
  document.getElementById('smEmptyNewBtn').addEventListener('click', createNewDoc);
  document.getElementById('smFileUpload').addEventListener('change', handleFileUpload);
  document.getElementById('smDocSearch').addEventListener('input', renderDocList);

  document.querySelectorAll('[data-smfilter]').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('[data-smfilter]').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      smCurrentFilter = chip.dataset.smfilter;
      renderDocList();
    });
  });

  document.querySelectorAll('.sm-tb-btn').forEach(btn => {
    btn.addEventListener('mousedown', e => {
      e.preventDefault(); 
      const cmd = btn.dataset.cmd;
      const val = btn.dataset.value;
      execEditorCmd(cmd, val);
    });
  });

  document.getElementById('tbHeading').addEventListener('change', e => {
    document.getElementById('smEditor').focus();
    document.execCommand('formatBlock', false, e.target.value);
  });

  document.getElementById('tbFont').addEventListener('change', e => {
    document.getElementById('smEditor').focus();
    document.execCommand('fontName', false, e.target.value);
  });

  document.getElementById('tbFontSize').addEventListener('change', e => {
    document.getElementById('smEditor').focus();
    insertStyledSpan({ fontSize: e.target.value });
  });

  document.getElementById('tbTextColor').addEventListener('input', e => {
    document.getElementById('smEditor').focus();
    document.execCommand('foreColor', false, e.target.value);
  });

  document.getElementById('tbHighlight').addEventListener('input', e => {
    document.getElementById('smEditor').focus();
    document.execCommand('hiliteColor', false, e.target.value);
  });

  const editor = document.getElementById('smEditor');

  document.querySelector('[data-cmd="insertLink"]').addEventListener('mousedown', e => {
    e.preventDefault();
    const url = prompt('Enter URL:');
    if (url) {
      editor.focus();
      document.execCommand('createLink', false, url);
    }
  });

  document.querySelector('[data-cmd="insertTable"]').addEventListener('mousedown', e => {
    e.preventDefault();
    insertTable();
  });

  document.getElementById('smDocTitle').addEventListener('input', scheduleSmSave);
  document.getElementById('smDocSubject').addEventListener('change', scheduleSmSave);

  document.getElementById('smUploadSubject').addEventListener('change', () => {
    if (!activeUploadId) return;
    const upload = state.studyUploads.find(u => u.id === activeUploadId);
    if (upload) {
      upload.subjectId = document.getElementById('smUploadSubject').value || null;
      saveState();
      renderDocList();
      showToast('Subject updated');
    }
  });

  document.getElementById('smSubjectFilter').addEventListener('change', renderDocList);

  editor.addEventListener('input', () => {
    updateWordCount();
    scheduleSmSave();
    markUnsaved();
  });

  document.getElementById('smDeleteDocBtn').addEventListener('click', () => {
    if (!activeDocId) return;
    if (!confirm('Delete this document? This cannot be undone.')) return;
    state.studyDocs = state.studyDocs.filter(d => d.id !== activeDocId);
    activeDocId = null;
    saveState();
    renderDocList();
    showSmEmptyState();
    showToast('Document deleted');
  });

  document.getElementById('smDeleteUploadBtn').addEventListener('click', () => {
    if (!activeUploadId) return;
    if (!confirm('Delete this uploaded file?')) return;
    state.studyUploads = state.studyUploads.filter(u => u.id !== activeUploadId);
    activeUploadId = null;
    saveState();
    renderDocList();
    showSmEmptyState();
    showToast('File deleted');
  });

  populateSmSubjectSelect();
  renderDocList();
}

function execEditorCmd(cmd, value) {
  const editor = document.getElementById('smEditor');
  editor.focus();
  if (cmd === 'formatBlock' && value) {
    document.execCommand('formatBlock', false, value);
  } else {
    document.execCommand(cmd, false, value || null);
  }
  updateToolbarState();
}

function insertStyledSpan(styles) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) {
    const span = document.createElement('span');
    Object.assign(span.style, styles);
    range.surroundContents(span);
    sel.removeAllRanges();
    const newRange = document.createRange();
    newRange.selectNodeContents(span);
    sel.addRange(newRange);
  }
}

function insertTable() {
  const rows = parseInt(prompt('Rows:', '3')) || 3;
  const cols = parseInt(prompt('Columns:', '3')) || 3;
  let html = '<table class="sm-editor-table"><tbody>';
  for (let r = 0; r < rows; r++) {
    html += '<tr>';
    for (let c = 0; c < cols; c++) {
      html += `<td contenteditable="true"> </td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table><br>';
  document.getElementById('smEditor').focus();
  document.execCommand('insertHTML', false, html);
}

function updateToolbarState() {
  document.querySelectorAll('.sm-tb-btn').forEach(btn => {
    const cmd = btn.dataset.cmd;
    try {
      btn.classList.toggle('active', document.queryCommandState(cmd));
    } catch {}
  });
}

function updateWordCount() {
  const editor = document.getElementById('smEditor');
  const text = editor.innerText || '';
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  document.getElementById('smWordCount').textContent = `${words} word${words === 1 ? '' : 's'}`;
}

function markUnsaved() {
  document.getElementById('smSavedLabel').textContent = 'Unsaved…';
}

function scheduleSmSave() {
  clearTimeout(smSaveTimeout);
  smSaveTimeout = setTimeout(saveCurrentDoc, 800);
}

function saveCurrentDoc() {
  if (!activeDocId) return;
  const doc = state.studyDocs.find(d => d.id === activeDocId);
  if (!doc) return;
  doc.title = document.getElementById('smDocTitle').value || 'Untitled Document';
  doc.subjectId = document.getElementById('smDocSubject').value || null;
  doc.content = document.getElementById('smEditor').innerHTML;
  doc.updatedAt = Date.now();
  saveState();
  renderDocList();
  document.getElementById('smSavedLabel').textContent = 'All changes saved';
}

function createNewDoc() {
  const doc = {
    id: genId(),
    title: 'Untitled Document',
    subjectId: null,
    content: '',
    updatedAt: Date.now(),
    type: 'document'
  };
  state.studyDocs.unshift(doc);
  saveState();
  renderDocList();
  openDoc(doc.id);
}

function openDoc(id) {
  const doc = state.studyDocs.find(d => d.id === id);
  if (!doc) return;

  activeDocId = id;
  activeUploadId = null;

  document.getElementById('smEmptyState').classList.add('hidden');
  document.getElementById('smUploadView').classList.add('hidden');
  document.getElementById('smEditorWrap').classList.remove('hidden');

  document.getElementById('smDocTitle').value = doc.title || '';
  document.getElementById('smEditor').innerHTML = doc.content || '';
  document.getElementById('smSavedLabel').textContent = 'All changes saved';
  document.getElementById('smDocSubject').value = doc.subjectId || '';

  updateWordCount();
  highlightActiveDoc();
  document.getElementById('smDocTitle').focus();
}

function openUpload(id) {
  const upload = state.studyUploads.find(u => u.id === id);
  if (!upload) return;

  activeUploadId = id;
  activeDocId = null;

  document.getElementById('smEmptyState').classList.add('hidden');
  document.getElementById('smEditorWrap').classList.add('hidden');
  document.getElementById('smUploadView').classList.remove('hidden');

  document.getElementById('smUploadFileName').textContent = upload.name;
  document.getElementById('smUploadMeta').textContent =
    `${formatBytes(upload.size)} · Uploaded ${new Date(upload.uploadedAt).toLocaleDateString()}`;

  const uploadSubjSel = document.getElementById('smUploadSubject');
  if (uploadSubjSel) {
    populateSmSubjectSelect();
    uploadSubjSel.value = upload.subjectId || '';
  }

  const dl = document.getElementById('smUploadDownload');
  dl.href = upload.dataUrl;
  dl.download = upload.name;

  const preview = document.getElementById('smUploadPreview');
  preview.innerHTML = '';
  if (upload.mimeType.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = upload.dataUrl;
    img.className = 'sm-preview-img';
    preview.appendChild(img);
  } else if (upload.mimeType === 'application/pdf') {
    try {
      const byteString = atob(upload.dataUrl.split(',')[1]);
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
      const blob = new Blob([ab], { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(blob);
      const iframe = document.createElement('iframe');
      iframe.src = blobUrl;
      iframe.className = 'sm-preview-pdf';
      iframe.title = upload.name;
      preview.appendChild(iframe);
    } catch(e) {
      preview.innerHTML = `<p class="empty-hint">📕 PDF preview failed. <a href="${upload.dataUrl}" download="${escapeHtml(upload.name)}" style="color:var(--mint)">Download instead</a>.</p>`;
    }
  } else if (upload.mimeType === 'application/msword' ||
             upload.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const infoDiv = document.createElement('div');
    infoDiv.className = 'sm-word-preview';
    infoDiv.innerHTML = `
      <div style="text-align:center;padding:40px 20px;">
        <div style="font-size:3rem;margin-bottom:12px;">📘</div>
        <h3 style="margin-bottom:8px;">${escapeHtml(upload.name)}</h3>
        <p style="color:var(--text-muted);margin-bottom:20px;font-size:0.9rem;">Word documents can't be previewed inline, but you can download and open them.</p>
        <a class="btn btn-primary" href="${upload.dataUrl}" download="${escapeHtml(upload.name)}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          Download Word File
        </a>
      </div>
    `;
    preview.appendChild(infoDiv);
  } else if (upload.mimeType.startsWith('video/')) {
    const video = document.createElement('video');
    video.src = upload.dataUrl;
    video.controls = true;
    video.className = 'sm-preview-video';
    preview.appendChild(video);
  } else if (upload.mimeType.startsWith('audio/')) {
    const audio = document.createElement('audio');
    audio.src = upload.dataUrl;
    audio.controls = true;
    audio.className = 'sm-preview-audio';
    preview.appendChild(audio);
  } else if (upload.mimeType === 'text/plain') {
    fetch(upload.dataUrl).then(r => r.text()).then(text => {
      const pre = document.createElement('pre');
      pre.className = 'sm-preview-text';
      pre.textContent = text;
      preview.appendChild(pre);
    }).catch(() => {
      preview.innerHTML = '<p class="empty-hint">Preview not available. Use Download.</p>';
    });
  } else {
    preview.innerHTML = `<p class="empty-hint">${getFileIcon(upload.mimeType)} No preview available for this file type. Use Download.</p>`;
  }

  highlightActiveDoc();
}

function showSmEmptyState() {
  document.getElementById('smEmptyState').classList.remove('hidden');
  document.getElementById('smEditorWrap').classList.add('hidden');
  document.getElementById('smUploadView').classList.add('hidden');
}

function highlightActiveDoc() {
  document.querySelectorAll('.sm-doc-item').forEach(el => {
    el.classList.toggle('active',
      el.dataset.docid === activeDocId || el.dataset.uploadid === activeUploadId);
  });
}

async function handleFileUpload(e) {
  const files = Array.from(e.target.files);
  for (const file of files) {
    const dataUrl = await fileToDataUrl(file);
    const upload = {
      id: genId(),
      name: file.name,
      dataUrl,
      mimeType: file.type,
      size: file.size,
      uploadedAt: Date.now(),
      subjectId: null
    };
    state.studyUploads.unshift(upload);
  }
  saveState();
  renderDocList();
  if (files.length) {
    showToast(`${files.length} file${files.length > 1 ? 's' : ''} uploaded`);
    openUpload(state.studyUploads[0].id);
  }
  e.target.value = ''; 
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function populateSmSubjectSelect() {
  const sel = document.getElementById('smDocSubject');
  const current = sel.value;
  sel.innerHTML = '<option value="">No subject</option>';
  state.subjects.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    sel.appendChild(opt);
  });
  sel.value = current;

  const uploadSel = document.getElementById('smUploadSubject');
  if (uploadSel) {
    const currentU = uploadSel.value;
    uploadSel.innerHTML = '<option value="">No subject</option>';
    state.subjects.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      uploadSel.appendChild(opt);
    });
    uploadSel.value = currentU;
  }

  const filterSel = document.getElementById('smSubjectFilter');
  if (filterSel) {
    const currentF = filterSel.value;
    filterSel.innerHTML = '<option value="">All subjects</option>';
    state.subjects.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      filterSel.appendChild(opt);
    });
    filterSel.value = currentF;
  }
}

function renderDocList() {
  const list = document.getElementById('smDocList');
  const emptyHint = document.getElementById('smDocListEmpty');
  const query = (document.getElementById('smDocSearch').value || '').toLowerCase();
  list.innerHTML = '';

  let items = [];

  if (smCurrentFilter !== 'upload') {
    state.studyDocs.forEach(d => {
      items.push({ ...d, itemType: 'document' });
    });
  }

  if (smCurrentFilter !== 'document') {
    state.studyUploads.forEach(u => {
      items.push({ ...u, itemType: 'upload' });
    });
  }

  items.sort((a, b) => (b.updatedAt || b.uploadedAt) - (a.updatedAt || a.uploadedAt));

  const subjectFilter = (document.getElementById('smSubjectFilter').value || '');
  if (subjectFilter) {
    items = items.filter(item => item.subjectId === subjectFilter);
  }

  if (query) {
    const subjectNames = {};
    state.subjects.forEach(s => { subjectNames[s.id] = s.name.toLowerCase(); });
    items = items.filter(item => {
      const nameMatch = (item.title || item.name || '').toLowerCase().includes(query);
      const subjectMatch = item.subjectId && (subjectNames[item.subjectId] || '').includes(query);
      return nameMatch || subjectMatch;
    });
  }

  if (items.length === 0) {
    emptyHint.classList.remove('hidden');
    return;
  }
  emptyHint.classList.add('hidden');

  items.forEach(item => {
    const li = document.createElement('li');
    li.className = 'sm-doc-item';

    if (item.itemType === 'document') {
      li.dataset.docid = item.id;
      const subj = state.subjects.find(s => s.id === item.subjectId);
      li.innerHTML = `
        <span class="sm-doc-icon">📄</span>
        <div class="sm-doc-info">
          <span class="sm-doc-name">${escapeHtml(item.title || 'Untitled Document')}</span>
          <span class="sm-doc-meta">${subj ? `<span class="sm-doc-subject-badge">${escapeHtml(subj.name)}</span> · ` : ''}${new Date(item.updatedAt).toLocaleDateString()}</span>
        </div>
      `;
      li.addEventListener('click', () => openDoc(item.id));
    } else {
      li.dataset.uploadid = item.id;
      const subjU = state.subjects.find(s => s.id === item.subjectId);
      li.innerHTML = `
        <span class="sm-doc-icon">${getFileIcon(item.mimeType)}</span>
        <div class="sm-doc-info">
          <span class="sm-doc-name">${escapeHtml(item.name)}</span>
          <span class="sm-doc-meta">${formatBytes(item.size)} · ${new Date(item.uploadedAt).toLocaleDateString()}${subjU ? `<span class="sm-doc-subject-badge" style="margin-left:4px;">${escapeHtml(subjU.name)}</span>` : ''}</span>
        </div>
      `;
      li.addEventListener('click', () => openUpload(item.id));
    }

    list.appendChild(li);
  });

  highlightActiveDoc();
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ============================================================
   POMODORO TIMER
   ============================================================ */

const POMO_STORAGE_KEY = 'studyos_pomo_v1';

let pomoState = {
  mode: 'work',        
  running: false,
  timeLeft: 25 * 60,   
  session: 1,
  completedSessions: 0,
  settings: { work: 25, short: 5, long: 15, sessionsUntilLong: 4 },
  todayKey: '', todaySessions: 0, todayMinutes: 0, soundEnabled: true
};

let pomoInterval = null;
const POMO_CIRCUMFERENCE = 2 * Math.PI * 96; 

function savePomo() {
  try {
    localStorage.setItem(POMO_STORAGE_KEY, JSON.stringify({
      settings: pomoState.settings,
      todayKey: pomoState.todayKey,
      todaySessions: pomoState.todaySessions,
      todayMinutes: pomoState.todayMinutes,
      soundEnabled: pomoState.soundEnabled
    }));
  } catch(e) {}
}

function loadPomo() {
  try {
    const raw = localStorage.getItem(POMO_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.settings) pomoState.settings = { ...pomoState.settings, ...saved.settings };
    pomoState.soundEnabled = saved.soundEnabled !== false;
    const todayKey = formatDateInput(new Date());
    if (saved.todayKey === todayKey) {
      pomoState.todaySessions = saved.todaySessions || 0;
      pomoState.todayMinutes = saved.todayMinutes || 0;
    }
    pomoState.todayKey = todayKey;
    pomoState.timeLeft = pomoState.settings.work * 60;
  } catch(e) {}
}

function initPomodoro() {
  loadPomo();

  document.getElementById('pomoWorkMin').value = pomoState.settings.work;
  document.getElementById('pomoShortMin').value = pomoState.settings.short;
  document.getElementById('pomoLongMin').value = pomoState.settings.long;
  document.getElementById('pomoSessionsUntilLong').value = pomoState.settings.sessionsUntilLong;
  document.getElementById('pomoSoundToggle').checked = pomoState.soundEnabled;

  document.querySelectorAll('.pomo-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (pomoState.running) stopPomo();
      pomoState.mode = tab.dataset.mode;
      pomoState.timeLeft = pomoState.settings[pomoState.mode] * 60;
      document.querySelectorAll('.pomo-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderPomoUI();
    });
  });

  document.getElementById('pomoPlayBtn').addEventListener('click', togglePomo);

  document.getElementById('pomoResetBtn').addEventListener('click', () => {
    stopPomo();
    pomoState.timeLeft = pomoState.settings[pomoState.mode] * 60;
    renderPomoUI();
  });

  document.getElementById('pomoSkipBtn').addEventListener('click', () => {
    stopPomo();
    advancePomoMode(false);
  });

  document.getElementById('pomoApplySettings').addEventListener('click', () => {
    const w = parseInt(document.getElementById('pomoWorkMin').value) || 25;
    const s = parseInt(document.getElementById('pomoShortMin').value) || 5;
    const l = parseInt(document.getElementById('pomoLongMin').value) || 15;
    const n = parseInt(document.getElementById('pomoSessionsUntilLong').value) || 4;
    pomoState.settings = { work: w, short: s, long: l, sessionsUntilLong: n };
    stopPomo();
    pomoState.timeLeft = pomoState.settings[pomoState.mode] * 60;
    savePomo();
    renderPomoUI();
    showToast('Pomodoro settings saved ✓');
  });

  document.getElementById('pomoSoundToggle').addEventListener('change', e => {
    pomoState.soundEnabled = e.target.checked;
    savePomo();
  });

  renderPomoUI();
  updatePomoStats();
}

function togglePomo() {
  if (pomoState.running) { stopPomo(); } else { startPomo(); }
  renderPomoUI();
}

function startPomo() {
  pomoState.running = true;
  const ring = document.getElementById('pomoRingFg');
  if (ring) ring.classList.add('running');
  pomoInterval = setInterval(() => {
    pomoState.timeLeft--;
    if (pomoState.mode === 'work') { pomoState.todayMinutes++; }
    if (pomoState.timeLeft <= 0) { timerComplete(); } else {
      renderPomoTime();
      renderPomoRing();
    }
  }, 1000);
}

function stopPomo() {
  pomoState.running = false;
  clearInterval(pomoInterval);
  pomoInterval = null;
  const ring = document.getElementById('pomoRingFg');
  if (ring) ring.classList.remove('running');
  savePomo();
}

function timerComplete() {
  stopPomo();
  playPomoSound();
  if (pomoState.mode === 'work') {
    pomoState.completedSessions++;
    pomoState.todaySessions++;
    updatePomoStats();
    savePomo();
    showToast('🍅 Focus session complete! Time for a break.');
  } else {
    showToast('⏰ Break over — back to work!');
  }
  advancePomoMode(true);
}

function advancePomoMode(auto) {
  if (pomoState.mode === 'work') {
    if (pomoState.completedSessions % pomoState.settings.sessionsUntilLong === 0 && pomoState.completedSessions > 0) {
      pomoState.mode = 'long';
    } else {
      pomoState.mode = 'short';
    }
  } else {
    pomoState.mode = 'work';
    if (auto) pomoState.session++;
  }
  pomoState.timeLeft = pomoState.settings[pomoState.mode] * 60;

  document.querySelectorAll('.pomo-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === pomoState.mode);
  });

  renderPomoUI();
  if (auto) { setTimeout(startPomo, 500); }
}

function renderPomoUI() {
  renderPomoTime();
  renderPomoRing();
  renderPomoPlayBtn();
  renderPomoSessions();
}

function renderPomoTime() {
  const m = Math.floor(pomoState.timeLeft / 60);
  const s = pomoState.timeLeft % 60;
  document.getElementById('pomoTime').textContent =
    String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');

  const modeLabels = { work: 'Focus', short: 'Short Break', long: 'Long Break' };
  document.getElementById('pomoModeLabel').textContent = modeLabels[pomoState.mode] || 'Focus';
}

function renderPomoRing() {
  const ring = document.getElementById('pomoRingFg');
  if (!ring) return;
  const total = pomoState.settings[pomoState.mode] * 60;
  const fraction = pomoState.timeLeft / total;
  const offset = POMO_CIRCUMFERENCE * (1 - fraction);
  ring.style.strokeDashoffset = offset;

  ring.className = 'pomo-ring-fg';
  if (pomoState.mode === 'short') ring.classList.add('mode-short');
  if (pomoState.mode === 'long')  ring.classList.add('mode-long');
  if (pomoState.running) ring.classList.add('running');
}

function renderPomoPlayBtn() {
  const btn = document.getElementById('pomoPlayBtn');
  btn.className = 'pomo-play-btn';
  if (pomoState.mode === 'short') btn.classList.add('mode-short');
  if (pomoState.mode === 'long')  btn.classList.add('mode-long');

  const icon = document.getElementById('pomoPlayIcon');
  if (pomoState.running) {
    icon.innerHTML = '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>';
  } else {
    icon.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
  }
}

function renderPomoSessions() {
  const dotsEl = document.getElementById('pomoSessionDots');
  const n = pomoState.settings.sessionsUntilLong;
  let html = '';
  for (let i = 0; i < n; i++) {
    const sessionIndex = (pomoState.completedSessions % n);
    if (i < sessionIndex) {
      html += '<span class="pomo-session-dot done"></span>';
    } else if (i === sessionIndex && pomoState.mode === 'work') {
      html += '<span class="pomo-session-dot current"></span>';
    } else {
      html += '<span class="pomo-session-dot"></span>';
    }
  }
  dotsEl.innerHTML = html;

  const sessionNum = Math.floor(pomoState.completedSessions) + 1;
  document.getElementById('pomoSessionText').textContent = `Session ${sessionNum}`;
}

function updatePomoStats() {
  document.getElementById('pomoTodaySessions').textContent = pomoState.todaySessions;
  document.getElementById('pomoTodayMinutes').textContent = pomoState.todayMinutes;
}

function playPomoSound() {
  if (!pomoState.soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = pomoState.mode === 'work' ? [523, 659, 784] : [784, 659, 523];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, ctx.currentTime + i * 0.18);
      gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + i * 0.18 + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.35);
      osc.start(ctx.currentTime + i * 0.18);
      osc.stop(ctx.currentTime + i * 0.18 + 0.4);
    });
  } catch(e) {}
}

function renderAll() {
  renderDashboard();
  renderSubjects();
  renderAttendance();
  renderCgpa();
  renderTasks();
  renderTodos();
  renderPlanner();
  renderNotes();
  renderAchievements();
  renderDocList();
  populateSmSubjectSelect();
}

/* ============================================================
   INIT
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  loadState();
  initOnboardingFlow();
  checkOnboardingRequirement();
  updateStreak();

  initNavigation();
  initTopbar();
  initSubjectManager();
  initCgpaCalculator();
  initTaskTracker();
  initTodoAndPlanner();
  initNotes();
  initAchievements();
  initAttendanceGoal();
  initStudyMaterial();
  initPomodoro();
  
  initGoogleDriveAuth();
  updateCloudUI('idle');

  renderAll();
});