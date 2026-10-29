import { Elysia } from "elysia";
import { FilterModel } from "../models/filter.model.js";
import { FilterService } from "../services/filter.service.js";

export const FilterRoutes = new Elysia({ prefix: "/api/v1/filters" })
	.get("/", FilterService.get, {
		response: FilterModel.getResponse,
		detail: {
			summary: "Get mail filters",
			description:
				"Returns the account's server-side filter rules (Dovecot Sieve) and their enabled state.",
			tags: ["Filters"],
		},
	})
	.put("/", FilterService.put, {
		body: FilterModel.putBody,
		response: FilterModel.putResponse,
		detail: {
			summary: "Save mail filters",
			description:
				"Validates and saves generated rules using ManageSieve; disabling retains the rules without an active script.",
			tags: ["Filters"],
		},
	})
	.delete("/", FilterService.remove, {
		response: FilterModel.deleteResponse,
		detail: {
			summary: "Delete all mail filters",
			description:
				"Deactivates ezmail filters and saves an empty rule set; previous scripts are retained.",
			tags: ["Filters"],
		},
	});
