const canvas = document.getElementById("xr-canvas");
const logEl = document.getElementById("log");
const enterArBtn = document.getElementById("enter-ar");

let gl = null;
let xrSession = null;
let xrRefSpace = null;
let xrGlBinding = null;

let pendingSnapshot = false;
let latestSnapshot = null;
let lastPinchTime = 0;
const PINCH_COOLDOWN_MS = 1200;

// ===== depth sampling config =====
const CENTER_WINDOW_SIZE = 15;
const GRID_ROWS = 5;
const GRID_COLS = 5;
const GRID_CELL_SIZE = 15;
const GRID_SPACING = 24;

// ===== heatmap panel config =====
const PANEL_DISTANCE = 0.7;   // 前方 0.7m
const PANEL_OFFSET_X = 0.0;   // 左右偏移
const PANEL_OFFSET_Y = 0.0;   // 上下偏移
const PANEL_WIDTH = 0.28;     // 面板宽（米）
const PANEL_HEIGHT = 0.20;    // 面板高（米）

// ===== GPU debug readback resources =====
let debugProgram = null;
let debugVAO = null;
let debugColorTex = null;
let debugFbo = null;
let debugDepthWidth = 0;
let debugDepthHeight = 0;

// ===== panel rendering resources =====
let panelProgram = null;
let panelVAO = null;
let panelTexture = null;
let panelCanvas = null;
let panelCtx = null;
let panelTextureDirty = false;

function log(...args) {
  const msg = args.map(String).join(" ");
  console.log(msg);
  logEl.textContent += "\n" + msg;
  logEl.scrollTop = logEl.scrollHeight;
}

function flattenMatrix(mat) {
  return Array.from(mat);
}

function poseToJSON(xrRigidTransform) {
  return {
    position: {
      x: xrRigidTransform.position.x,
      y: xrRigidTransform.position.y,
      z: xrRigidTransform.position.z,
      w: xrRigidTransform.position.w,
    },
    orientation: {
      x: xrRigidTransform.orientation.x,
      y: xrRigidTransform.orientation.y,
      z: xrRigidTransform.orientation.z,
      w: xrRigidTransform.orientation.w,
    },
    matrix: flattenMatrix(xrRigidTransform.matrix),
    inverseMatrix: flattenMatrix(xrRigidTransform.inverse.matrix),
  };
}

function sanitizeNumber(v) {
  return Number.isFinite(v) ? v : null;
}

function requestSnapshot(reason = "manual") {
  const now = Date.now();
  if (now - lastPinchTime < PINCH_COOLDOWN_MS) {
    log("Pinch ignored: cooldown active.");
    return;
  }

  lastPinchTime = now;
  pendingSnapshot = true;
  log("Snapshot requested by", reason);
}

function isHandInputSource(inputSource) {
  return inputSource && inputSource.hand;
}

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error("Shader compile failed: " + info);
  }

  return shader;
}

function createProgram(gl, vsSource, fsSource) {
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error("Program link failed: " + info);
  }

  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

function multiplyMat4(a, b) {
  const out = new Float32Array(16);

  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }

  return out;
}

function makeTranslationMatrix(tx, ty, tz) {
  return new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    tx, ty, tz, 1,
  ]);
}

function makeScaleMatrix(sx, sy, sz) {
  return new Float32Array([
    sx, 0, 0, 0,
    0, sy, 0, 0,
    0, 0, sz, 0,
    0, 0, 0, 1,
  ]);
}

