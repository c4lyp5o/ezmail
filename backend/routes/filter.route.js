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
				"Replaces all filter rules. Rules apply at delivery time via Dovecot Sieve; disabling removes the sieve script but keeps rules for later.",
			tags: ["Filters"],
		},
	})
	.delete("/", FilterService.remove, {
		response: FilterModel.deleteResponse,
		detail: {
			summary: "Delete all mail filters",
			description:
				"Removes every filter rule and the sieve script for the account.",
			tags: ["Filters"],
		},
	});
