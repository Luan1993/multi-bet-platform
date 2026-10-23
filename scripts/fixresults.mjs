import fs from "fs";
const p = "web/src/pages/owner/OwnerResults.tsx";
let s = fs.readFileSync(p, "utf8");
s = s.replace("<Card key={item.id} title={`${item.home} x ${item.away}`} subtitle={`${item.competition ?? \"\"} • ${kickoff} • ${item.openCoupons} cupom(ns) aceito(s)`}>",
  "<Card key={item.id} title={`${item.home} x ${item.away}`}>");
s = s.replace("              {item.resultFinal ? (",
  "              <div style={{ color: \"var(--text-dim)\", fontSize: \"0.875rem\", marginBottom: \"0.75rem\" }}>${item.competition ?? \"\"} • ${kickoff} • ${item.openCoupons} cupom(ns) aceito(s)</div>\n              {item.resultFinal ? (");
fs.writeFileSync(p, s);
console.log("done");
