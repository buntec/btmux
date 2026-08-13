import { useEffect, useRef, useState } from 'react';
import { randomizeWallpaper } from '../lib/wallpaperRandom';
import { findWallpaperShader } from '../lib/wallpaperShaders';

const VERTEX_SRC = `#version 300 es
void main() {
  vec2 position = vec2(
    (gl_VertexID << 1) & 2,
    gl_VertexID & 2
  );
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
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
  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    throw new Error('could not create shader program');
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? 'unknown shader link error';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

interface ShaderWallpaperProps {
  shaderId: string;
  opacity: number;
  blur: number;
  saturate: number;
  speed: number;
  animated: boolean;
  seed: string;
}

export function ShaderWallpaper({ shaderId, opacity, blur, saturate, speed, animated, seed }: ShaderWallpaperProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [contextGeneration, setContextGeneration] = useState(0);
  const effect = findWallpaperShader(shaderId);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !effect) return;

    const handleContextLost = (event: Event) => event.preventDefault();
    const handleContextRestored = () => setContextGeneration((generation) => generation + 1);
    canvas.addEventListener('webglcontextlost', handleContextLost);
    canvas.addEventListener('webglcontextrestored', handleContextRestored);

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
    });
    if (!gl) {
      console.warn('btmux: WebGL2 is unavailable; shader wallpaper disabled');
      return () => {
        canvas.removeEventListener('webglcontextlost', handleContextLost);
        canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      };
    }

    let program: WebGLProgram;
    try {
      program = createProgram(gl, effect.src);
    } catch (error) {
      console.error(`btmux: could not compile wallpaper shader "${shaderId}"`, error);
      return () => {
        canvas.removeEventListener('webglcontextlost', handleContextLost);
        canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      };
    }

    const resolution = gl.getUniformLocation(program, 'u_resolution');
    const time = gl.getUniformLocation(program, 'u_time');
    const background = gl.getUniformLocation(program, 'u_background');
    const color1 = gl.getUniformLocation(program, 'u_color1');
    const color2 = gl.getUniformLocation(program, 'u_color2');
    const color3 = gl.getUniformLocation(program, 'u_color3');
    const random1 = gl.getUniformLocation(program, 'u_random1');
    const random2 = gl.getUniformLocation(program, 'u_random2');
    const randomized = randomizeWallpaper(shaderId, seed);
    const startedAt = performance.now();
    let rafId = 0;
    let disposed = false;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };

    const draw = (now: number) => {
      if (disposed) return;
      resize();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform1f(time, ((now - startedAt) / 1000) * speed);
      gl.uniform3fv(background, randomized.background);
      gl.uniform3fv(color1, randomized.colors[0]);
      gl.uniform3fv(color2, randomized.colors[1]);
      gl.uniform3fv(color3, randomized.colors[2]);
      gl.uniform4fv(random1, randomized.values.slice(0, 4));
      gl.uniform4fv(random2, randomized.values.slice(4, 8));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const tick = (now: number) => {
      draw(now);
      if (animated && !document.hidden) rafId = requestAnimationFrame(tick);
    };

    const start = () => {
      cancelAnimationFrame(rafId);
      if (document.hidden) return;
      if (animated) {
        rafId = requestAnimationFrame(tick);
      } else {
        draw(performance.now());
      }
    };

    const handleVisibility = () => start();
    const handleResize = () => {
      if (!animated) draw(performance.now());
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('resize', handleResize);
    start();

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('resize', handleResize);
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
      gl.deleteProgram(program);
    };
  }, [effect, shaderId, speed, animated, seed, contextGeneration]);

  if (!effect) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: blur > 0 ? `${-blur * 2}px` : 0,
        width: blur > 0 ? `calc(100% + ${blur * 4}px)` : '100%',
        height: blur > 0 ? `calc(100% + ${blur * 4}px)` : '100%',
        opacity,
        filter: `blur(${blur}px) saturate(${saturate})`,
        zIndex: -1,
        pointerEvents: 'none',
      }}
    />
  );
}
