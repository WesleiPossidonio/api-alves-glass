import OrderAddress from '../models/OrderAddress.js';

class OrderAddressRepository {
    async findById(id){
        return await OrderAddress.findByPk(id)
    }

    async update(id, addressData) {
        const address = await this.findById(id);
        if (!address) {
          throw new Error('Address not found');
        }
        return await address.update(addressData);
    }

    async delete(address) {
        return await address.destroy();
    }
}

export default new OrderAddressRepository();
