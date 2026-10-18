export async function hasInstalledRelatedWebApp(navigatorObject) {
  if (typeof navigatorObject?.getInstalledRelatedApps !== 'function') return false;

  const applications = await navigatorObject.getInstalledRelatedApps();
  return Array.isArray(applications) &&
    applications.some((application) => application?.platform === 'webapp');
}
