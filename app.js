// ProCam Front Application Logic

// --- App State ---
const appState = {
  currentMode: 'pro', // 'photo' | 'pro'
  activeControl: 'auto', // 'auto' | 'exposure' | 'iso' | 'whitebalance' | 'focus'
  aspectRatio: '4:3', // '4:3' | '16:9' | '1:1'
  gridType: 'off', // 'off' | 'thirds' | 'golden' | 'square'
  levelActive: false,
  mirror: true,
  timer: 0, // 0 | 3 | 5 | 10 (seconds)
  isCapturing: false,
  
  // Pro Parameters
  exposure: 0.0,    // -2.0 to +2.0 (step 0.1)
  iso: 'auto',      // 'auto' or 50, 100, 200, 400, 800, 1600, 3200
  whitebalance: 'auto', // 'auto' or Kelvin value (2500 to 8000)
  focus: 'auto'     // 'auto' or 0 to 100
};

// --- DOM Elements ---
const video = document.getElementById('video-preview');
const canvas = document.getElementById('canvas-preview');
const ctx = canvas.getContext('2d');
const wbOverlay = document.getElementById('wb-overlay');
const grainOverlay = document.getElementById('grain-overlay');
const gridOverlay = document.getElementById('grid-overlay');
const levelOverlay = document.getElementById('level-overlay');
const manualFocusRing = document.getElementById('manual-focus-ring');
const toastNotification = document.getElementById('toast-notification');
const flashOverlay = document.getElementById('flash-overlay');
const timerOverlay = document.getElementById('timer-overlay');
const timerNumber = document.getElementById('timer-number');

// HUD Buttons
const ratioBtn = document.getElementById('ratio-btn');
const gridBtn = document.getElementById('grid-btn');
const levelBtn = document.getElementById('level-btn');
const mirrorBtn = document.getElementById('mirror-btn');
const timerBtn = document.getElementById('timer-btn');

// Status Badges
const badgeIso = document.getElementById('status-iso');
const badgeEv = document.getElementById('status-ev');
const badgeWb = document.getElementById('status-wb');
const badgeFoc = document.getElementById('status-foc');

// Live Histogram Canvas
const histogramCanvas = document.getElementById('histogram-canvas');
const histogramCtx = histogramCanvas.getContext('2d');

// Dial Controls
const dialContainer = document.getElementById('dial-container');
const dialLabelValue = document.getElementById('dial-label-value');
const dialRangeInput = document.getElementById('dial-range-input');
const proMenuItems = document.querySelectorAll('.pro-menu-item');
const resetProBtn = document.getElementById('reset-pro-btn');

// Bottom Action Buttons
const shutterBtn = document.getElementById('shutter-btn');
const galleryThumbBtn = document.getElementById('gallery-thumb-btn');

// Modes
const modeTabPhoto = document.getElementById('mode-tab-photo');
const modeTabPro = document.getElementById('mode-tab-pro');

// Gallery Elements
const galleryPanel = document.getElementById('gallery-panel');
const galleryBackBtn = document.getElementById('gallery-back-btn');
const galleryGrid = document.getElementById('gallery-grid');
const galleryEmptyState = document.getElementById('gallery-empty-state');

// Photo Viewer Elements
const photoViewer = document.getElementById('photo-viewer');
const viewerImg = document.getElementById('viewer-img');
const viewerBackBtn = document.getElementById('viewer-back-btn');
const viewerDeleteBtn = document.getElementById('viewer-delete-btn');
const viewerShareBtn = document.getElementById('viewer-share-btn');
const viewerDownloadBtn = document.getElementById('viewer-download-btn');
const metaDate = document.getElementById('meta-date');
const metaSettings = document.getElementById('meta-settings');

// --- Global Variables ---
let mediaStream = null;
let videoTrack = null;
let imageCapture = null;
let db = null;
let frameCount = 0;
let isStreamActive = false;
let isDrawing = true;
let renderLoopId = null;
let activeObjectURLs = [];
let thumbnailURL = null;
let smoothRoll = null;
let smoothPitch = null;

// Offscreen micro-canvas for high-speed histogram downsampling
const miniCanvas = document.createElement('canvas');
miniCanvas.width = 40;
miniCanvas.height = 30;
const miniCtx = miniCanvas.getContext('2d');

// Offscreen noise-canvases for dynamic ISO chromatic grain
let noiseCanvases = [];
let noisePatterns = [];
let lastAppliedFilter = '';
let noiseDataURL = '';
function initNoiseCanvases() {
  noiseCanvases = [];
  noisePatterns = [];
  
  // Generate a single tiled grain canvas for CSS background repetition
  const nCanvas = document.createElement('canvas');
  nCanvas.width = 256;
  nCanvas.height = 256;
  const nCtx = nCanvas.getContext('2d');
  const imgData = nCtx.createImageData(256, 256);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    // Base monochrome noise value
    const val = Math.floor(Math.random() * 100) + 78; // grey noise
    
    // Inject chromatic red/blue sensor noise for realistic high-ISO film grain
    const rNoise = val + (Math.random() * 30 - 15);
    const gNoise = val + (Math.random() * 20 - 10);
    const bNoise = val + (Math.random() * 30 - 15);
    
    data[i] = Math.max(0, Math.min(255, rNoise));     // R
    data[i+1] = Math.max(0, Math.min(255, gNoise));   // G
    data[i+2] = Math.max(0, Math.min(255, bNoise));   // B
    data[i+3] = 45;                                  // Base alpha for pattern
  }
  nCtx.putImageData(imgData, 0, 0);
  noiseCanvases.push(nCanvas);
  
  // Export to Data URL to set as CSS background pattern
  noiseDataURL = nCanvas.toDataURL('image/png');
  grainOverlay.style.backgroundImage = `url(${noiseDataURL})`;
}

// --- Initialize Database (IndexedDB) ---
function initDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ProCamDB', 1);
    
    request.onupgradeneeded = (e) => {
      const dbInstance = e.target.result;
      if (!dbInstance.objectStoreNames.contains('photos')) {
        dbInstance.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
      }
    };
    
    request.onsuccess = (e) => {
      db = e.target.result;
      console.log('IndexedDB initialized successfully');
      loadLastPhotoThumbnail();
      resolve(db);
    };
    
    request.onerror = (e) => {
      console.error('Failed to open database:', e);
      reject(e);
    };
  });
}

