import OrderAddressRepository from '../repositories/OrderAddressRepository.js';
import UserRepository from '../repositories/UserRepository.js';
class OrderAddressService {
  async findById(id) {

    try {
        return await OrderAddressRepository.findById(id);
    } catch (error) {
        throw new Error('Address not found');
    }
    
  }

  async create(addressData, idAdmin) {
    try {
        const user = await UserRepository.findById(idAdmin);
        
        if(!user) {
            throw new Error('User not authorized to create address');
        }

        return await OrderAddressRepository.create(addressData);
    } catch (error) {
        throw new Error('Error creating address');
    }
  }

  async update(id, addressData, idAdmin) {
    try {
         const user = await UserRepository.findById(idAdmin);
        
        if(!user) {
            throw new Error('User not authorized to create address');
        }

        return await OrderAddressRepository.update(id, addressData);
    } catch (error) {
        throw new Error('Error updating address');
    }
  }

  async delete(address, idAdmin) {
    try {
        const user = await UserRepository.findById(idAdmin);
        
        if(!user) {
            throw new Error('User not authorized to delete address');
        }

        return await OrderAddressRepository.delete(address);
    } catch (error) {
        throw new Error('Error deleting address');
    }
  }
}

export default new OrderAddressService();