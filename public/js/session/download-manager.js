/**
 * SageTV MiniClient browser download helper.
 *
 * Downloads use the server-provided video file URL directly.
 * Offline metadata is intentionally ignored for now because the PWA does not
 * render or store that information yet.
 */

export class DownloadManager {
  async downloadFromSessionAck(sessionAck) {
    if (!sessionAck) {
      throw new Error('Missing download session data');
    }

    const downloadUrl = sessionAck.download_url || sessionAck.downloadUrl || '';
    const suggestedName = sessionAck.file_name || sessionAck.fileName || '';
    return this.downloadFromManifest('', downloadUrl, suggestedName);
  }

  async downloadFromManifest(manifestUrl, downloadUrl = '', suggestedName = '') {
    const resolvedDownloadUrl = downloadUrl
      ? new URL(downloadUrl, window.location.href).toString()
      : (manifestUrl ? this._deriveDownloadUrl(new URL(manifestUrl, window.location.href).toString()) : '');
    if (!resolvedDownloadUrl) {
      throw new Error('Missing download URL');
    }

    const filename = suggestedName || this._deriveFilename(resolvedDownloadUrl);

    console.log(`[Download] Download URL: ${resolvedDownloadUrl}`);

    this._triggerBrowserDownload(resolvedDownloadUrl, filename);

    return {
      manifestUrl: manifestUrl ? new URL(manifestUrl, window.location.href).toString() : '',
      downloadUrl: resolvedDownloadUrl,
      filename,
      videoPath: '',
      manifest: null,
    };
  }

  _deriveDownloadUrl(manifestUrl) {
    const url = new URL(manifestUrl, window.location.href);
    const path = url.pathname;

    if (path.includes('/offline/metadata')) {
      url.pathname = path.replace('/offline/metadata', '/content');
      return url.toString();
    }

    if (path.endsWith('/metadata')) {
      url.pathname = path.slice(0, -'/metadata'.length) + '/content';
      return url.toString();
    }

    return url.toString();
  }

  _deriveFilename(value) {
    if (!value) {
      return 'download.bin';
    }

    const clean = String(value).split('?')[0].split('#')[0];
    const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
    const name = slash >= 0 ? clean.slice(slash + 1) : clean;
    return name || 'download.bin';
  }

  _triggerBrowserDownload(url, filename) {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename || '';
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => anchor.remove(), 0);
  }
}