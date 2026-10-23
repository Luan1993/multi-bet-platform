import fs from "fs";
const p = "web/src/pages/owner/OwnerRisk.tsx";
let s = fs.readFileSync(p, "utf8");
s = s.replace("import { Alert, Button, Card, PageTitle } from \"../../components/ui\";\nimport { formatBRL } from \"../../lib/format\";",
  "import { Alert, Button, Card, Input, PageTitle } from \"../../components/ui\";\nimport { formatBRL } from \"../../lib/format\";");
fs.writeFileSync(p, s);
console.log("ok");
