/**
 * Samsung Tizen key normalization for SageTV command routing.
 */

export class TizenInputAdapter {
  constructor(platformDetector) {
    this.platformDetector = platformDetector;
  }

  isEnabled() {
    return !!this.platformDetector?.isTizen?.();
  }

  /**
   * Convert Tizen-specific key data to a normalized keyboard-like key.
   * Returns null when no mapping is needed.
   */
  normalize(event) {
    if (!this.isEnabled() || !event) {
      return null;
    }

    const key = String(event.key || '');
    const code = String(event.code || '');
    const keyCode = Number(event.keyCode || 0);

    const mapByKey = {
      ArrowLeft: 'ArrowLeft',
      ArrowRight: 'ArrowRight',
      ArrowUp: 'ArrowUp',
      ArrowDown: 'ArrowDown',
      Enter: 'Enter',
      Back: 'Escape',
      Exit: 'Escape',
      ColorF0Red: 'F1',
      ColorF1Green: 'F2',
      ColorF2Yellow: 'F3',
      ColorF3Blue: 'F4',
      MediaPlayPause: 'MediaPlayPause',
      MediaPlay: 'MediaPlay',
      MediaPause: 'MediaPause',
      MediaStop: 'MediaStop',
      MediaFastForward: 'MediaFastForward',
      MediaRewind: 'MediaRewind',
    };

    if (mapByKey[key]) {
      return { key: mapByKey[key], code: mapByKey[key] };
    }

    const mapByCode = {
      Backspace: 'Escape',
      NumpadEnter: 'Enter',
    };
    if (mapByCode[code]) {
      return { key: mapByCode[code], code: mapByCode[code] };
    }

    const mapByKeyCode = {
      13: 'Enter',
      37: 'ArrowLeft',
      38: 'ArrowUp',
      39: 'ArrowRight',
      40: 'ArrowDown',
      10009: 'Escape', // Tizen Back
      10182: 'MediaPlayPause',
      10252: 'MediaPlayPause',
      415: 'MediaPlay',
      19: 'MediaPause',
      413: 'MediaStop',
      417: 'MediaFastForward',
      412: 'MediaRewind',
      403: 'F1',
      404: 'F2',
      405: 'F3',
      406: 'F4',
    };

    const mapped = mapByKeyCode[keyCode];
    if (mapped) {
      return { key: mapped, code: mapped };
    }

    return null;
  }
}
