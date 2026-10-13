import { hello } from "fixture-peer-consumer";

const output = hello();
if (output !== "consumer:provider") {
  throw new Error(`unexpected peer output: ${output}`);
}

console.log(output);
