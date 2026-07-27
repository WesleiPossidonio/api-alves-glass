import validator from "validator";
import * as Yup from "yup";
import OrderService from "../services/OrderService.js";

const sanitize = (data) => {
  const sanitized = {};

  for (const key in data) {
    const value = data[key];
    sanitized[key] =
      typeof value === "string" ? validator.escape(value.trim()) : value;
  }
  return sanitized;
};

class OrderController {
  async store (request, response) {
    const body = sanitize(request.body);

    const schema = Yup.object().shape({
      client_id: Yup.string().uuid().required(),
      order_number: Yup.string().required(),
      status_description: Yup.string().required(),
      status: Yup.string().required(),
      products: Yup.array()
        .of(
          Yup.object().shape({
            product_name: Yup.string().required(),
            quantity: Yup.number().positive().required(),
            unit_price: Yup.number().positive().required(),
          })
        )
        .required(),
      address: yup.object().shape({
        cep: Yup.string().min(8).max(9).required(),
        rua: Yup.string().required(),
        number_house: Yup.string().required(),
        bairro: Yup.string().required(),
        cidade: Yup.string().required(),
        uf: Yup.string().length(2).required(),
      })
    });

    try {
      await schema.validate(body, { abortEarly: false });
    } catch (err) {
      return response.status(400).json({ errors: err.errors });
    }

    try {
      const {
        client_id,
        order_number,
        status_description,
        status,
        products,
        address,
      } = body;

      const orderService = {
        client_id,
        order_number,
        status_description,
        status,
        products,
        address
      };

      const order =  await OrderService.createOrders(orderService);
      response.status(201).json({ message: "Pedido criado com sucesso!", order: order });

    } catch (error) {
      return response.status(500).json({
        error: error.message,
      });
    }
  }

  async index (request, response) {

    try {
      const userId = request.userId;
      const list = await OrderService.getAllOrders(userId);
      return response.json(list);
    } catch (error) {
      console.error("Erro no index:", error);
      return response.status(500).json({ error: "Erro interno do servidor" });
    }
  }

  async show (request, response) {
    try {
      const id = request.userId;

      const order = await OrderService.getOrderById(id);

      return response.json(order);
    } catch (error) {
      console.error("Erro no show:", error);
      return response.status(500).json({ error: "Erro interno do servidor", error: error.message });
    }
  }

  async update (request, response) {
    const body = sanitize(request.body);

    const schema = Yup.object().shape({
      client_id: Yup.string().uuid(),
      order_number: Yup.string(),
      status_description: Yup.string(),
      status: Yup.string(),
    });

    try {
      await schema.validate(body, { abortEarly: false });
    } catch (err) {
      return response.status(400).json({ errors: err.errors });
    }

    try {
      const { id } = request.params;

      const { client_id, order_number, status_description, status } = body;

      const updatedData = {
        client_id,
        order_number,
        status_description,
        status,
      };

      try {
        await OrderService.updateOrder(id, updatedData, request.transaction);
        return response.status(200).json({
          message: "Pedido atualizado com sucesso!"
        });
      } catch (error) {
        console.error("Erro ao atualizar pedido:", error);
        return response.status(500).json({ error: "Erro interno do servidor" });
      }

      return response.status(200).json({
        message: "Pedido atualizado com sucesso!"
      });
    } catch (error) {
      console.error("Erro no update:", error);
      return response.status(500).json({ error: "Erro interno do servidor" });
    }
  }
}

export default new OrderController();
