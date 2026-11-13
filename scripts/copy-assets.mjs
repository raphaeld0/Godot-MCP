import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(projectRoot, "dist");
await mkdir(outputDirectory, { recursive: true });
await copyFile(
  join(projectRoot, "src", "godot_operations.gd"),
  join(outputDirectory, "godot_operations.gd"),
);