// --- Audio Synthesizer (Mechanical Shutter Sound) ---
function playShutterSound() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    // 1. Shutter Transient Snap (noise buffer)
    const bufferSize = audioCtx.sampleRate * 0.08; // 80ms duration
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    
    const noiseNode = audioCtx.createBufferSource();
    noiseNode.buffer = buffer;
    
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1000;
    filter.Q.value = 4;
    
    const gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(0.6, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.07);
    
    noiseNode.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    // 2. Low Mirror Slap Sound (sine sweep)
    const osc = audioCtx.createOscillator();
    const oscGain = audioCtx.createGain();
    
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(160, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(30, audioCtx.currentTime + 0.09);
    
    oscGain.gain.setValueAtTime(0.5, audioCtx.currentTime);
    oscGain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.09);
    
    osc.connect(oscGain);
    oscGain.connect(audioCtx.destination);
    
    noiseNode.start();
    osc.start();
    noiseNode.stop(audioCtx.currentTime + 0.1);
    osc.stop(audioCtx.currentTime + 0.1);

    // Automatically close audio context to free resources
    setTimeout(() => {
      if (audioCtx.state !== 'closed') {
        audioCtx.close();
      }
    }, 500);
  } catch (e) {
    console.warn("Failed to play synthesized shutter sound:", e);
  }
}

// --- Camera Stream Initialization ---
async function initCamera() {
  showToast("Initializing Front Camera...");
  try {
    // Stop any existing stream
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
    }
    
    // Mobile-optimized front camera settings
    const constraints = {
      video: {
        facingMode: { ideal: "user" },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    };
    
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = mediaStream;
    
    // Wait until video has loaded metadata to retrieve track details
    video.onloadedmetadata = () => {
      videoTrack = mediaStream.getVideoTracks()[0];
      isStreamActive = true;
      video.play();
      
      // Sync canvas dimensions with active video aspect ratio
      updateCanvasDimensions();
      
      // Start real-time drawing loop safely
      if (renderLoopId) {
        cancelAnimationFrame(renderLoopId);
      }
      isDrawing = true;
      renderLoopId = requestAnimationFrame(renderLoop);
      
      // Probe native camera hardware attributes
      detectNativeCapabilities();
      
      showToast("Camera Connected");
    };
  } catch (err) {
    console.error("Error accessing front camera:", err);
    showToast("Error: Access Denied / Lens Blocked");
    // Activate fallback display helper
    video.classList.add('active-fallback');
  }
}

function updateCanvasDimensions() {
  if (!video.videoWidth) return;
  
  let targetAspect = 3/4; // Default 4:3 portrait (viewfinder is 3:4 vertical)
  let aspectVal = '3/4';
  
  if (appState.aspectRatio === '16:9') {
    targetAspect = 9/16;
    aspectVal = '9/16';
  } else if (appState.aspectRatio === '1:1') {
    targetAspect = 1/1;
    aspectVal = '1/1';
  }
  
  const streamAspect = video.videoWidth / video.videoHeight;
  let w = video.videoWidth;
  let h = video.videoHeight;
  
  if (streamAspect > targetAspect) {
    h = video.videoHeight;
    w = video.videoHeight * targetAspect;
  } else {
    w = video.videoWidth;
    h = video.videoWidth / targetAspect;
  }
  
  // Set the canvas resolution to a highly optimized size (max 720px width)
  const maxPreviewWidth = 720;
  let previewW = w;
  let previewH = h;
  if (w > maxPreviewWidth) {
    previewW = maxPreviewWidth;
    previewH = Math.round(maxPreviewWidth / targetAspect);
  }
  
  canvas.width = previewW;
  canvas.height = previewH;
  canvas.style.aspectRatio = aspectVal;
  
  // Sync aspect ratio directly to raw video preview and GPU overlays
  video.style.aspectRatio = aspectVal;
  wbOverlay.style.aspectRatio = aspectVal;
  grainOverlay.style.aspectRatio = aspectVal;
}

// Inspect hardware for native Pro sliders support (Android Chrome mainly)
function detectNativeCapabilities() {
  if (!videoTrack || !videoTrack.getCapabilities) {
    console.log("Native track capabilities query unsupported on this browser");
    return;
  }
  
  const caps = videoTrack.getCapabilities();
  const settings = videoTrack.getSettings();
  console.log("Hardware Capabilities:", caps);
  console.log("Hardware Settings:", settings);
}

// --- Dynamic Preview Rendering Loop (Pro fallbacks included) ---
function renderLoop() {
  if (!isStreamActive || !isDrawing) {
    renderLoopId = null;
    return;
  }
  
  // 1. Process combined Exposure Value (EV) and ISO brightness + contrast scaling + saturation shifts for moody/cinematic feel
  let brightness = 1.0;
  brightness *= (1.0 + appState.exposure * 0.4);
  let contrast = 1.0;
  let saturation = 1.0;
  let grainOpacity = 0;
  
  if (appState.iso !== 'auto') {
    const isoVal = parseInt(appState.iso);
    if (isoVal === 50) {
      brightness *= 0.4;
      contrast *= 1.15;
      saturation *= 1.10;
    } else if (isoVal === 100) {
      brightness *= 0.7;
      contrast *= 1.05;
      saturation *= 1.0;
    } else if (isoVal === 200) {
      brightness *= 1.0;
      contrast *= 1.0;
      saturation *= 1.0;
    } else if (isoVal === 400) {
      brightness *= 1.35;
      contrast *= 1.02;
      saturation *= 0.95;
      grainOpacity = 0.04;
    } else if (isoVal === 800) {
      brightness *= 1.8;
      contrast *= 1.08;
      saturation *= 0.90;
      grainOpacity = 0.08;
    } else if (isoVal === 1600) {
      brightness *= 2.5;
      contrast *= 1.15;
      saturation *= 0.85;
      grainOpacity = 0.14;
    } else if (isoVal === 3200) {
      brightness *= 3.4;
      contrast *= 1.25;
      saturation *= 0.75;
      grainOpacity = 0.22; // heavy dynamic film grain for artistic night mood shots
    }
  }
  
  // EV moody grade: darker exposure enhances contrast and mutes highlights/colors
  if (appState.exposure < 0) {
    contrast *= (1.0 - appState.exposure * 0.15);
    saturation *= (1.0 + appState.exposure * 0.12);
  } else if (appState.exposure > 0) {
    contrast *= (1.0 - appState.exposure * 0.1);
  }
  
  // 2. Process focus distance blur simulation (face sharpest at 70%)
  let blurPx = 0;
  if (appState.focus !== 'auto') {
    const focVal = parseInt(appState.focus);
    if (focVal < 70) {
      blurPx = ((70 - focVal) / 70) * 8; // Macro blur up to 8px
    } else {
      blurPx = ((focVal - 70) / 30) * 3; // Infinity blur up to 3px
    }
  }
  
  const finalBrightness = Math.max(10, Math.round(brightness * 100));
  const finalContrast = Math.max(10, Math.round(contrast * 100));
  const finalSaturate = Math.max(0, Math.round(saturation * 100));
  let filterStr = `brightness(${finalBrightness}%) contrast(${finalContrast}%) saturate(${finalSaturate}%)`;
  if (blurPx > 0.1) {
    filterStr += ` blur(${blurPx.toFixed(1)}px)`;
  }
  
  // Apply accumulative CSS filter adjustments directly to native video DOM element, skipping DOM updates when unchanged
  if (filterStr !== lastAppliedFilter) {
    video.style.filter = filterStr;
    lastAppliedFilter = filterStr;
  }
  
  // Mirror state styling checks (sync class triggers)
  if (appState.mirror) {
    video.classList.remove('unmirrored');
  } else {
    video.classList.add('unmirrored');
  }
  
  // 3. Process Color Temperature / White Balance tint overlay (using GPU composite source-over overlays)
  if (appState.whitebalance !== 'auto') {
    const temp = parseInt(appState.whitebalance);
    if (temp > 5500) {
      const opacity = ((temp - 5500) / 2500) * 0.18;
      wbOverlay.style.backgroundColor = 'rgba(229, 193, 88, 1)';
      wbOverlay.style.opacity = opacity;
    } else if (temp < 5500) {
      const opacity = ((5500 - temp) / 3000) * 0.18;
      wbOverlay.style.backgroundColor = 'rgba(64, 156, 255, 1)';
      wbOverlay.style.opacity = opacity;
    } else {
      wbOverlay.style.opacity = 0;
    }
  } else {
    wbOverlay.style.opacity = 0;
  }
  
  // 4. Process ISO High gain chromatic dynamic grain noise overlay via CSS animations
  if (grainOpacity > 0) {
    grainOverlay.style.opacity = grainOpacity;
    grainOverlay.classList.add('active');
  } else {
    grainOverlay.style.opacity = 0;
    grainOverlay.classList.remove('active');
  }
  
  // 5. Downsample frame low-frequency and calculate luminance histogram
  if (frameCount % 6 === 0) {
    drawHistogram();
  }
  
  frameCount++;
  renderLoopId = requestAnimationFrame(renderLoop);
}

