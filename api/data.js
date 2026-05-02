import { put, list } from '@vercel/blob';

const BLOB_KEY = 'edc-data.json';

export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const { blobs } = await list({ prefix: BLOB_KEY });
      if (blobs.length > 0) {
        const resp = await fetch(blobs[0].url);
        const data = await resp.json();
        return res.status(200).json(data);
      }
      return res.status(200).json({ users: {}, schedule: null });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const data = req.body;
      if (!data) return res.status(400).json({ error: 'No body' });
      await put(BLOB_KEY, JSON.stringify(data), { allowOverwrite: true });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
