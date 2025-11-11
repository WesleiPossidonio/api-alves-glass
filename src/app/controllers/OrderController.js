import * as Yup from 'yup';
import Order from '../models/Order.js';
import ServiceProducts from '../models/ServicesProducts.js';

class OrderController {
  async store (request, response) {
    try {
      const schema = Yup.object().shape({
        client_id: Yup.string().uuid().required(),
        order_number: Yup.string().required(),
        status_description: Yup.string().required(),
        status: Yup.string().required(),
        total: Yup.number().required(),
        products: Yup.array()
          .of(
            Yup.object().shape({
              product_name: Yup.string().required(),
              quantity: Yup.number().required(),
              price: Yup.number().required()
            })
          )
          .required()
      });

      await schema.validate(request.body, { abortEarly: false });

      const {
        client_id,
        order_number,
        status_description,
        status,
        total,
        products
      } = request.body;

      // 1️⃣ Cria o pedido principal
      const service = await Order.create({
        client_id,
        order_number,
        status_description,
        status,
        total
      });

      // 2️⃣ Associa produtos ao pedido
      const productsToInsert = products.map((p) => ({
        service_id: service.id,
        product_name: p.product_name,
        quantity: p.quantity,
        price: p.price,
        subtotal: p.quantity * p.price
      }));

      // 🔹 Insere ignorando timestamps se não existirem
      await ServiceProducts.bulkCreate(productsToInsert, {
        validate: true,
        ignoreDuplicates: false
      });

      return response.status(201).json({
        message: 'Pedido criado com sucesso!',
        order: {
          ...service.toJSON(),
          products: productsToInsert
        }
      });
    } catch (error) {
      console.error('Erro no método store:', error);
      return response.status(500).json({
        error:
          error.name === 'SequelizeDatabaseError'
            ? 'Erro no banco de dados: verifique as colunas da tabela.'
            : 'Erro interno do servidor'
      });
    }
  }


  async index (request, response) {
    const list = await Order.findAll({
      include: [{ model: ServiceProducts, as: 'products' }],
      order: [['created_at', 'DESC']]
    });
    return response.json(list);
  }

  async update (request, response) {
    try {
      const { id } = request.params;

      // ✅ Schema com campos opcionais
      const schema = Yup.object().shape({
        client_id: Yup.string().uuid(),
        order_number: Yup.string(),
        status_description: Yup.string(),
        status: Yup.string(),
        total: Yup.number(),
        products: Yup.array().of(
          Yup.object().shape({
            product_name: Yup.string().required(),
            quantity: Yup.number().required(),
            price: Yup.number().required(),
          })
        ),
      });

      await schema.validate(request.body, { abortEarly: false });

      const {
        client_id,
        order_number,
        status_description,
        status,
        total,
        products,
      } = request.body;

      // 🔍 Verifica se o pedido existe
      const order = await Order.findByPk(id);

      if (!order) {
        return response.status(404).json({ error: "Pedido não encontrado" });
      }

      // 🧾 Atualiza apenas os campos enviados
      await order.update({
        ...(client_id && { client_id }),
        ...(order_number && { order_number }),
        ...(status_description && { status_description }),
        ...(status && { status }),
        ...(typeof total === "number" && { total }),
      });

      // 🛒 Atualiza produtos, se enviados
      if (products && Array.isArray(products)) {
        // Remove antigos
        await ServiceProducts.destroy({
          where: { service_id: id },
        });

        // Adiciona novos
        const productsToInsert = products.map((p) => ({
          service_id: id,
          product_name: p.product_name,
          quantity: p.quantity,
          price: p.price,
          subtotal: p.quantity * p.price,
        }));

        await ServiceProducts.bulkCreate(productsToInsert);
      }

      // 🔁 Retorna o pedido atualizado com produtos
      const updatedOrder = await Order.findByPk(id, {
        include: [{ model: ServiceProducts, as: "products" }],
      });

      return response.status(200).json({
        message: "Pedido atualizado com sucesso!",
        order: updatedOrder,
      });
    } catch (error) {
      console.error("Erro no método update:", error);
      return response.status(500).json({
        error:
          error.name === "SequelizeDatabaseError"
            ? "Erro no banco de dados: verifique as colunas da tabela."
            : "Erro interno do servidor",
      });
    }
  }
}

export default new OrderController();