// --- Live Luminance Histogram Calculations ---
function drawHistogram() {
  if (!isStreamActive) return;
  
  // Clear offscreen canvas
  miniCtx.save();
  miniCtx.clearRect(0, 0, 40, 30);
  
  // Apply active visual filters to the micro-canvas so the histogram updates accurately
  let brightness = 1.0;
  brightness *= (1.0 + appState.exposure * 0.4);
  let contrast = 1.0;
  let saturation = 1.0;
  if (appState.iso !== 'auto') {
    const isoVal = parseInt(appState.iso);
    if (isoVal === 50) {
      brightness *= 0.4;
      contrast *= 1.15;
      saturation *= 1.10;
    } else if (isoVal === 100) {
      brightness *= 0.7;
      contrast *= 1.05;
      saturation *= 1.0;
    } else if (isoVal === 200) {
      brightness *= 1.0;
    } else if (isoVal === 400) {
      brightness *= 1.35;
      contrast *= 1.02;
      saturation *= 0.95;
    } else if (isoVal === 800) {
      brightness *= 1.8;
      contrast *= 1.08;
      saturation *= 0.90;
    } else if (isoVal === 1600) {
      brightness *= 2.5;
      contrast *= 1.15;
      saturation *= 0.85;
    } else if (isoVal === 3200) {
      brightness *= 3.4;
      contrast *= 1.25;
      saturation *= 0.75;
    }
  }
  
  if (appState.exposure < 0) {
    contrast *= (1.0 - appState.exposure * 0.15);
    saturation *= (1.0 + appState.exposure * 0.12);
  } else if (appState.exposure > 0) {
    contrast *= (1.0 - appState.exposure * 0.1);
  }
  
  let blurPx = 0;
  if (appState.focus !== 'auto') {
    const focVal = parseInt(appState.focus);
    if (focVal < 70) blurPx = ((70 - focVal) / 70) * 8;
    else blurPx = ((focVal - 70) / 30) * 3;
  }
  
  const finalBrightness = Math.max(10, Math.round(brightness * 100));
  const finalContrast = Math.max(10, Math.round(contrast * 100));
  const finalSaturate = Math.max(0, Math.round(saturation * 100));
  let filterStr = `brightness(${finalBrightness}%) contrast(${finalContrast}%) saturate(${finalSaturate}%)`;
  if (blurPx > 0.1) {
    filterStr += ` blur(${blurPx.toFixed(1)}px)`;
  }
  
  miniCtx.filter = filterStr;
  
  // Calculate source bounds to center-crop onto the micro-canvas
  let targetAspect = 3/4;
  if (appState.aspectRatio === '16:9') targetAspect = 9/16;
  else if (appState.aspectRatio === '1:1') targetAspect = 1/1;
  
  const streamAspect = video.videoWidth / video.videoHeight;
  let sx = 0, sy = 0, sw = video.videoWidth, sh = video.videoHeight;
  if (streamAspect > targetAspect) {
    sw = video.videoHeight * targetAspect;
    sx = (video.videoWidth - sw) / 2;
  } else {
    sh = video.videoWidth / targetAspect;
    sy = (video.videoHeight - sh) / 2;
  }
  
  // Draw raw video directly on the micro-canvas with active settings filters applied
  miniCtx.drawImage(video, sx, sy, sw, sh, 0, 0, 40, 30);
  miniCtx.restore();
  
  // Draw White Balance tint on the micro-canvas
  if (appState.whitebalance !== 'auto') {
    const temp = parseInt(appState.whitebalance);
    miniCtx.save();
    if (temp > 5500) {
      const opacity = ((temp - 5500) / 2500) * 0.18;
      miniCtx.fillStyle = `rgba(229, 193, 88, ${opacity})`;
      miniCtx.fillRect(0, 0, 40, 30);
    } else if (temp < 5500) {
      const opacity = ((5500 - temp) / 3000) * 0.18;
      miniCtx.fillStyle = `rgba(64, 156, 255, ${opacity})`;
      miniCtx.fillRect(0, 0, 40, 30);
    }
    miniCtx.restore();
  }
  
  const imgData = miniCtx.getImageData(0, 0, 40, 30);
  const data = imgData.data;
  
  const bins = new Array(256).fill(0);
  let maxCount = 0;
  
  // Read pixel RGB and calculate luminance Y
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i+1];
    const b = data[i+2];
    const y = Math.round(0.299*r + 0.587*g + 0.114*b);
    bins[y]++;
    if (bins[y] > maxCount) {
      maxCount = bins[y];
    }
  }
  
  // Render graph
  histogramCtx.clearRect(0, 0, histogramCanvas.width, histogramCanvas.height);
  if (maxCount === 0) return;
  
  histogramCtx.fillStyle = 'rgba(229, 193, 88, 0.45)'; // Semi-translucent gold area
  histogramCtx.beginPath();
  histogramCtx.moveTo(0, histogramCanvas.height);
  
  const step = histogramCanvas.width / 256;
  for (let j = 0; j < 256; j++) {
    const height = (bins[j] / maxCount) * (histogramCanvas.height - 4);
    const x = j * step;
    const y = histogramCanvas.height - height;
    histogramCtx.lineTo(x, y);
  }
  
  histogramCtx.lineTo(histogramCanvas.width, histogramCanvas.height);
  histogramCtx.closePath();
  histogramCtx.fill();
  
  // Render golden outline on top edge
  histogramCtx.strokeStyle = 'rgba(229, 193, 88, 0.9)';
  histogramCtx.lineWidth = 1;
  histogramCtx.beginPath();
  for (let j = 0; j < 256; j++) {
    const height = (bins[j] / maxCount) * (histogramCanvas.height - 4);
    const x = j * step;
    const y = histogramCanvas.height - height;
    if (j === 0) histogramCtx.moveTo(x, y);
    else histogramCtx.lineTo(x, y);
  }
  histogramCtx.stroke();
}

