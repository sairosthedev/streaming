/**
 * Manage the camera registry.
 *
 *   npm run cameras -- list
 *   npm run cameras -- add <name> "<label>" <rtspUrl> [--udp] [--passthrough]
 *   npm run cameras -- set-url <name> <rtspUrl>
 *   npm run cameras -- rename <old-name> <new-name>
 *   npm run cameras -- disable <name>
 *   npm run cameras -- enable <name>
 *   npm run cameras -- remove <name>
 *
 * `name` is a slug (lowercase/digits/dashes) used in the viewing URL:
 * https://camera.titancctv.xyz/?cam=<name>
 *
 * Use --passthrough for cameras that emit standard yuv420p H264: the stream is
 * forwarded untouched at near-zero CPU. Leave it off (the default transcodes)
 * for cameras like Dahuas that emit full-range yuvj420p, which browsers render
 * as a grey screen without re-encoding.
 */
import { dbConfigured, getCameras, addCamera, updateCameraUrl, renameCamera, listAll, setEnabled, removeCamera, closeDb } from './db.js';

if (!dbConfigured()) {
  console.error('\n  MONGODB_URI is not set in .env - the camera registry needs it.\n');
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);

function maskUrl(u) {
  return String(u).replace(/\/\/[^@/]*@/, '//***:***@');
}

try {
  switch (cmd) {
    case 'list': {
      const all = await listAll();
      if (!all.length) {
        console.log('\n  No cameras yet. Add one:');
        console.log('    npm run cameras -- add gate "Front Gate" rtsp://user:pass@ip:554/path\n');
        break;
      }
      console.log('');
      for (const c of all) {
        const flags = [
          c.enabled === false ? 'DISABLED' : 'enabled',
          c.transcode === false ? 'passthrough' : 'transcode',
          c.transport === 'udp' ? 'udp' : 'tcp',
        ].join(', ');
        console.log(`  ${c.name.padEnd(16)} ${String(c.label).padEnd(24)} ${flags}`);
        console.log(`  ${''.padEnd(16)} ${maskUrl(c.rtspUrl)}`);
      }
      console.log('');
      break;
    }

    case 'add': {
      const flags = rest.filter((a) => a.startsWith('--'));
      const args = rest.filter((a) => !a.startsWith('--'));
      const [name, label, rtspUrl] = args;
      if (!name || !label || !rtspUrl) {
        console.error('\n  usage: npm run cameras -- add <name> "<label>" <rtspUrl> [--udp] [--passthrough]\n');
        process.exit(1);
      }
      await addCamera({
        name,
        label,
        rtspUrl,
        transport: flags.includes('--udp') ? 'udp' : 'tcp',
        transcode: !flags.includes('--passthrough'),
      });
      console.log(`\n  Added "${name}". Restart the server to pick it up:\n    npm run camera\n`);
      break;
    }

    case 'set-url': {
      const [name, rtspUrl] = rest;
      if (!name || !rtspUrl) {
        console.error('\n  usage: npm run cameras -- set-url <name> <rtspUrl>\n');
        process.exit(1);
      }
      await updateCameraUrl(name, rtspUrl);
      console.log(`\n  Updated "${name}" -> ${maskUrl(rtspUrl)}\n  Restart the server to apply:\n    npm run camera\n`);
      break;
    }

    case 'rename': {
      const [from, to] = rest;
      if (!from || !to) {
        console.error('\n  usage: npm run cameras -- rename <old-name> <new-name>\n');
        process.exit(1);
      }
      await renameCamera(from, to);
      console.log(`\n  Renamed "${from}" -> "${to}". It is now served at /${to}.mp4`);
      console.log(`  Restart the server to apply:\n    npm run camera\n`);
      break;
    }

    case 'disable':
    case 'enable': {
      const [name] = rest;
      if (!name) { console.error(`\n  usage: npm run cameras -- ${cmd} <name>\n`); process.exit(1); }
      await setEnabled(name, cmd === 'enable');
      console.log(`\n  ${cmd}d "${name}". Restart the server to apply.\n`);
      break;
    }

    case 'remove': {
      const [name] = rest;
      if (!name) { console.error('\n  usage: npm run cameras -- remove <name>\n'); process.exit(1); }
      await removeCamera(name);
      console.log(`\n  Removed "${name}". Restart the server to apply.\n`);
      break;
    }

    default:
      console.log('\n  usage:');
      console.log('    npm run cameras -- list');
      console.log('    npm run cameras -- add <name> "<label>" <rtspUrl> [--udp] [--passthrough]');
      console.log('    npm run cameras -- set-url <name> <rtspUrl>');
      console.log('    npm run cameras -- rename <old-name> <new-name>');
      console.log('    npm run cameras -- disable <name>');
      console.log('    npm run cameras -- enable <name>');
      console.log('    npm run cameras -- remove <name>\n');
  }
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
