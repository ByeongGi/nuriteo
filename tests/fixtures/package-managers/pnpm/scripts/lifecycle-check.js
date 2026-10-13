import fs from "node:fs";

const marker = "node_modules/fixture-optional/lifecycle-marker.txt";
if (!fs.existsSync(marker)) {
  throw new Error("optional dependency lifecycle marker missing");
}

console.log(fs.readFileSync(marker, "utf8").trim());