// --- Live Spirit Level (DeviceOrientation Handler) ---
function initSpiritLevel() {
  window.addEventListener('deviceorientation', handleDeviceOrientation);
}

function handleDeviceOrientation(e) {
  if (!appState.levelActive) return;
  
  const roll = e.gamma || 0; // Left-Right rotation (-90 to 90)
  const pitch = e.beta || 0; // Forward-Backward tilt (-180 to 180)
  
  const levelH = document.querySelector('.level-line-h');
  const levelTarget = document.querySelector('.level-target-dot');
  
  // Map roll pitch degrees to physical pixel constraints
  // Maximum rotation angle boundary representation
  const maxRoll = 15;
  const maxPitch = 15;
  
  // Apply low-pass filter (exponential smoothing) to filter raw accelerometer noise
  if (smoothRoll === null) {
    smoothRoll = roll;
    smoothPitch = pitch;
  } else {
    const k = 0.15; // smoothing coefficient
    smoothRoll = smoothRoll * (1 - k) + roll * k;
    smoothPitch = smoothPitch * (1 - k) + pitch * k;
  }
  
  const clampedRoll = Math.max(-maxRoll, Math.min(maxRoll, smoothRoll));
  const clampedPitch = Math.max(-maxPitch, Math.min(maxPitch, smoothPitch));
  
  // Scale translations: 1 degree tilt moves marker by 4 pixels
  const transX = clampedRoll * 4;
  const transY = clampedPitch * 4;
  
  // Transform elements
  levelH.style.transform = `rotate(${-smoothRoll}deg)`;
  levelTarget.style.transform = `translate(calc(-50% + ${transX}px), calc(-50% + ${transY}px))`;
  
  // Perfect alignment lock
  if (Math.abs(smoothRoll) < 0.8 && Math.abs(smoothPitch) < 0.8) {
    levelOverlay.classList.add('perfect');
  } else {
    levelOverlay.classList.remove('perfect');
  }
}

// Request DeviceOrientation Permission (Required for modern iOS)
async function requestOrientationPermission() {
  if (typeof DeviceOrientationEvent !== 'undefined' && 
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const permissionState = await DeviceOrientationEvent.requestPermission();
      if (permissionState === 'granted') {
        initSpiritLevel();
        return true;
      }
      return false;
    } catch (error) {
      console.warn("Failed requesting orientation permissions: ", error);
      return false;
    }
  } else {
    // Android or generic browsers
    initSpiritLevel();
    return true;
  }
}

// --- Shutter Capture Action flow ---
async function triggerCapture() {
  if (appState.isCapturing || !isStreamActive) return;
  
  appState.isCapturing = true;
  shutterBtn.disabled = true;
  
  // Haptic vibration feedback on photo capture if supported
  if (navigator.vibrate) navigator.vibrate(50);
  
  // 1. Handle Self-timer delay if selected
  if (appState.timer > 0) {
    timerOverlay.classList.add('active');
    let count = appState.timer;
    
    const runTimer = () => {
      timerNumber.innerText = count;
      timerNumber.classList.remove('pulse');
      void timerNumber.offsetWidth; // Trigger reflow
      timerNumber.classList.add('pulse');
      
      // Quick tone beep for countdown feedback
      playTimerBeep(count === 1 ? 880 : 440);
      
      if (count === 0) {
        timerOverlay.classList.remove('active');
        executeSnapshot();
      } else {
        count--;
        setTimeout(runTimer, 1000);
      }
    };
    
    runTimer();
  } else {
    executeSnapshot();
  }
}

// Sound buzzer for timer countdown feedback
function playTimerBeep(freq) {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    
    gainNode.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
    
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    osc.start();
    osc.stop(audioCtx.currentTime + 0.15);

    // Automatically close audio context to free resources
    setTimeout(() => {
      if (audioCtx.state !== 'closed') {
        audioCtx.close();
      }
    }, 500);
  } catch (e) {}
}

