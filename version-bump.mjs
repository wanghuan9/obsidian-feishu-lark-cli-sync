import fs from "fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(fs.readFileSync("versions.json", "utf8"));

versions[manifest.version] = manifest.minAppVersion;

fs.writeFileSync("versions.json", `${JSON.stringify(versions, null, "\t")}\n`);
