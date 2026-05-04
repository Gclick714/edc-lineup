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

      const { group, users, mustSee, schedule, groups, scheduleEdits, scheduleAdditions } = data;

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

      // Store user data (users + mustSee + scheduleEdits + scheduleAdditions) for a group
      if (users || mustSee || scheduleEdits || scheduleAdditions) {
        const key = userKey(group);

        // Fetch current cloud state FIRST — admin deletions are authoritative.
        // This prevents stale clients from resurrecting admin-deleted users.
        let existingUsers = {};
        let existingMustSee = {};
        let existingEdits = {};
        let existingAdditions = [];
        try {
          const { blobs } = await list({ prefix: key });
          if (blobs.length > 0) {
            const resp = await fetch(blobs[0].url);
            const current = await resp.json();
            if (current.users) existingUsers = current.users;
            if (current.mustSee) existingMustSee = current.mustSee;
            if (current.scheduleEdits) existingEdits = current.scheduleEdits;
            if (current.scheduleAdditions) existingAdditions = current.scheduleAdditions;
          }
        } catch (e) { /* ignore read errors */ }

        // Merge: three-state authority model for users.
        //   undefined (key absent) → brand new user, ALLOW
        //   null (tombstone)      → admin-deleted, BLOCK permanently
        //   Array[]               → existing user, ALLOW incoming picks
        // Cloud is authoritative for WHICH users exist.
        const payload = {};
        if (users && Object.keys(users).length > 0) {
          const mergedUsers = {};
          for (const u in users) {
            const cloudVal = existingUsers[u];
            if (cloudVal === null) {
              // Admin-deleted (tombstone) — skip incoming, preserve tombstone
              mergedUsers[u] = null;
              continue;
            }
            // New user (undefined) or existing user (Array) — accept incoming picks
            mergedUsers[u] = users[u];
          }
          // Users only in cloud (admin hasn't deleted them) — keep cloud picks
          // Also preserve null tombstones so they survive sync cycles
          for (const u in existingUsers) {
            if (!mergedUsers.hasOwnProperty(u)) {
              mergedUsers[u] = existingUsers[u];
            }
          }
          payload.users = mergedUsers;
        }
        if (mustSee && Object.keys(mustSee).length > 0) {
          const mergedMustSee = {};
          for (const u in mustSee) {
            const cloudVal = existingMustSee[u];
            if (cloudVal === null) {
              mergedMustSee[u] = null;
              continue;
            }
            mergedMustSee[u] = mustSee[u];
          }
          for (const u in existingMustSee) {
            if (!mergedMustSee.hasOwnProperty(u)) {
              mergedMustSee[u] = existingMustSee[u];
            }
          }
          payload.mustSee = mergedMustSee;
        }
        // Merge schedule edits: incoming overwrites cloud for same index
        if (scheduleEdits && Object.keys(scheduleEdits).length > 0) {
          payload.scheduleEdits = { ...existingEdits, ...scheduleEdits };
        } else if (Object.keys(existingEdits).length > 0) {
          payload.scheduleEdits = existingEdits;
        }
        // Merge schedule additions: deduplicate by DJ name, incoming first
        if (scheduleAdditions && scheduleAdditions.length > 0) {
          const names = new Set(scheduleAdditions.map(a => a.dj));
          const merged = [...scheduleAdditions];
          existingAdditions.forEach(a => {
            if (!names.has(a.dj)) merged.push(a);
          });
          payload.scheduleAdditions = merged;
        } else if (existingAdditions.length > 0) {
          payload.scheduleAdditions = existingAdditions;
        }
        await put(key, JSON.stringify(payload), { access: 'public', allowOverwrite: true });
        return res.status(200).json({ ok: true });
      }

      // Admin operations (password-protected dashboard)
      if (data.admin === true) {
        if (data.password !== 'asia123') {
          return res.status(403).json({ error: 'Unauthorized' });
        }

        if (data.action === 'list') {
          const { blobs } = await list({ prefix: '' });
          const results = [];
          for (const blob of blobs) {
            try {
              const resp = await fetch(blob.url);
              const content = await resp.json();
              results.push({ pathname: blob.pathname, url: blob.url, uploadedAt: blob.uploadedAt, content });
            } catch (e) {
              results.push({ pathname: blob.pathname, url: blob.url, error: e.message });
            }
          }
          return res.status(200).json({ ok: true, blobs: results });
        }

        if (data.action === 'deleteUser') {
          const key = userKey(data.group);
          const { blobs } = await list({ prefix: key });
          if (blobs.length > 0) {
            const resp = await fetch(blobs[0].url);
            const existing = await resp.json();
            // Use null tombstone — distinguishes "never existed" from "admin-deleted"
            if (existing.users) existing.users[data.user] = null;
            if (existing.mustSee) existing.mustSee[data.user] = null;
            await put(key, JSON.stringify(existing), { access: 'public', allowOverwrite: true });
            return res.status(200).json({ ok: true, message: 'Removed ' + data.user + ' from ' + data.group });
          }
          return res.status(404).json({ error: 'Group data not found' });
        }

        if (data.action === 'clearUser') {
          const key = userKey(data.group);
          const { blobs } = await list({ prefix: key });
          if (blobs.length > 0) {
            const resp = await fetch(blobs[0].url);
            const existing = await resp.json();
            if (existing.users) existing.users[data.user] = [];
            if (existing.mustSee) existing.mustSee[data.user] = [];
            await put(key, JSON.stringify(existing), { access: 'public', allowOverwrite: true });
            return res.status(200).json({ ok: true, message: 'Cleared picks for ' + data.user });
          }
          return res.status(404).json({ error: 'Group data not found' });
        }

        if (data.action === 'clearGroup') {
          const key = userKey(data.group);
          const { blobs } = await list({ prefix: key });
          if (blobs.length > 0) {
            const existing = { users: {}, mustSee: {} };
            const resp = await fetch(blobs[0].url);
            const current = await resp.json();
            if (current.users) {
              for (const u in current.users) {
                existing.users[u] = [];
              }
            }
            await put(key, JSON.stringify(existing), { access: 'public', allowOverwrite: true });
            return res.status(200).json({ ok: true, message: 'Cleared all picks for group' });
          }
          return res.status(404).json({ error: 'Group data not found' });
        }

        if (data.action === 'deleteGroup') {
          const key = userKey(data.group);
          const { blobs } = await list({ prefix: key });
          if (blobs.length > 0) {
            await del(blobs[0].url);
          }
          // Remove from metadata
          const { blobs: metaBlobs } = await list({ prefix: GROUPS_META_KEY });
          if (metaBlobs.length > 0) {
            try {
              const resp = await fetch(metaBlobs[0].url);
              const meta = await resp.json();
              if (meta[data.group]) {
                delete meta[data.group];
                await put(GROUPS_META_KEY, JSON.stringify(meta), { access: 'public', allowOverwrite: true });
              }
            } catch (e) { /* ignore meta errors */ }
          }
          return res.status(200).json({ ok: true, message: 'Group ' + data.group + ' deleted' });
        }

        if (data.action === 'deleteLegacy') {
          const { blobs } = await list({ prefix: LEGACY_KEY });
          if (blobs.length > 0) {
            await del(blobs[0].url);
            return res.status(200).json({ ok: true, message: 'Legacy data deleted' });
          }
          return res.status(404).json({ error: 'No legacy data found' });
        }

        if (data.action === 'deleteBlob') {
          if (data.url) {
            await del(data.url);
            return res.status(200).json({ ok: true, message: 'Blob deleted' });
          }
          return res.status(400).json({ error: 'No URL provided' });
        }

        return res.status(400).json({ error: 'Unknown admin action' });
      }

      return res.status(400).json({ error: 'No recognizable data' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