async function executeSnapshot() {
  // Apply flash overlay visual effect
  flashOverlay.classList.add('flash');
  setTimeout(() => flashOverlay.classList.remove('flash'), 350);
  
  // Play camera shutter sound
  playShutterSound();
  
  // Get raw video native size
  let rawW = video.videoWidth;
  let rawH = video.videoHeight;
  
  // Fallback to preview canvas size if video track sizes aren't loaded
  if (!rawW || !rawH) {
    rawW = canvas.width;
    rawH = canvas.height;
  }
  
  let targetAspect = 3/4;
  if (appState.aspectRatio === '16:9') targetAspect = 9/16;
  else if (appState.aspectRatio === '1:1') targetAspect = 1/1;
  
  const streamAspect = rawW / rawH;
  let sx = 0, sy = 0, sw = rawW, sh = rawH;
  
  if (streamAspect > targetAspect) {
    sw = rawH * targetAspect;
    sx = (rawW - sw) / 2;
  } else {
    sh = rawW / targetAspect;
    sy = (rawH - sh) / 2;
  }
  
  let captureCanvas = document.createElement('canvas');
  captureCanvas.width = Math.round(sw);
  captureCanvas.height = Math.round(sh);
  const cCtx = captureCanvas.getContext('2d');
  
  // Ensure maximum image quality on capture
  cCtx.imageSmoothingEnabled = true;
  cCtx.imageSmoothingQuality = 'high';
  
  // 1. Calculate visual filters
  let brightness = 1.0;
  brightness *= (1.0 + appState.exposure * 0.4);
  let contrast = 1.0;
  let saturation = 1.0;
  let grainOpacity = 0;
  
  if (appState.iso !== 'auto') {
    const isoVal = parseInt(appState.iso);
    if (isoVal === 50) {
      brightness *= 0.4;
      contrast *= 1.15;
      saturation *= 1.10;
    } else if (isoVal === 100) {
      brightness *= 0.7;
      contrast *= 1.05;
      saturation *= 1.0;
    } else if (isoVal === 200) {
      brightness *= 1.0;
      contrast *= 1.0;
      saturation *= 1.0;
    } else if (isoVal === 400) {
      brightness *= 1.35;
      contrast *= 1.02;
      saturation *= 0.95;
      grainOpacity = 0.04;
    } else if (isoVal === 800) {
      brightness *= 1.8;
      contrast *= 1.08;
      saturation *= 0.90;
      grainOpacity = 0.08;
    } else if (isoVal === 1600) {
      brightness *= 2.5;
      contrast *= 1.15;
      saturation *= 0.85;
      grainOpacity = 0.14;
    } else if (isoVal === 3200) {
      brightness *= 3.4;
      contrast *= 1.25;
      saturation *= 0.75;
      grainOpacity = 0.22;
    }
  }
  
  // EV moody grade: darker exposure enhances contrast and mutes highlights/colors
  if (appState.exposure < 0) {
    contrast *= (1.0 - appState.exposure * 0.15);
    saturation *= (1.0 + appState.exposure * 0.12);
  } else if (appState.exposure > 0) {
    contrast *= (1.0 - appState.exposure * 0.1);
  }
  
  let blurPx = 0;
  if (appState.focus !== 'auto') {
    const focVal = parseInt(appState.focus);
    if (focVal < 70) {
      // scale blur relative to resolution size (preview blur is calibrated for 720px width)
      const scaleFactor = captureCanvas.width / 720;
      blurPx = (((70 - focVal) / 70) * 8) * scaleFactor;
    } else {
      const scaleFactor = captureCanvas.width / 720;
      blurPx = (((focVal - 70) / 30) * 3) * scaleFactor;
    }
  }
  
  const finalBrightness = Math.max(10, Math.round(brightness * 100));
  const finalContrast = Math.max(10, Math.round(contrast * 100));
  const finalSaturate = Math.max(0, Math.round(saturation * 100));
  let filterStr = `brightness(${finalBrightness}%) contrast(${finalContrast}%) saturate(${finalSaturate}%)`;
  if (blurPx > 0.1) {
    filterStr += ` blur(${blurPx.toFixed(1)}px)`;
  }
  
  // Apply context filters
  cCtx.save();
  cCtx.filter = filterStr;
  
  // Mirror if active
  if (appState.mirror) {
    cCtx.translate(captureCanvas.width, 0);
    cCtx.scale(-1, 1);
  }
  
  // Draw center-cropped raw video frame with brightness/contrast/blur filters applied
  cCtx.drawImage(video, sx, sy, sw, sh, 0, 0, captureCanvas.width, captureCanvas.height);
  cCtx.restore();
  
  // 2. Draw White Balance tint
  if (appState.whitebalance !== 'auto') {
    const temp = parseInt(appState.whitebalance);
    cCtx.save();
    if (temp > 5500) {
      const opacity = ((temp - 5500) / 2500) * 0.22;
      cCtx.fillStyle = `rgba(229, 193, 88, ${opacity})`;
      cCtx.globalCompositeOperation = 'soft-light';
      cCtx.fillRect(0, 0, captureCanvas.width, captureCanvas.height);
    } else if (temp < 5500) {
      const opacity = ((5500 - temp) / 3000) * 0.22;
      cCtx.fillStyle = `rgba(64, 156, 255, ${opacity})`;
      cCtx.globalCompositeOperation = 'soft-light';
      cCtx.fillRect(0, 0, captureCanvas.width, captureCanvas.height);
    }
    cCtx.restore();
  }
  
  // 3. Draw dynamic chromatic noise grain
  if (grainOpacity > 0 && noiseCanvases.length > 0) {
    cCtx.save();
    cCtx.globalAlpha = grainOpacity;
    cCtx.globalCompositeOperation = 'overlay';
    // Select a random noise canvas to maintain dynamic appearance
    const randNoiseCanvas = noiseCanvases[Math.floor(Math.random() * noiseCanvases.length)];
    const pattern = cCtx.createPattern(randNoiseCanvas, 'repeat');
    cCtx.fillStyle = pattern;
    cCtx.fillRect(0, 0, captureCanvas.width, captureCanvas.height);
    cCtx.restore();
  }
  
  // Save captured canvas to blob with 98% high quality compression
  captureCanvas.toBlob(async (blob) => {
    if (!blob) {
      showToast("Error: Capture Failed");
      appState.isCapturing = false;
      shutterBtn.disabled = false;
      return;
    }
    
    // Create database metadata properties object
    const settingsLog = {
      iso: appState.iso,
      ev: appState.exposure,
      wb: appState.whitebalance,
      foc: appState.focus,
      aspect: appState.aspectRatio
    };
    
    const photoData = {
      blob: blob,
      timestamp: Date.now(),
      settings: settingsLog
    };
    
    // Save to database
    try {
      const savedId = await savePhotoToDB(photoData);
      showToast("Photo captured");
      
      // Update gallery thumbnail
      updateThumbnail(blob);
      
    } catch (e) {
      console.error(e);
      showToast("Error saving image");
    }
    
    appState.isCapturing = false;
    shutterBtn.disabled = false;
  }, 'image/jpeg', 0.98);
}