function initDebugDrawResources() {
  const vsSource = `#version 300 es
    const vec2 POS[3] = vec2[](
      vec2(-1.0, -1.0),
      vec2( 3.0, -1.0),
      vec2(-1.0,  3.0)
    );
    out vec2 vUv;
    void main() {
      vec2 pos = POS[gl_VertexID];
      vUv = pos * 0.5 + 0.5;
      gl_Position = vec4(pos, 0.0, 1.0);
    }
  `;

  const fsSource = `#version 300 es
    precision highp float;
    precision highp sampler2D;
    precision highp sampler2DArray;

    in vec2 vUv;
    out vec4 outColor;

    uniform sampler2D uTex2D;
    uniform sampler2DArray uTexArray;
    uniform int uTextureType;
    uniform int uImageIndex;

    void main() {
      float d = 0.0;

      if (uTextureType == 0) {
        d = texture(uTex2D, vUv).r;
      } else {
        d = texture(uTexArray, vec3(vUv, float(uImageIndex))).r;
      }

      outColor = vec4(d, d, d, 1.0);
    }
  `;

  debugProgram = createProgram(gl, vsSource, fsSource);
  debugVAO = gl.createVertexArray();
}

function initPanelResources() {
  panelCanvas = document.createElement("canvas");
  panelCanvas.width = 512;
  panelCanvas.height = 384;
  panelCtx = panelCanvas.getContext("2d");

  const vsSource = `#version 300 es
    precision highp float;

    layout(location = 0) in vec2 aPosition;
    layout(location = 1) in vec2 aUv;

    uniform mat4 uMvp;
    out vec2 vUv;

    void main() {
      vUv = aUv;
      gl_Position = uMvp * vec4(aPosition, 0.0, 1.0);
    }
  `;

  const fsSource = `#version 300 es
    precision highp float;

    in vec2 vUv;
    uniform sampler2D uTexture;
    out vec4 outColor;

    void main() {
      outColor = texture(uTexture, vUv);
    }
  `;

  panelProgram = createProgram(gl, vsSource, fsSource);

  const vertices = new Float32Array([
    // x, y, u, v
    -0.5, -0.5, 0, 1,
     0.5, -0.5, 1, 1,
    -0.5,  0.5, 0, 0,
     0.5,  0.5, 1, 0,
  ]);

  panelVAO = gl.createVertexArray();
  gl.bindVertexArray(panelVAO);

  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);

  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  panelTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, panelTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    panelCanvas.width,
    panelCanvas.height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null
  );
  gl.bindTexture(gl.TEXTURE_2D, null);

  drawPlaceholderPanel();
  uploadPanelTexture();
}

function drawPlaceholderPanel() {
  const ctx = panelCtx;
  ctx.clearRect(0, 0, panelCanvas.width, panelCanvas.height);

  ctx.fillStyle = "rgba(20,20,20,0.85)";
  ctx.fillRect(0, 0, panelCanvas.width, panelCanvas.height);

  ctx.fillStyle = "white";
  ctx.font = "bold 28px sans-serif";
  ctx.fillText("Depth Heatmap", 24, 40);

  ctx.font = "20px sans-serif";
  ctx.fillText("Pinch to capture a snapshot", 24, 80);

  panelTextureDirty = true;
}

function gray01ToColor(v) {
  // 简单蓝->青->黄->红
  const t = Math.max(0, Math.min(1, v));
  const r = Math.floor(255 * Math.max(0, Math.min(1, 1.5 * t)));
  const g = Math.floor(255 * Math.max(0, Math.min(1, 1.5 * (1 - Math.abs(t - 0.5) * 2))));
  const b = Math.floor(255 * Math.max(0, Math.min(1, 1.5 * (1 - t))));
  return `rgb(${r},${g},${b})`;
}

function buildGridMatrix(regionGridStats) {
  const grid = [];
  for (let r = 0; r < regionGridStats.rows; r++) {
    const row = [];
    for (let c = 0; c < regionGridStats.cols; c++) {
      const item = regionGridStats.regions.find(x => x.row === r && x.col === c);
      row.push(item ? item.meanGray01 : null);
    }
    grid.push(row);
  }
  return grid;
}

