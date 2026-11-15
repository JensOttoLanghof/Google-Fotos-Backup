// Baut die Webseite als eine einzige HTML-Datei (dist/index.html) und bettet
// sie für das Windows-Programm ein (src/generated-page.js).
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "..");
const result = await Bun.build({ entrypoints: [path.join(root, "web/app.js")], target: "browser", minify: true });
if (!result.success) { console.error(result.logs.join("\n")); process.exit(1); }
const js = (await result.outputs[0].text()).replaceAll("</script", "<\\/script");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8").replace("/*APP*/", () => js);
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist/index.html"), html);
fs.writeFileSync(path.join(root, "src/generated-page.js"), "export default " + JSON.stringify(html) + ";\n");
console.log(`dist/index.html: ${(html.length / 1024).toFixed(0)} KB`);
