import Order from '../models/Order.js'
import OrdersProducts from "../models/OrdersProducts.js";

class OrderRepository {
    async findById(id){
      return await Order.findByPk(id, {
        include: [{ model: OrdersProducts, as: "products" }],
        order: [["createdAt", "DESC"]],
      })
    }

    async findByOrderClientId(clientId) {
      return await Order.findAll({
        where: { client_id: clientId },
        include: [{ model: OrdersProducts, as: "products" }],
        order: [["createdAt", "DESC"]],
      });
    }

    async findByOrderNumber(orderNumber) {
       return Order.findOne({
         where: {
           order_number: orderNumber,
         },
       });
    }

    async findAll() {
        return await Order.findAll({
            include: [{ model: OrdersProducts, as: "products" }],
            order: [["createdAt", "DESC"]],
        });
    }

    async create(orderData, transaction) {
        return Order.create(orderData, {
            transaction,
        });
    }

    async update(id, orderData, transaction) {
      return await Order.update(orderData, {
      where: { id },
      transaction,
      });
    }

    async delete(id, transaction) {
      return await Order.destroy({
        where: { id },
        transaction,
      });
    }
}

export default new OrderRepository()