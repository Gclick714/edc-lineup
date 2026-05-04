import { list } from '@vercel/blob';

const GROUPS_META_KEY = 'edc-groups-meta.json';

export default async function handler(req, res) {
  const group = req.query.group || '';
  if (!group) {
    // No group specified — show generic OG tags
    return res.status(200).send(ogPage('EDC 2026', 'Plan your EDC Las Vegas 2026 schedule with friends.'));
  }

  let groupName = null;
  try {
    const { blobs } = await list({ prefix: GROUPS_META_KEY });
    if (blobs.length > 0) {
      const resp = await fetch(blobs[0].url);
      const meta = await resp.json();
      if (meta[group] && meta[group].name) {
        groupName = meta[group].name;
      }
    }
  } catch (e) { /* fallback */ }

  const name = groupName || 'Group';
  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(ogPage(name + ' — EDC 2026', 'Plan your EDC Las Vegas 2026 schedule with friends.', group));
}

function ogPage(title, description, group) {
  const redirect = group ? `/?group=${encodeURIComponent(group)}` : '/';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:image" content="https://edc-app.vercel.app/og-image.png">
  <meta name="description" content="${escapeHtml(description)}">
  <meta http-equiv="refresh" content="0;url=${redirect}">
  <script>window.location.href = '${redirect}';</script>
</head>
<body>
  <p>Redirecting to <a href="${redirect}">${title}</a>...</p>
</body>
</html>`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');
}
