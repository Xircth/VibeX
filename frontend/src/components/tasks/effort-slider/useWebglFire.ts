/**
 * React port of the claude-range-slider WebGL fire engine: a four-pass WebGL2
 * pipeline (simulation → horizontal blur → vertical blur → composite) drawn
 * behind the effort slider's track while the slider sits at its maximum.
 *
 * The render loop self-suspends after ~3s of inactivity and restarts on the
 * next `sync(..., active=true)` call, so an idle composer costs no frames.
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { VERT, FRAG_SIM, FRAG_BLUR, FRAG_COMP } from './shaders';

const MAX_IDLE_FRAMES = 180;

interface FboEntry {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
}

class FireEngine {
  private gl: WebGL2RenderingContext | null = null;
  private canvas: HTMLCanvasElement;
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeDebounce: number | null = null;

  private loopRunning = false;
  private idleFrames = 0;
  private wasActive = false;
  private ultraStart: number | null = null;

  private simProg: WebGLProgram | null = null;
  private blurProg: WebGLProgram | null = null;
  private compProg: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private programsReady = false;

  private simA: FboEntry | null = null;
  private simB: FboEntry | null = null;
  private blurH: FboEntry | null = null;
  private blurV: FboEntry | null = null;

  private uniforms: Record<string, WebGLUniformLocation | null> = {};

  private cachedActive = false;
  private cachedSlider = 0.7;

  private readonly onContextLost = (event: Event) => {
    event.preventDefault();
  };

  private readonly onContextRestored = () => {
    this.programsReady = false;
    this.compilePrograms();
    if (this.programsReady) {
      this.resize();
      if (this.cachedActive) this.ensureLoop();
    }
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('webgl2', {
      preserveDrawingBuffer: false,
      antialias: false,
    });
    if (!ctx) return;

    this.gl = ctx;
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    this.compilePrograms();
    if (!this.programsReady) return;

    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeDebounce !== null) {
        window.clearTimeout(this.resizeDebounce);
      }
      this.resizeDebounce = window.setTimeout(() => this.resize(), 80);
    });
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  sync(slider01: number, active: boolean) {
    this.cachedSlider = slider01;
    if (active && this.ultraStart == null) {
      this.ultraStart = performance.now();
    } else if (!active) {
      this.ultraStart = null;
    }
    this.cachedActive = active;
    if (active) this.ensureLoop();
  }

  dispose() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeDebounce !== null) {
      window.clearTimeout(this.resizeDebounce);
      this.resizeDebounce = null;
    }
    this.loopRunning = false;
    this.destroyFbos();
    this.destroyPrograms();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener(
      'webglcontextrestored',
      this.onContextRestored
    );
    this.gl = null;
  }

  private resize() {
    const { gl, canvas } = this;
    if (!gl) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const dpr = window.devicePixelRatio;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);

    this.destroyFbos();
    this.createFbos();
  }

  private compileShader(type: number, src: string): WebGLShader | null {
    const gl = this.gl!;
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  private linkProgram(vsSrc: string, fsSrc: string): WebGLProgram | null {
    const gl = this.gl!;
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSrc);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'a_pos');
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program));
      return null;
    }
    return program;
  }

  private compilePrograms() {
    const gl = this.gl;
    if (!gl) return;

    this.simProg = this.linkProgram(VERT, FRAG_SIM);
    this.blurProg = this.linkProgram(VERT, FRAG_BLUR);
    this.compProg = this.linkProgram(VERT, FRAG_COMP);
    if (!this.simProg || !this.blurProg || !this.compProg) return;

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.uniforms = {
      simTime: gl.getUniformLocation(this.simProg, 'u_time'),
      simSlider: gl.getUniformLocation(this.simProg, 'u_slider'),
      simElapsed: gl.getUniformLocation(this.simProg, 'u_elapsed'),
      simBack: gl.getUniformLocation(this.simProg, 'u_back'),
      blurDir: gl.getUniformLocation(this.blurProg, 'u_dir'),
      blurExt: gl.getUniformLocation(this.blurProg, 'u_ext'),
      blurTex: gl.getUniformLocation(this.blurProg, 'u_tex'),
      blurRes: gl.getUniformLocation(this.blurProg, 'u_res'),
      compScene: gl.getUniformLocation(this.compProg, 'u_scene'),
      compGlow: gl.getUniformLocation(this.compProg, 'u_glow'),
    };

    this.programsReady = true;
  }

  private makeFbo(): FboEntry | null {
    const gl = this.gl!;
    const fbo = gl.createFramebuffer();
    const tex = gl.createTexture();
    if (!fbo || !tex) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      this.canvas.width,
      this.canvas.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      tex,
      0
    );
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { fbo, tex };
  }

  private createFbos() {
    if (!this.gl) return;
    this.simA = this.makeFbo();
    this.simB = this.makeFbo();
    this.blurH = this.makeFbo();
    this.blurV = this.makeFbo();
  }

  private destroyFbo(entry: FboEntry | null) {
    if (!this.gl || !entry) return;
    this.gl.deleteFramebuffer(entry.fbo);
    this.gl.deleteTexture(entry.tex);
  }

  private destroyFbos() {
    this.destroyFbo(this.simA);
    this.simA = null;
    this.destroyFbo(this.simB);
    this.simB = null;
    this.destroyFbo(this.blurH);
    this.blurH = null;
    this.destroyFbo(this.blurV);
    this.blurV = null;
  }

  private destroyPrograms() {
    const gl = this.gl;
    if (!gl) return;
    if (this.simProg) gl.deleteProgram(this.simProg);
    if (this.blurProg) gl.deleteProgram(this.blurProg);
    if (this.compProg) gl.deleteProgram(this.compProg);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    this.simProg = this.blurProg = this.compProg = null;
    this.vao = null;
    this.vbo = null;
    this.programsReady = false;
  }

  private ensureLoop() {
    const gl = this.gl;
    if (!gl || !this.programsReady) return;
    if (!this.simA || !this.simB) {
      this.resize();
      if (!this.simA || !this.simB) return;
    }
    if (this.loopRunning) {
      this.idleFrames = 0;
      return;
    }

    this.loopRunning = true;
    this.idleFrames = 0;
    this.wasActive = false;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.simA.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.simB.fbo);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.rafId = requestAnimationFrame(this.render);
  }

  private readonly render = (t: number) => {
    const gl = this.gl;
    if (!gl || !this.simA || !this.simB || !this.blurH || !this.blurV) {
      this.loopRunning = false;
      this.rafId = null;
      return;
    }

    const active = this.cachedActive;

    if (!active && !this.wasActive) {
      if (++this.idleFrames > MAX_IDLE_FRAMES) {
        this.loopRunning = false;
        this.rafId = null;
        return;
      }
      this.rafId = requestAnimationFrame(this.render);
      return;
    }

    this.idleFrames = 0;

    if (active && !this.wasActive) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.simA.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.simB.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this.wasActive = active;

    const elapsed = active
      ? (performance.now() - (this.ultraStart ?? 0)) / 1000
      : -1.0;
    const sv = this.cachedSlider;
    const U = this.uniforms;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    // Pass 1: fire simulation (ping-pong).
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.simB.fbo);
    gl.useProgram(this.simProg);
    gl.uniform1f(U.simTime, t * 0.001);
    gl.uniform1f(U.simSlider, sv);
    gl.uniform1f(U.simElapsed, elapsed);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.simA.tex);
    gl.uniform1i(U.simBack, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Pass 2: horizontal blur (bright extraction on).
    gl.useProgram(this.blurProg);
    gl.uniform2f(U.blurRes, this.canvas.width, this.canvas.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurH.fbo);
    gl.uniform2f(U.blurDir, 1.0, 0.0);
    gl.uniform1f(U.blurExt, 1.0);
    gl.bindTexture(gl.TEXTURE_2D, this.simB.tex);
    gl.uniform1i(U.blurTex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Pass 3: vertical blur.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurV.fbo);
    gl.uniform2f(U.blurDir, 0.0, 1.0);
    gl.uniform1f(U.blurExt, 0.0);
    gl.bindTexture(gl.TEXTURE_2D, this.blurH.tex);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Pass 4: composite to screen.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.compProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.simB.tex);
    gl.uniform1i(U.compScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.blurV.tex);
    gl.uniform1i(U.compGlow, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const tmp = this.simA;
    this.simA = this.simB;
    this.simB = tmp;

    this.rafId = requestAnimationFrame(this.render);
  };
}

/**
 * Mounts the fire engine on the given canvas and returns a stable `sync`
 * callback; call it with the slider position (0..1) and whether the flame
 * should burn whenever either changes.
 */
export function useWebglFire(
  canvasRef: RefObject<HTMLCanvasElement | null>
): (slider01: number, active: boolean) => void {
  const engineRef = useRef<FireEngine | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new FireEngine(canvas);
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [canvasRef]);

  return useCallback((slider01: number, active: boolean) => {
    engineRef.current?.sync(slider01, active);
  }, []);
}
