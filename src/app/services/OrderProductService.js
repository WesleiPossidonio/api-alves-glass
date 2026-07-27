import OrderRepository from "../repositories/OrderRepository.js";
import OrdersProductsRepository from "../repositories/OrdersProductsRepository.js";


class OrderProductService {
    async updateOrderProduct({id, productData}, transaction) {  
      const orderProduct = await OrdersProductsRepository.findById(id)

      if(!orderProduct){
       throw new Error('Produto do pedido não encontrado');
      }

      try {
        await OrdersProductsRepository.update(id, productData, transaction);

        if(productData.quantity || productData.unit_price
          || productData.quantity && productData.unit_price) {
          const order = await OrderRepository.findById(orderProduct.order_id, transaction);
          const totalPrice = order.products.reduce((total, product) => {
            return total + (product.unit_price * product.quantity);
          }, 0);

          await OrderRepository.update(orderProduct.order_id, { total: totalPrice }, transaction);
        }
        
        return { message: 'Produto do pedido atualizado com sucesso.' };
      } catch (error) {
        console.error('Erro ao atualizar produto do pedido:', error);
        throw new Error('Erro ao atualizar produto do pedido.', { cause: error });
      }

    }
}

export default new OrderProductService()