export async function hasInstalledRelatedWebApp(navigatorObject) {
  if (typeof navigatorObject?.getInstalledRelatedApps !== 'function') return false;

  const applications = await navigatorObject.getInstalledRelatedApps();
  return Array.isArray(applications) &&
    applications.some((application) => application?.platform === 'webapp');
}

export function supportsManualInstallInstructions(navigatorObject) {
  const userAgent = navigatorObject?.userAgent || '';
  const isIPad = /iPad/.test(userAgent) ||
    (navigatorObject?.platform === 'MacIntel' && navigatorObject?.maxTouchPoints > 1);
  const isIOS = /iPhone/.test(userAgent) || isIPad;
  const isSafari = /Safari/.test(userAgent) && !/(?:CriOS|FxiOS|EdgiOS)/.test(userAgent);
  return isIOS && isSafari;
}