// --- IndexedDB Access Operations ---
function savePhotoToDB(photoData) {
  return new Promise((resolve, reject) => {
    if (!db) return reject("Database offline");
    
    const transaction = db.transaction(['photos'], 'readwrite');
    const store = transaction.objectStore('photos');
    const request = store.add(photoData);
    
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

function getAllPhotosFromDB() {
  return new Promise((resolve, reject) => {
    if (!db) return resolve([]);
    
    const transaction = db.transaction(['photos'], 'readonly');
    const store = transaction.objectStore('photos');
    const request = store.getAll();
    
    request.onsuccess = (e) => {
      // Sort newest photos first
      const photos = e.target.result || [];
      photos.sort((a, b) => b.timestamp - a.timestamp);
      resolve(photos);
    };
    request.onerror = (e) => reject(e.target.error);
  });
}

function deletePhotoFromDB(id) {
  return new Promise((resolve, reject) => {
    if (!db) return reject("Database offline");
    
    const transaction = db.transaction(['photos'], 'readwrite');
    const store = transaction.objectStore('photos');
    const request = store.delete(id);
    
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e.target.error);
  });
}

// --- UI Controls Interactions & Dynamic Dials ---
function setupUIListeners() {
  
  // 1. Hud Aspect Ratio Button
  ratioBtn.addEventListener('click', () => {
    if (appState.aspectRatio === '4:3') {
      appState.aspectRatio = '16:9';
    } else if (appState.aspectRatio === '16:9') {
      appState.aspectRatio = '1:1';
    } else {
      appState.aspectRatio = '4:3';
    }
    
    ratioBtn.querySelector('span').innerText = appState.aspectRatio;
    updateCanvasDimensions();
    showToast(`Aspect Ratio: ${appState.aspectRatio}`);
  });
  
  // 2. Hud Grid Selector
  gridBtn.addEventListener('click', () => {
    if (appState.gridType === 'off') {
      appState.gridType = 'thirds';
      gridBtn.classList.add('active');
    } else if (appState.gridType === 'thirds') {
      appState.gridType = 'golden';
    } else if (appState.gridType === 'golden') {
      appState.gridType = 'square';
    } else {
      appState.gridType = 'off';
      gridBtn.classList.remove('active');
    }
    
    gridOverlay.setAttribute('data-grid', appState.gridType);
    showToast(`Grid: ${appState.gridType.toUpperCase()}`);
  });
  
  // 3. Hud Level Toggle
  levelBtn.addEventListener('click', async () => {
    appState.levelActive = !appState.levelActive;
    if (appState.levelActive) {
      const granted = await requestOrientationPermission();
      if (granted) {
        levelBtn.classList.add('active');
        levelOverlay.classList.add('active');
        showToast("Level HUD Enabled");
      } else {
        appState.levelActive = false;
        showToast("Orientation Permission Denied");
      }
    } else {
      levelBtn.classList.remove('active');
      levelOverlay.classList.remove('active');
      showToast("Level HUD Disabled");
    }
  });
  
  // 4. Hud Mirror Front Video Toggle
  mirrorBtn.addEventListener('click', () => {
    appState.mirror = !appState.mirror;
    if (appState.mirror) {
      mirrorBtn.classList.add('active');
      video.classList.remove('unmirrored');
      canvas.classList.remove('unmirrored');
      showToast("Front Mirroring Active");
    } else {
      mirrorBtn.classList.remove('active');
      video.classList.add('unmirrored');
      canvas.classList.add('unmirrored');
      showToast("Mirroring Disabled");
    }
  });
  
  // 5. Hud Timer toggle
  timerBtn.addEventListener('click', () => {
    if (appState.timer === 0) appState.timer = 3;
    else if (appState.timer === 3) appState.timer = 5;
    else if (appState.timer === 5) appState.timer = 10;
    else appState.timer = 0;
    
    if (appState.timer > 0) {
      timerBtn.classList.add('active');
      showToast(`Timer: ${appState.timer}s`);
    } else {
      timerBtn.classList.remove('active');
      showToast("Timer: Off");
    }
  });
  
  // 6. Pro Option scrolling bar tabs hookups
  proMenuItems.forEach(item => {
    item.addEventListener('click', () => {
      proMenuItems.forEach(btn => btn.classList.remove('active'));
      item.classList.add('active');
      
      const controlType = item.getAttribute('data-control');
      activateDialControl(controlType);
    });
  });
  
  // 7. Interactive dial settings input range adjustments
  dialRangeInput.addEventListener('input', (e) => {
    const rawVal = parseFloat(e.target.value);
    updateProParameter(appState.activeControl, rawVal);
  });
  
  // 8. Shutter Capture press trigger
  shutterBtn.addEventListener('click', () => {
    triggerCapture();
  });
  
  // 9. Reset button to auto settings
  resetProBtn.addEventListener('click', () => {
    resetAllProParameters();
  });
  
  // 10. Photo Viewfinder manual tap-to-focus indicator lock
  video.addEventListener('click', (e) => {
    const rect = video.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Position target focus ring indicator relative to the viewport container parent
    const parentRect = video.parentElement.getBoundingClientRect();
    const ringX = e.clientX - parentRect.left;
    const ringY = e.clientY - parentRect.top;
    manualFocusRing.style.left = `${ringX}px`;
    manualFocusRing.style.top = `${ringY}px`;
    manualFocusRing.classList.add('active');
    
    // Quick vibration/tactile click if supported
    if (navigator.vibrate) navigator.vibrate(20);
    
    // Auto reset indicator display after brief delay
    setTimeout(() => {
      manualFocusRing.classList.remove('active');
    }, 1200);
    
    showToast("Focus Locked");
  });
  
  // 11. Mode switches
  modeTabPhoto.addEventListener('click', () => {
    switchToMode('photo');
  });
  modeTabPro.addEventListener('click', () => {
    switchToMode('pro');
  });
}

function switchToMode(mode) {
  appState.currentMode = mode;
  if (mode === 'photo') {
    modeTabPhoto.classList.add('active');
    modeTabPro.classList.remove('active');
    resetAllProParameters();
    
    // Hide controls HUD
    document.getElementById('pro-menu-scroller').style.display = 'none';
    dialContainer.style.display = 'none';
    shutterBtn.classList.remove('pro-active-shutter');
    showToast("Photo Auto Mode");
  } else {
    modeTabPhoto.classList.remove('active');
    modeTabPro.classList.add('active');
    
    // Show controls HUD
    document.getElementById('pro-menu-scroller').style.display = 'block';
    dialContainer.style.display = 'flex';
    shutterBtn.classList.add('pro-active-shutter');
    activateDialControl(appState.activeControl);
    showToast("Pro Settings Active");
  }
}

// Adjust Dial Min, Max, Value bounds depending on parameter selected
function activateDialControl(control) {
  appState.activeControl = control;
  
  if (control === 'auto') {
    dialContainer.style.visibility = 'hidden';
    resetAllProParameters();
    return;
  }
  
  dialContainer.style.visibility = 'visible';
  dialContainer.style.display = 'flex';
  
  switch (control) {
    case 'exposure':
      dialLabelValue.innerText = `EXPOSURE: ${appState.exposure >= 0 ? '+' : ''}${appState.exposure.toFixed(1)} EV`;
      dialRangeInput.min = -2.0;
      dialRangeInput.max = 2.0;
      dialRangeInput.step = 0.1;
      dialRangeInput.value = appState.exposure;
      break;
      
    case 'iso':
      dialRangeInput.min = 0;
      dialRangeInput.max = 7;
      dialRangeInput.step = 1;
      
      const isoMap = ['auto', 50, 100, 200, 400, 800, 1600, 3200];
      const activeIdx = isoMap.indexOf(appState.iso === 'auto' ? 'auto' : parseInt(appState.iso));
      dialRangeInput.value = activeIdx !== -1 ? activeIdx : 0;
      dialLabelValue.innerText = `ISO: ${appState.iso.toUpperCase()}`;
      break;
      
    case 'whitebalance':
      dialRangeInput.min = 0;
      dialRangeInput.max = 56; // ranges representing increments: Auto or 2500K - 8000K in steps of 100
      dialRangeInput.step = 1;
      
      if (appState.whitebalance === 'auto') {
        dialRangeInput.value = 0;
        dialLabelValue.innerText = `WHITE BALANCE: AUTO`;
      } else {
        // Map 2500K-8000K to slider indices 1-56
        const stepsIdx = Math.round((parseInt(appState.whitebalance) - 2500) / 100) + 1;
        dialRangeInput.value = stepsIdx;
        dialLabelValue.innerText = `WHITE BALANCE: ${appState.whitebalance} K`;
      }
      break;
      
    case 'focus':
      dialRangeInput.min = 0;
      dialRangeInput.max = 100; // slider ranges: 0 representing Auto, 1-100 representing focal ranges
      dialRangeInput.step = 1;
      
      if (appState.focus === 'auto') {
        dialRangeInput.value = 0;
        dialLabelValue.innerText = `FOCUS DISTANCE: AUTO`;
      } else {
        dialRangeInput.value = appState.focus;
        dialLabelValue.innerText = `MANUAL FOCUS: ${appState.focus}%`;
      }
      break;
  }
}

// Save Slider value into State variables & updates display text elements
function updateProParameter(param, val) {
  switch (param) {
    case 'exposure':
      appState.exposure = val;
      dialLabelValue.innerText = `EXPOSURE: ${val >= 0 ? '+' : ''}${val.toFixed(1)} EV`;
      document.getElementById('menu-val-exposure').innerText = `${val >= 0 ? '+' : ''}${val.toFixed(1)}`;
      badgeEv.querySelector('span').innerText = `${val >= 0 ? '+' : ''}${val.toFixed(1)}`;
      break;
      
    case 'iso':
      const isoMap = ['auto', 50, 100, 200, 400, 800, 1600, 3200];
      const targetIso = isoMap[Math.round(val)];
      appState.iso = targetIso;
      
      dialLabelValue.innerText = `ISO: ${targetIso === 'auto' ? 'AUTO' : targetIso}`;
      document.getElementById('menu-val-iso').innerText = `${targetIso === 'auto' ? 'AUTO' : targetIso}`;
      badgeIso.querySelector('span').innerText = `${targetIso === 'auto' ? 'AUTO' : targetIso}`;
      break;
      
    case 'whitebalance':
      if (Math.round(val) === 0) {
        appState.whitebalance = 'auto';
        dialLabelValue.innerText = `WHITE BALANCE: AUTO`;
        document.getElementById('menu-val-whitebalance').innerText = `AUTO`;
        badgeWb.querySelector('span').innerText = `AUTO`;
      } else {
        const kelvin = 2500 + (Math.round(val) - 1) * 100;
        appState.whitebalance = kelvin;
        dialLabelValue.innerText = `WHITE BALANCE: ${kelvin} K`;
        document.getElementById('menu-val-whitebalance').innerText = `${kelvin}K`;
        badgeWb.querySelector('span').innerText = `${kelvin}K`;
      }
      break;
      
    case 'focus':
      if (Math.round(val) === 0) {
        appState.focus = 'auto';
        dialLabelValue.innerText = `FOCUS DISTANCE: AUTO`;
        document.getElementById('menu-val-focus').innerText = `AUTO`;
        badgeFoc.querySelector('span').innerText = `AUTO`;
      } else {
        appState.focus = Math.round(val);
        dialLabelValue.innerText = `MANUAL FOCUS: ${Math.round(val)}%`;
        document.getElementById('menu-val-focus').innerText = `${Math.round(val)}%`;
        badgeFoc.querySelector('span').innerText = `${Math.round(val)}%`;
      }
      break;
  }
  
  // Apply changes natively where hardware supports it
  applyNativeTrackConstraints();
}

function resetAllProParameters() {
  appState.exposure = 0.0;
  appState.iso = 'auto';
  appState.whitebalance = 'auto';
  appState.focus = 'auto';
  
  // Update HUD text items
  document.getElementById('menu-val-exposure').innerText = '0.0';
  document.getElementById('menu-val-iso').innerText = 'AUTO';
  document.getElementById('menu-val-whitebalance').innerText = 'AUTO';
  document.getElementById('menu-val-focus').innerText = 'AUTO';
  
  badgeEv.querySelector('span').innerText = '0.0';
  badgeIso.querySelector('span').innerText = 'AUTO';
  badgeWb.querySelector('span').innerText = 'AUTO';
  badgeFoc.querySelector('span').innerText = 'AUTO';
  
  // Set scroller item selection
  proMenuItems.forEach(btn => btn.classList.remove('active'));
  document.querySelector('[data-control="auto"]').classList.add('active');
  
  appState.activeControl = 'auto';
  dialContainer.style.visibility = 'hidden';
  
  applyNativeTrackConstraints();
  showToast("Pro settings reset to AUTO");
}

async function applyNativeTrackConstraints() {
  if (!videoTrack || !videoTrack.applyConstraints) return;
  
  const constraints = {};
  const caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
  
  // Try to set native track ISO
  if (appState.iso !== 'auto' && caps.iso) {
    constraints.iso = Math.max(caps.iso.min, Math.min(caps.iso.max, parseInt(appState.iso)));
  }
  
  // Try to set native exposure compensation
  if (appState.exposure !== 0 && caps.exposureCompensation) {
    constraints.exposureCompensation = Math.max(caps.exposureCompensation.min, Math.min(caps.exposureCompensation.max, appState.exposure));
  }
  
  // Try to set native white balance Kelvin temperature
  if (appState.whitebalance !== 'auto' && caps.colorTemperature) {
    constraints.whiteBalanceMode = 'manual';
    constraints.colorTemperature = Math.max(caps.colorTemperature.min, Math.min(caps.colorTemperature.max, parseInt(appState.whitebalance)));
  } else if (caps.whiteBalanceMode) {
    constraints.whiteBalanceMode = 'continuous';
  }
  
  // Try to set native focus
  if (appState.focus !== 'auto' && caps.focusDistance) {
    constraints.focusMode = 'manual';
    const min = caps.focusDistance.min;
    const max = caps.focusDistance.max;
    // Map slider values 1-100 to min-max focus distance
    const scalar = (appState.focus - 1) / 99;
    constraints.focusDistance = min + scalar * (max - min);
  } else if (caps.focusMode) {
    constraints.focusMode = 'continuous';
  }
  
  if (Object.keys(constraints).length > 0) {
    try {
      await videoTrack.applyConstraints({ advanced: [constraints] });
    } catch (e) {
      console.warn("Failed applying native camera constraints:", e);
    }
  }
}

// --- PWA Toast Overlay Notifications ---
let toastTimer = null;
function showToast(message) {
  toastNotification.innerText = message;
  toastNotification.classList.add('show');
  
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastNotification.classList.remove('show');
  }, 2000);
}

