import path from "node:path";
import { loadConfig } from "../src/config.js";
import { ensureAuthed } from "../src/gdrive.js";

const config = loadConfig();
const dataDir = path.resolve(process.cwd(), config.dataDir);
const gapi = await ensureAuthed(config, dataDir);
if (gapi) console.log("Google authorized — restart `npm run up` to connect the doc.");
else process.exit(1);
