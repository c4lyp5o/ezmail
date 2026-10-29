import { Elysia } from "elysia";
import { FilterModel } from "../models/filter.model.js";
import { FilterService } from "../services/filter.service.js";

export const FilterRoutes = new Elysia({ prefix: "/api/v1/filters" })
	.get("/", FilterService.get, {
		response: FilterModel.getResponse,
		detail: {
			summary: "Get mail filters",
			description:
				"Returns the selected filtering mode, its rules, and its enabled state.",
			tags: ["Filters"],
		},
	})
	.put("/", FilterService.put, {
		body: FilterModel.putBody,
		response: FilterModel.putResponse,
		detail: {
			summary: "Save mail filters",
			description:
				"Saves rules using ManageSieve or the explicitly selected continuous IMAP fallback.",
			tags: ["Filters"],
		},
	})
	.delete("/", FilterService.remove, {
		response: FilterModel.deleteResponse,
		detail: {
			summary: "Delete all mail filters",
			description:
				"Deletes IMAP fallback rules and credentials, or deactivates ezmail's Sieve rules.",
			tags: ["Filters"],
		},
	});