// --- Thumbnail Preview Management ---
function updateThumbnail(blob) {
  if (thumbnailURL) {
    URL.revokeObjectURL(thumbnailURL);
  }
  thumbnailURL = URL.createObjectURL(blob);
  
  // Clean elements inside thumbnail
  galleryThumbBtn.innerHTML = '';
  
  const img = document.createElement('img');
  img.src = thumbnailURL;
  galleryThumbBtn.appendChild(img);
}

async function loadLastPhotoThumbnail() {
  try {
    const photos = await getAllPhotosFromDB();
    if (photos && photos.length > 0) {
      updateThumbnail(photos[0].blob);
    }
  } catch (err) {
    console.warn("Failed loading last thumbnail:", err);
  }
}

// --- Local Gallery Overlay Engine ---
galleryThumbBtn.addEventListener('click', () => {
  openGalleryDrawer();
});

galleryBackBtn.addEventListener('click', () => {
  closeGalleryDrawer();
});

function updateRenderState() {
  const shouldDraw = !galleryPanel.classList.contains('active') && !photoViewer.classList.contains('active');
  if (shouldDraw && !isDrawing) {
    isDrawing = true;
    if (!renderLoopId && isStreamActive) {
      renderLoopId = requestAnimationFrame(renderLoop);
    }
  } else if (!shouldDraw && isDrawing) {
    isDrawing = false;
  }
}

