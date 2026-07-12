/**
 * Camera registry in MongoDB.
 *
 * One document per camera in the `cameras` collection of the `titancctv`
 * database:
 *
 *   {
 *     name:      'gate',                 // slug: used in URLs and stream paths
 *     label:     'Front Gate',           // what viewers see in the picker
 *     rtspUrl:   'rtsp://user:pass@...', // same URL you would paste into VLC
 *     transport: 'tcp',                  // or 'udp'
 *     transcode: true,                   // false = pass H264 through untouched
 *     enabled:   true,
 *     createdAt: Date
 *   }
 *
 * Only the registry lives here. Video never touches the database.
 */
import './env.js';
import { MongoClient } from 'mongodb';

const URI = process.env.MONGODB_URI || '';

/** Stream path names end up in URLs and MediaMTX config: keep them strict. */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

let client = null;

export function dbConfigured() {
  return Boolean(URI);
}

async function collection() {
  if (!client) {
    client = new MongoClient(URI, { serverSelectionTimeoutMS: 20000 });
    await client.connect();
  }
  return client.db('titancctv').collection('cameras');
}

/** Enabled cameras, oldest first, validated. Throws if MONGODB_URI is unset. */
export async function getCameras() {
  const col = await collection();
  const docs = await col.find({ enabled: { $ne: false } }).sort({ createdAt: 1 }).toArray();

  return docs
    .filter((d) => {
      const ok = NAME_RE.test(d.name ?? '') && typeof d.rtspUrl === 'string' && d.rtspUrl;
      if (!ok) console.error(`  [db] skipping malformed camera doc: ${d._id}`);
      return ok;
    })
    .map((d) => ({
      name: d.name,
      label: d.label || d.name,
      rtspUrl: d.rtspUrl,
      transport: d.transport === 'udp' ? 'udp' : 'tcp',
      transcode: d.transcode !== false,
    }));
}

export async function addCamera({ name, label, rtspUrl, transport = 'tcp', transcode = true }) {
  if (!NAME_RE.test(name)) {
    throw new Error(`name must match ${NAME_RE} (lowercase letters, digits, dashes)`);
  }
  const col = await collection();
  const existing = await col.findOne({ name });
  if (existing) throw new Error(`camera "${name}" already exists`);

  await col.insertOne({
    name,
    label: label || name,
    rtspUrl,
    transport,
    transcode,
    enabled: true,
    createdAt: new Date(),
  });
}

export async function listAll() {
  const col = await collection();
  return col.find({}).sort({ createdAt: 1 }).toArray();
}

export async function setEnabled(name, enabled) {
  const col = await collection();
  const r = await col.updateOne({ name }, { $set: { enabled } });
  if (!r.matchedCount) throw new Error(`no camera named "${name}"`);
}

export async function removeCamera(name) {
  const col = await collection();
  const r = await col.deleteOne({ name });
  if (!r.deletedCount) throw new Error(`no camera named "${name}"`);
}

export async function closeDb() {
  await client?.close();
  client = null;
}
