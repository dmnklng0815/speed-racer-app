// Upload a finished ride to intervals.icu.
//
// No server is involved: intervals.icu reflects any origin and allows the
// Authorization header, so the browser can post the file directly. Checked
// against the service on 2026-09-14; the endpoint comes from its own
// OpenAPI description at https://intervals.icu/api/v1/docs
//
// The key lives in the rider's own profile on the rider's own device - see
// rider.js, which stores it. It must never end up in the repository.

const BASE = 'https://intervals.icu/api/v1';

/**
 * Post a TCX to intervals.icu. Athlete "0" means whoever the key belongs to,
 * so there is no athlete id to look up or mistype.
 */
export async function upload({ key, athlete = '0', filename, xml,
                               name, description, externalId }) {
  if (!key) throw new Error('Kein API-Schlüssel hinterlegt');

  const url = new URL(`${BASE}/athlete/${athlete || '0'}/activities`);
  if (name) url.searchParams.set('name', name);
  if (description) url.searchParams.set('description', description);
  url.searchParams.set('device_name', 'Hammer Speed Racer S (FitShow FS-BT-D2)');
  // Lets the service recognise a repeated send as the same ride.
  if (externalId) url.searchParams.set('external_id', externalId);

  const form = new FormData();
  form.append('file', new Blob([xml], { type: 'application/xml' }), filename);

  const res = await fetch(url, {
    method: 'POST',
    // Content-Type is deliberately unset: the browser adds the boundary.
    headers: { Authorization: 'Basic ' + btoa('API_KEY:' + key) },
    body: form,
  });

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403)
      throw new Error('Schlüssel abgelehnt — in intervals.icu unter '
                    + 'Settings, Developer Settings prüfen');
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  try { return JSON.parse(text); } catch (e) { return {}; }
}
