import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	test: {
		environment: "happy-dom",
		setupFiles: ["./src/test/setup.js"],
		testTimeout: 15000,
	},
	server: {
		port: 5173,
		proxy: {
			"/api": {
				target: "http://localhost:5000",
				changeOrigin: true,
			},
			"/openapi": {
				target: "http://localhost:5000",
				changeOrigin: true,
			},
		},
	},
});