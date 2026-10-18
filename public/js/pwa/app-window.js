export function canOfferAppWindow(windowObject) {
  if (!windowObject || typeof windowObject.open !== 'function') return false;
  if (typeof windowObject.tizen !== 'undefined') return false;
  if (windowObject.opener || windowObject.name === 'sagetv-pwa-app') return false;
  return !windowObject.matchMedia?.('(display-mode: standalone)').matches &&
    windowObject.navigator?.standalone !== true;
}

export function openAppWindow(windowObject) {
  const width = Math.max(640, windowObject.screen?.availWidth || windowObject.outerWidth || 1280);
  const height = Math.max(480, windowObject.screen?.availHeight || windowObject.outerHeight || 720);
  const features = [
    'popup=yes',
    `width=${width}`,
    `height=${height}`,
    'left=0',
    'top=0',
    'resizable=yes',
    'scrollbars=yes',
  ].join(',');
  const popup = windowObject.open(windowObject.location.href, 'sagetv-pwa-app', features);
  popup?.focus?.();
  return popup;
}
