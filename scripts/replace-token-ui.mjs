import fs from "node:fs";
const apps = ["piki-admin", "piki-fleet", "piki-rider"];
for (const app of apps) {
  const path = `/home/ubuntu/${app}/src/App.tsx`;
  let source = fs.readFileSync(path, "utf8");
  if (!source.includes("EmployeeAuthGate")) source = source.replace(/(import \"\.\/App\.css\";\n?)/, '$1import EmployeeAuthGate from "./EmployeeAuthGate";\n');
  source = source.replace(/\s*const \[tokenDraft,\s*setTokenDraft\] = useState\(""\);/, "");
  source = source.replace(/,\[tokenDraft,setTokenDraft\]=useState\(""\)/, "");
  source = source.replace(/\{authRequired\s*&&\s*<form className="token-card"[\s\S]*?<\/form>\}/, '{authRequired && <EmployeeAuthGate apiOrigin={apiOrigin} onAuthenticated={(token)=>{sessionStorage.setItem(tokenStorageKey,token);setApiToken(token);setAuthRequired(false);setStatus("checking")}} />}');
  source = source.replace(/\{authRequired&&<form className="token-card"[\s\S]*?<\/form>\}/, '{authRequired&&<EmployeeAuthGate apiOrigin={apiOrigin} onAuthenticated={(token)=>{sessionStorage.setItem(tokenStorageKey,token);setApiToken(token);setAuthRequired(false);setStatus("checking")}}/>}');
  if (source.includes("Bearer Token asignado") || source.includes("placeholder=\"Bearer token\"")) throw new Error(`Token UI remains in ${app}`);
  fs.writeFileSync(path, source);
}
