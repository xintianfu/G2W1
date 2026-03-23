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
const CENTER_WINDOW_SIZE = 15;   // 中心区域 9x9
const GRID_ROWS = 5;            // 3x3 区域
const GRID_COLS = 5;
const GRID_CELL_SIZE = 15;       // 每个区域窗口 9x9
const GRID_SPACING = 24;        // 区域中心之间的像素间隔

// ===== GPU debug readback resources =====
let debugProgram = null;
let debugVAO = null;
let debugColorTex = null;
let debugFbo = null;
let debugDepthWidth = 0;
let debugDepthHeight = 0;

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

function initDebugDrawResources() {
  // 一个最简单的 fullscreen triangle
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

  // 同时支持 texture-2d 和 texture-array，两者只用一个
  const fsSource = `#version 300 es
    precision highp float;
    precision highp sampler2D;
    precision highp sampler2DArray;

    in vec2 vUv;
    out vec4 outColor;

    uniform sampler2D uTex2D;
    uniform sampler2DArray uTexArray;
    uniform int uTextureType;   // 0 = 2D, 1 = array
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
  return [
    pixels[idx],
    pixels[idx + 1],
    pixels[idx + 2],
    pixels[idx + 3],
  ];
}

function rgbaToGray01(rgba) {
  // 这里你的 debug depth 是灰度写入，所以 rgb 相同，取 r 就够了
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
      const centerX = baseX + (col - colOffset) * GRID_SPACING;
      const centerY = baseY + (row - rowOffset) * GRID_SPACING;

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

  // GPU 路径
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

  const view = pose.views[0];
  if (!view) return;

  if (pendingSnapshot) {
    pendingSnapshot = false;

    const debugLogs = [];
    debugLogs.push("----- SNAPSHOT START -----");
    debugLogs.push(`pose views count: ${pose.views.length}`);

    let depthInfo = null;
    let depthPath = "none";

    // 先试 GPU 路径
    try {
      if (xrGlBinding) {
        depthInfo = xrGlBinding.getDepthInformation(view);
        if (depthInfo) depthPath = "gpu";
      }
    } catch (err) {
      debugLogs.push(`gpu getDepthInformation failed: ${err.message}`);
    }

    // 再退回 CPU 路径
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
        // CPU 路径可直接拿米
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
        "regionGridStats is a 3x3 grid around the center",
        "these values are useful as relative depth cues"
      ],
    };

    debugLogs.push("snapshot-depth.json download triggered.");
    debugLogs.push("----- SNAPSHOT END -----");

    downloadJSON(latestSnapshot, "snapshot-depth.json");
    log("snapshot-depth.json download triggered.");
  }
}

function downloadJSON(obj, filename = "snapshot-depth.json") {
  const blob = new Blob(
    [JSON.stringify(obj, null, 2)],
    { type: "application/json" }
  );

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

enterArBtn.addEventListener("click", async () => {
  try {
    await initAR();
  } catch (err) {
    log("Failed to start AR:", err.message);
    console.error(err);
  }
});