function updateHeatmapPanel(snapshot) {
  if (!snapshot || !snapshot.regionGridStats) return;

  const ctx = panelCtx;
  const w = panelCanvas.width;
  const h = panelCanvas.height;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(20,20,20,0.88)";
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = "white";
  ctx.font = "bold 28px sans-serif";
  ctx.fillText("Depth Heatmap", 20, 36);

  ctx.font = "18px sans-serif";
  ctx.fillText(`center mean: ${snapshot.centerRegionStats?.meanGray01?.toFixed(4) ?? "n/a"}`, 20, 66);
  ctx.fillText(`depthUsage: ${snapshot.depthUsage ?? "n/a"}`, 20, 92);

  const grid = buildGridMatrix(snapshot.regionGridStats);

  const rows = grid.length;
  const cols = grid[0].length;
  const gridSize = 240;
  const cellW = gridSize / cols;
  const cellH = gridSize / rows;
  const startX = 20;
  const startY = 120;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = grid[r][c];
      ctx.fillStyle = v == null ? "rgb(80,80,80)" : gray01ToColor(v);
      ctx.fillRect(startX + c * cellW, startY + r * cellH, cellW - 2, cellH - 2);

      if (v != null) {
        ctx.fillStyle = "black";
        ctx.font = "14px sans-serif";
        ctx.fillText(
          v.toFixed(3),
          startX + c * cellW + 8,
          startY + r * cellH + cellH / 2
        );
      }
    }
  }

  // 小图例
  const legendX = 300;
  const legendY = 130;
  const legendW = 28;
  const legendH = 180;
  for (let i = 0; i < legendH; i++) {
    const t = 1 - i / (legendH - 1);
    ctx.fillStyle = gray01ToColor(t);
    ctx.fillRect(legendX, legendY + i, legendW, 1);
  }
  ctx.strokeStyle = "white";
  ctx.strokeRect(legendX, legendY, legendW, legendH);

  ctx.fillStyle = "white";
  ctx.font = "16px sans-serif";
  ctx.fillText("near-ish", legendX + 40, legendY + legendH);
  ctx.fillText("far-ish", legendX + 40, legendY + 12);

  ctx.font = "16px sans-serif";
  ctx.fillText(`window: ${snapshot.regionGridStats.cellWindowSize}x${snapshot.regionGridStats.cellWindowSize}`, 20, 345);
  ctx.fillText(`spacing: ${snapshot.regionGridStats.spacingPixels}`, 220, 345);

  panelTextureDirty = true;
}

function uploadPanelTexture() {
  if (!panelTextureDirty || !panelTexture) return;

  gl.bindTexture(gl.TEXTURE_2D, panelTexture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    panelCanvas
  );
  gl.bindTexture(gl.TEXTURE_2D, null);

  panelTextureDirty = false;
}

function drawPanelInFrontOfView(view) {
  if (!panelProgram || !panelTexture) return;

  uploadPanelTexture();

  const viewMatrix = new Float32Array(view.transform.inverse.matrix);
  const projMatrix = new Float32Array(view.projectionMatrix);

  const modelTranslate = makeTranslationMatrix(
    PANEL_OFFSET_X,
    PANEL_OFFSET_Y,
    -PANEL_DISTANCE
  );
  const modelScale = makeScaleMatrix(PANEL_WIDTH, PANEL_HEIGHT, 1);
  const modelMatrix = multiplyMat4(modelTranslate, modelScale);
  const mv = multiplyMat4(viewMatrix, modelMatrix);
  const mvp = multiplyMat4(projMatrix, mv);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);

  gl.useProgram(panelProgram);
  gl.bindVertexArray(panelVAO);

  const uMvp = gl.getUniformLocation(panelProgram, "uMvp");
  const uTexture = gl.getUniformLocation(panelProgram, "uTexture");

  gl.uniformMatrix4fv(uMvp, false, mvp);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, panelTexture);
  gl.uniform1i(uTexture, 0);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindVertexArray(null);
  gl.useProgram(null);
}

