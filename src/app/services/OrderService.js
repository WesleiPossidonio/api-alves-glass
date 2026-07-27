
import Database from '../../database/index.js';
import OrderAddressRepository from '../repositories/OrderAddressRepository.js';
import OrderRepository from "../repositories/OrderRepository.js";
import OrdersProductsRepository from "../repositories/OrdersProductsRepository.js";
import UserRepository from '../repositories/UserRepository.js';

class OrderService {
  async createOrders(orderData) {
    const transaction = await Database.connection.transaction();

    const existsOrder = await OrderRepository.findByOrderNumber(
      orderData.order_number
    );

    if (existsOrder) {
      throw new Error('Já existe um pedido com esse número.');
    }

    const productsToInsert = orderData.products.map((product) => ({
        product_name: product.product_name,
        quantity: product.quantity,
        unit_price: product.unit_price,
        subtotal: product.quantity * product.unit_price,
    }));

    const dataOrder = {
        client_id: orderData.client_id,
        order_number: orderData.order_number,
        status_description: orderData.status_description,
        status: orderData.status,
        products: productsToInsert,
        total: productsToInsert.reduce((acc, product) => acc + product.subtotal, 0),
    };

    try {
      const order = await OrderRepository.create(
        dataOrder,
        transaction
      );

      const orderProducts = productsToInsert.map((product) => ({
        order_id: order.id,
        product_name: product.product_name,
        quantity: product.quantity,
        unit_price: product.unit_price,
        subtotal: product.subtotal,
      }));

      await OrdersProductsRepository.create(
        orderProducts,
        transaction
      );

      await OrderAddressRepository.create(
        {
          order_id: order.id,
          ...orderData.address
        },
        transaction
      );

      await transaction.commit();
      return order;
    } catch (error) {
      await transaction.rollback();
       console.log(error.errors);
       console.log(error.fields);
      throw new Error(error);
    }
  }

  async getOrderById(id) {
    try {
      const order = await OrderRepository.findByOrderClientId(id);

      if (!order) {
        throw new Error('Algum dos dados não foi encontrado.');
      }

      return order;
    } catch (error) {
      throw new Error('Erro ao buscar pedido.');
      console.error('Erro ao buscar pedido:', error);
    }
  }

  async getAllOrders(userId) {
    try {
      const user = await UserRepository.findById(userId);
      if (!user) {
          throw new Error('Usuário não encontrado');
      }

      const orders = await OrderRepository.findAll();
      return orders;
    } catch (error) {
      console.error('Erro ao buscar pedidos:', error);
      throw new Error('Erro ao buscar pedidos.');
    }
  }

  async updateOrder(orderId, updateData) {
    try {
      const order = await OrderRepository.findById(orderId);

      if (!order) {
        throw new Error('Pedido não encontrado');
      }

      const dataOrder = {
        client_id: updateData.client_id,
        order_number: updateData.order_number,
        status_description: updateData.status_description,
        status: updateData.status,
      };

      await OrderRepository.update(orderId, dataOrder);

    } catch (error) {
      console.error('Erro ao atualizar pedido:', error);
      throw new Error('Erro ao atualizar pedido.');
    }
  }
}

export default new OrderService()
