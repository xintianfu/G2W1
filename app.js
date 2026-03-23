const canvas = document.getElementById("xr-canvas");
const logEl = document.getElementById("log");
const enterArBtn = document.getElementById("enter-ar");

let gl = null;
let xrSession = null;
let xrRefSpace = null;
let glBinding = null;

let debugLogs = [];

// GPU depth preview program
let previewProgram = null;
let previewVbo = null;

function log(...args) {
  const msg = args.map(String).join(" ");
  console.log(msg);
  debugLogs.push(msg);
  logEl.textContent += "\n" + msg;
  logEl.scrollTop = logEl.scrollHeight;
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

function initPreviewPipeline() {
  const vs = `#version 300 es
    in vec2 a_pos;
    out vec2 v_uv;
    void main() {
      v_uv = a_pos * 0.5 + 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  // 这版先做“相对灰度预览”
  // 对于 gpu-optimized + texture-array，我们按 sampler2DArray 采样
  // 用 red 通道先看是否存在合理深浅变化
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

      // texture-array 路径
      vec4 texel = texture(u_depthTex, vec3(duv, u_imageIndex));

      // 这里只做可视化，不保证是米制深度
      // 先用 red 通道看相对深浅
      float depthVis = texel.r;

      // 近处亮/远处暗，你也可以改成 1.0 - depthVis
      float gray = 1.0 - clamp(depthVis, 0.0, 1.0);

      outColor = vec4(vec3(gray), u_opacity);
    }
  `;

  previewProgram = createProgram(gl, vs, fs);

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

function drawGpuDepthPreview(depthInfo, viewport) {
  if (!previewProgram || !depthInfo) return;

  gl.useProgram(previewProgram);

  // 在右上角画一个小预览窗
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

  await gl.makeXRCompatible();

  const baseLayer = new XRWebGLLayer(xrSession, gl, { alpha: true });
  xrSession.updateRenderState({ baseLayer });

  xrRefSpace = await xrSession.requestReferenceSpace("local");
  glBinding = new XRWebGLBinding(xrSession, gl);

  initPreviewPipeline();

  log("AR session started.");
  log("GPU depth preview should appear in the top-right area.");

  xrSession.requestAnimationFrame(onXRFrame);
}

function onXRFrame(time, frame) {
  const session = frame.session;
  session.requestAnimationFrame(onXRFrame);

  const pose = frame.getViewerPose(xrRefSpace);
  if (!pose) return;

  const baseLayer = session.renderState.baseLayer;
  gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);

  // 保持真实世界透视
  gl.clearColor(0.0, 0.0, 0.0, 0.0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  for (const view of pose.views) {
    const viewport = baseLayer.getViewport(view);
    gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);

    // 如果是 gpu-optimized，就尝试预览 depth 纹理
    if (xrSession.depthUsage === "gpu-optimized" && glBinding) {
      try {
        const depthInfo = glBinding.getDepthInformation(view);
        if (depthInfo) {
          drawGpuDepthPreview(depthInfo, viewport);
        }
      } catch (err) {
        // 避免每帧刷爆日志，只在控制台留痕
        console.error("GPU depth preview failed:", err);
      }
    }
  }
}

enterArBtn.addEventListener("click", async () => {
  try {
    await initAR();
  } catch (err) {
    log("Failed to start AR:", err.name, err.message);
  }
});