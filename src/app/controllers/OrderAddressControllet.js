import * as Yup from "yup";
import OrderAddressService from "../services/OrderAddressService.js";

const sanitize = (data) => {
    const sanitized = {};

    for (const key in data) {
        const value = data[key];
        sanitized[key] =
            typeof value === "string" ? validator.escape(value.trim()) : value;
    }
    return sanitized;
};


class OrderAddressController {

    async update(request, response) {
        const body = sanitize(request.body);
        const { id } = request.params;

        const schema = Yup.object().shape({
            cep: Yup.string().min(8).max(9),
            rua: Yup.string(),
            number_house: Yup.string(),
            bairro: Yup.string(),
            cidade: Yup.string(),
            uf: Yup.string().length(2),
        });

        try {
            await schema.validate(body, { abortEarly: false });
        } catch (err) {
            return response.status(400).json({ errors: err.errors });
        }

        try {
            const updatedOrderAddress = await OrderAddressService.update(id, body);

            if (!updatedOrderAddress) {
                return response.status(404).json({ error: "Order address not found" });
            }

            return response.status(200).json(updatedOrderAddress);
        } catch (error) {
            return response.status(500).json({ error: "Internal server error" });
        }
    }
}

export default new OrderAddressController();
