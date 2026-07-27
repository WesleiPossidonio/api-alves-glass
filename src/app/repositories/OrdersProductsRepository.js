import OrdersProducts from "../models/OrdersProducts.js";


class OrdersProductsRepository {
  async findById(id) {
    return await OrdersProducts.findByPk(id);
  }

  async findAllByOrderId(orderId) {
    return await OrdersProducts.findAll({
      where: {
        order_id: orderId,
      },
    });
  }

  async create(products, transaction) {
    return await OrdersProducts.bulkCreate(products, {
      transaction,
    });
  }

  async update(id, productData, transaction) {
    return await OrdersProducts.update(productData, {
      where: {
        id: id,
      },
      transaction,
    });
  }

  async delete(id, transaction) {
    return await OrdersProducts.destroy({
      where: {
        id,
      },
      transaction,
    });
  }

  async deleteByOrderId(orderId, transaction) {
    return await OrdersProducts.destroy({
      where: {
        order_id: orderId,
      },
      transaction,
    });
  }
}

export default new OrdersProductsRepository();