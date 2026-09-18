import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Loads the repo's .env, if there is one, before anything reads the environment.
// Import this first. Variables already set in the shell or by a host win, so a
// deployment's own settings are never overridden by a stray file.
const path = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(path)) process.loadEnvFile(path);