function ensureDebugTarget(width, height) {
  if (
    debugColorTex &&
    debugFbo &&
    debugDepthWidth === width &&
    debugDepthHeight === height
  ) {
    return;
  }

  if (debugColorTex) gl.deleteTexture(debugColorTex);
  if (debugFbo) gl.deleteFramebuffer(debugFbo);

  debugDepthWidth = width;
  debugDepthHeight = height;

  debugColorTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, debugColorTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    width,
    height,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null
  );

  debugFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, debugFbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    debugColorTex,
    0
  );

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error("Debug framebuffer incomplete: " + status);
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function drawDepthTextureToDebugColor(depthInfo) {
  ensureDebugTarget(depthInfo.width, depthInfo.height);

  gl.bindFramebuffer(gl.FRAMEBUFFER, debugFbo);
  gl.viewport(0, 0, depthInfo.width, depthInfo.height);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);

  gl.useProgram(debugProgram);
  gl.bindVertexArray(debugVAO);

  const uTextureType = gl.getUniformLocation(debugProgram, "uTextureType");
  const uImageIndex = gl.getUniformLocation(debugProgram, "uImageIndex");
  const uTex2D = gl.getUniformLocation(debugProgram, "uTex2D");
  const uTexArray = gl.getUniformLocation(debugProgram, "uTexArray");

  if (depthInfo.textureType === "texture-array") {
    gl.uniform1i(uTextureType, 1);
    gl.uniform1i(uImageIndex, depthInfo.imageIndex ?? 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, depthInfo.texture);

    gl.uniform1i(uTex2D, 0);
    gl.uniform1i(uTexArray, 1);
  } else {
    gl.uniform1i(uTextureType, 0);
    gl.uniform1i(uImageIndex, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, depthInfo.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

    gl.uniform1i(uTex2D, 0);
    gl.uniform1i(uTexArray, 1);
  }

  gl.drawArrays(gl.TRIANGLES, 0, 3);

  gl.bindVertexArray(null);
  gl.useProgram(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function readDebugColorPixels() {
  const pixels = new Uint8Array(debugDepthWidth * debugDepthHeight * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, debugFbo);
  gl.readPixels(
    0,
    0,
    debugDepthWidth,
    debugDepthHeight,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return pixels;
}

function getPixelRGBA(pixels, width, x, y) {
  const clampedX = Math.max(0, Math.min(width - 1, x));
  const clampedY = Math.max(0, Math.min(debugDepthHeight - 1, y));
  const idx = (clampedY * width + clampedX) * 4;
  return [pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3]];
}

function rgbaToGray01(rgba) {
  return rgba[0] / 255;
}

function computeWindowStats(pixels, width, height, centerX, centerY, windowSize) {
  const half = Math.floor(windowSize / 2);
  const values = [];

  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const x = Math.max(0, Math.min(width - 1, centerX + dx));
      const y = Math.max(0, Math.min(height - 1, centerY + dy));
      const rgba = getPixelRGBA(pixels, width, x, y);
      values.push(rgbaToGray01(rgba));
    }
  }

  let sum = 0;
  let min = Infinity;
  let max = -Infinity;

  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  return {
    center: { x: centerX, y: centerY },
    windowSize,
    sampleCount: values.length,
    meanGray01: sanitizeNumber(sum / values.length),
    minGray01: sanitizeNumber(min),
    maxGray01: sanitizeNumber(max),
  };
}

function computeGridStats(pixels, width, height, baseX, baseY) {
  const regions = [];
  const rowOffset = (GRID_ROWS - 1) / 2;
  const colOffset = (GRID_COLS - 1) / 2;

  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const centerX = Math.round(baseX + (col - colOffset) * GRID_SPACING);
      const centerY = Math.round(baseY + (row - rowOffset) * GRID_SPACING);

      const stats = computeWindowStats(
        pixels,
        width,
        height,
        centerX,
        centerY,
        GRID_CELL_SIZE
      );

      regions.push({
        row,
        col,
        name: `r${row}_c${col}`,
        ...stats,
      });
    }
  }

  return {
    rows: GRID_ROWS,
    cols: GRID_COLS,
    cellWindowSize: GRID_CELL_SIZE,
    spacingPixels: GRID_SPACING,
    regions,
  };
}

