import path from "node:path";
import deadslog from "deadslog";
import { LOG_DIR } from "./config.js";

export const generalLogger = deadslog({
	consoleOutput: {
		enabled: true,
		coloredCoding: true,
	},
	fileOutput: {
		enabled: true,
		logFilePath: path.join(LOG_DIR, "ezmail.log"),
	},
});