import type { Theme } from '../state/types';
import { readableColor } from './astryx-theme';
import { mix } from './chrome-colors';

export function sessionInitials(name: string): string {
  const words = name.replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2').match(/[\p{L}\p{N}]+/gu);
  const letters = words?.length
    ? words.length > 1
      ? Array.from(words[0])[0] + Array.from(words[words.length - 1])[0]
      : Array.from(words[0]).slice(0, 2).join('')
    : Array.from(name.trim()).slice(0, 2).join('');
  return Array.from(letters.toUpperCase()).slice(0, 2).join('') || '?';
}

export function sessionGradient(id: string, palette: Theme) {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619) >>> 0;
  const accents = [palette.red, palette.yellow, palette.green, palette.cyan, palette.blue, palette.magenta];
  const first = hash % accents.length;
  const second = (first + 1 + (Math.floor(hash / accents.length) % (accents.length - 1))) % accents.length;
  const foreground = readableColor(palette.background, mix(accents[first], accents[second], 0.5), 7);
  return {
    start: readableColor(accents[first], foreground, 7),
    end: readableColor(accents[second], foreground, 7),
    foreground,
    direction: Math.floor(hash / (accents.length * (accents.length - 1))) % 4,
  };
}
