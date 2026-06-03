import fs from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";
import type { Plugin } from "vite";

type WebsiteConfig = {
	id?: string;
	name?: string;
	description?: string;
	url?: string;
	hostname?: string;
	port?: number;
};

export default function runableAnalyticsPlugin(): Plugin {
	let rootDir = process.cwd();

	return {
		name: "runable-analytics-plugin",
		enforce: "pre",
		configResolved(config) {
			rootDir = config.root;
		},
		async transformIndexHtml(html) {
			const raw = await fs.readFile(path.resolve(rootDir, "website.config.json"), "utf-8");
			const config = JSON.parse(raw) as WebsiteConfig;

			const dom = new JSDOM(html);
			const doc = dom.window.document;
			const head = doc.head;

			const hostname = config.hostname ?? "";

			// Runable script
			const script = doc.createElement("script");
			script.defer = true;
			script.src = "./runable.js";
			script.dataset.hostname = hostname;
			script.dataset.url = "https://r.lilstts.com/events";
			head.appendChild(script);

			return dom.serialize();
		},
	};
}
