import { put, list, del } from '@vercel/blob';

const SCHEDULE_KEY = 'edc-schedule.json';
const GROUPS_META_KEY = 'edc-groups-meta.json';
const LEGACY_KEY = 'edc-data.json';

function userKey(group) {
  return 'edc-users-' + (group || 'default') + '.json';
}

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const { group, meta, schedule } = req.query;

      // Return group metadata (for OG endpoint and frontend)
      if (meta === 'true') {
        const { blobs } = await list({ prefix: GROUPS_META_KEY });
        if (blobs.length > 0) {
          const resp = await fetch(blobs[0].url);
          const data = await resp.json();
          return res.status(200).json(data);
        }
        return res.status(200).json({});
      }

      // Return global schedule
      if (schedule === 'true') {
        const { blobs } = await list({ prefix: SCHEDULE_KEY });
        if (blobs.length > 0) {
          const resp = await fetch(blobs[0].url);
          const data = await resp.json();
          return res.status(200).json(data);
        }
        return res.status(200).json({ schedule: null });
      }

      // Return group user data
      const key = userKey(group);
      const { blobs } = await list({ prefix: key });
      if (blobs.length > 0) {
        const resp = await fetch(blobs[0].url);
        const data = await resp.json();
        return res.status(200).json(data);
      }

      // Auto-migrate legacy edc-data.json blob to new group-scoped key
      if (!group || group === 'default') {
        const { blobs: legacyBlobs } = await list({ prefix: LEGACY_KEY });
        if (legacyBlobs.length > 0) {
          const resp = await fetch(legacyBlobs[0].url);
          const legacy = await resp.json();
          const migrated = {};
          if (legacy.users) migrated.users = legacy.users;
          if (legacy.mustSee) migrated.mustSee = legacy.mustSee;
          if (Object.keys(migrated).length > 0) {
            await put(key, JSON.stringify(migrated), { access: 'public', allowOverwrite: true });
            try { await del(legacyBlobs[0].url); } catch(e) { /* ignore if already deleted */ }
            return res.status(200).json(migrated);
          }
        }
      }

      return res.status(200).json({ users: {}, mustSee: {} });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const data = req.body;
      if (!data) return res.status(400).json({ error: 'No body' });

      const { group, users, mustSee, schedule, groups } = data;

      // Store group metadata (names)
      if (groups && Object.keys(groups).length > 0) {
        const metaKey = GROUPS_META_KEY;
        let existingMeta = {};
        try {
          const { blobs } = await list({ prefix: metaKey });
          if (blobs.length > 0) {
            const resp = await fetch(blobs[0].url);
            existingMeta = await resp.json();
          }
        } catch (e) { /* ignore */ }
        const merged = { ...existingMeta, ...groups };
        await put(metaKey, JSON.stringify(merged), { access: 'public', allowOverwrite: true });
        return res.status(200).json({ ok: true });
      }

      // Store schedule globally
      if (schedule && schedule.length > 0) {
        await put(SCHEDULE_KEY, JSON.stringify({ schedule }), { access: 'public', allowOverwrite: true });
        return res.status(200).json({ ok: true });
      }

      // Store user data (users + mustSee) for a group
      if (users || mustSee) {
        const key = userKey(group);
        const payload = {};
        if (users) payload.users = users;
        if (mustSee) payload.mustSee = mustSee;
        await put(key, JSON.stringify(payload), { access: 'public', allowOverwrite: true });
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'No recognizable data' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
