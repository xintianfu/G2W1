const canvas = document.getElementById("xr-canvas");
const logEl = document.getElementById("log");
const enterArBtn = document.getElementById("enter-ar");

let gl = null;
let xrSession = null;
let xrRefSpace = null;
let glBinding = null;

let pendingSnapshot = false;
let lastPinchTime = 0;
const PINCH_COOLDOWN_MS = 1200;

let debugLogs = [];

// preview
let previewProgram = null;
let previewVbo = null;

// readback
let readProgram = null;
let readFbo = null;
let readColorTex = null;
const READ_SIZE = 1;

function log(...args) {
  const msg = args.map(String).join(" ");
  console.log(msg);
  debugLogs.push(msg);
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

function downloadJSON(obj, filename = "snapshot-depth.json") {
  const blob = new Blob([JSON.stringify(obj, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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

function compileShader(gl, type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error("Shader compile failed: " + info);
  }
  return s;
}

function createProgram(gl, vsSource, fsSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);

  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error("Program link failed: " + info);
  }
  return p;
}

function initQuadBuffer() {
  previewVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, previewVbo);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1,
    ]),
    gl.STATIC_DRAW
  );
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
}

function initPreviewPipeline() {
  const vs = `#version 300 es
    in vec2 a_pos;
    out vec2 v_uv;
    void main() {
      v_uv = a_pos * 0.5 + 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  const fs = `#version 300 es
    precision highp float;
    precision highp sampler2DArray;

    in vec2 v_uv;
    out vec4 outColor;

    uniform sampler2DArray u_depthTex;
    uniform mat4 u_uvTransform;
    uniform float u_imageIndex;
    uniform float u_opacity;

    vec2 transformUV(vec2 uv) {
      vec4 t = u_uvTransform * vec4(uv, 0.0, 1.0);
      return t.xy;
    }

    void main() {
      vec2 duv = transformUV(v_uv);
      vec4 texel = texture(u_depthTex, vec3(duv, u_imageIndex));

      float depthVis = texel.r;
      float gray = 1.0 - clamp(depthVis, 0.0, 1.0);

      outColor = vec4(vec3(gray), u_opacity);
    }
  `;

  previewProgram = createProgram(gl, vs, fs);
}

function initReadbackPipeline() {
  const vs = `#version 300 es
    in vec2 a_pos;
    out vec2 v_uv;
    void main() {
      v_uv = a_pos * 0.5 + 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  // 把 depth texture 的采样值直接写到 RGBA 颜色里，方便 readPixels
  const fs = `#version 300 es
    precision highp float;
    precision highp sampler2DArray;

    in vec2 v_uv;
    out vec4 outColor;

    uniform sampler2DArray u_depthTex;
    uniform mat4 u_uvTransform;
    uniform float u_imageIndex;

    vec2 transformUV(vec2 uv) {
      vec4 t = u_uvTransform * vec4(uv, 0.0, 1.0);
      return t.xy;
    }

    void main() {
      vec2 duv = transformUV(v_uv);
      vec4 texel = texture(u_depthTex, vec3(duv, u_imageIndex));

      // 这里只先读 red 通道
      float v = texel.r;
      outColor = vec4(v, v, v, 1.0);
    }
  `;

  readProgram = createProgram(gl, vs, fs);

  readFbo = gl.createFramebuffer();
  readColorTex = gl.createTexture();

  gl.bindTexture(gl.TEXTURE_2D, readColorTex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA8,
    READ_SIZE,
    READ_SIZE,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  gl.bindFramebuffer(gl.FRAMEBUFFER, readFbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    readColorTex,
    0
  );

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error("Readback framebuffer incomplete: " + status);
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

function drawGpuDepthPreview(depthInfo, viewport) {
  gl.useProgram(previewProgram);

  const x = Math.floor(viewport.x + viewport.width * 0.60);
  const y = Math.floor(viewport.y + viewport.height * 0.55);
  const w = Math.floor(viewport.width * 0.35);
  const h = Math.floor(viewport.height * 0.35);
  gl.viewport(x, y, w, h);

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const aPos = gl.getAttribLocation(previewProgram, "a_pos");
  const uDepthTex = gl.getUniformLocation(previewProgram, "u_depthTex");
  const uUvTransform = gl.getUniformLocation(previewProgram, "u_uvTransform");
  const uImageIndex = gl.getUniformLocation(previewProgram, "u_imageIndex");
  const uOpacity = gl.getUniformLocation(previewProgram, "u_opacity");

  gl.bindBuffer(gl.ARRAY_BUFFER, previewVbo);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, depthInfo.texture);
  gl.uniform1i(uDepthTex, 0);
  gl.uniformMatrix4fv(
    uUvTransform,
    false,
    depthInfo.normDepthBufferFromNormView.matrix
  );
  gl.uniform1f(uImageIndex, depthInfo.imageIndex ?? 0);
  gl.uniform1f(uOpacity, 0.85);

  gl.drawArrays(gl.TRIANGLES, 0, 6);

  gl.disableVertexAttribArray(aPos);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  gl.disable(gl.BLEND);
}

function readCenterDepthRaw(depthInfo) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, readFbo);
  gl.viewport(0, 0, READ_SIZE, READ_SIZE);

  gl.useProgram(readProgram);

  const aPos = gl.getAttribLocation(readProgram, "a_pos");
  const uDepthTex = gl.getUniformLocation(readProgram, "u_depthTex");
  const uUvTransform = gl.getUniformLocation(readProgram, "u_uvTransform");
  const uImageIndex = gl.getUniformLocation(readProgram, "u_imageIndex");

  gl.bindBuffer(gl.ARRAY_BUFFER, previewVbo);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, depthInfo.texture);
  gl.uniform1i(uDepthTex, 0);
  gl.uniformMatrix4fv(
    uUvTransform,
    false,
    depthInfo.normDepthBufferFromNormView.matrix
  );
  gl.uniform1f(uImageIndex, depthInfo.imageIndex ?? 0);

  gl.drawArrays(gl.TRIANGLES, 0, 6);

  const pixels = new Uint8Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  gl.disableVertexAttribArray(aPos);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return {
    rgba: Array.from(pixels),
    gray01: pixels[0] / 255.0,
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

  xrSession = await navigator.xr.requestSession("immersive-ar", {
    requiredFeatures: ["local", "depth-sensing"],
    optionalFeatures: ["hand-tracking"],
    depthSensing: {
      usagePreference: ["gpu-optimized", "cpu-optimized"],
      dataFormatPreference: ["luminance-alpha", "float32"],
    },
  });

  log("XR session created.");
  log("depthUsage:", xrSession.depthUsage ?? "undefined");
  log("depthDataFormat:", xrSession.depthDataFormat ?? "undefined");

  xrSession.addEventListener("end", () => {
    log("XR session ended.");
    xrSession = null;
    xrRefSpace = null;
    glBinding = null;
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

  const baseLayer = new XRWebGLLayer(xrSession, gl, { alpha: true });
  xrSession.updateRenderState({ baseLayer });

  xrRefSpace = await xrSession.requestReferenceSpace("local");
  glBinding = new XRWebGLBinding(xrSession, gl);

  initQuadBuffer();
  initPreviewPipeline();
  initReadbackPipeline();

  log("AR session started.");
  log("GPU depth preview should appear in the top-right area.");
  log("Pinch to capture center raw depth sample.");

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

  // 只用左眼 view 做预览和读取
  const view = pose.views[0];
  if (!view) return;

  const viewport = baseLayer.getViewport(view);

  let depthInfo = null;
  if (xrSession.depthUsage === "gpu-optimized" && glBinding) {
    try {
      depthInfo = glBinding.getDepthInformation(view);
      if (depthInfo) {
        drawGpuDepthPreview(depthInfo, viewport);
      }
    } catch (err) {
      console.error("GPU depth preview failed:", err);
    }
  }

  if (pendingSnapshot) {
    pendingSnapshot = false;
    debugLogs = [];
    log("----- SNAPSHOT START -----");
    log("pose views count:", pose.views.length);
    log("depthUsage runtime:", xrSession.depthUsage ?? "undefined");
    log("depthDataFormat runtime:", xrSession.depthDataFormat ?? "undefined");

    let rawCenterSample = null;

    try {
      if (xrSession.depthUsage === "gpu-optimized") {
        log("depth path:", "gpu");
        log("depthInfo exists:", depthInfo !== null);

        if (depthInfo) {
          log("depth width:", depthInfo.width);
          log("depth height:", depthInfo.height);
          log("textureType:", depthInfo.textureType ?? "unknown");
          log("imageIndex:", depthInfo.imageIndex ?? "unknown");

          rawCenterSample = readCenterDepthRaw(depthInfo);
          log("raw center rgba:", JSON.stringify(rawCenterSample.rgba));
          log("raw center gray01:", rawCenterSample.gray01);
        }
      } else {
        log("This test page is intended for gpu-optimized depth.");
      }
    } catch (err) {
      log("gpu center read failed:", err.name, err.message);
    }

    const latestSnapshot = {
      timestamp: new Date().toISOString(),
      sessionMode: session.mode,
      referenceSpaceType: "local",
      camera: {
        transform: poseToJSON(view.transform),
        projectionMatrix: flattenMatrix(view.projectionMatrix),
      },
      depthUsage: xrSession.depthUsage ?? null,
      depthDataFormat: xrSession.depthDataFormat ?? null,
      depthSummary: depthInfo
        ? {
            width: depthInfo.width,
            height: depthInfo.height,
            textureType: depthInfo.textureType ?? null,
            imageIndex: depthInfo.imageIndex ?? null,
            type: "gpu",
          }
        : null,
      rawCenterSample: rawCenterSample,
      debugLogs: [],
      notes: [
        "rawCenterSample is not meters yet",
        "it is a GPU readback debug value",
        "use it to test whether near/far viewing changes the sampled value",
      ],
    };

    log("snapshot-depth.json download triggered.");
    log("----- SNAPSHOT END -----");

    latestSnapshot.debugLogs = [...debugLogs];
    downloadJSON(latestSnapshot, "snapshot-depth.json");
  }
}

enterArBtn.addEventListener("click", async () => {
  try {
    await initAR();
  } catch (err) {
    log("Failed to start AR:", err.name, err.message);
  }
});