import * as Yup from "yup";
import Order from "../models/Order.js";
import ServiceProducts from "../models/ServicesProducts.js";
import validator from "validator";

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
      total: Yup.number().positive().required(),
      products: Yup.array()
        .of(
          Yup.object().shape({
            product_name: Yup.string().required(),
            quantity: Yup.number().positive().required(),
            price: Yup.number().positive().required(),
          })
        )
        .required(),
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
        total,
        products,
      } = body;

      // 1️⃣ Cria pedido
      const service = await Order.create({
        client_id,
        order_number,
        status_description,
        status,
        total,
      });

      // 2️⃣ Produtos associados
      const productsToInsert = products.map((p) => ({
        service_id: service.id,
        product_name: p.product_name,
        quantity: p.quantity,
        price: p.price,
        subtotal: p.quantity * p.price,
      }));

      await ServiceProducts.bulkCreate(productsToInsert, {
        validate: true,
      });

      return response.status(201).json({
        message: "Pedido criado com sucesso!",
        order: {
          ...service.toJSON(),
          products: productsToInsert,
        },
      });
    } catch (error) {
      console.error("Erro interno no store:", error);
      return response.status(500).json({
        error: "Erro interno do servidor",
      });
    }
  }

  async index (request, response) {
    try {
      const list = await Order.findAll({
        include: [{ model: ServiceProducts, as: "products" }],
        order: [["createdAt", "DESC"]],
      });

      return response.json(list);
    } catch (error) {
      console.error("Erro no index:", error);
      return response.status(500).json({ error: "Erro interno do servidor" });
    }
  }

  async update (request, response) {
    const body = sanitize(request.body);

    const schema = Yup.object().shape({
      client_id: Yup.string().uuid(),
      order_number: Yup.string(),
      status_description: Yup.string(),
      status: Yup.string(),
      total: Yup.number().positive(),
      products: Yup.array().of(
        Yup.object().shape({
          product_name: Yup.string().required(),
          quantity: Yup.number().positive().required(),
          price: Yup.number().positive().required(),
        })
      ),
    });

    try {
      await schema.validate(body, { abortEarly: false });
    } catch (err) {
      return response.status(400).json({ errors: err.errors });
    }

    try {
      const { id } = request.params;

      const order = await Order.findByPk(id);

      if (!order) {
        return response.status(404).json({ error: "Pedido não encontrado" });
      }

      const { client_id, order_number, status_description, status, total, products } = body;

      // Atualiza apenas campos enviados
      await order.update({
        ...(client_id && { client_id }),
        ...(order_number && { order_number }),
        ...(status_description && { status_description }),
        ...(status && { status }),
        ...(typeof total === "number" && { total }),
      });

      // Atualiza produtos
      if (products) {
        await ServiceProducts.destroy({ where: { service_id: id } });

        const productsToInsert = products.map((p) => ({
          service_id: id,
          product_name: p.product_name,
          quantity: p.quantity,
          price: p.price,
          subtotal: p.quantity * p.price,
        }));

        await ServiceProducts.bulkCreate(productsToInsert);
      }

      const updatedOrder = await Order.findByPk(id, {
        include: [{ model: ServiceProducts, as: "products" }],
      });

      return response.status(200).json({
        message: "Pedido atualizado com sucesso!",
        order: updatedOrder,
      });
    } catch (error) {
      console.error("Erro no update:", error);
      return response.status(500).json({ error: "Erro interno do servidor" });
    }
  }
}

export default new OrderController();