async function openGalleryDrawer() {
  galleryPanel.classList.add('active');
  updateRenderState();
  await renderGalleryGrid();
}

function closeGalleryDrawer() {
  galleryPanel.classList.remove('active');
  updateRenderState();
}

async function renderGalleryGrid() {
  // Revoke previous grid URLs to release memory
  activeObjectURLs.forEach(url => URL.revokeObjectURL(url));
  activeObjectURLs = [];

  galleryGrid.innerHTML = '';
  
  try {
    const photos = await getAllPhotosFromDB();
    
    if (!photos || photos.length === 0) {
      galleryEmptyState.style.display = 'flex';
      return;
    }
    
    galleryEmptyState.style.display = 'none';
    
    photos.forEach(photo => {
      const item = document.createElement('div');
      item.className = 'gallery-grid-item';
      
      const img = document.createElement('img');
      const objectURL = URL.createObjectURL(photo.blob);
      activeObjectURLs.push(objectURL);
      img.src = objectURL;
      img.loading = 'lazy';
      
      item.appendChild(img);
      
      // Tap to open full screen viewer
      item.addEventListener('click', () => {
        openPhotoViewer(photo, objectURL);
      });
      
      galleryGrid.appendChild(item);
    });
  } catch (err) {
    console.error("Failed rendering gallery:", err);
    showToast("Error loading gallery");
  }
}

// --- Fullscreen Photo Viewer Drawer ---
let activeViewerPhoto = null;
let activeObjectURL = null;

function openPhotoViewer(photo, objectURL) {
  activeViewerPhoto = photo;
  activeObjectURL = objectURL;
  
  viewerImg.src = objectURL;
  
  // Display clean Date
  const dateObj = new Date(photo.timestamp);
  const formattedDate = dateObj.toLocaleDateString(undefined, { 
    month: 'short', 
    day: 'numeric', 
    year: 'numeric', 
    hour: '2-digit', 
    minute: '2-digit' 
  });
  metaDate.innerText = formattedDate;
  
  // Display captures attributes
  const sets = photo.settings;
  const isoStr = sets.iso === 'auto' ? 'AUTO' : `ISO ${sets.iso}`;
  const evStr = `EV ${sets.ev >= 0 ? '+' : ''}${sets.ev.toFixed(1)}`;
  const wbStr = sets.wb === 'auto' ? 'WB AUTO' : `${sets.wb}K`;
  const focStr = sets.foc === 'auto' ? 'FOC AUTO' : `FOC ${sets.foc}%`;
  
  metaSettings.innerText = `${isoStr} • ${evStr} • ${wbStr} • ${focStr}`;
  
  photoViewer.classList.add('active');
  updateRenderState();
}

function closePhotoViewer() {
  photoViewer.classList.remove('active');
  activeViewerPhoto = null;
  activeObjectURL = null;
  updateRenderState();
}

viewerBackBtn.addEventListener('click', () => {
  closePhotoViewer();
});

// Delete captured photo
viewerDeleteBtn.addEventListener('click', async () => {
  if (!activeViewerPhoto) return;
  
  const confirmDel = confirm("Delete this photo permanently?");
  if (!confirmDel) return;
  
  try {
    await deletePhotoFromDB(activeViewerPhoto.id);
    showToast("Photo deleted");
    
    closePhotoViewer();
    await renderGalleryGrid();
    await loadLastPhotoThumbnail();
  } catch (e) {
    console.error(e);
    showToast("Failed to delete photo");
  }
});

// Download photo directly into device gallery folder
viewerDownloadBtn.addEventListener('click', () => {
  if (!activeViewerPhoto) return;
  
  const link = document.createElement('a');
  link.href = activeObjectURL;
  link.download = `procam-capture-${activeViewerPhoto.id}.jpg`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast("Photo saved to downloads");
});

// Native Web Share API integration
viewerShareBtn.addEventListener('click', async () => {
  if (!activeViewerPhoto) return;
  
  const file = new File([activeViewerPhoto.blob], `procam-photo-${activeViewerPhoto.id}.jpg`, { type: 'image/jpeg' });
  
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: 'ProCam Snapshot',
        text: 'Captured on ProCam Front'
      });
      showToast("Shared successfully");
    } catch (e) {
      console.warn("Share was cancelled or failed: ", e);
    }
  } else {
    // Fallback: Copy direct file link or offer clipboard download
    showToast("Web Sharing not supported on this browser");
  }
});

function stopCamera() {
  isStreamActive = false;
  isDrawing = false;
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  video.srcObject = null;
  renderLoopId = null;
}

// Handle visibility changes (e.g. user switches tabs, locks screen, minimizes window)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopCamera();
  } else {
    isDrawing = true;
    initCamera();
  }
});

// --- Initialize App ---
window.addEventListener('DOMContentLoaded', async () => {
  initNoiseCanvases();
  await initDatabase();
  setupUIListeners();
  
  // Set initial mode to pro
  switchToMode('pro');
  
  // Trigger camera startup request
  await initCamera();
});
