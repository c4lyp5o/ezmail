module.exports = {
	apps: [
		{
			name: "server",
			// Run via start.sh shim (exec bun) — PM2's fork+bun interpreter wrapper
			// require()s the entrypoint and can't load top-level-await ESM.
			script: "./start.sh",
			interpreter: "none",
			instances: 1,
			exec_mode: "fork",
			autorestart: true,
			watch: false,
			env: {
				NODE_ENV: "development",
				PORT: 5000,
			},
			env_production: {
				NODE_ENV: "production",
				PORT: 5000,
			},
		},
	],
};