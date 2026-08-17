import { useEffect, useRef } from 'react';
import type { Theme } from '../state/types';
import { findPaneSwitchEffect, findShaderEffect } from '../lib/terminalFxShaders';

const VERTEX_SRC = `#version 300 es
out vec2 v_uv;

void main() {
  vec2 positions[3] = vec2[3](
    vec2(-1.0, -1.0),
    vec2(3.0, -1.0),
    vec2(-1.0, 3.0)
  );
  vec2 position = positions[gl_VertexID];
  v_uv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const PASSTHROUGH_FRAGMENT_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_scene;

void main() {
  fragColor = texture(u_scene, v_uv);
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('could not create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? 'unknown shader compile error';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, fragmentSrc: string): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSrc);
  const program = gl.createProgram();
  if (!program) throw new Error('could not create shader program');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? 'unknown program link error';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function drawScene(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  theme: Theme,
  fontFamily: string,
  fontWeight: number,
  fontSize: number,
  dpr: number,
): void {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const logicalWidth = width / dpr;
  const logicalHeight = height / dpr;
  const textSize = fontSize;
  const x = 20;
  const lineHeight = textSize * 1.55;
  let y = 22 + textSize;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, logicalWidth, logicalHeight);
  ctx.font = `${fontWeight} ${textSize}px "${fontFamily}", monospace`;
  ctx.textBaseline = 'alphabetic';

  const line = (parts: Array<[string, string]>) => {
    let cursor = x;
    for (const [text, color] of parts) {
      ctx.fillStyle = color;
      ctx.fillText(text, cursor, y);
      cursor += ctx.measureText(text).width;
    }
    y += lineHeight;
  };

  line([
    ['$ ', theme.green],
    ['btmux attach dev', theme.foreground],
  ]);
  line([['connected to session dev', theme.brightBlack]]);
  y += lineHeight * 0.45;
  line([
    ['src/', theme.cyan],
    ['App.tsx', theme.foreground],
  ]);
  line([
    ['const ', theme.magenta],
    ['config', theme.foreground],
    [' = ', theme.foreground],
    ['livePreview', theme.yellow],
    ['();', theme.foreground],
  ]);
  y += lineHeight * 0.45;
  line([['ready', theme.green]]);
  ctx.fillStyle = theme.cursor;
  ctx.fillRect(
    x + ctx.measureText('ready').width + 3,
    y - lineHeight - textSize + 2,
    Math.max(7, textSize * 0.55),
    textSize,
  );
}

interface Props {
  shaderId: string;
  paneSwitchShaderId: string;
  paneSwitchIntensity: number;
  paneSwitchDuration: number;
  paneSwitchPreviewKey: number;
  theme: Theme;
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  animations: boolean;
}

export function TerminalShaderPreview({
  shaderId,
  paneSwitchShaderId,
  paneSwitchIntensity,
  paneSwitchDuration,
  paneSwitchPreviewKey,
  theme,
  fontFamily,
  fontWeight,
  fontSize,
  animations,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) return;

    const effect = findShaderEffect(shaderId);
    const paneSwitchEffect = findPaneSwitchEffect(
      paneSwitchShaderId || undefined,
      paneSwitchIntensity,
      paneSwitchDuration,
    );
    let baseProgram: WebGLProgram;
    let paneSwitchProgram: WebGLProgram | null = null;
    try {
      baseProgram = createProgram(gl, effect?.src ?? PASSTHROUGH_FRAGMENT_SRC);
      if (paneSwitchPreviewKey > 0 && animations && paneSwitchEffect.src) {
        paneSwitchProgram = createProgram(gl, paneSwitchEffect.src);
      }
    } catch (error) {
      console.error('btmux: could not compile terminal preview shader', error);
      return;
    }

    const texture = gl.createTexture();
    if (!texture) {
      gl.deleteProgram(baseProgram);
      if (paneSwitchProgram) gl.deleteProgram(paneSwitchProgram);
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    const scene = document.createElement('canvas');
    const uniforms = new Map<
      WebGLProgram,
      {
        resolution: WebGLUniformLocation | null;
        time: WebGLUniformLocation | null;
        scene: WebGLUniformLocation | null;
      }
    >();
    for (const program of [baseProgram, paneSwitchProgram]) {
      if (!program) continue;
      uniforms.set(program, {
        resolution: gl.getUniformLocation(program, 'u_resolution'),
        time: gl.getUniformLocation(program, 'u_time'),
        scene: gl.getUniformLocation(program, 'u_scene'),
      });
    }
    const startedAt = performance.now();
    let frame = 0;

    const render = (now: number) => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      drawScene(scene, width, height, theme, fontFamily, fontWeight, fontSize, dpr);
      gl.viewport(0, 0, width, height);
      const elapsed = now - startedAt;
      const paneSwitchActive = paneSwitchProgram !== null && elapsed <= paneSwitchEffect.durationMs;
      const program: WebGLProgram = paneSwitchActive && paneSwitchProgram ? paneSwitchProgram : baseProgram;
      const locations = uniforms.get(program)!;
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, scene);
      gl.uniform1i(locations.scene, 0);
      gl.uniform2f(locations.resolution, width, height);
      gl.uniform1f(locations.time, elapsed / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (paneSwitchActive || (effect?.animated && animations)) {
        frame = requestAnimationFrame(render);
      }
    };

    const resizeObserver = new ResizeObserver(() => render(performance.now()));
    resizeObserver.observe(canvas);
    render(performance.now());

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      gl.deleteTexture(texture);
      gl.deleteProgram(baseProgram);
      if (paneSwitchProgram) gl.deleteProgram(paneSwitchProgram);
    };
  }, [
    shaderId,
    paneSwitchShaderId,
    paneSwitchIntensity,
    paneSwitchDuration,
    paneSwitchPreviewKey,
    theme,
    fontFamily,
    fontWeight,
    fontSize,
    animations,
  ]);

  return <canvas ref={canvasRef} className="block h-64 w-full" aria-label="Terminal shader preview" />;
}
