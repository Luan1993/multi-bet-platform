#!/usr/bin/env node
/**
 * Backup do PostgreSQL via pg_dump (se disponível) ou export JSON.
 * Uso: DATABASE_URL=... node scripts/backup-db.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pool } from "../server/dist/db/pool.js";

const outDir = path.resolve("backups");
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = path.join(outDir, `backup-${stamp}.sql`);

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL não definida.");
  process.exit(1);
}

const pgDump = spawn("pg_dump", [url, "--no-owner", "--no-privileges", "--clean", "--if-exists", "-f", file]);
pgDump.on("error", (err) => {
  console.error("pg_dump não encontrado. Instale o cliente PostgreSQL ou use um serviço de backup.");
  console.error(err.message);
  process.exit(1);
});
pgDump.on("close", (code) => {
  if (code === 0) {
    console.log("Backup gerado:", file);
  } else {
    console.error("Falha no backup, código:", code);
    process.exit(code);
  }
});
