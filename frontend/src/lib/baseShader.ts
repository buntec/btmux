import { useStore } from '../state/store';
import { findShaderEffect } from './terminalFxShaders';

/**
 * GLSL source of the persistent post-process effect the user picked with
 * `shader: choose effect`, or null when none is configured.
 *
 * Read live from the store rather than passed in, because the callers are
 * cleanup paths of *transient* effects (the navigate-to glitch, the privacy
 * pixelate): they own the post-process slot for a few hundred ms and have to
 * hand it back to whatever the base state is when they finish, which may not
 * be the one they saw when they started.
 */
export function baseShaderSrc(): string | null {
  return findShaderEffect(useStore.getState().config?.shader)?.src ?? null;
}
