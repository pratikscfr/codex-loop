/** Generates docs/CONTROLS.md from the control catalog so the documentation can never drift from the code. */
import { writeFile } from "node:fs/promises";
import { renderControlsDoc } from "./controls-doc.mts";

await writeFile(new URL("../docs/CONTROLS.md", import.meta.url), renderControlsDoc(), "utf8");
console.log("wrote docs/CONTROLS.md");
