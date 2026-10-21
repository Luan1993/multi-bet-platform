const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "src", "db", "migrations");
const dest = path.join(__dirname, "..", "dist", "db", "migrations");

fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });
console.log("[build] migrações copiadas para dist/db/migrations");
