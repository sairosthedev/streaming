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
 *     mac:       'f8:ce:07:3d:57:39',    // optional: re-resolve the IP by MAC
 *     enabled:   true,
 *     createdAt: Date
 *   }
 *
 * Only the registry lives here. Video never touches the database.
 */
import './env.js';
import { MongoClient } from 'mongodb';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URI = process.env.MONGODB_URI || '';

/**
 * Last known good camera list, on disk.
 *
 * The registry lives in Atlas, so a site with no internet cannot read it and
 * the server would exit at boot having never streamed a frame. Every
 * successful read writes this file; a failed connection falls back to it.
 * Cameras are not secret from the machine already holding their passwords, but
 * the file does contain them, so it stays out of git.
 */
const CACHE_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.cache',
  'cameras.json',
);

function writeCache(cams) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cams, null, 2));
  } catch (err) {
    console.error(`  [cache] could not write: ${err.message}`);
  }
}

function readCache() {
  try {
    const cams = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return Array.isArray(cams) && cams.length ? cams : null;
  } catch {
    return null;
  }
}

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

/**
 * Enabled cameras, oldest first, validated.
 *
 * Falls back to the on-disk cache when Atlas cannot be reached, so a site with
 * no internet still streams. Throws only when there is neither.
 */
export async function getCameras() {
  try {
    const cams = await getCamerasFromDb();
    writeCache(cams);
    return cams;
  } catch (err) {
    const cached = readCache();
    if (!cached) throw err;
    const why = String(err.message).split(/\r?\n/)[0].slice(0, 60);
    console.error(`  [cache] Atlas unreachable (${why})`);
    console.error(`  [cache] using ${cached.length} camera(s) from the last successful read`);
    return cached;
  }
}

async function getCamerasFromDb() {
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
      mac: d.mac ?? null,
    }));
}

export async function addCamera({ name, label, rtspUrl, transport = 'tcp', transcode = true, mac = null }) {
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
    mac,
    enabled: true,
    createdAt: new Date(),
  });
}

/** Change an existing camera's RTSP URL. Cameras move when a router hands out a new lease. */
export async function updateCameraUrl(name, rtspUrl) {
  const col = await collection();
  const r = await col.updateOne({ name }, { $set: { rtspUrl } });
  if (!r.matchedCount) throw new Error(`no camera named "${name}"`);
}

/** Rename a camera. The name is its URL: /<name>.mp4 and ?cam=<name>. */
export async function renameCamera(from, to) {
  if (!NAME_RE.test(to)) {
    throw new Error(`name must match ${NAME_RE} (lowercase letters, digits, dashes)`);
  }
  const col = await collection();
  if (await col.findOne({ name: to })) throw new Error(`camera "${to}" already exists`);

  const r = await col.updateOne({ name: from }, { $set: { name: to } });
  if (!r.matchedCount) throw new Error(`no camera named "${from}"`);
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

export async function setMac(name, mac) {
  const col = await collection();
  const r = await col.updateOne({ name }, { $set: { mac } });
  if (!r.matchedCount) throw new Error(`no camera named "${name}"`);
}

export async function setTranscode(name, transcode) {
  const col = await collection();
  const r = await col.updateOne({ name }, { $set: { transcode } });
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
