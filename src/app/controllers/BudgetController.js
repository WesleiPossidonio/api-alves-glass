import validator from "validator";
import * as Yup from "yup";
import BudgetService from "../services/BudgetService.js";

const sanitize = (data) => {
    const sanitized = {};

    for (const key in data) {
        const value = data[key];
        sanitized[key] =
            typeof value === "string" ? validator.escape(value.trim()) : value;
    }
    return sanitized;
};


class BudgetController {
    async store(request, response) {
        const schema = Yup.object().shape({
            name_budget: Yup.string().required(),
            description_budget: Yup.string().required(),
            expiration_date: Yup.string().required(),
            total_value: Yup.number().required(),
            client_id: Yup.string().uuid().nullable(),
        });

        const body = sanitize(request.body);
        const idAdmin = request.userId;
        const filePdf = request.file;

        try {
            await schema.validate(body, { abortEarly: false });
        } catch (err) {
            return response.status(400).json({ errors: err.errors });
        }

        try {
            const {
                name_budget,
                description_budget,
                expiration_date,
                total_value,
                client_id
            } = body;

            const budgetData = {
                name_budget,
                description_budget,
                expiration_date,
                total_value,
                client_id,
            };

            const createdBudget = await BudgetService.createBudget(budgetData, idAdmin, filePdf);

            return response.status(201).json(createdBudget);
        } catch (error) {
            return response.status(500).json({ error: "Internal server error" });
        }
    }

    async update(request, response) {
        const schema = Yup.object().shape({
            name_budget: Yup.string().nullable(),
            description_budget: Yup.string().nullable(),
            expiration_date: Yup.date().nullable(),
            total_value: Yup.number().nullable(),
            client_id: Yup.string().uuid().required(),
        });

        const body = sanitize(request.body);
        const idAdmin = request.userId;
        const budgetId = request.params.id;

        try {
            await schema.validate(body, { abortEarly: false });
        } catch (err) {
            return response.status(400).json({ errors: err.errors });
        }

        try {
            const { name_budget, description_budget, expiration_date, total_value, client_id } = body;

            const updateData = {
                name_budget,
                description_budget,
                expiration_date,
                total_value,
                client_id,
            };

            const updatedBudget = await BudgetService.updateBudget(budgetId, updateData, idAdmin);

            return response.status(200).json(updatedBudget);
        } catch (error) {
            return response.status(500).json({ error: "Internal server error" });
        }
    }

    async index(request, response) {

        const clientId = request.userId;
        try {
            const budgets = await BudgetService.getBudgetByClientId(ClientId);
            return response.status(200).json(budgets);
        } catch (error) {
            return response.status(500).json({ error: "Internal server error" });
        }
    }

    async show(request, response) {
        const budgetId = request.params.id;

        try {
            const budget = await BudgetService.getBudgetById(budgetId);

            return response.status(200).json(budget);
        } catch (error) {
            return response.status(404).json({ error: "Budget not found" });
        }
    }

    async delete(request, response) {
        const budgetId = request.params.id;
        const idAdmin = request.userId;

        try {
            await BudgetService.deleteBudget(budgetId, idAdmin);
            return response.status(204).send();
        } catch (error) {
            return response.status(500).json({ error: "Internal server error" });
        }
    }
}

export default new BudgetController();