function downloadJSON(obj, filename = "snapshot-depth.json") {
  const blob = new Blob([JSON.stringify(obj, null, 2)], {
    type: "application/json"
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function initAR() {
  if (!navigator.xr) {
    log("navigator.xr not available.");
    return;
  }

  const supported = await navigator.xr.isSessionSupported("immersive-ar");
  if (!supported) {
    log("immersive-ar not supported on this browser/device.");
    return;
  }

  gl = canvas.getContext("webgl2", {
    xrCompatible: true,
    alpha: true,
    antialias: true,
  });

  if (!gl) {
    log("WebGL2 not available.");
    return;
  }

  initDebugDrawResources();
  initPanelResources();

  xrSession = await navigator.xr.requestSession("immersive-ar", {
    requiredFeatures: ["local", "depth-sensing"],
    optionalFeatures: ["hand-tracking"],
    depthSensing: {
      usagePreference: ["gpu-optimized", "cpu-optimized"],
      dataFormatPreference: ["unsigned-short", "float32", "luminance-alpha"],
    },
  });

  xrSession.addEventListener("end", () => {
    log("XR session ended.");
    xrSession = null;
    xrRefSpace = null;
    xrGlBinding = null;
  });

  xrSession.addEventListener("select", (event) => {
    if (isHandInputSource(event.inputSource)) {
      const handedness = event.inputSource.handedness || "unknown-hand";
      requestSnapshot(`pinch-${handedness}`);
    } else {
      requestSnapshot("select-non-hand");
    }
  });

  await gl.makeXRCompatible();

  const baseLayer = new XRWebGLLayer(xrSession, gl, {
    alpha: true,
  });

  xrSession.updateRenderState({ baseLayer });
  xrRefSpace = await xrSession.requestReferenceSpace("local");
  xrGlBinding = new XRWebGLBinding(xrSession, gl);

  log("AR session started.");
  log("Use pinch to capture a snapshot.");

  xrSession.requestAnimationFrame(onXRFrame);
}

function onXRFrame(time, frame) {
  const session = frame.session;
  session.requestAnimationFrame(onXRFrame);

  const pose = frame.getViewerPose(xrRefSpace);
  if (!pose) return;

  const baseLayer = session.renderState.baseLayer;
  gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);
  gl.clearColor(0.0, 0.0, 0.0, 0.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // 先渲染面板到每个 view
  for (const view of pose.views) {
    const viewport = baseLayer.getViewport(view);
    gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
    drawPanelInFrontOfView(view);
  }

  const view = pose.views[0];
  if (!view) return;

  if (pendingSnapshot) {
    pendingSnapshot = false;

    const debugLogs = [];
    debugLogs.push("----- SNAPSHOT START -----");
    debugLogs.push(`pose views count: ${pose.views.length}`);

    let depthInfo = null;
    let depthPath = "none";

    try {
      if (xrGlBinding) {
        depthInfo = xrGlBinding.getDepthInformation(view);
        if (depthInfo) depthPath = "gpu";
      }
    } catch (err) {
      debugLogs.push(`gpu getDepthInformation failed: ${err.message}`);
    }

    if (!depthInfo) {
      try {
        depthInfo = frame.getDepthInformation(view);
        if (depthInfo) depthPath = "cpu";
      } catch (err) {
        debugLogs.push(`cpu getDepthInformation failed: ${err.message}`);
      }
    }

    debugLogs.push(`depthUsage runtime: ${xrSession.depthUsage || "unknown"}`);
    debugLogs.push(`depthDataFormat runtime: ${xrSession.depthDataFormat || "unknown"}`);
    debugLogs.push(`depth path: ${depthPath}`);
    debugLogs.push(`depthInfo exists: ${depthInfo !== null}`);

    let depthSummary = null;
    let rawCenterSample = null;
    let centerRegionStats = null;
    let regionGridStats = null;

    if (depthInfo) {
      debugLogs.push(`depth width: ${depthInfo.width}`);
      debugLogs.push(`depth height: ${depthInfo.height}`);

      if (depthPath === "gpu") {
        depthSummary = {
          width: depthInfo.width,
          height: depthInfo.height,
          textureType: depthInfo.textureType,
          imageIndex: depthInfo.imageIndex ?? 0,
          type: "gpu",
        };

        debugLogs.push(`textureType: ${depthInfo.textureType}`);
        debugLogs.push(`imageIndex: ${depthInfo.imageIndex ?? 0}`);

        try {
          drawDepthTextureToDebugColor(depthInfo);
          const pixels = readDebugColorPixels();

          const centerX = Math.floor(depthInfo.width / 2);
          const centerY = Math.floor(depthInfo.height / 2);

          const centerRGBA = getPixelRGBA(pixels, depthInfo.width, centerX, centerY);
          rawCenterSample = {
            rgba: centerRGBA,
            gray01: rgbaToGray01(centerRGBA),
          };

          centerRegionStats = computeWindowStats(
            pixels,
            depthInfo.width,
            depthInfo.height,
            centerX,
            centerY,
            CENTER_WINDOW_SIZE
          );

          regionGridStats = computeGridStats(
            pixels,
            depthInfo.width,
            depthInfo.height,
            centerX,
            centerY
          );

          debugLogs.push(`raw center rgba: [${centerRGBA.join(",")}]`);
          debugLogs.push(`raw center gray01: ${rawCenterSample.gray01}`);
          debugLogs.push(`center region meanGray01: ${centerRegionStats.meanGray01}`);
        } catch (err) {
          debugLogs.push(`gpu readback failed: ${err.message}`);
        }
      } else {
        try {
          const centerDepthMeters = depthInfo.getDepthInMeters(0.5, 0.5);
          rawCenterSample = {
            gray01: null,
            depthMeters: sanitizeNumber(centerDepthMeters),
          };
          debugLogs.push(`cpu center depth meters: ${centerDepthMeters}`);
        } catch (err) {
          debugLogs.push(`cpu center depth read failed: ${err.message}`);
        }

        depthSummary = {
          width: depthInfo.width,
          height: depthInfo.height,
          type: "cpu",
        };
      }
    }

    latestSnapshot = {
      timestamp: new Date().toISOString(),
      referenceSpaceType: "local",
      camera: {
        transform: poseToJSON(view.transform),
        projectionMatrix: flattenMatrix(view.projectionMatrix),
      },
      depthUsage: xrSession.depthUsage || null,
      depthDataFormat: xrSession.depthDataFormat || null,
      depthSummary,
      rawCenterSample,
      centerRegionStats,
      regionGridStats,
      debugLogs,
      notes: [
        "rawCenterSample.gray01 is not meters",
        "centerRegionStats is the mean/min/max of a center window",
        "regionGridStats is a 5x5 grid around the center",
        "these values are useful as relative depth cues"
      ],
    };

    if (latestSnapshot.regionGridStats) {
      updateHeatmapPanel(latestSnapshot);
    }

    debugLogs.push("snapshot-depth.json download triggered.");
    debugLogs.push("----- SNAPSHOT END -----");

    downloadJSON(latestSnapshot, "snapshot-depth.json");
    log("snapshot-depth.json download triggered.");
  }
}

enterArBtn.addEventListener("click", async () => {
  try {
    await initAR();
  } catch (err) {
    log("Failed to start AR:", err.message);
    console.error(err);
  }
});